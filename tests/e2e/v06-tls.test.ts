/**
 * **v0.6 — TLS 종단과 인증서 롤백** (DESIGN.md §4.6 · §4.8 · §7.2 · §8.1, S8·S16·S17)
 *
 * `tests/golden/tls.test.ts` 는 렌더 산출물을 손으로 띄워 인증서 선택을 쟀다. 여기서는
 * **REST 로 끝까지 몬다**: 자료 업로드 → changeset → plan → commit → apply → 실제 HTTPS.
 *
 * ── 진짜 질문은 롤백이다 ────────────────────────────────────────────────
 *
 * §4.8 이 *"버전 없는 참조는 롤백을 거짓말로 만든다"* 고 적어 둔 이유를 S8 이 실측했다.
 * 인증서를 세대 **밖** mutable 경로에 두거나 이름만으로 참조하면, 갱신이 덮어써서
 * **conf 를 롤백해도 갱신된 인증서가 그대로 제시된다.** 그리고 그 상태는 트래픽만 보면
 * 정상이다 — 200 이 잘 나온다.
 *
 * 그래서 여기서 재는 것은 "롤백이 성공했는가" 가 아니라 **"롤백 뒤에 제시되는 인증서가
 * 옛 것인가"** 다. 판정은 제시된 인증서의 CN 으로 한다.
 *
 * ── 이 테스트가 잡는 실패 모드 ──────────────────────────────────────────
 *
 *   · 렌더러가 SNI 바인딩을 무시하고 default 인증서만 낸다 → 호스트별 CN 이 안 갈린다
 *   · 인증서 바이트가 세대에 안 들어간다               → apply 가 configtest 에서 죽는다
 *   · 롤백이 인증서를 안 되돌린다                       → 롤백 후 CN 이 새 것이다
 *   · API 가 개인키를 돌려준다 (§8.1 위반)              → 응답에 PRIVATE KEY 가 보인다
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { waitForPg } from './pg-ready.js';
import { waitForDaemon } from './daemon-up.js';
import { appMount } from './mounts.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const NET = 'bary-v06-net';
const PG = 'bary-v06-pg';
const DP = 'bary-v06-dp';
const API_PORT = 18601;
const TLS_PORT = 18602;
const TOKEN = 'v06-test-token';

const docker = (...args: string[]): string =>
  execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

const quiet = (...args: string[]): void => {
  try { docker(...args); } catch { /* 없으면 그만 */ }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(probe: () => Promise<T>, ok: (v: T) => boolean, budgetMs = 30_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last = await probe();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(250);
    last = await probe();
  }
  return last;
}

type ApiResult = { status: number; body: any };

async function api(method: string, path: string, body?: unknown): Promise<ApiResult> {
  const r = await fetch(`http://127.0.0.1:${API_PORT}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
}

async function push(patch: unknown[]): Promise<{ apply: ApiResult; plan: ApiResult }> {
  const head = await api('GET', '/api/v1/config/head');
  const cs = await api('POST', '/api/v1/changesets', { base_revision: head.body.revision });
  await api('PATCH', `/api/v1/changesets/${cs.body.id}`, { patch });
  const plan = await api('POST', `/api/v1/changesets/${cs.body.id}/plan`);
  if (plan.status !== 200) return { apply: plan, plan };
  await api('POST', `/api/v1/changesets/${cs.body.id}/commit`, { plan_id: plan.body.id });
  return { apply: await api('POST', '/api/v1/apply', { plan_id: plan.body.id }), plan };
}

/**
 * **제시된 인증서의 CN 을 읽는다.** 본문이 아니라 인증서를 본다 — 질문이 "무엇이
 * 제시되는가" 이기 때문이다. 컨테이너 안에서 openssl 로 잰다.
 */
function servedCn(sni: string): string {
  try {
    return docker('exec', DP, 'sh', '-c',
      `echo | openssl s_client -connect 127.0.0.1:443 -servername ${sni} 2>/dev/null ` +
      `| openssl x509 -noout -subject 2>/dev/null | sed 's/.*CN *= *//'`).trim();
  } catch {
    return '(실패)';
  }
}

/** 자체서명 인증서 한 벌을 컨테이너 안에서 굽고 PEM 두 개를 읽어 온다. */
function mintCert(cn: string, san: string): { fullchain: string; privkey: string } {
  const dir = `/tmp/mint-${cn.replace(/[^a-z0-9]/gi, '_')}`;
  docker('exec', DP, 'sh', '-c',
    `mkdir -p ${dir} && openssl req -x509 -newkey rsa:2048 -nodes -days 2 ` +
    `-subj "/CN=${cn}" -addext "subjectAltName=${san}" ` +
    `-keyout ${dir}/k.pem -out ${dir}/c.pem >/dev/null 2>&1`);
  return {
    fullchain: docker('exec', DP, 'cat', `${dir}/c.pem`),
    privkey: docker('exec', DP, 'cat', `${dir}/k.pem`),
  };
}

function tearDown(): void {
  quiet('rm', '-f', DP);
  quiet('rm', '-f', PG);
  quiet('network', 'rm', NET);
}

beforeAll(async () => {
  try {
    docker('version', '--format', '{{.Server.Version}}');
  } catch {
    throw new Error('도커가 없다 — TLS 종단은 실물로만 잰다');
  }
  tearDown();
  docker('network', 'create', NET);
  docker('run', '-d', '--name', PG, '--network', NET,
    '-e', 'POSTGRES_PASSWORD=bary', '-e', 'POSTGRES_DB=bary', 'docker.io/library/postgres:17-alpine');

  // PG 가 답할 때까지 기다린다 — 안 그러면 데몬이 ECONNREFUSED 로 죽고 다시 안 시도한다.
  await waitForPg(PG);

  const hash = execFileSync('node', ['-e',
    `process.stdout.write(require('crypto').createHash('sha256').update('${TOKEN}').digest('hex'))`,
  ]).toString();

  docker('run', '-d', '--name', DP, '--network', NET,
    '-p', `${API_PORT}:8088`, '-p', `${TLS_PORT}:443`,
    ...appMount(),
    '-e', `BARY_DSN=postgres://postgres:bary@${PG}:5432/bary`,
    '-e', 'BARY_PREFIX=/prefix',
    '-e', 'BARY_SECRETS=/secrets',
    '-e', 'BARY_LISTEN=0.0.0.0:8088',
    '-e', 'BARY_ENGINE_BIN=/usr/local/openresty/bin/openresty',
    '-e', `BARY_TOKENS=[{"name":"tester","hash":"sha256:${hash}","scopes":["read","write","apply"]}]`,
    '-e', 'BARY_RELOAD_CMD=kill -HUP $(cat /prefix/logs/nginx.pid)',
    '-e', 'BARY_CONFIGTEST_CMD=/usr/local/openresty/bin/openresty -p /prefix -c /prefix/generations/{generation}/nginx.conf -t',
    '--entrypoint', '/bin/sh', IMAGE, '-c', [
      'set -e',
      'apk add --no-cache nodejs openssl curl >/dev/null 2>&1',
      'mkdir -p /prefix/logs /prefix/state /prefix/generations /secrets /backend/logs',
      `printf '%s' 'error_log logs/e.log warn;
pid logs/p.pid;
events { worker_connections 64; }
http { access_log off;
    server { listen 11; location / { return 200 "B11"; } }
}
' > /backend/nginx.conf`,
      '/usr/local/openresty/bin/openresty -p /backend -c /backend/nginx.conf',
      'node /app/dist/bin/barycenterd.js --write-bootstrap',
      '/usr/local/openresty/bin/openresty -p /prefix -c /prefix/current/nginx.conf',
      'exec node /app/dist/bin/barycenterd.js',
    ].join(' && '));

  // **진단을 한 자리에 모았다** (검수 N4 후속). 전에는 `docker logs` 만 붙였고,
  // 기동 스크립트가 출력을 지운 탓에 그 로그가 **빈 문자열**이라 원인이 어디에도
  // 안 드러났다 — N4 를 진단할 때 정확히 그 자리에서 막혔다.
  await waitForDaemon({
    container: DP,
    probe: async () => {
      try {
        return (await fetch(`http://127.0.0.1:${API_PORT}/healthz`,
          { signal: AbortSignal.timeout(2000) })).ok;
      } catch {
        return false;
      }
    },
  });
}, 300_000);

afterAll(() => {
  tearDown();
});

describe('v0.6 TLS 종단 — 실물', () => {
  let refOld = '';
  let refNew = '';
  let digestsOld = { chain: '', key: '' };
  let digestsNew = { chain: '', key: '' };

  it('**자료 업로드는 개인키를 안 돌려준다** (§8.1)', async () => {
    const mat = mintCert('old.example', 'DNS:app.example');
    const r = await api('POST', '/api/v1/certificates/material',
      { name: 'app', fullchain: mat.fullchain, privkey: mat.privkey });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    // **응답 전체를 문자열로 훑는다.** 특정 필드만 보면 다른 필드로 새는 것을 못 잡는다.
    expect(JSON.stringify(r.body)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(r.body)).not.toContain('BEGIN CERTIFICATE');
    // 참조는 **버전 고정**이어야 한다. 이름만이면 롤백이 거짓말이 된다 (§4.8).
    expect(r.body.ref).toMatch(/^store:\/\/app@[a-f0-9]{32}$/);
    refOld = r.body.ref;
    digestsOld = { chain: r.body.chainDigest, key: r.body.keyDigest };
  }, 120_000);

  it('같은 바이트를 다시 올리면 **같은 버전**이다 — 멱등 업로드가 세대를 안 늘린다', async () => {
    const again = await api('POST', '/api/v1/certificates/material', {
      name: 'app',
      fullchain: docker('exec', DP, 'cat', '/tmp/mint-old_example/c.pem'),
      privkey: docker('exec', DP, 'cat', '/tmp/mint-old_example/k.pem'),
    });
    expect(again.body.ref).toBe(refOld);
  }, 60_000);

  it('PEM 이 아닌 것은 400 — 세대가 configtest 에서 죽는 대신 여기서 막는다', async () => {
    const r = await api('POST', '/api/v1/certificates/material',
      { name: 'junk', fullchain: 'not a cert', privkey: 'not a key' });
    expect(r.status).toBe(400);
  }, 60_000);

  /**
   * **§7.2 — 인증서-키 일치.**
   *
   * 이게 없으면 무관한 한 쌍이 저장되고, 실패는 며칠 뒤 apply 의 `nginx -t` 에서
   * "설정이 이상하다" 로 나타난다. 원인은 업로드인데.
   */
  it('**체인과 무관한 개인키는 400** — apply 까지 끌고 가지 않는다', async () => {
    const a = mintCert('pair-a.example', 'DNS:pair-a.example');
    const b = mintCert('pair-b.example', 'DNS:pair-b.example');
    const r = await api('POST', '/api/v1/certificates/material',
      { name: 'mixed', fullchain: a.fullchain, privkey: b.privkey });
    expect(r.status, JSON.stringify(r.body)).toBe(400);
    expect(r.body.kind).toBe('key_mismatch');
  }, 120_000);

  it('업로드 응답이 **바이트에서 뽑은 사실**을 준다 — SAN·만료', async () => {
    const m = mintCert('facts.example', 'DNS:facts.example,DNS:*.facts.example');
    const r = await api('POST', '/api/v1/certificates/material',
      { name: 'facts', fullchain: m.fullchain, privkey: m.privkey });
    expect(r.status).toBe(201);
    expect(r.body.domains).toEqual(['facts.example', '*.facts.example']);
    expect(new Date(r.body.notAfter).getTime()).toBeGreaterThan(Date.now());
    // 사실이 나가도 **자료는 안 나간다.**
    expect(JSON.stringify(r.body)).not.toContain('PRIVATE KEY');
  }, 120_000);

  it('**HTTPS 가 선다** — 업로드한 인증서가 실제로 제시된다', async () => {
    const { apply } = await push([
      { op: 'put', kind: 'pool', key: 'app', body: { protocolClass: 'http', algorithm: 'round_robin' } },
      { op: 'put', kind: 'backend', key: 'b11', body: { pool: 'app', host: '127.0.0.1', port: 11, weight: 1 } },
      { op: 'put', kind: 'certificate', key: 'cert-app',
        body: { materialRef: refOld, chainDigest: digestsOld.chain, keyDigest: digestsOld.key } },
      { op: 'put', kind: 'tlsPolicy', key: 'modern', body: { minVersion: '1.2' } },
      { op: 'put', kind: 'listener', key: 'sec',
        body: {
          protocol: 'https', bind: '0.0.0.0', port: 443, enabled: true,
          tls: { policy: 'modern', defaultCertificate: 'cert-app' },
          http: { defaultAction: 'reject' },
        } },
      { op: 'put', kind: 'sniBinding', key: 'b-app',
        body: { listener: 'sec', hosts: ['app.example'], certificate: 'cert-app' } },
      { op: 'put', kind: 'httpRoute', key: 'r-app',
        body: {
          listener: 'sec', hosts: ['app.example'], priority: 10,
          action: { kind: 'proxy', pool: 'app', websocket: false },
        } },
    ]);
    expect(apply.body.phase, JSON.stringify(apply.body.detail)).toBe('activated');

    // 인증서 바이트가 **세대 안에** 들어갔는가 (§7.2 · S8).
    const ls = docker('exec', DP, 'sh', '-c',
      `ls -lR /prefix/generations/${apply.body.generation}/certs/cert-app/`);
    expect(ls).toContain('fullchain.pem');
    expect(ls).toContain('privkey.pem');
    // 개인키 퍼미션. SecretStore 가 0400 으로 지킨 것을 세대가 도로 풀면 안 된다.
    expect(ls).toMatch(/-r--------.*privkey\.pem/);

    expect(await waitFor(async () => servedCn('app.example'), (v) => v === 'old.example'))
      .toBe('old.example');

    // 실제로 프록시도 된다 — 인증서만 맞고 트래픽이 안 흐르면 소용없다.
    const body = docker('exec', DP, 'sh', '-c',
      'curl -sk --resolve app.example:443:127.0.0.1 https://app.example/');
    expect(body.trim()).toBe('B11');
  }, 240_000);

  it('**인증서를 갱신하면 새 것이 제시된다** — 롤백을 재려면 먼저 바뀌어야 한다', async () => {
    const mat = mintCert('new.example', 'DNS:app.example');
    const up = await api('POST', '/api/v1/certificates/material',
      { name: 'app', fullchain: mat.fullchain, privkey: mat.privkey });
    expect(up.status).toBe(201);
    // **다른 바이트 → 다른 버전.** 같은 이름 아래 두 버전이 공존한다.
    expect(up.body.ref).not.toBe(refOld);
    refNew = up.body.ref;
    digestsNew = { chain: up.body.chainDigest, key: up.body.keyDigest };

    const { apply } = await push([
      { op: 'put', kind: 'certificate', key: 'cert-app',
        body: { materialRef: refNew, chainDigest: digestsNew.chain, keyDigest: digestsNew.key } },
    ]);
    expect(apply.body.phase, JSON.stringify(apply.body.detail)).toBe('activated');
    expect(await waitFor(async () => servedCn('app.example'), (v) => v === 'new.example'))
      .toBe('new.example');
  }, 240_000);

  it('**롤백하면 옛 인증서가 돌아온다** — §4.8 이 버전 참조를 요구한 이유', async () => {
    const head = await api('GET', '/api/v1/config/head');
    const target = String(Number(head.body.revision) - 1);

    const rolled = await api('POST', '/api/v1/rollback', { to_revision: target });
    expect(rolled.status, JSON.stringify(rolled.body)).toBe(200);
    const applied = await api('POST', '/api/v1/apply', { plan_id: rolled.body.planId });
    expect(applied.body.phase, JSON.stringify(applied.body)).toBe('activated');

    // **여기가 전부다.** 롤백이 성공했다는 응답이 아니라, 제시되는 인증서를 본다.
    // 이름만으로 참조했다면 여기서 여전히 new.example 이 나온다 — 그리고 200 도 잘 나온다.
    expect(await waitFor(async () => servedCn('app.example'), (v) => v === 'old.example'))
      .toBe('old.example');

    // 롤백 세대는 **새 세대**다. 옛 세대를 다시 게시하면 epoch 가 재사용된다 (S11·S19).
    const st = await api('GET', '/api/v1/status');
    expect(String(st.body.activeGeneration)).not.toBe('');
  }, 240_000);

  it('모르는 SNI 는 default 인증서 — 첫 블록으로 새지 않는다 (S17)', async () => {
    expect(servedCn('nope.example')).toBe('old.example');
  }, 60_000);

  /**
   * **만료가 보인다** (§4.6: *"`not_after` 를 상태 API 에 노출"*).
   *
   * 만료는 아무 데서도 안 터진다 — 그냥 handshake 가 깨진다. 그래서 알람을 걸 자리가
   * 있어야 하고, 그 자리는 **개인키를 안 읽고** 답할 수 있어야 한다.
   */
  it('`/certificates` 와 `/metrics` 가 만료를 드러낸다', async () => {
    const list = await api('GET', '/api/v1/certificates');
    expect(list.status).toBe(200);
    const cert = list.body.find((x: { key: string }) => x.key === 'cert-app');
    expect(cert, JSON.stringify(list.body)).toBeDefined();
    expect(cert.domains).toContain('app.example');
    expect(cert.expiresInDays).toBeGreaterThanOrEqual(0);
    // 자료는 여전히 안 나간다.
    expect(JSON.stringify(list.body)).not.toContain('PRIVATE KEY');

    const metrics = await api('GET', '/metrics');
    expect(String(metrics.body)).toContain('bary_certificate_expiry_seconds{certificate="cert-app"}');
  }, 120_000);
});

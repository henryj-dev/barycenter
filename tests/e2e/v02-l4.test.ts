/**
 * **v0.2 L4** — tcp · udp · SNI 패스스루를 API 로 끝까지 몬다 (DESIGN.md §12.1, §4.1, §7.5)
 *
 * 모델도 검증기도 렌더러도 셋을 **이미 지원한다.** S1 이 세 서브시스템 전부에서 성립을
 * 증명했고 골든이 `nginx -t` 를 통과시킨다. 그런데 **REST 로 넣어서 실제 트래픽까지 가
 * 본 적이 없다** — v0.1 e2e 는 http 하나뿐이었다.
 *
 * "지원한다" 와 "돈다" 사이가 이 저장소가 반복해서 데인 자리다. v0.1 배선에서만 네 개의
 * 결함이 나왔고 전부 *한 번도 실행된 적 없는 경로*였다.
 *
 * ── 무엇을 재는가 ────────────────────────────────────────────────────────
 *
 *   tcp          :998 → TCP 백엔드 :12
 *   udp          :997 → UDP 백엔드 :13   (dns 프리셋 — `proxy_responses 1`)
 *   passthrough  :996 → SNI 로 갈린다. **TLS 를 종단하지 않는다** —
 *                       클라이언트가 백엔드의 인증서를 그대로 받는다
 *
 * 마지막이 핵심이다. 패스스루가 진짜인지는 **누구의 인증서가 오는가**로만 판정할 수
 * 있다. 응답 본문만 보면 종단해서 프록시해도 같은 답이 나온다.
 */
import { execFileSync } from 'node:child_process';
import { connect as netConnect } from 'node:net';
import { createSocket } from 'node:dgram';
import { connect as tlsConnect } from 'node:tls';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const NET = 'bary-v02-net';
const PG = 'bary-v02-pg';
const DP = 'bary-v02-dp';
// 다른 e2e 와 겹치면 안 된다 — vitest 는 파일을 동시에 돌린다.
const API_PORT = 18201;
const TCP_PORT = 18202;
const UDP_PORT = 18203;
const SNI_PORT = 18204;
const TOKEN = 'v02-test-token';

const docker = (...args: string[]): string =>
  execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

const quiet = (...args: string[]): void => {
  try {
    docker(...args);
  } catch {
    /* 없으면 그만 */
  }
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
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  try {
    return { status: r.status, body: JSON.parse(text) };
  } catch {
    return { status: r.status, body: text };
  }
}

const tokensEnv = (): string => JSON.stringify([{
  name: 'tester',
  hash: `sha256:${execFileSync('node', ['-e',
    `process.stdout.write(require('crypto').createHash('sha256').update('${TOKEN}').digest('hex'))`,
  ]).toString()}`,
  scopes: ['read', 'write', 'apply'],
}]);

// ── 프로브 ───────────────────────────────────────────────────────────────

/** 원시 TCP. 연결하고 서버가 먼저 말하는 것을 받는다. */
function probeTcp(port: number, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    const s = netConnect({ host: '127.0.0.1', port });
    const done = (v: string): void => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(timeoutMs, () => done('err:timeout'));
    s.on("data", (d: Buffer) => chunks.push(d));
    s.on('end', () => done(Buffer.concat(chunks).toString().trim()));
    s.on('close', () => done(Buffer.concat(chunks).toString().trim()));
    s.on('error', (e) => done(`err:${e.message}`));
  });
}

/** UDP 한 발. dns 프리셋은 `proxy_responses 1` 이라 한 번 답하고 세션을 닫는다. */
function probeUdp(port: number, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve) => {
    const s = createSocket('udp4');
    const timer = setTimeout(() => {
      s.close();
      resolve('err:timeout');
    }, timeoutMs);
    s.on('message', (msg) => {
      clearTimeout(timer);
      s.close();
      resolve(msg.toString().trim());
    });
    s.on('error', (e) => {
      clearTimeout(timer);
      s.close();
      resolve(`err:${e.message}`);
    });
    s.send(Buffer.from('ping'), port, '127.0.0.1');
  });
}

/**
 * SNI 를 붙여 TLS 로 붙고 **누구의 인증서가 오는지** 본다.
 *
 * 본문이 아니라 인증서를 보는 이유: 패스스루가 진짜인지는 이걸로만 갈린다.
 */
function probeSni(port: number, servername: string, timeoutMs = 6000): Promise<string> {
  return new Promise((resolve) => {
    const s = tlsConnect({
      host: '127.0.0.1', port, servername,
      rejectUnauthorized: false, timeout: timeoutMs,
    });
    const done = (v: string): void => {
      s.destroy();
      resolve(v);
    };
    s.on('secureConnect', () => {
      const cn = s.getPeerCertificate()?.subject?.CN ?? '(없음)';
      done(`cn=${cn}`);
    });
    s.on('timeout', () => done('err:timeout'));
    s.on('error', (e) => done(`err:${e.message}`));
  });
}

// ── 무대 ─────────────────────────────────────────────────────────────────

function tearDown(): void {
  quiet('rm', '-f', DP);
  quiet('rm', '-f', PG);
  quiet('network', 'rm', NET);
}

/**
 * 컨트롤 플레인이 **모르는** 백엔드 넷을 컨테이너 안에 띄운다.
 *
 * 우리가 렌더한 설정 안에 백엔드를 두면 "우리 설정이 우리 설정으로 프록시한다" 가 되어
 * 아무것도 증명하지 못한다.
 *
 * **stream 백엔드는 `return` 디렉티브로 답한다.** 처음엔 `content_by_lua_block` 에
 * `ngx.say` 를 썼는데 UDP 에서 죽는다:
 *
 *   [error] lua entry thread aborted: runtime error: API disabled in the current context
 *   [C]: in function 'say' ... udp client: 127.0.0.1, server: 0.0.0.0:13
 *
 * TCP 에서는 멀쩡하고 UDP 에서만 막히는 자리라, **UDP 를 실제로 쏴 보기 전까지는
 * 안 드러난다.** 이 테스트가 존재하는 이유의 축소판이다 — 다만 이건 우리 결함이 아니라
 * 테스트 무대의 결함이었고, 그래서 프로브가 처음 빨간 것은 좋은 신호였다.
 */
const BACKEND_SETUP = [
  'mkdir -p /backend/logs /backend/certs',
  // SNI 별로 **다른 인증서**를 쓴다. 패스스루 판정이 여기 걸린다.
  'for h in a b; do openssl req -x509 -newkey rsa:2048 -nodes -days 2'
    + ' -subj "/CN=$h.test" -addext "subjectAltName=DNS:$h.test"'
    + ' -keyout /backend/certs/$h.key -out /backend/certs/$h.crt >/dev/null 2>&1; done',
  `printf '%s' 'error_log logs/e.log warn;
pid logs/p.pid;
events { worker_connections 64; }
stream {
    server { listen 12;     return "TCP_B_12"; }
    server { listen 13 udp; return "UDP_B_13"; }
}
http {
    access_log off;
    server { listen 14 ssl; ssl_certificate certs/a.crt; ssl_certificate_key certs/a.key;
             return 200 "TLS_A"; }
    server { listen 15 ssl; ssl_certificate certs/b.crt; ssl_certificate_key certs/b.key;
             return 200 "TLS_B"; }
}
' > /backend/nginx.conf`,
  '/usr/local/openresty/bin/openresty -p /backend -c /backend/nginx.conf',
].join(' && ');

beforeAll(async () => {
  try {
    docker('version', '--format', '{{.Server.Version}}');
  } catch {
    throw new Error('도커가 없다 — L4 는 실물로만 잰다');
  }
  tearDown();
  docker('network', 'create', NET);
  docker('run', '-d', '--name', PG, '--network', NET,
    '-e', 'POSTGRES_PASSWORD=bary', '-e', 'POSTGRES_DB=bary', 'docker.io/library/postgres:17-alpine');

  docker('run', '-d', '--name', DP, '--network', NET,
    '-p', `${API_PORT}:8088`,
    '-p', `${TCP_PORT}:998`,
    '-p', `${UDP_PORT}:997/udp`,
    '-p', `${SNI_PORT}:996`,
    '-v', `${process.cwd()}:/app:ro`,
    '-e', `BARY_DSN=postgres://postgres:bary@${PG}:5432/bary`,
    '-e', 'BARY_PREFIX=/prefix',
    '-e', 'BARY_LISTEN=0.0.0.0:8088',
    '-e', `BARY_TOKENS=${tokensEnv()}`,
    '-e', 'BARY_RELOAD_CMD=kill -HUP $(cat /prefix/logs/nginx.pid)',
    '-e', 'BARY_CONFIGTEST_CMD=/usr/local/openresty/bin/openresty -p /prefix -c /prefix/generations/{generation}/nginx.conf -t',
    '--entrypoint', '/bin/sh', IMAGE, '-c', [
      'set -e',
      'apk add --no-cache nodejs openssl >/dev/null 2>&1',
      'mkdir -p /prefix/logs /prefix/state /prefix/generations',
      BACKEND_SETUP,
      // **부트스트랩도 데몬이 만든다.** 손으로 쓰면 멤버십 dict 와 admin 이 빠지고,
      // 그러면 §6.5-1 의 "HUP 전 staging" 이 쓸 곳을 못 찾는다 — 실제로 멤버십 평면을
      // 켜자 이 파일이 통째로 빨개졌다. 배포(`deploy/entrypoint.sh`)와 같은 방식이다.
      'node /app/dist/bin/barycenterd.js --write-bootstrap',
      '/usr/local/openresty/bin/openresty -p /prefix -c /prefix/current/nginx.conf',
      'exec node /app/dist/bin/barycenterd.js',
    ].join(' && '));

  const up = await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${API_PORT}/healthz`,
        { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      return false;
    }
  }, (ok) => ok, 120_000);
  if (!up) throw new Error(`데몬이 안 떴다:\n${docker('logs', '--tail', '40', DP)}`);
}, 300_000);

afterAll(() => {
  tearDown();
});

/** patch 한 장을 changeset → plan → commit → apply 로 민다. */
async function push(patch: unknown[]): Promise<ApiResult> {
  const head = await api('GET', '/api/v1/config/head');
  const cs = await api('POST', '/api/v1/changesets', { base_revision: head.body.revision });
  const patched = await api('PATCH', `/api/v1/changesets/${cs.body.id}`, { patch });
  if (patched.status !== 200) return patched;
  const plan = await api('POST', `/api/v1/changesets/${cs.body.id}/plan`);
  if (plan.status !== 200) return plan;
  const committed = await api('POST', `/api/v1/changesets/${cs.body.id}/commit`,
    { plan_id: plan.body.id });
  if (committed.status !== 200) return committed;
  return api('POST', '/api/v1/apply', { plan_id: plan.body.id });
}

describe('v0.2 L4 — API 로 끝까지', () => {
  it('**TCP 가 흐른다** — :998 → 백엔드 :12', async () => {
    const op = await push([
      { op: 'put', kind: 'pool', key: 'tcp-pool', body: { protocolClass: 'tcp', algorithm: 'round_robin' } },
      { op: 'put', kind: 'backend', key: 't-12', body: { pool: 'tcp-pool', host: '127.0.0.1', port: 12, weight: 1 } },
      {
        op: 'put', kind: 'listener', key: 'tcp-front',
        body: { protocol: 'tcp', bind: '0.0.0.0', port: 998, enabled: true, defaultPool: 'tcp-pool' },
      },
    ]);
    expect(op.body.phase, JSON.stringify(op.body.detail)).toBe('activated');
    // **`planes` 에 stream 이 들어가야 한다.** http 만 옮기면 stream 좌표가 옛 값으로 남는다.
    expect(await waitFor(() => probeTcp(TCP_PORT), (v) => v === 'TCP_B_12')).toBe('TCP_B_12');

    const st = await api('GET', '/api/v1/status');
    expect(st.body.planes.stream.activationEpoch).not.toBe('0');
  }, 180_000);

  it('**UDP 가 흐른다** — :997 → 백엔드 :13 (dns 프리셋)', async () => {
    const op = await push([
      { op: 'put', kind: 'pool', key: 'udp-pool', body: { protocolClass: 'udp', algorithm: 'round_robin' } },
      { op: 'put', kind: 'backend', key: 'u-13', body: { pool: 'udp-pool', host: '127.0.0.1', port: 13, weight: 1 } },
      {
        op: 'put', kind: 'listener', key: 'udp-front',
        body: {
          protocol: 'udp', bind: '0.0.0.0', port: 997, enabled: true,
          defaultPool: 'udp-pool', udp: { preset: 'dns' },
        },
      },
    ]);
    expect(op.body.phase, JSON.stringify(op.body.detail)).toBe('activated');
    expect(await waitFor(() => probeUdp(UDP_PORT), (v) => v === 'UDP_B_13')).toBe('UDP_B_13');
  }, 180_000);

  it('**SNI 패스스루가 갈린다 — 그리고 종단하지 않는다**', async () => {
    const op = await push([
      { op: 'put', kind: 'pool', key: 'tls-a', body: { protocolClass: 'tcp', algorithm: 'round_robin' } },
      { op: 'put', kind: 'pool', key: 'tls-b', body: { protocolClass: 'tcp', algorithm: 'round_robin' } },
      { op: 'put', kind: 'backend', key: 'ta-14', body: { pool: 'tls-a', host: '127.0.0.1', port: 14, weight: 1 } },
      { op: 'put', kind: 'backend', key: 'tb-15', body: { pool: 'tls-b', host: '127.0.0.1', port: 15, weight: 1 } },
      {
        op: 'put', kind: 'listener', key: 'sni-front',
        body: {
          protocol: 'tls_passthrough', bind: '0.0.0.0', port: 996, enabled: true,
          onUnmatchedSni: 'reject',
        },
      },
      {
        op: 'put', kind: 'passthroughRoute', key: 'to-a',
        body: { listener: 'sni-front', snis: ['a.test'], priority: 10, action: { kind: 'proxy', pool: 'tls-a' } },
      },
      {
        op: 'put', kind: 'passthroughRoute', key: 'to-b',
        body: { listener: 'sni-front', snis: ['b.test'], priority: 10, action: { kind: 'proxy', pool: 'tls-b' } },
      },
    ]);
    expect(op.body.phase, JSON.stringify(op.body.detail)).toBe('activated');

    // **인증서로 판정한다.** 본문만 보면 종단해서 프록시해도 같은 답이 나온다.
    // 백엔드의 인증서가 그대로 온다는 것이 "종단하지 않는다" 의 유일한 증거다.
    expect(await waitFor(() => probeSni(SNI_PORT, 'a.test'), (v) => v === 'cn=a.test'))
      .toBe('cn=a.test');
    expect(await waitFor(() => probeSni(SNI_PORT, 'b.test'), (v) => v === 'cn=b.test'))
      .toBe('cn=b.test');
  }, 180_000);

  it('**매칭 없는 SNI 는 거부된다** — 조용히 아무 데나 가지 않는다', async () => {
    // §4.1: 설정 가능한 폴백 풀로 보내면 SNI 를 안 보내는 클라이언트가 조용히 임의
    // 백엔드에 도달한다. 부재·파싱 실패는 **언제나** reject 다.
    const got = await probeSni(SNI_PORT, 'nope.test');
    expect(got).toMatch(/^err:/);
    // SNI 를 아예 안 보내도 마찬가지다.
    const noSni = await new Promise<string>((resolve) => {
      const s = tlsConnect({ host: '127.0.0.1', port: SNI_PORT, rejectUnauthorized: false, timeout: 5000 });
      s.on('secureConnect', () => { s.destroy(); resolve('연결됨'); });
      s.on('timeout', () => { s.destroy(); resolve('err:timeout'); });
      s.on('error', (e) => { s.destroy(); resolve(`err:${e.message}`); });
    });
    expect(noSni).toMatch(/^err:/);
  }, 60_000);

  it('세 프로토콜이 **한 세대에 공존한다** — 그리고 서로를 안 깬다', async () => {
    // 여기까지 셋을 따로 넣었다. 지금 head 에는 셋이 다 있다 — 마지막 apply 가 셋을
    // 함께 렌더했다는 뜻이고, 그게 깨지지 않았는지 한 번에 확인한다.
    const model = (await api('GET', '/api/v1/config/model')).body.model;
    expect(model.listeners.map((l: { key: string }) => l.key).sort())
      .toEqual(['sni-front', 'tcp-front', 'udp-front']);

    expect(await probeTcp(TCP_PORT)).toBe('TCP_B_12');
    expect(await probeUdp(UDP_PORT)).toBe('UDP_B_13');
    expect(await probeSni(SNI_PORT, 'a.test')).toBe('cn=a.test');
  }, 120_000);

  it('**소켓이 겹치면 plan 에서 막힌다** — HUP 실패 전에', async () => {
    // §5.4 가 `socket_changes` 를 내는 이유이고, 소켓 겹침 검증기가 있는 이유다.
    // 실물에서 겹치면 nginx 가 bind 에 실패하고 **HUP 이 조용히 옛 설정을 유지한다**
    // (S7 이 실측한 그 실패다). 저장 단계에서 막아야 한다.
    const head = await api('GET', '/api/v1/config/head');
    const cs = await api('POST', '/api/v1/changesets', { base_revision: head.body.revision });
    await api('PATCH', `/api/v1/changesets/${cs.body.id}`, {
      patch: [{
        op: 'put', kind: 'listener', key: 'clash',
        body: { protocol: 'tcp', bind: '0.0.0.0', port: 998, enabled: true, defaultPool: 'tcp-pool' },
      }],
    });
    const plan = await api('POST', `/api/v1/changesets/${cs.body.id}/plan`);
    expect(plan.status).toBe(422);

    // 그리고 트래픽은 그대로다 — 막힌 것이 아무것도 안 건드렸다.
    expect(await probeTcp(TCP_PORT)).toBe('TCP_B_12');
  }, 60_000);

  it('**udp 리스너를 tcp 풀에 붙이면 막힌다** — 서브시스템이 갈린다', async () => {
    const head = await api('GET', '/api/v1/config/head');
    const cs = await api('POST', '/api/v1/changesets', { base_revision: head.body.revision });
    await api('PATCH', `/api/v1/changesets/${cs.body.id}`, {
      patch: [{
        op: 'put', kind: 'listener', key: 'wrong-class',
        body: {
          protocol: 'udp', bind: '0.0.0.0', port: 995, enabled: true,
          defaultPool: 'tcp-pool', udp: { preset: 'dns' },
        },
      }],
    });
    // DB 의 복합 FK 가 문다 — 렌더러까지 가지 않는다.
    const plan = await api('POST', `/api/v1/changesets/${cs.body.id}/plan`);
    expect(plan.status).toBe(422);
  }, 60_000);
});

/**
 * **엔진 capability 가 저장 단계의 판정을 바꾼다** (DESIGN.md §7.6 · E0 · E63)
 *
 * E0 이 실증한 것: 우리가 필요한 두 모듈이 **서로 다른 이미지 계열에 나뉘어 있다.**
 *
 *   공식 nginx  : `stream_realip` ✅ / `ngx_stream_lua` ❌
 *   OpenResty   : `stream_realip` ❌ / `ngx_stream_lua` ✅
 *
 * 그래서 목록을 하드코딩하면 어떤 이미지를 골라도 "설계 위반" 이 된다 — 대신 엔진에게
 * 물어보고 모델이 표현 가능한 것을 거기 맞춰 좁힌다. 그게 §7.6 의 답이었다.
 *
 * **그런데 물어보지 않고 있었다.** 컨트롤 플레인이 `streamRealip: false` 를 상수로
 * 가정했고, PROXY 신뢰 경계를 넣은 뒤로 **stream PROXY 수신이 엔진과 무관하게 항상
 * 막혔다.** capability 로 좁힌다면서 capability 를 안 물어본 셈이다.
 *
 * 이 파일은 **모듈이 있는 엔진**으로 그 배선을 관측한다. 기본 이미지(OpenResty)로는
 * 관측이 안 된다 — 거기서는 조회 결과가 보수적 기본값과 같아서, 배선을 통째로 빼도
 * 아무 테스트가 안 깨진다. 실제로 변이 검사에서 그걸 확인하고 이 파일을 만들었다.
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/** **공식 nginx 다.** 여기에는 `stream_realip` 이 있고 lua 는 없다. */
const IMAGE = process.env['BARY_NGINX_IMAGE'] ?? 'nginx:alpine';
const NET = 'bary-cap-net';
const PG = 'bary-cap-pg';
const DP = 'bary-cap-dp';
const API_PORT = 18301;
const TOKEN = 'cap-test-token';

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

async function waitFor<T>(probe: () => Promise<T>, ok: (v: T) => boolean, budgetMs = 120_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last = await probe();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(500);
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

function tearDown(): void {
  quiet('rm', '-f', DP);
  quiet('rm', '-f', PG);
  quiet('network', 'rm', NET);
}

beforeAll(async () => {
  try {
    docker('version', '--format', '{{.Server.Version}}');
  } catch {
    throw new Error('도커가 없다 — capability 는 실물 엔진으로만 잰다');
  }
  tearDown();
  docker('network', 'create', NET);
  docker('run', '-d', '--name', PG, '--network', NET,
    '-e', 'POSTGRES_PASSWORD=bary', '-e', 'POSTGRES_DB=bary', 'postgres:17-alpine');

  const hash = execFileSync('node', ['-e',
    `process.stdout.write(require('crypto').createHash('sha256').update('${TOKEN}').digest('hex'))`,
  ]).toString();

  docker('run', '-d', '--name', DP, '--network', NET,
    '-p', `${API_PORT}:8088`,
    '-v', `${process.cwd()}:/app:ro`,
    '-e', `BARY_DSN=postgres://postgres:bary@${PG}:5432/bary`,
    '-e', 'BARY_PREFIX=/prefix',
    '-e', 'BARY_LISTEN=0.0.0.0:8088',
    '-e', 'BARY_ADMIN_PORT=19999',
    // **여기가 요점이다** — 조회할 실행 파일이 공식 nginx 다.
    '-e', 'BARY_ENGINE_BIN=/usr/sbin/nginx',
    '-e', `BARY_TOKENS=[{"name":"tester","hash":"sha256:${hash}","scopes":["read","write","apply"]}]`,
    '-e', 'BARY_RELOAD_CMD=kill -HUP $(cat /prefix/logs/nginx.pid)',
    '--entrypoint', '/bin/sh', IMAGE, '-c', [
      'set -e',
      'apk add --no-cache nodejs >/dev/null 2>&1',
      'mkdir -p /prefix/logs /prefix/state /prefix/generations/bootstrap/admin /backend/logs',
      `printf '%s' 'error_log logs/e.log warn;
pid logs/p.pid;
events { worker_connections 64; }
stream { server { listen 12; return "TCP_B_12"; } }
' > /backend/nginx.conf`,
      'nginx -p /backend -c /backend/nginx.conf',
      `printf '%s' 'error_log logs/error.log warn;
pid logs/nginx.pid;
events { worker_connections 64; }
http { access_log off; include admin/*.conf; }
' > /prefix/generations/bootstrap/nginx.conf`,
      'ln -sfn generations/bootstrap /prefix/current',
      'nginx -p /prefix -c /prefix/current/nginx.conf',
      'exec node /app/dist/bin/barycenterd.js',
    ].join(' && '));

  const up = await waitFor(async () => {
    try {
      return (await fetch(`http://127.0.0.1:${API_PORT}/healthz`,
        { signal: AbortSignal.timeout(2000) })).ok;
    } catch {
      return false;
    }
  }, (ok) => ok);
  if (!up) throw new Error(`데몬이 안 떴다:\n${docker('logs', '--tail', '40', DP)}`);
}, 300_000);

afterAll(() => {
  tearDown();
});

describe('capability 가 판정을 바꾼다 (§7.6)', () => {
  it('**공식 nginx 에는 `stream_realip` 이 있다** — 그리고 조회가 그걸 읽는다', () => {
    return api('GET', '/api/v1/status').then((st) => {
      expect(st.body.engine.probed).toBe(true);
      expect(st.body.engine.flavor).toBe('nginx');
      // E0 이 말한 분리가 여기서 보인다: 이쪽은 realip 이 있고 lua 가 없다.
      expect(st.body.engine.supports.streamRealip).toBe(true);
      expect(st.body.engine.supports.streamLua).toBe(false);
    });
  });

  it('**모듈이 있으면 stream PROXY 수신이 통과한다** — 기본 이미지에서는 막히는 것이', async () => {
    // 이 한 건이 배선의 유일한 관측점이다. 데몬이 조회 결과를 `ConfigStore` 로 안 넘기면
    // 보수적 기본값(`false`)이 쓰여 여기서 422 가 난다.
    const head = await api('GET', '/api/v1/config/head');
    const cs = await api('POST', '/api/v1/changesets', { base_revision: head.body.revision });
    await api('PATCH', `/api/v1/changesets/${cs.body.id}`, {
      patch: [
        { op: 'put', kind: 'pool', key: 'tcp-app', body: { protocolClass: 'tcp', algorithm: 'source_ip_hash' } },
        { op: 'put', kind: 'backend', key: 't-12', body: { pool: 'tcp-app', host: '127.0.0.1', port: 12, weight: 1 } },
        {
          op: 'put', kind: 'listener', key: 'edge',
          body: {
            protocol: 'tcp', bind: '0.0.0.0', port: 998, enabled: true,
            defaultPool: 'tcp-app',
            acceptProxyProtocol: { trustedCidrs: ['10.0.0.0/8'] },
          },
        },
      ],
    });
    const plan = await api('POST', `/api/v1/changesets/${cs.body.id}/plan`);
    expect(plan.status, JSON.stringify(plan.body)).toBe(200);

    // 그리고 실제로 활성화된다 — 렌더된 `set_real_ip_from` 을 이 엔진이 받아들인다.
    const committed = await api('POST', `/api/v1/changesets/${cs.body.id}/commit`,
      { plan_id: plan.body.id });
    expect(committed.status).toBe(200);
    const op = await api('POST', '/api/v1/apply', { plan_id: plan.body.id });
    expect(op.body.phase, JSON.stringify(op.body.detail)).toBe('activated');

    // 신뢰 경계가 산출물에 실제로 들어 있다.
    const rendered = await api('GET', '/api/v1/config/rendered');
    expect(rendered.body.conf).toContain('set_real_ip_from 10.0.0.0/8;');
    // **`real_ip_header` 는 여기 없어야 한다** — http 전용 디렉티브다. stream 에 넣으면
    // `"real_ip_header" directive is not allowed here` 로 기동이 깨진다. 처음엔 양쪽에
    // 똑같이 냈고 이 테스트가 잡았다(정확히는 이 테스트의 apply 가 failed 로 떨어졌다).
    // stream 에서는 PROXY 가 유일한 출처라 선언할 것이 없다 (E63.5).
    expect(rendered.body.conf).not.toContain('real_ip_header');
    // 그리고 게이팅되지 않는 변수는 안 쓴다 (E63.1·E63.3).
    expect(rendered.body.conf).not.toContain('$proxy_protocol_addr');
    expect(rendered.body.conf).toContain('hash $remote_addr consistent;');
  }, 180_000);
});

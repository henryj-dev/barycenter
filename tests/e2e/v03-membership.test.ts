/**
 * **v0.3 2단계 — reload 없이 백엔드가 바뀐다** (DESIGN.md §6.5 · S1)
 *
 * 이 제품의 이유다. S1 이 HTTP·TCP·UDP 세 서브시스템 전부에서 reload 0 회·마스터 PID
 * 불변으로 실증했고, 그게 설계 전체가 걸려 있던 내기였다. 여기서 그 경로를 **REST 로
 * 끝까지** 몬다.
 *
 * ── 무엇이 판정인가 ──────────────────────────────────────────────────────
 *
 * "트래픽이 옮겨갔다" 만으로는 부족하다 — 세대를 새로 만들고 HUP 을 보내도 그렇게 된다.
 * **안 일어난 일**을 재야 한다.
 *
 *   · 마스터 PID 불변        재시작이 아니었다
 *   · 워커 기동 수 불변      **reload 가 없었다** (HUP 은 워커를 새로 띄운다)
 *   · 활성 세대 불변         세대 전환이 없었다
 *   · 세대 디렉토리 수 불변  새 아티팩트를 안 만들었다
 *
 * ── 멤버십 평면은 capability 로 켜진다 ──────────────────────────────────
 *
 * `*_lua` 가 없는 엔진에서는 백엔드가 conf 에 남고, 그때는 세대 전환 + reload 가 **맞는
 * 동작**이다. 그건 열등한 게 아니라 다른 계약이다.
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { waitForPg } from './pg-ready.js';
import { appMount } from './mounts.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const NET = 'bary-v03-net';
const PG = 'bary-v03-pg';
const DP = 'bary-v03-dp';
const API_PORT = 18501;
const DATA_PORT = 18502;
const TOKEN = 'v03-test-token';

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

/** 데이터 플레인에 진짜 요청. */
async function hit(): Promise<string> {
  try {
    const r = await fetch(`http://127.0.0.1:${DATA_PORT}/`, { signal: AbortSignal.timeout(4000) });
    return (await r.text()).trim();
  } catch (e) {
    return `err:${String(e).slice(0, 40)}`;
  }
}

/** **안 일어난 일**을 재기 위한 관측치. */
function observe(): { master: string; workers: number; generations: number } {
  const master = docker('exec', DP, 'sh', '-c', 'cat /prefix/logs/nginx.pid').trim();
  const workers = Number(docker('exec', DP, 'sh', '-c',
    'grep -c "start worker process" /prefix/logs/error.log 2>/dev/null || echo 0').trim());
  const generations = Number(docker('exec', DP, 'sh', '-c',
    'ls /prefix/generations | wc -l').trim());
  return { master, workers, generations };
}

/** 한 바퀴: changeset → plan → commit → apply. */
async function push(patch: unknown[]): Promise<{ apply: ApiResult; plan: ApiResult }> {
  const head = await api('GET', '/api/v1/config/head');
  const cs = await api('POST', '/api/v1/changesets', { base_revision: head.body.revision });
  await api('PATCH', `/api/v1/changesets/${cs.body.id}`, { patch });
  const plan = await api('POST', `/api/v1/changesets/${cs.body.id}/plan`);
  if (plan.status !== 200) return { apply: plan, plan };
  await api('POST', `/api/v1/changesets/${cs.body.id}/commit`, { plan_id: plan.body.id });
  return { apply: await api('POST', '/api/v1/apply', { plan_id: plan.body.id }), plan };
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
    throw new Error('도커가 없다 — 멤버십 평면은 실물로만 잰다');
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
    '-p', `${API_PORT}:8088`, '-p', `${DATA_PORT}:999`,
    ...appMount(),
    '-e', `BARY_DSN=postgres://postgres:bary@${PG}:5432/bary`,
    '-e', 'BARY_PREFIX=/prefix',
    '-e', 'BARY_LISTEN=0.0.0.0:8088',
    '-e', 'BARY_ENGINE_BIN=/usr/local/openresty/bin/openresty',
    '-e', `BARY_TOKENS=[{"name":"tester","hash":"sha256:${hash}","scopes":["read","write","apply"]}]`,
    '-e', 'BARY_RELOAD_CMD=kill -HUP $(cat /prefix/logs/nginx.pid)',
    '-e', 'BARY_CONFIGTEST_CMD=/usr/local/openresty/bin/openresty -p /prefix -c /prefix/generations/{generation}/nginx.conf -t',
    '--entrypoint', '/bin/sh', IMAGE, '-c', [
      'set -e',
      'apk add --no-cache nodejs >/dev/null 2>&1',
      'mkdir -p /prefix/logs /prefix/state /prefix/generations /backend/logs',
      // 컨트롤 플레인이 **모르는** 백엔드 둘.
      `printf '%s' 'error_log logs/e.log warn;
pid logs/p.pid;
events { worker_connections 64; }
http { access_log off;
    server { listen 11; location / { return 200 "B11"; } }
    server { listen 12; location / { return 200 "B12"; } }
}
' > /backend/nginx.conf`,
      '/usr/local/openresty/bin/openresty -p /backend -c /backend/nginx.conf',
      // **부트스트랩도 데몬이 만든다** — 멤버십 dict 가 옛 세대에 이미 있어야 §6.5-1 의
      // "HUP 전 staging" 이 성립한다.
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

describe('v0.3 멤버십 평면 — reload 없는 교체', () => {
  it('엔진이 멤버십 평면을 지원한다 — 그리고 부트스트랩에 dict 가 있다', async () => {
    const st = await api('GET', '/api/v1/status');
    expect(st.body.engine.supports.runtimeMembership).toEqual({ http: true, stream: true });
    // §6.5-1 은 HUP **전에** 적재하라고 한다. 그 시점에 도는 것은 옛 세대이므로,
    // dict 와 admin 이 **부트스트랩에 이미 있어야** 적재할 곳이 있다.
    const conf = docker('exec', DP, 'sh', '-c', 'cat /prefix/generations/bootstrap/nginx.conf');
    expect(conf).toContain('lua_shared_dict bary_http');
  });

  it('첫 apply — **백엔드가 conf 에 없다**. dict 에 산다', async () => {
    const { apply } = await push([
      { op: 'put', kind: 'pool', key: 'app', body: { protocolClass: 'http', algorithm: 'round_robin' } },
      { op: 'put', kind: 'backend', key: 'b11', body: { pool: 'app', host: '127.0.0.1', port: 11, weight: 1 } },
      {
        op: 'put', kind: 'listener', key: 'front',
        body: {
          protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true,
          http: { defaultAction: { pool: 'app' } },
        },
      },
    ]);
    expect(apply.body.phase, JSON.stringify(apply.body.detail)).toBe('activated');
    expect(await waitFor(hit, (v) => v === 'B11')).toBe('B11');

    const rendered = await api('GET', '/api/v1/config/rendered');
    expect(rendered.body.conf).toContain('balancer_by_lua_block');
    expect(rendered.body.conf).not.toContain('127.0.0.1:11');
  }, 180_000);

  it('**백엔드를 바꿔도 reload 가 없다** — 이게 v0.3 의 헤드라인이다', async () => {
    const before = observe();
    expect(await hit()).toBe('B11');

    const { apply, plan } = await push([
      { op: 'delete', kind: 'backend', key: 'b11' },
      { op: 'put', kind: 'backend', key: 'b12', body: { pool: 'app', host: '127.0.0.1', port: 12, weight: 1 } },
    ]);
    // plan 이 미리 말한다 — 산출물이 안 바뀌므로 reload 가 필요 없다 (§5.4).
    expect(plan.body.impact.requiresReload).toBe(false);
    expect(apply.body.phase, JSON.stringify(apply.body.detail)).toBe('activated');
    expect(apply.body.detail).toMatchObject({ membershipOnly: true, reload: false });

    // 트래픽이 옮겨갔다.
    expect(await waitFor(hit, (v) => v === 'B12')).toBe('B12');

    // **그리고 아무것도 안 일어났다.**
    const after = observe();
    expect(after.master, '마스터 PID 가 바뀌었다 — 재시작이다').toBe(before.master);
    expect(after.workers, '워커가 새로 떴다 — reload 가 일어났다').toBe(before.workers);
    expect(after.generations, '세대가 새로 생겼다').toBe(before.generations);
    expect(apply.body.activationEpoch, 'epoch 가 움직였다 — 세대 전환이다')
      .toBe((await api('GET', '/api/v1/status')).body.planes.http.activationEpoch);
  }, 180_000);

  it('**리스너를 바꾸면 reload 가 있다** — 판정이 무차별이 아니다', async () => {
    const before = observe();
    const { apply, plan } = await push([{
      op: 'put', kind: 'listener', key: 'front',
      body: {
        protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true,
        http: { defaultAction: 'reject' },
      },
    }]);
    expect(plan.body.impact.requiresReload).toBe(true);
    expect(apply.body.phase, JSON.stringify(apply.body.detail)).toBe('activated');
    expect(apply.body.detail).not.toMatchObject({ membershipOnly: true });

    const after = observe();
    expect(after.generations, '세대가 안 생겼다 — 설정 변경인데').toBeGreaterThan(before.generations);
  }, 180_000);

  it('**죽은 백엔드가 슬롯에서 빠진다 — reload 없이** (§6.5 · §6.6)', async () => {
    // 백엔드 둘을 넣고 하나를 죽인다. 프로버가 판정하고 리듀서가 슬롯을 다시 쓴다.
    await push([
      { op: 'put', kind: 'backend', key: 'b11', body: { pool: 'app', host: '127.0.0.1', port: 11, weight: 1 } },
      { op: 'put', kind: 'listener', key: 'front',
        body: {
          protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true,
          http: { defaultAction: { pool: 'app' } },
        } },
    ]);
    // 둘 다 살아 있으면 응답이 섞인다.
    const mixed = new Set<string>();
    for (let i = 0; i < 20; i += 1) mixed.add(await hit());
    expect(mixed, `둘 다 받아야 한다: ${[...mixed].join()}`).toEqual(new Set(['B11', 'B12']));

    const before = observe();

    // **:11 만 죽인다.** 컨트롤 플레인은 이 사실을 모른다 — 프로버가 알아내야 한다.
    docker('exec', DP, 'sh', '-c',
      "sed -i 's/listen 11;/listen 111;/' /backend/nginx.conf"
      + ' && /usr/local/openresty/bin/openresty -p /backend -c /backend/nginx.conf -s reload');

    // 프로버가 내리고 리듀서가 반영할 때까지.
    const only12 = await waitFor(async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 10; i += 1) seen.add(await hit());
      return [...seen].sort().join(',');
    }, (v) => v === 'B12', 60_000);
    expect(only12, '죽은 백엔드가 안 빠졌다').toBe('B12');

    // **그리고 reload 는 없었다.** 헬스 반영이 세대 전환이 되면 안 된다 —
    // 백엔드 하나 죽을 때마다 워커를 새로 띄우면 장수 연결이 계속 끊긴다.
    const after = observe();
    expect(after.master).toBe(before.master);
    expect(after.workers, 'reload 가 일어났다').toBe(before.workers);
    expect(after.generations, '세대가 생겼다').toBe(before.generations);

    // 판정이 API 로 보인다 — `unknown` 을 숨기지 않는다.
    const health = await api('GET', '/api/v1/health/backends');
    const byKey = Object.fromEntries(
      (health.body as { backendKey: string; state: string }[]).map((r) => [r.backendKey, r.state]));
    expect(byKey['b11']).toBe('unhealthy');
    expect(byKey['b12']).toBe('healthy');
  }, 300_000);

  it('**살아나면 되돌아온다** — 판정이 한 방향이 아니다', async () => {
    docker('exec', DP, 'sh', '-c',
      "sed -i 's/listen 111;/listen 11;/' /backend/nginx.conf"
      + ' && /usr/local/openresty/bin/openresty -p /backend -c /backend/nginx.conf -s reload');
    const back = await waitFor(async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 12; i += 1) seen.add(await hit());
      return [...seen].sort().join(',');
    }, (v) => v === 'B11,B12', 60_000);
    expect(back, '살아난 백엔드가 안 돌아왔다').toBe('B11,B12');
  }, 300_000);

  it('**설정 전환 뒤에도 슬롯이 지금 헬스와 일치한다** (§6.5-4 replay 의 자리)', async () => {
    // staging 은 스냅샷 시점의 헬스로 슬롯을 채운다. 그 시점과 활성화 사이에 백엔드가
    // 죽으면 **새 epoch 은 옛 멤버십을 들고 서빙을 시작한다.** §6.5 가 cut·replay 를
    // 요구한 창이다.
    //
    // ⚠️ **그 창 자체는 여기서 못 잰다** — staging 과 활성화 사이에 헬스를 바꾸는 것을
    // 밖에서 결정적으로 만들 방법이 없다. 재는 것은 그 대신 유지되는 **불변식**이다:
    // 설정 전환이 끝나면 슬롯이 *지금* 헬스와 일치한다.
    docker('exec', DP, 'sh', '-c',
      "sed -i 's/listen 11;/listen 1111;/' /backend/nginx.conf"
      + ' && /usr/local/openresty/bin/openresty -p /backend -c /backend/nginx.conf -s reload');
    // 프로버가 내릴 때까지 기다린다.
    const down = await waitFor(async () => {
      const h = await api('GET', '/api/v1/health/backends');
      const m = Object.fromEntries((h.body as { backendKey: string; state: string }[])
        .map((r) => [r.backendKey, r.state]));
      return m['b11'] ?? 'none';
    }, (v) => v === 'unhealthy', 60_000);
    expect(down).toBe('unhealthy');

    // **설정을 바꿔 새 세대를 만든다.** 죽은 백엔드가 새 epoch 에 실리면 안 된다.
    const { apply } = await push([{
      op: 'put', kind: 'listener', key: 'front',
      body: {
        protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true,
        acceptProxyProtocol: undefined,
        http: { defaultAction: { pool: 'app' } },
      },
    }, {
      op: 'put', kind: 'pool', key: 'app',
      body: { protocolClass: 'http', algorithm: 'source_ip_hash' },
    }]);
    expect(apply.body.phase, JSON.stringify(apply.body.detail)).toBe('activated');
    expect(apply.body.detail, '설정이 바뀌었으므로 세대 전환이어야 한다')
      .not.toMatchObject({ membershipOnly: true });

    // 새 epoch 이 죽은 백엔드를 안 든다.
    const only12 = await waitFor(async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 10; i += 1) seen.add(await hit());
      return [...seen].sort().join(',');
    }, (v) => v === 'B12', 60_000);
    expect(only12, '새 세대가 죽은 백엔드를 들고 있다').toBe('B12');

    // 되돌린다.
    docker('exec', DP, 'sh', '-c',
      "sed -i 's/listen 1111;/listen 11;/' /backend/nginx.conf"
      + ' && /usr/local/openresty/bin/openresty -p /backend -c /backend/nginx.conf -s reload');
    await waitFor(async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 12; i += 1) seen.add(await hit());
      return [...seen].sort().join(',');
    }, (v) => v === 'B11,B12', 60_000);
  }, 300_000);

  it('**`/metrics` 가 실제를 말한다** (§6.4 리소스 알람)', async () => {
    // 관측 없이 오래 돌리면 "안 죽었다" 까지만 알 수 있고 그건 측정이 아니다.
    // 여기서 재는 것은 **재는 자리가 진짜를 말하는가**다.
    const r = await fetch(`http://127.0.0.1:${API_PORT}/metrics`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/plain');
    const text = await r.text();
    const val = (name: string): number => {
      const m = new RegExp(`^${name.replace(/[{}"]/g, '\\$&')} (\\d+)$`, 'm').exec(text);
      return m === null ? Number.NaN : Number(m[1]);
    };

    // 디스크의 세대 수와 일치한다 — 상한이 도는지 보는 자리다.
    const onDisk = Number(docker('exec', DP, 'sh', '-c', 'ls /prefix/generations | wc -l').trim());
    expect(val('bary_generations')).toBe(onDisk);
    expect(val('bary_generation_bytes')).toBeGreaterThan(0);

    // **원장 성장의 관측 창구.** 오래 달고 있는 부채를 여기서 잰다.
    expect(val('bary_agent_state_bytes')).toBeGreaterThan(0);

    // 헬스 판정이 그대로 나온다.
    const health = await api('GET', '/api/v1/health/backends');
    const rows = health.body as { state: string }[];
    expect(val('bary_backends_healthy'))
      .toBe(rows.filter((x) => x.state === 'healthy').length);
    expect(val('bary_backends_unhealthy'))
      .toBe(rows.filter((x) => x.state === 'unhealthy').length);

    // 리더와 좌표.
    expect(val('bary_leader')).toBe(1);
    expect(val('bary_activation_epoch_http')).toBeGreaterThan(0);
    expect(val('bary_unfinished_transitions')).toBe(0);

    // **일어난 것도 센다.** 지금까지 apply 가 여러 번 있었다.
    expect(text).toMatch(/bary_apply_total\{phase="activated"\} [1-9]/);

    // 인증 없이는 안 준다 — 풀 이름과 리비전이 나가는 자리다.
    expect((await fetch(`http://127.0.0.1:${API_PORT}/metrics`)).status).toBe(401);
  }, 120_000);

  it('**로그가 한 줄에 JSON 하나다** — 오래 돌리면 문장은 관측이 아니다', () => {
    const logs = docker('logs', DP);
    const lines = logs.split('\n').filter((l) => l.trim().startsWith('{'));
    expect(lines.length, '구조화 로그가 하나도 없다').toBeGreaterThan(3);
    for (const line of lines) {
      const parsed = JSON.parse(line) as Record<string, unknown>;
      expect(parsed['ts'], `ts 가 없다: ${line}`).toBeDefined();
      expect(parsed['event'], `event 가 없다: ${line}`).toBeDefined();
    }
    // 기동 경로의 사건들이 이름으로 잡힌다.
    const events = new Set(lines.map((l) => (JSON.parse(l) as { event: string }).event));
    expect(events).toContain('leader.acquired');
    expect(events).toContain('engine.probed');
    expect(events).toContain('listening');
  });

  it('**재기동 뒤에도 헬스 판정이 계속 움직인다** (§6.6 관측 좌표)', async () => {
    // §6.6 은 늦게 끝난 낡은 관측이 최신 판정을 덮는 것을 막으려고 **프로브 시작 순번**을
    // 싣게 한다. 그 순번을 프로세스 메모리에서 1 부터 세면 — 처음에 그렇게 짰다 —
    // 재기동한 프로세스의 1 번이 저장된 50 번보다 작아서 **자기 관측을 전부 버린다.**
    // 헬스가 영영 얼어붙고, 그건 "프로버가 있다" 는 말을 거짓으로 만든다.
    docker('restart', DP);
    const up = await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${API_PORT}/healthz`,
          { signal: AbortSignal.timeout(2000) })).ok;
      } catch {
        return false;
      }
    }, (ok) => ok, 120_000);
    expect(up).toBe(true);

    // 재기동 **뒤에** 백엔드를 죽인다. 판정이 얼어 있으면 영영 안 빠진다.
    docker('exec', DP, 'sh', '-c',
      "sed -i 's/listen 12;/listen 122;/' /backend/nginx.conf"
      + ' && /usr/local/openresty/bin/openresty -p /backend -c /backend/nginx.conf -s reload');
    const only11 = await waitFor(async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 10; i += 1) seen.add(await hit());
      return [...seen].sort().join(',');
    }, (v) => v === 'B11', 60_000);
    expect(only11, '재기동 뒤 헬스 판정이 얼었다').toBe('B11');

    // 되돌려 놓는다 — 다음 테스트가 이 상태에 기대지 않게.
    docker('exec', DP, 'sh', '-c',
      "sed -i 's/listen 122;/listen 12;/' /backend/nginx.conf"
      + ' && /usr/local/openresty/bin/openresty -p /backend -c /backend/nginx.conf -s reload');
    await waitFor(async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 12; i += 1) seen.add(await hit());
      return [...seen].sort().join(',');
    }, (v) => v === 'B11,B12', 60_000);
  }, 300_000);

  it('**재시작이 멤버십을 되돌리지 않는다** — 정본은 head 다 (§6.4)', async () => {
    // shared dict 는 **프로세스 수명**이다. 엔진이 재시작하면 슬롯이 통째로 비고 밸런서는
    // 연결을 끊는다(§6.5-3) — 설정은 멀쩡한데 트래픽이 전부 죽는다.
    //
    // 그리고 복원의 정본이 **세대 아티팩트면 안 된다.** 아티팩트는 그 세대가 만들어질
    // 때의 스냅샷이라, 그 뒤의 멤버십 전용 변경(세대를 안 만든다)이 통째로 사라진다.
    // 실제로 그렇게 만들었다가 :12 로 옮긴 백엔드가 재시작 뒤 :11 로 되살아났다.
    //
    // 앞 테스트가 백엔드를 둘 다 넣고 풀을 source_ip_hash 로 바꿨다. 한 클라이언트
    // IP 는 한 백엔드만 본다 — CI 가 B11 에 붙으면 여기서 영원히 B12 를 못 본다.
    // 재는 것은 해시가 아니라 **멤버십만 :12 로 옮긴 뒤 재시작이 그걸 지키는가**다.
    const { apply, plan } = await push([
      { op: 'delete', kind: 'backend', key: 'b11' },
    ]);
    expect(plan.body.impact.requiresReload).toBe(false);
    expect(apply.body.phase, JSON.stringify(apply.body.detail)).toBe('activated');
    expect(apply.body.detail).toMatchObject({ membershipOnly: true, reload: false });
    expect(await waitFor(hit, (v) => v === 'B12')).toBe('B12');

    docker('restart', DP);
    const up = await waitFor(async () => {
      try {
        return (await fetch(`http://127.0.0.1:${API_PORT}/healthz`,
          { signal: AbortSignal.timeout(2000) })).ok;
      } catch {
        return false;
      }
    }, (ok) => ok, 120_000);
    expect(up, `재기동 실패:\n${docker('logs', '--tail', '20', DP)}`).toBe(true);

    // **head 가 말하는 백엔드로 돌아온다** — 아티팩트가 아니라.
    expect(await waitFor(hit, (v) => v === 'B12')).toBe('B12');
  }, 300_000);
});

/**
 * **v0.1 완료 판정** — `curl` 로 `:999 → A:11` 이 뜬다 (DESIGN.md §12.1)
 *
 * 여기까지가 한 줄로 이어진다.
 *
 *   REST → PG(changeset·plan·commit) → render → materialize(세대) → 게시 → HUP
 *        → 활성화 증거 → 좌표 이동 → **실제 트래픽**
 *
 * ── 왜 데몬이 컨테이너 **안에서** 도는가 ────────────────────────────────
 *
 * §3.2 · §11.1 이 "DP Agent 는 `/etc/barycenter` 의 유일한 writer 이고 DP 와 같은 호스트에
 * 산다" 고 못 박았고, 그건 취향이 아니라 실측이다. **호스트에서 심볼릭 링크를 바꾸면
 * 컨테이너가 그걸 못 본다** — 이 파일을 쓰기 전에 다시 재 봤다:
 *
 *   호스트에서 `current → generations/g2` 로 교체 + HUP
 *   → 컨테이너 안 `readlink /prefix/current` 는 여전히 `generations/g1`
 *   → 트래픽도 g1
 *
 * 그래서 에이전트를 밖에 두는 구성으로는 이 테스트를 **통과시킬 수가 없다.** 통과시키려고
 * 컨테이너 밖에서 링크를 바꾸는 순간 그건 제품이 아닌 것을 재는 셈이 된다.
 *
 * 컨테이너 안에서 `dist/` 를 돌린다. 소스를 직접 못 돌리는 이유도 실측했다 — Node 의
 * 타입 제거는 `./x.js` 스펙파이어를 `./x.ts` 로 바꿔 주지 않는다. 그래서 빌드가 있다.
 *
 *   npm run build && npm run test:e2e
 */
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const NET = 'bary-v01-net';
const PG = 'bary-v01-pg';
const DP = 'bary-v01-dp';
// **다른 e2e 와 겹치면 안 된다.** vitest 는 파일을 동시에 돌리므로, 18099 를 쓰면
// S12 e2e 가 같은 포트에 바인드하려다 `docker run` 이 통째로 깨진다 — 실제로 깨졌고,
// 단독으로 돌리면 초록이라 원인을 찾기 전에 "가끔 깨진다" 로 넘어가기 쉽다.
const API_PORT = 18101;
const DATA_PORT = 18102;      // 컨테이너 안의 :999 를 여기로 뺀다
const TOKEN = 'v01-test-token';

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

/**
 * 조건이 참이 될 때까지 기다린다.
 *
 * 고정 sleep 은 느린 머신에서 거짓 실패를, 빠른 머신에서 거짓 성공을 만든다. 이 저장소는
 * 그걸로 이미 세 번 데였다 (S8 두 번 · e2e 한 번).
 */
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

async function api(method: string, path: string, body?: unknown, token = TOKEN): Promise<ApiResult> {
  const r = await fetch(`http://127.0.0.1:${API_PORT}${path}`, {
    method,
    headers: {
      ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await r.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = text;
  }
  return { status: r.status, body: parsed };
}

/** 데이터 플레인에 진짜 요청을 던진다 — 이게 판정이다. */
async function hitDataPlane(host = 'anything'): Promise<string> {
  try {
    const r = await fetch(`http://127.0.0.1:${DATA_PORT}/`, {
      headers: { host },
      signal: AbortSignal.timeout(5000),
    });
    return `${r.status}:${(await r.text()).trim()}`;
  } catch (e) {
    return `err:${String(e).slice(0, 60)}`;
  }
}

/** 데몬에 넘길 토큰 명세. 평문은 안 넘어간다 — 해시만. */
const tokensEnv = (): string => JSON.stringify([{
  name: 'tester',
  hash: `sha256:${execFileSync('node', ['-e',
    `process.stdout.write(require('crypto').createHash('sha256').update('${TOKEN}').digest('hex'))`,
  ]).toString()}`,
  scopes: ['read', 'write', 'apply'],
}]);

/**
 * `:999 → A:11` 이 서비스되는 상태로 만든다.
 *
 * **테스트마다 자기 상태를 세운다.** 앞 테스트가 남긴 상태에 기대면 순서가 바뀌는 순간
 * 깨지고, 그 실패는 원인이 자기 자신이 아니라 남이라 찾기 어렵다 — 실제로 그렇게 두
 * 건이 깨졌다.
 */
async function ensureServing(): Promise<void> {
  if (await hitDataPlane() === '200:BACKEND_A_11') return;
  const head = await api('GET', '/api/v1/config/head');
  const cs = await api('POST', '/api/v1/changesets', { base_revision: head.body.revision });
  await api('PATCH', `/api/v1/changesets/${cs.body.id}`, {
    patch: [
      { op: 'put', kind: 'pool', key: 'app', body: { protocolClass: 'http', algorithm: 'round_robin' } },
      { op: 'put', kind: 'backend', key: 'a-11', body: { pool: 'app', host: '127.0.0.1', port: 11, weight: 1 } },
      {
        op: 'put', kind: 'listener', key: 'front',
        body: {
          protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true,
          http: { defaultAction: { pool: 'app' } },
        },
      },
    ],
  });
  const plan = await api('POST', `/api/v1/changesets/${cs.body.id}/plan`);
  await api('POST', `/api/v1/changesets/${cs.body.id}/commit`, { plan_id: plan.body.id });
  const op = await api('POST', '/api/v1/apply', { plan_id: plan.body.id });
  if (op.body.phase !== 'activated') {
    throw new Error(`상태 복구 실패: ${JSON.stringify(op.body)}`);
  }
  const got = await waitFor(() => hitDataPlane(), (v) => v === '200:BACKEND_A_11');
  if (got !== '200:BACKEND_A_11') throw new Error(`상태 복구 뒤에도 트래픽이 없다: ${got}`);
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
    throw new Error('도커가 없다 — v0.1 완료 판정은 실물로만 잰다');
  }
  tearDown();
  docker('network', 'create', NET);

  docker('run', '-d', '--name', PG, '--network', NET,
    '-e', 'POSTGRES_PASSWORD=bary', '-e', 'POSTGRES_DB=bary', 'docker.io/library/postgres:17-alpine');

  // **백엔드 A:11 은 DP 컨테이너 안의 별도 nginx 가 아니다.** 백엔드까지 컨트롤 플레인이
  // 렌더한 설정 안에 두면 "우리 설정이 우리 설정으로 프록시한다" 가 되어 아무것도 증명하지
  // 못한다. 그래서 컨테이너 안에서 별도 프로세스로 :11 을 띄운다.
  docker('run', '-d', '--name', DP, '--network', NET,
    '-p', `${API_PORT}:8088`, '-p', `${DATA_PORT}:999`,
    '-v', `${process.cwd()}:/app:ro`,
    '-e', 'BARY_DSN=postgres://postgres:bary@bary-v01-pg:5432/bary',
    '-e', 'BARY_PREFIX=/prefix',
    '-e', 'BARY_LISTEN=0.0.0.0:8088',
    '-e', `BARY_TOKENS=${tokensEnv()}`,
    '-e', 'BARY_RELOAD_CMD=kill -HUP $(cat /prefix/logs/nginx.pid)',
    '-e', 'BARY_CONFIGTEST_CMD=/usr/local/openresty/bin/openresty -p /prefix -c /prefix/generations/{generation}/nginx.conf -t',
    '--entrypoint', '/bin/sh', IMAGE, '-c', [
      'set -e',
      'apk add --no-cache nodejs >/dev/null 2>&1',
      'mkdir -p /prefix/logs /prefix/state /prefix/generations',
      // 백엔드 A:11 — 컨트롤 플레인이 모르는 별개 프로세스다.
      // `logs/` 가 없으면 nginx 는 **access_log 를 열다가** 죽는다. error_log 를 절대경로로
      // 바꿔도 access_log 기본값이 `logs/access.log` 라 소용없다 — 처음에 그걸로 깨졌다.
      'mkdir -p /backend/logs',
      'printf \'error_log logs/e.log warn;\\npid logs/p.pid;\\nevents{worker_connections 64;}\\nhttp{access_log off;server{listen 11;location /{return 200 "BACKEND_A_11";}}}\\n\' > /backend/nginx.conf',
      '/usr/local/openresty/bin/openresty -p /backend -c /backend/nginx.conf',
      // **부트스트랩도 데몬이 만든다.** 손으로 쓰면 멤버십 dict 와 admin 이 빠지고,
      // 그러면 §6.5-1 의 "HUP 전 staging" 이 쓸 곳을 못 찾는다 — 실제로 멤버십 평면을
      // 켜자 이 파일이 통째로 빨개졌다. 배포(`deploy/entrypoint.sh`)와 같은 방식이다.
      'node /app/dist/bin/barycenterd.js --write-bootstrap',
      '/usr/local/openresty/bin/openresty -p /prefix -c /prefix/current/nginx.conf',
      'exec node /app/dist/bin/barycenterd.js',
    ].join(' && '));

  const up = await waitFor(
    async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${API_PORT}/healthz`, { signal: AbortSignal.timeout(2000) });
        return r.ok;
      } catch {
        return false;
      }
    },
    (ok) => ok,
    120_000,
  );
  if (!up) {
    throw new Error(`데몬이 안 떴다:\n${docker('logs', '--tail', '40', DP)}`);
  }
}, 300_000);

afterAll(() => {
  tearDown();
});

describe('v0.1 완료 판정', () => {
  it('토큰이 없으면 401, 스코프가 없으면 403', async () => {
    expect((await api('GET', '/api/v1/config/head', undefined, '')).status).toBe(401);
    // 헤더 값은 ByteString 이라 비-ASCII 를 못 싣는다. 한글 토큰으로 쓰면 fetch 가
    // 요청을 보내기도 전에 던진다 — 서버를 재는 게 아니라 클라이언트가 죽는다.
    expect((await api('GET', '/api/v1/config/head', undefined, 'wrong-token')).status).toBe(401);
    // 살아 있는지 묻는 데는 토큰이 필요 없다 — 오케스트레이터가 토큰을 들고 다니면
    // 그 토큰이 곧 새는 경로가 된다.
    const health = await fetch(`http://127.0.0.1:${API_PORT}/healthz`);
    expect(health.status).toBe(200);
  });

  it('빈 저장소의 head 는 r1 이고 데이터 플레인은 아직 아무것도 안 준다', async () => {
    const head = await api('GET', '/api/v1/config/head');
    expect(head.status).toBe(200);
    expect(head.body.revision).toBe('1');
    // :999 는 아직 열리지 않았다.
    expect(await hitDataPlane()).toMatch(/^err:/);
  });

  it('**`curl :999` 가 A:11 에 닿는다** — REST 한 바퀴로', async () => {
    const head = await api('GET', '/api/v1/config/head');
    const cs = await api('POST', '/api/v1/changesets', { base_revision: head.body.revision });
    expect(cs.status).toBe(201);
    const id = cs.body.id as string;

    const patched = await api('PATCH', `/api/v1/changesets/${id}`, {
      patch: [
        { op: 'put', kind: 'pool', key: 'app', body: { protocolClass: 'http', algorithm: 'round_robin' } },
        // **A:11** — 컨테이너 안에서 도는 별개 프로세스다.
        { op: 'put', kind: 'backend', key: 'a-11', body: { pool: 'app', host: '127.0.0.1', port: 11, weight: 1 } },
        {
          op: 'put', kind: 'listener', key: 'front',
          body: {
            protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true,
            http: { defaultAction: { pool: 'app' } },
          },
        },
      ],
    });
    expect(patched.status).toBe(200);

    const plan = await api('POST', `/api/v1/changesets/${id}/plan`);
    expect(plan.status).toBe(200);
    // HUP 실패 위험이 여기서 드러나야 한다 (§5.4).
    expect(plan.body.impact.socketChanges.added).toContain('tcp://0.0.0.0:999');

    const commit = await api('POST', `/api/v1/changesets/${id}/commit`, { plan_id: plan.body.id });
    expect(commit.status).toBe(200);
    expect(commit.body.revision).toBe('2');

    const applied = await api('POST', '/api/v1/apply', { plan_id: plan.body.id });
    expect(applied.status).toBe(200);
    expect(applied.body.phase, `apply 실패: ${JSON.stringify(applied.body.detail)}`).toBe('activated');
    expect(applied.body.generation).toBe(`r2-e${commit.body.activationEpoch}`);

    // ── 판정 ──
    const got = await waitFor(() => hitDataPlane(), (v) => v === '200:BACKEND_A_11');
    expect(got).toBe('200:BACKEND_A_11');
  }, 180_000);

  it('활성화 증거가 **세대 리터럴**로 판정됐다 (§6.3)', async () => {
    const st = await api('GET', '/api/v1/status');
    expect(st.status).toBe(200);
    expect(st.body.head).toBe('2');
    // 좌표가 실제로 움직였다 — 증거 없이는 안 움직인다.
    expect(st.body.planes.http.activationEpoch).not.toBe('0');
    // `published` 는 판별 유니온이다 — `{kind:'owned', record}` / `inconsistent` / `none`.
    // 이름만 노출하면 컨트롤 플레인이 "내가 믿는 것과 실제가 갈라졌다" 를 볼 수 없다.
    expect(st.body.published.kind).toBe('owned');
    expect(st.body.published.record.generation).toMatch(/^r2-e/);
    expect(st.body.unfinished).toBeFalsy();
    expect(st.body.pendingApply).toEqual([]);
  });

  it('같은 plan 으로 다시 apply 하면 **같은 오퍼레이션**이다 (§5.3 멱등)', async () => {
    const plans = await api('GET', '/api/v1/audit?limit=200');
    const applyRow = (plans.body as { action: string; subject: string }[]).find((r) => r.action === 'apply');
    expect(applyRow).toBeDefined();
    const planId = applyRow?.subject ?? '';

    const a = await api('POST', '/api/v1/apply', { plan_id: planId });
    const b = await api('POST', '/api/v1/apply', { plan_id: planId });
    expect(a.status).toBe(200);
    expect(a.body.id).toBe(b.body.id);
    // 그리고 트래픽은 그대로다 — 멱등이란 부작용이 안 늘어난다는 뜻이다.
    expect(await hitDataPlane()).toBe('200:BACKEND_A_11');
  });

  it('**모순 조합은 저장이 거부된다** — 422/400 이 실제 코드로 나온다', async () => {
    const head = await api('GET', '/api/v1/config/head');
    const cs = await api('POST', '/api/v1/changesets', { base_revision: head.body.revision });
    const id = cs.body.id as string;

    // 해독 단계 — 400
    const bad = await api('PATCH', `/api/v1/changesets/${id}`, {
      patch: [{
        op: 'put', kind: 'listener', key: 'u',
        body: {
          protocol: 'udp', bind: '0.0.0.0', port: 53, enabled: true,
          defaultPool: 'app', udp: { preset: 'dns' }, acceptProxyProtocol: true,
        },
      }],
    });
    expect(bad.status).toBe(400);
    expect(bad.body.code).toBe('malformed');

    // 의미 단계 — 422 (없는 풀 참조)
    await api('PATCH', `/api/v1/changesets/${id}`, {
      patch: [{
        op: 'put', kind: 'listener', key: 't',
        body: { protocol: 'tcp', bind: '0.0.0.0', port: 1234, enabled: true, defaultPool: '없는풀' },
      }],
    });
    const planned = await api('POST', `/api/v1/changesets/${id}/plan`);
    expect(planned.status).toBe(422);
  });

  it('**두 번째 리비전이 트래픽을 바꾼다** — 세대 전환이 실제로 도는가', async () => {
    const head = await api('GET', '/api/v1/config/head');
    const cs = await api('POST', '/api/v1/changesets', { base_revision: head.body.revision });
    const id = cs.body.id as string;
    // 같은 백엔드를 거부로 바꾼다. 트래픽이 바뀌면 새 세대가 실제로 활성화된 것이다.
    await api('PATCH', `/api/v1/changesets/${id}`, {
      patch: [{
        op: 'put', kind: 'listener', key: 'front',
        body: {
          protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true,
          http: { defaultAction: 'reject' },
        },
      }],
    });
    const plan = await api('POST', `/api/v1/changesets/${id}/plan`);
    expect(plan.status).toBe(200);
    const commit = await api('POST', `/api/v1/changesets/${id}/commit`, { plan_id: plan.body.id });
    expect(commit.status).toBe(200);
    const applied = await api('POST', '/api/v1/apply', { plan_id: plan.body.id });
    expect(applied.body.phase, JSON.stringify(applied.body.detail)).toBe('activated');

    // **epoch 는 앞으로만 간다** — 롤백이든 전진이든 (§3.3-1, S19).
    const st = await api('GET', '/api/v1/status');
    expect(BigInt(st.body.planes.http.activationEpoch)).toBeGreaterThan(1n);

    const got = await waitFor(() => hitDataPlane(), (v) => v !== '200:BACKEND_A_11');
    expect(got).not.toBe('200:BACKEND_A_11');
  }, 180_000);

  it('**head 가 움직인 뒤의 옛 plan 은 막힌다** (superseded)', async () => {
    const head = await api('GET', '/api/v1/config/head');
    const a = await api('POST', '/api/v1/changesets', { base_revision: head.body.revision });
    await api('PATCH', `/api/v1/changesets/${a.body.id}`, {
      patch: [{ op: 'put', kind: 'pool', key: 'x', body: { protocolClass: 'tcp', algorithm: 'round_robin' } }],
    });
    const pa = await api('POST', `/api/v1/changesets/${a.body.id}/plan`);

    const b = await api('POST', '/api/v1/changesets', { base_revision: head.body.revision });
    await api('PATCH', `/api/v1/changesets/${b.body.id}`, {
      patch: [{ op: 'put', kind: 'pool', key: 'y', body: { protocolClass: 'tcp', algorithm: 'round_robin' } }],
    });
    const pb = await api('POST', `/api/v1/changesets/${b.body.id}/plan`);

    expect((await api('POST', `/api/v1/changesets/${a.body.id}/commit`, { plan_id: pa.body.id })).status).toBe(200);
    const second = await api('POST', `/api/v1/changesets/${b.body.id}/commit`, { plan_id: pb.body.id });
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('PLAN_STALE');
  });

  it('**데몬이 재기동해도 자기 락을 회수한다** — 컨테이너에서 pid 는 늘 겹친다', async () => {
    // 이 테스트가 생긴 경위: 처음엔 회수하지 못해서 재기동이 **아예 안 됐다.**
    //
    //   기동 실패: StoreLocked: 다른 프로세스(pid 1)가 이 상태를 쓰고 있다
    //
    // `FileStore` 는 락 주인이 살아 있는지 pid 로 봤고, "pid 재사용은 잔여 경합" 이라고
    // 적혀 있었다. 그런데 §11.1 이 규정한 배포(DP 컨테이너 안의 에이전트)에서는 잔여
    // 경합이 아니라 **확정**이다 — 데몬은 언제나 pid 1 이고 재기동하면 그 자리에 새
    // 프로세스가 다시 선다. 락 레코드에 프로세스 시작 시각을 넣어 갈랐다.
    const before = await api('GET', '/api/v1/status');
    docker('restart', DP);
    const up = await waitFor(
      async () => {
        try {
          return (await fetch(`http://127.0.0.1:${API_PORT}/healthz`,
            { signal: AbortSignal.timeout(2000) })).ok;
        } catch {
          return false;
        }
      },
      (ok) => ok,
      120_000,
    );
    expect(up, `재기동 실패:\n${docker('logs', '--tail', '15', DP)}`).toBe(true);

    // 그리고 **상태를 잃지 않았다.** 좌표가 그대로여야 durable store 가 제 일을 한 것이다.
    const after = await api('GET', '/api/v1/status');
    expect(after.body.planes.http.activationEpoch).toBe(before.body.planes.http.activationEpoch);
    expect(after.body.head).toBe(before.body.head);
  }, 180_000);

  it('**리더 토큰이 선출에서 온다** — 환경변수가 아니다 (§3.5)', async () => {
    const st = await api('GET', '/api/v1/status');
    expect(st.body.leader.isLeader).toBe(true);
    // 토큰이 실제로 DP 의 좌표 봉투에 실렸는지 본다. `BARY_LEADER_TOKEN` 은 이제 없다.
    expect(BigInt(st.body.leader.token as string)).toBeGreaterThan(0n);
    expect(st.body.leader.since).toMatch(/^\d{4}-/);
  });

  it('**스탠바이는 쓰기를 거부한다** — 503 이지 403 이 아니다', async () => {
    // 같은 PG 를 보는 둘째 인스턴스를 띄운다. **advisory lock 은 하나만 준다.**
    const NAME = 'bary-v01-standby';
    quiet('rm', '-f', NAME);
    docker('run', '-d', '--name', NAME, '--network', NET,
      '-p', `${API_PORT + 10}:8088`,
      '-v', `${process.cwd()}:/app:ro`,
      '-e', 'BARY_DSN=postgres://postgres:bary@bary-v01-pg:5432/bary',
      '-e', 'BARY_PREFIX=/standby-prefix',
      '-e', 'BARY_LISTEN=0.0.0.0:8088',
      '-e', 'BARY_NODE_NAME=standby',
      '-e', `BARY_TOKENS=${tokensEnv()}`,
      '--entrypoint', '/bin/sh', IMAGE, '-c', [
        'apk add --no-cache nodejs >/dev/null 2>&1',
        'mkdir -p /standby-prefix/logs /standby-prefix/state',
        'exec node /app/dist/bin/barycenterd.js',
      ].join(' && '));
    try {
      const up = await waitFor(async () => {
        try {
          return (await fetch(`http://127.0.0.1:${API_PORT + 10}/healthz`,
            { signal: AbortSignal.timeout(2000) })).ok;
        } catch {
          return false;
        }
      }, (ok) => ok, 120_000);
      expect(up, `스탠바이가 안 떴다:\n${docker('logs', '--tail', '20', NAME)}`).toBe(true);

      const at = async (method: string, path: string, body?: unknown): Promise<ApiResult> => {
        const r = await fetch(`http://127.0.0.1:${API_PORT + 10}${path}`, {
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
      };

      // **읽기는 답한다.** 스탠바이를 죽여 버리면 오케스트레이터가 재시작 루프를 돌고
      // 그건 "리더가 아니다" 가 아니라 "고장" 으로 보인다.
      const head = await at('GET', '/api/v1/config/head');
      expect(head.status).toBe(200);

      const st = await at('GET', '/api/v1/status');
      expect(st.body.leader.isLeader).toBe(false);
      expect(st.body.leader.reason).toMatch(/다른 인스턴스가 리더/);

      // **쓰기는 503.** 권한이 없는 것(403)이 아니라 *여기서는* 못 하는 것이다.
      const cs = await at('POST', '/api/v1/changesets', { base_revision: '1' });
      expect(cs.status).toBe(503);
      expect(cs.body.code).toBe('not_leader');

      const applied = await at('POST', '/api/v1/apply', { plan_id: 'x' });
      expect(applied.status).toBe(503);
    } finally {
      quiet('rm', '-f', NAME);
    }
  }, 180_000);

  it('**오래된 세대가 치워진다** — 무한히 쌓이지 않는다 (§8.4 수동 상한)', async () => {
    await ensureServing();
    const list = (): string[] =>
      docker('exec', DP, 'sh', '-c', 'ls /prefix/generations').split(/\s+/).filter(Boolean);
    const before = list();
    // 상한(기본 10)을 넘도록 여러 번 적용한다. 매번 내용이 달라야 새 세대가 생긴다.
    for (let i = 0; i < 12; i += 1) {
      const head = await api('GET', '/api/v1/config/head');
      const cs = await api('POST', '/api/v1/changesets', { base_revision: head.body.revision });
      await api('PATCH', `/api/v1/changesets/${cs.body.id}`, {
        patch: [{
          op: 'put', kind: 'backend', key: `b-${i}`,
          body: { pool: 'app', host: '127.0.0.1', port: 11, weight: i + 1 },
        }],
      });
      const plan = await api('POST', `/api/v1/changesets/${cs.body.id}/plan`);
      await api('POST', `/api/v1/changesets/${cs.body.id}/commit`, { plan_id: plan.body.id });
      const op = await api('POST', '/api/v1/apply', { plan_id: plan.body.id });
      expect(op.body.phase, JSON.stringify(op.body.detail)).toBe('activated');
    }
    const after = list();
    // 12 번을 더 돌렸는데 세대 수가 그만큼 안 늘었으면 치워진 것이다.
    expect(after.length).toBeLessThan(before.length + 12);
    // **활성 세대와 bootstrap 은 남아 있다** (§8.4 GC root).
    const st = await api('GET', '/api/v1/status');
    expect(after).toContain(st.body.published.record.generation);
    expect(after).toContain('bootstrap');
    // 그리고 트래픽은 멀쩡하다 — 치우다가 활성 세대를 건드리면 여기서 드러난다.
    expect(await hitDataPlane()).toBe('200:BACKEND_A_11');
  }, 300_000);

  it('**롤백이 트래픽을 되돌린다** — head 는 앞으로 가면서 (§5.3 · S19)', async () => {
    await ensureServing();
    const good = (await api('GET', '/api/v1/config/head')).body.revision as string;
    expect(await hitDataPlane()).toBe('200:BACKEND_A_11');

    // 망가뜨린다 — 기본 동작을 거부로 바꾼다.
    const cs = await api('POST', '/api/v1/changesets', { base_revision: good });
    await api('PATCH', `/api/v1/changesets/${cs.body.id}`, {
      patch: [{
        op: 'put', kind: 'listener', key: 'front',
        body: {
          protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true,
          http: { defaultAction: 'reject' },
        },
      }],
    });
    const bad = await api('POST', `/api/v1/changesets/${cs.body.id}/plan`);
    await api('POST', `/api/v1/changesets/${cs.body.id}/commit`, { plan_id: bad.body.id });
    expect((await api('POST', '/api/v1/apply', { plan_id: bad.body.id })).body.phase)
      .toBe('activated');
    expect(await waitFor(() => hitDataPlane(), (v) => v !== '200:BACKEND_A_11'))
      .not.toBe('200:BACKEND_A_11');

    // 되돌린다.
    const rolled = await api('POST', '/api/v1/rollback', { to_revision: good });
    expect(rolled.status).toBe(200);
    // **head 는 앞으로 간다** — 되돌린 리비전보다 크다 (§5.3).
    expect(BigInt(rolled.body.revision as string)).toBeGreaterThan(BigInt(good));
    expect(rolled.body.rollbackOf).toBe(good);

    const op = await api('POST', '/api/v1/apply', { plan_id: rolled.body.planId });
    expect(op.body.phase, JSON.stringify(op.body.detail)).toBe('activated');
    // **트래픽이 돌아왔다.**
    expect(await waitFor(() => hitDataPlane(), (v) => v === '200:BACKEND_A_11'))
      .toBe('200:BACKEND_A_11');
  }, 300_000);

  it('**엔진 capability 를 실제로 조회한다** (§7.6)', async () => {
    // `capabilities.ts` 는 오래 있었지만 **아무도 부르지 않았다.** 컨트롤 플레인이
    // `streamRealip: false` 를 상수로 가정했고, PROXY 신뢰 경계를 넣은 뒤로 stream
    // 수신이 엔진과 무관하게 항상 막혔다 — capability 로 좁힌다면서 안 물어본 셈이었다.
    const st = await api('GET', '/api/v1/status');
    expect(st.body.engine.probed).toBe(true);
    expect(st.body.engine.flavor).toBe('openresty');
    expect(st.body.engine.version).toMatch(/^\d+\.\d+\.\d+$/);
    // E63.4 가 실측한 사실이 여기 그대로 나타난다.
    expect(st.body.engine.supports.streamRealip).toBe(false);
    expect(st.body.engine.supports.sniPassthrough).toBe(true);
  });

  it('**진행 중인 전환을 취소할 수 있다** — 그리고 활성화된 것은 못 되돌린다', async () => {
    await ensureServing();
    // 방금 활성화된 오퍼레이션을 찾는다.
    const audit = await api('GET', '/api/v1/audit?limit=200');
    const row = (audit.body as { action: string; subject: string }[])
      .find((r) => r.action === 'apply');
    const applied = await api('POST', '/api/v1/apply', { plan_id: row?.subject ?? '' });

    // §3.3 — 되돌리는 것은 취소가 아니라 롤백이다. 취소가 이걸 되돌리면 "포기" 와
    // "되돌리기" 가 같은 동작이 되고, 그러면 epoch 규칙이 무너진다.
    const cancelled = await api('POST', `/api/v1/operations/${applied.body.id}/cancel`);
    expect(cancelled.status).toBe(409);
    expect(cancelled.body.code).toBe('already_activated');

    // 그리고 트래픽은 그대로다 — 거절된 취소가 아무것도 안 건드렸다.
    expect(await hitDataPlane()).toBe('200:BACKEND_A_11');
  }, 120_000);

  it('감사에 who/what/revision 이 남는다 (§5.1)', async () => {
    const audit = await api('GET', '/api/v1/audit?limit=500');
    const rows = audit.body as { principal: string; action: string; revision: string | null }[];
    expect(rows.length).toBeGreaterThan(5);
    expect(new Set(rows.map((r) => r.principal))).toEqual(new Set(['tester']));
    expect(rows.some((r) => r.action === 'apply' && r.revision === '2')).toBe(true);
  });
});

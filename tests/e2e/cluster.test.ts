/**
 * **클러스터 — 두 노드가 같은 세대를 서빙한다** (ADR-CLUSTER, #118) — 실물 엔진 두 대 + PG 하나.
 *
 * web-01 과 web-02 는 **각자 nginx 와 DP 에이전트**를 가진 별개 컨테이너다. 설정 PG 만 함께 쓴다.
 * 먼저 뜬 web-01 이 리더다. 재는 것:
 *
 *   ① 리더에 적용하면 **팔로워의 nginx 도** 같은 트래픽을 준다 — 실제 요청으로 잰다
 *   ② `/api/v1/cluster/nodes` 가 두 노드를 같은 세대로 보여 준다
 *   ③ 팔로워에 쓰면 503 not_leader 다
 *   ④ 설정을 바꾸면 팔로워가 새 리비전을 따라간다
 *   ⑤ 리더를 내리면 팔로워가 리더가 되고, 그 노드에서 쓰기·적용이 된다
 *
 * 실제 DP 에이전트의 펜싱(I5: 기록 토큰 ≤ 최대 토큰)을 지나는 것이 이 파일의 요점이다 —
 * 가짜 드라이버로 잰 `tests/store/cluster-follow.test.ts` 는 그것을 못 본다.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { waitForPg } from './pg-ready.js';
import { waitForDaemon } from './daemon-up.js';
import { appMount } from './mounts.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const NET = 'bary-cluster-net';
const PG = 'bary-cluster-pg';
const NODES = [
  { name: 'web-01', container: 'bary-cluster-web01', api: 18301, data: 18302 },
  { name: 'web-02', container: 'bary-cluster-web02', api: 18311, data: 18312 },
] as const;
const TOKEN = 'cluster-test-token';
// 실행할 때마다 만든다 — 저장소에 KEK 모양의 값을 두지 않는다(.gitleaks.toml).
const KEK = randomBytes(32).toString('base64');

const docker = (...args: string[]): string =>
  execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const quiet = (...args: string[]): void => { try { docker(...args); } catch { /* 없으면 그만 */ } };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(probe: () => Promise<T>, ok: (v: T) => boolean, budgetMs = 30_000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last = await probe();
  while (!ok(last) && Date.now() < deadline) { await sleep(300); last = await probe(); }
  return last;
}

type ApiResult = { status: number; body: any };
async function api(port: number, method: string, path: string, body?: unknown): Promise<ApiResult> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers: { authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    const text = await r.text();
    let parsed: unknown;
    try { parsed = JSON.parse(text); } catch { parsed = text; }
    return { status: r.status, body: parsed };
  } catch (e) {
    return { status: 0, body: String(e) };
  }
}

async function hit(port: number, path = '/'): Promise<string> {
  try {
    const r = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000) });
    return `${r.status}:${(await r.text()).trim()}`;
  } catch (e) {
    return `err:${String(e).slice(0, 60)}`;
  }
}

const tokensEnv = (): string => JSON.stringify([{
  name: 'tester',
  hash: `sha256:${execFileSync('node', ['-e',
    `process.stdout.write(require('crypto').createHash('sha256').update('${TOKEN}').digest('hex'))`]).toString()}`,
  scopes: ['read', 'write', 'apply'],
}]);

/** 변경 하나를 커밋하고 적용한다. 리더에 대고. */
async function applyVia(port: number, patch: unknown[]): Promise<ApiResult> {
  const head = await api(port, 'GET', '/api/v1/config/head');
  const cs = await api(port, 'POST', '/api/v1/changesets', { base_revision: head.body.revision });
  if (cs.status !== 201) return cs;
  await api(port, 'PATCH', `/api/v1/changesets/${cs.body.id}`, { patch });
  const plan = await api(port, 'POST', `/api/v1/changesets/${cs.body.id}/plan`);
  await api(port, 'POST', `/api/v1/changesets/${cs.body.id}/commit`, { plan_id: plan.body.id });
  return api(port, 'POST', '/api/v1/apply', { plan_id: plan.body.id });
}

function startNode(n: typeof NODES[number]): void {
  docker('run', '-d', '--name', n.container, '--network', NET,
    '-p', `${n.api}:8088`, '-p', `${n.data}:999`,
    ...appMount(),
    '-e', `BARY_DSN=postgres://postgres:bary@${PG}:5432/bary`,
    '-e', 'BARY_PREFIX=/prefix',
    '-e', 'BARY_LISTEN=0.0.0.0:8088', '-e', 'BARY_ALLOW_PLAINTEXT_EXPOSED=1',
    '-e', `BARY_TOKENS=${tokensEnv()}`,
    '-e', 'BARY_RELOAD_CMD=kill -HUP $(cat /prefix/logs/nginx.pid)',
    '-e', 'BARY_CONFIGTEST_CMD=/usr/local/openresty/bin/openresty -p /prefix -c /prefix/generations/{generation}/nginx.conf -t',
    '-e', 'BARY_CLUSTER=1', '-e', `BARY_NODE_NAME=${n.name}`, '-e', 'BARY_CLUSTER_SYNC_MS=1000',
    '-e', 'BARY_SECRET_BACKEND=pg', '-e', `BARY_SECRET_KEK=${KEK}`,
    '--entrypoint', '/bin/sh', IMAGE, '-c', [
      'set -e',
      'apk add --no-cache nodejs >/dev/null 2>&1',
      'mkdir -p /prefix/logs /prefix/state /prefix/generations /backend/logs',
      // 노드마다 자기 백엔드 :11 — 응답에 노드 이름을 싣는다. 어느 nginx 가 받았는지 가른다.
      `printf 'error_log logs/e.log warn;\\npid logs/p.pid;\\nevents{worker_connections 64;}\\nhttp{access_log off;server{listen 11;location /{return 200 "BACKEND@${n.name}";}}}\\n' > /backend/nginx.conf`,
      '/usr/local/openresty/bin/openresty -p /backend -c /backend/nginx.conf',
      'node /app/dist/bin/barycenterd.js --write-bootstrap',
      '/usr/local/openresty/bin/openresty -p /prefix -c /prefix/current/nginx.conf',
      'exec node /app/dist/bin/barycenterd.js',
    ].join(' && '));
}

async function waitUp(n: typeof NODES[number]): Promise<void> {
  await waitForDaemon({
    container: n.container,
    probe: async () => {
      try { return (await fetch(`http://127.0.0.1:${n.api}/healthz`, { signal: AbortSignal.timeout(2000) })).ok; } catch { return false; }
    },
  });
}

function tearDown(): void {
  for (const n of NODES) quiet('rm', '-f', n.container);
  quiet('rm', '-f', PG);
  quiet('network', 'rm', NET);
}

const [W1, W2] = NODES;

const SERVE = [
  { op: 'put', kind: 'pool', key: 'app', body: { protocolClass: 'http', algorithm: 'round_robin' } },
  { op: 'put', kind: 'backend', key: 'a-11', body: { pool: 'app', host: '127.0.0.1', port: 11, weight: 1 } },
  { op: 'put', kind: 'listener', key: 'front', body: { protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true, http: { defaultAction: { pool: 'app' } } } },
];

beforeAll(async () => {
  try { docker('version', '--format', '{{.Server.Version}}'); } catch { throw new Error('도커가 없다 — 실물로만 잰다'); }
  tearDown();
  docker('network', 'create', NET);
  docker('run', '-d', '--name', PG, '--network', NET,
    '-e', 'POSTGRES_PASSWORD=bary', '-e', 'POSTGRES_DB=bary', 'docker.io/library/postgres:17-alpine');
  await waitForPg(PG);
  // **web-01 을 먼저 띄운다** — 락을 먼저 잡은 쪽이 리더다.
  startNode(W1);
  await waitUp(W1);
  startNode(W2);
  await waitUp(W2);
}, 400_000);

afterAll(() => { tearDown(); });

describe('클러스터 (ADR-CLUSTER)', () => {
  it('① 리더에 적용하면 팔로워의 nginx 도 같은 트래픽을 준다', async () => {
    const op = await applyVia(W1.api, SERVE);
    expect(op.body.phase).toBe('activated');
    expect(await waitFor(() => hit(W1.data), (v) => v === '200:BACKEND@web-01')).toBe('200:BACKEND@web-01');
    // 팔로워는 주기(1초)마다 따라간다.
    expect(await waitFor(() => hit(W2.data), (v) => v === '200:BACKEND@web-02', 20_000)).toBe('200:BACKEND@web-02');
  }, 120_000);

  it('② 클러스터 노드 목록이 두 노드를 같은 세대로 보여 준다', async () => {
    const r = await waitFor(() => api(W2.api, 'GET', '/api/v1/cluster/nodes'),
      (x) => Array.isArray(x.body?.nodes) && x.body.nodes.length === 2
        && x.body.nodes.every((n: { state: string }) => n.state === 'in_sync')
        && new Set(x.body.nodes.map((n: { activeGeneration?: string }) => n.activeGeneration)).size === 1, 20_000);
    expect(r.body.enabled).toBe(true);
    expect(r.body.self).toBe('web-02');
    expect(r.body.nodes.map((n: { name: string; role: string }) => [n.name, n.role]))
      .toEqual([['web-01', 'leader'], ['web-02', 'follower']]);
  }, 60_000);

  it('③ 팔로워에 쓰면 503 not_leader 다', async () => {
    const head = await api(W2.api, 'GET', '/api/v1/config/head');
    const r = await api(W2.api, 'POST', '/api/v1/changesets', { base_revision: head.body.revision });
    expect(r.status).toBe(503);
    expect(r.body.code).toBe('not_leader');
  });

  it('④ 설정을 바꾸면 팔로워가 새 리비전을 따라간다', async () => {
    const op = await applyVia(W1.api, [
      { op: 'put', kind: 'listener', key: 'front', body: { protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true, http: { defaultAction: 'reject' } } },
    ]);
    expect(op.body.phase).toBe('activated');
    // reject 는 444 — 응답 없이 끊는다.
    expect(await waitFor(() => hit(W2.data), (v) => v.startsWith('err:'), 20_000)).toMatch(/^err:/);
    const nodes = await waitFor(() => api(W1.api, 'GET', '/api/v1/cluster/nodes'),
      (x) => x.body?.nodes?.every((n: { activeGeneration?: string }) => n.activeGeneration === op.body.generation), 20_000);
    expect(nodes.body.nodes.map((n: { activeGeneration?: string }) => n.activeGeneration))
      .toEqual([op.body.generation, op.body.generation]);
  }, 120_000);

  it('⑤ 리더를 내리면 팔로워가 리더가 되고 그 노드에서 적용이 된다', async () => {
    docker('stop', '-t', '2', W1.container);
    // 리더 재시도 주기 안에 락을 넘겨받는다.
    const st = await waitFor(() => api(W2.api, 'GET', '/api/v1/status'),
      (x) => x.body?.leader?.isLeader === true || x.body?.leader?.self === true || x.body?.leader?.holder === 'web-02', 60_000);
    expect(st.status).toBe(200);
    const op = await waitFor(() => applyVia(W2.api, SERVE), (x) => x.body?.phase === 'activated', 60_000);
    expect(op.body.phase).toBe('activated');
    expect(await waitFor(() => hit(W2.data), (v) => v === '200:BACKEND@web-02', 20_000)).toBe('200:BACKEND@web-02');
  }, 180_000);
});

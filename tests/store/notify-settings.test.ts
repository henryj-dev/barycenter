/**
 * **알림 설정을 DB 에서 고친다** (036, 2026-11-20).
 *
 * 전에는 `BARY_NOTIFY_*` 만 있었다 — 바꾸려면 파일을 고치고 데몬을 다시 띄웠고, 보냈는지는 계측으로만 알았다.
 * 이 파일이 재는 것:
 *   · 첫 기동에 환경 변수를 옮긴다(비밀은 시크릿 저장소의 `opaque://`). 두 번째는 아무것도 안 한다
 *   · API 가 비밀을 내보내지 않는다(`secretSet` 만). 비밀을 바꾸면 옛 버전이 저장소에서 사라진다
 *   · 종류는 못 바꾼다 · 모양이 틀리면 400 · 지우면 비밀도 지운다
 *   · 시험 전송이 기록에 남고, 사유 문장의 비밀은 가린다
 *   · 기록은 새것부터 쪽으로 읽고, DB 보존이 오래된 것을 지운다
 *   · DB 시크릿 저장소(봉투 암호화)도 `opaque` 를 넣고 읽고 지운다. 청소는 그것을 안 본다
 *
 *   npm run test:store     (도커 필요 — PG · MySQL. SQLite 는 BARY_TEST_DB=sqlite)
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TokenAuth, hashToken } from '../../src/api/auth.js';
import { createApi } from '../../src/api/server.js';
import type { LeaderElection } from '../../src/control/leader.js';
import type { ControlPlane } from '../../src/control/plane.js';
import { sweepSecretsPg } from '../../src/dp/secret-gc-pg.js';
import { FsSecretStore } from '../../src/dp/secrets.js';
import { PgSecretStore } from '../../src/dp/secrets-pg.js';
import { NotifyRuntime } from '../../src/notify/runtime.js';
import { ConfigStore } from '../../src/store/config-store.js';
import { sweepDatabase } from '../../src/store/db-retention.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('notify-settings');
const TOKEN = 'notify-settings-token';
const CAPS = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };

// 비밀 · URL 은 실행 중에 만든 가짜 값이다.
const hookSecret = randomBytes(24).toString('hex');
const slackUrl = ['https://hooks.slack.test/services', 'T0', 'B0', randomBytes(8).toString('hex')].join('/');

type Call = { url: string; body: string };
let calls: Call[] = [];
let answer = (): Response => new Response('ok', { status: 200 });
const fakeFetch = (async (url: string | URL, init?: RequestInit) => {
  calls.push({ url: String(url), body: String(init?.body) });
  return answer();
}) as typeof fetch;

let db: Db;
let config: ConfigStore;
let secrets: FsSecretStore;
let root = '';
let dir = '';
let server: Server | undefined;
let base = '';
let runtime: NotifyRuntime;

function env(): NodeJS.ProcessEnv {
  writeFileSync(join(dir, 'hook'), hookSecret);
  writeFileSync(join(dir, 'slack'), slackUrl);
  return {
    BARY_NOTIFY: 'webhook,slack',
    BARY_NOTIFY_WEBHOOK_URL: 'https://hooks.test/bary',
    BARY_NOTIFY_WEBHOOK_SECRET_FILE: join(dir, 'hook'),
    BARY_NOTIFY_SLACK_URL_FILE: join(dir, 'slack'),
    BARY_NOTIFY_REPEAT_S: '600',
  };
}

function newRuntime(e: NodeJS.ProcessEnv): NotifyRuntime {
  return new NotifyRuntime({
    db: db as unknown as never, secrets, node: 'n1', env: e, deps: { fetch: fakeFetch }, pollMs: 3_600_000,
    sources: { isLeader: () => true },
  });
}

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  config = new ConfigStore(db as unknown as never, CAPS);
  root = mkdtempSync(join(tmpdir(), 'bary-notify-'));
  dir = mkdtempSync(join(tmpdir(), 'bary-notify-env-'));
  secrets = new FsSecretStore(root);
}, 240_000);

afterAll(async () => {
  runtime?.stop();
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server === undefined ? r() : server.close(() => r())));
  await db?.close();
  stopPg(PG);
  for (const d of [root, dir]) {
    if (d === '') continue;
    try { execFileSync('chmod', ['-R', 'u+w', d]); } catch { /* 이미 없으면 그만 */ }
    rmSync(d, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  runtime?.stop();
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server === undefined ? r() : server.close(() => r())));
  await reset(db);
  calls = [];
  answer = () => new Response('ok', { status: 200 });
  runtime = newRuntime(env());
  await runtime.start();
  server = createApi({
    db: db as unknown as never,
    store: config,
    control: {} as ControlPlane,
    auth: new TokenAuth([{ name: 'admin', hash: hashToken(TOKEN), scopes: ['read', 'write', 'apply', 'admin'] }]),
    election: { state: { isLeader: true } } as unknown as LeaderElection,
    secrets,
    notify: runtime,
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

type Res = { status: number; body: Record<string, unknown>; text: string };
async function call(method: string, path: string, body?: unknown): Promise<Res> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  return { status: r.status, body: JSON.parse(text) as Record<string, unknown>, text };
}

const opaqueVersions = (name: string): string[] => {
  try { return readdirSync(join(root, 'opaque', name)); } catch { return []; }
};

describe('씨 뿌리기', () => {
  it('첫 기동에 환경 변수를 옮긴다 — 비밀은 저장소에, 설정에는 참조만', async () => {
    const c = (await runtime.config())!;
    expect(c.seededFrom).toBe('env');
    expect(c.knobs.repeatS).toBe(600);
    expect(c.channels.map((x) => [x.name, x.kind, x.enabled])).toEqual([['slack', 'slack', true], ['webhook', 'webhook', true]]);
    expect(c.channels.find((x) => x.name === 'webhook')?.settings.url).toBe('https://hooks.test/bary');
    expect(c.channels.every((x) => x.secretRef?.startsWith('opaque://notify.') === true)).toBe(true);
    expect(await runtime.store.secretOf(c.channels.find((x) => x.name === 'slack')!)).toBe(slackUrl);
    // 행 자체에는 비밀이 없다.
    const raw = JSON.stringify((await db.query('SELECT * FROM notify_channels')).rows);
    expect(raw).not.toContain(hookSecret);
    expect(raw).not.toContain(slackUrl);
    expect(runtime.status().active.sort()).toEqual(['slack', 'webhook']);
  });

  it('두 번째 기동은 환경 변수를 보지 않는다 — DB 가 이긴다', async () => {
    await call('PUT', '/api/v1/notify/settings', { repeatS: 900, certDays: 7, intervalS: 30, queue: 50 });
    const again = newRuntime({ ...env(), BARY_NOTIFY_REPEAT_S: '60' });
    await again.start();
    expect((await again.config())!.knobs).toEqual({ repeatS: 900, certDays: 7, intervalS: 30, queue: 50 });
    again.stop();
  });

  it('환경 변수가 없으면 기본값으로 빈 설정을 만든다', async () => {
    await reset(db);
    const bare = newRuntime({});
    await bare.start();
    const c = (await bare.config())!;
    expect(c.seededFrom).toBe('default');
    expect(c.channels).toEqual([]);
    expect(c.knobs).toEqual({ repeatS: 21_600, certDays: 14, intervalS: 60, queue: 100 });
    bare.stop();
  });
});

describe('API', () => {
  it('비밀을 내보내지 않는다 — `secretSet` 만', async () => {
    const r = await call('GET', '/api/v1/notify');
    expect(r.status).toBe(200);
    expect(r.text).not.toContain(hookSecret);
    expect(r.text).not.toContain(slackUrl);
    expect(r.text).not.toContain('opaque://');
    const channels = r.body['channels'] as Record<string, unknown>[];
    expect(channels.map((c) => c['secretSet'])).toEqual([true, true]);
    expect(r.body['settings']).toMatchObject({ repeatS: 600 });
  });

  it('비밀 없이 고치면 있던 비밀을 둔다 · 비밀을 바꾸면 옛 버전이 사라진다', async () => {
    const v0 = opaqueVersions('notify.webhook');
    expect(v0).toHaveLength(1);
    const keep = await call('PUT', '/api/v1/notify/channels/webhook', {
      kind: 'webhook', enabled: false, url: 'https://hooks.test/other', minSeverity: 'warning', kinds: ['apply.failed'],
    });
    expect(keep.status).toBe(200);
    expect(keep.body).toMatchObject({ enabled: false, secretSet: true, settings: { url: 'https://hooks.test/other', minSeverity: 'warning', kinds: ['apply.failed'] } });
    expect(opaqueVersions('notify.webhook')).toEqual(v0);

    const fresh = randomBytes(24).toString('hex');
    const swap = await call('PUT', '/api/v1/notify/channels/webhook', { kind: 'webhook', enabled: true, url: 'https://hooks.test/other', secret: fresh });
    expect(swap.status).toBe(200);
    expect(swap.text).not.toContain(fresh);
    const v1 = opaqueVersions('notify.webhook');
    expect(v1).toHaveLength(1);
    expect(v1).not.toEqual(v0);
    // 감사에는 비밀이 없다 — 바뀌었는지만.
    const audit = JSON.stringify((await db.query("SELECT action, after FROM audit WHERE action LIKE 'notify.%'")).rows);
    expect(audit).not.toContain(fresh);
    expect(audit).toContain('secretChanged');
  });

  it('새 통로 — 메일 · 이름 · 모양 · 종류 바꾸기', async () => {
    const bad = await call('PUT', '/api/v1/notify/channels/Ops', { kind: 'mail', enabled: true, to: ['ops@example.com'] });
    expect(bad.status).toBe(400);
    const noSecret = await call('PUT', '/api/v1/notify/channels/hook2', { kind: 'webhook', enabled: true, url: 'https://hooks.test/x' });
    expect(noSecret.status).toBe(400);
    const http = await call('PUT', '/api/v1/notify/channels/hook2', { kind: 'webhook', enabled: true, url: 'http://hooks.test/x', secret: hookSecret });
    expect(http.status).toBe(400);
    const slackUrlInUrl = await call('PUT', '/api/v1/notify/channels/sl2', { kind: 'slack', enabled: true, url: slackUrl });
    expect(slackUrlInUrl.status).toBe(400);
    const mail = await call('PUT', '/api/v1/notify/channels/ops', { kind: 'mail', enabled: true, to: ['ops@example.com', ' oncall@example.com '] });
    expect(mail.status).toBe(201);
    expect(mail.body).toMatchObject({ kind: 'mail', secretSet: false, settings: { to: ['ops@example.com', 'oncall@example.com'] } });
    const swapKind = await call('PUT', '/api/v1/notify/channels/ops', { kind: 'slack', enabled: true, secret: slackUrl });
    expect(swapKind.status).toBe(409);
    // 메일 전송 설정이 없는 데몬이라 이 통로는 「만들지 못했다」 로 보인다.
    const st = (await call('GET', '/api/v1/notify')).body['status'] as { problems: { channel: string }[]; mailAvailable: boolean };
    expect(st.mailAvailable).toBe(false);
    expect(st.problems.map((p) => p.channel)).toEqual(['ops']);
  });

  it('지우면 비밀도 지운다', async () => {
    expect(opaqueVersions('notify.slack')).toHaveLength(1);
    const r = await call('DELETE', '/api/v1/notify/channels/slack');
    expect(r.status).toBe(200);
    expect(opaqueVersions('notify.slack')).toEqual([]);
    expect((await call('DELETE', '/api/v1/notify/channels/slack')).status).toBe(404);
    expect(runtime.status().active).toEqual(['webhook']);
  });

  it('공통 값 — 범위 밖은 400', async () => {
    expect((await call('PUT', '/api/v1/notify/settings', { repeatS: 10, certDays: 14, intervalS: 60, queue: 100 })).status).toBe(400);
    expect((await call('PUT', '/api/v1/notify/settings', { repeatS: 600, certDays: 14, intervalS: 60 })).status).toBe(400);
    const ok = await call('PUT', '/api/v1/notify/settings', { repeatS: 3600, certDays: 30, intervalS: 120, queue: 10 });
    expect(ok.status).toBe(200);
    const v = (await call('GET', '/api/v1/notify')).body;
    expect(v['settings']).toEqual({ repeatS: 3600, certDays: 30, intervalS: 120, queue: 10 });
    expect(Number(v['version'])).toBeGreaterThan(1);
  });
});

describe('시험 전송 · 기록', () => {
  it('보내고 기록한다 — 실패의 사유에서 비밀을 가린다', async () => {
    const ok = await call('POST', '/api/v1/notify/channels/webhook/test');
    expect(ok.body).toEqual({ outcome: 'sent' });
    expect(calls.at(-1)?.url).toBe('https://hooks.test/bary');
    expect(JSON.parse(calls.at(-1)!.body)).toMatchObject({ kind: 'notify.test' });

    answer = () => new Response(`no such hook ${slackUrl}`, { status: 404 });
    const fail = await call('POST', '/api/v1/notify/channels/slack/test');
    expect(fail.body).toMatchObject({ outcome: 'auth' });
    expect(fail.text).not.toContain(slackUrl);

    const log = await call('GET', '/api/v1/notify/deliveries?limit=1');
    const items = log.body['items'] as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ channel: 'slack', outcome: 'auth', test: true, kind: 'notify.test', node: 'n1' });
    expect(String(items[0]!['detail'])).not.toContain(slackUrl);
    const next = await call('GET', `/api/v1/notify/deliveries?limit=5&before=${String(log.body['next'])}`);
    expect((next.body['items'] as Record<string, unknown>[]).map((x) => x['channel'])).toEqual(['webhook']);
    expect((await call('GET', '/api/v1/notify/deliveries?before=abc')).status).toBe(400);
    expect((await call('POST', '/api/v1/notify/channels/nope/test')).status).toBe(404);
  });

  it('허브가 보낸 것도 기록한다 — 받을 사건 · 심각도를 거른다', async () => {
    await call('PUT', '/api/v1/notify/channels/webhook', { kind: 'webhook', enabled: true, url: 'https://hooks.test/bary', minSeverity: 'critical' });
    runtime.emit({ kind: 'cert.expiring', severity: 'warning', key: 'k1', title: 't', detail: 'd' });
    runtime.emit({ kind: 'apply.failed', severity: 'critical', key: 'k2', title: 't', detail: 'd' });
    await runtime.hub.drain();
    await new Promise((r) => setTimeout(r, 100));
    const rows = (await call('GET', '/api/v1/notify/deliveries?limit=10')).body['items'] as Record<string, unknown>[];
    const byChannel = rows.map((r) => `${String(r['channel'])}:${String(r['key'])}`).sort();
    expect(byChannel).toEqual(['slack:k1', 'slack:k2', 'webhook:k2']);
  });

  it('DB 보존이 오래된 기록을 지운다', async () => {
    await call('POST', '/api/v1/notify/channels/webhook/test');
    await call('POST', '/api/v1/notify/channels/webhook/test');
    const ids = (await db.query('SELECT id FROM notify_deliveries ORDER BY id')).rows.map((r) => String(r['id']));
    await db.query(`UPDATE notify_deliveries SET at = $1 WHERE id = ${ids[0]!}`, [new Date(Date.now() - 40 * 86_400_000).toISOString()]);
    const out = await sweepDatabase({ db: db as unknown as never });
    expect(out.notifyDeliveries).toBe(1);
    expect((await db.query('SELECT id FROM notify_deliveries')).rows.map((r) => String(r['id']))).toEqual([ids[1]]);
  });
});

describe('DB 시크릿 저장소의 opaque', () => {
  it('봉투로 넣고 읽고 지운다 · 청소가 보지 않는다', async () => {
    const pg = new PgSecretStore({ db: db as unknown as never, kek: randomBytes(32), kekId: 'k1' });
    const a = await pg.putOpaque('notify.x', 'value-one');
    expect(a.ref).toMatch(/^opaque:\/\/notify\.x@[a-f0-9]{32}$/);
    expect(await pg.getOpaque(a.ref)).toBe('value-one');
    expect((await pg.putOpaque('notify.x', 'value-one')).ref).toBe(a.ref);
    const swept = await sweepSecretsPg({ db: db as unknown as never, roots: [], keepPerName: 0, minAgeMs: 0 });
    expect(swept.removed).toEqual([]);
    expect(await pg.getOpaque(a.ref)).toBe('value-one');
    await pg.removeOpaque(a.ref);
    await expect(pg.getOpaque(a.ref)).rejects.toThrow(/없다/);
    await expect(pg.getKey(a.ref)).rejects.toThrow();
  });
});

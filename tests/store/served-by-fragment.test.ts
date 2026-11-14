/**
 * **노드 이름은 렌더 결과가 아니라 세대 조각이다** (conf/served-by.ts, 2026-11-14)
 *
 * `BARY_SERVED_BY` 는 노드마다 다르다. 렌더 결과(`nginx.conf`)에 들어가면 같은 모델이 노드마다 다른 digest 가 되어
 * plan 이 렌더러 드리프트를 못 잡는다. 그래서 각 노드가 세대를 만들 때 `admin/served-by.map` 을 쓴다.
 *
 * 재는 것: 별칭을 준 노드의 세대에는 조각이 있고 nginx.conf 는 별칭 없는 노드와 바이트까지 같다. 안 준 노드에는
 * 조각이 없다(기본은 끈다).
 *
 *   npm run test:store     (도커 필요)
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { ControlPlane } from '../../src/control/plane.js';
import { LeaderElection } from '../../src/control/leader.js';
import { openLeaderLockForTest } from '../../src/store/open.js';
import { SERVED_BY_FILE, servedByFragment } from '../../src/conf/served-by.js';
import type { DataplaneDriver } from '../../src/dp/driver.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('served-by-fragment');
const CAPS = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true, headersMore: true };

let db: Db;
let store: ConfigStore;
let election: LeaderElection;
const prefixes: string[] = [];
/** 엔진이 서빙 중이라고 말하는 epoch. 활성 plan 을 적을 때 맞춘다. */
let liveEpoch = '0';

/** 세대를 다 쓴 뒤 엔진에 넘기는 자리에서 멈춘다 — 엔진은 없다. */
class Stop extends Error {}
const driver = {
  fence: () => Promise.resolve({ maxToken: '0' }),
  applyConfig: () => Promise.reject(new Stop('config')),
  applyMembership: () => Promise.reject(new Stop('membership')),
  recoverConfig: () => Promise.reject(new Error('안 쓴다')),
  abortConfig: () => Promise.resolve(),
  pushMembershipDirect: () => Promise.resolve(),
  reconcileConfig: () => Promise.reject(new Error('안 쓴다')),
  status: () => Promise.resolve({
    maxLeaderToken: '0',
    planes: {
      http: { activationEpoch: liveEpoch, membershipRevision: '1', payloadDigest: '' },
      stream: { activationEpoch: liveEpoch, membershipRevision: '1', payloadDigest: '' },
    },
    published: { kind: 'none' }, lastEvidence: undefined, unfinished: undefined,
  }),
} as unknown as DataplaneDriver;

const MODEL: PatchOp[] = [
  { op: 'put', kind: 'pool', key: 'web', body: { protocolClass: 'http', algorithm: 'round_robin' } },
  { op: 'put', kind: 'backend', key: 'w1', body: { pool: 'web', host: '10.0.0.1', port: 80, weight: 1 } },
  { op: 'put', kind: 'listener', key: 'a',
    body: { protocol: 'http', bind: '127.0.0.1', port: 18080, enabled: true, http: { defaultAction: { pool: 'web' } } } },
];

/**
 * 한 노드가 같은 모델로 세대를 만든다. 돌려주는 것은 그 세대 디렉터리.
 * 노드마다 DB 를 비우고 같은 모델을 새로 커밋한다 — 같은 plan 을 두 번 적용하면 둘째는 세대를 안 만든다.
 */
async function generationOf(servedBy?: string): Promise<string> {
  await reset(db);
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, MODEL, 't');
  const plan = await store.plan(cs, 't');
  await store.commit(cs, plan.id, 't');

  const prefix = mkdtempSync(join(tmpdir(), 'bary-servedby-'));
  prefixes.push(prefix);
  const control = new ControlPlane(db, store, driver, election, {
    prefix, adminSocket: join(prefix, 'admin.sock'), renderCaps: CAPS,
    ...(servedBy === undefined ? {} : { servedBy }),
  });
  // 세대를 다 쓴 뒤 드라이버에서 멈춘다.
  await expect(control.apply(plan.id, 't')).rejects.toBeInstanceOf(Stop);
  const gens = readdirSync(join(prefix, 'generations'));
  expect(gens).toHaveLength(1);
  return join(prefix, 'generations', gens[0]!);
}

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new ConfigStore(db, CAPS);
  election = new LeaderElection(openLeaderLockForTest(PG.dsn), 'served-by-test');
  if (!(await election.tryAcquire())) throw new Error('리더 획득 실패');
}, 240_000);

afterAll(async () => {
  for (const p of prefixes) rmSync(p, { recursive: true, force: true });
  await db?.close();
  stopPg(PG);
});

describe('노드 이름 — 세대 조각', () => {
  it('별칭을 준 노드만 `admin/served-by.map` 을 쓰고, nginx.conf 는 바이트까지 같다', async () => {
    const named = await generationOf('icn-a1');
    const bare = await generationOf();

    expect(readFileSync(join(named, SERVED_BY_FILE), 'utf8')).toContain('default "icn-a1";');
    expect(existsSync(join(bare, SERVED_BY_FILE))).toBe(false);
    const conf = readFileSync(join(named, 'nginx.conf'), 'utf8');
    expect(conf).toBe(readFileSync(join(bare, 'nginx.conf'), 'utf8'));
    expect(conf).not.toContain('icn-a1');
    expect(conf).toContain(`include ${SERVED_BY_FILE}*;`);
  }, 240_000);
});

/**
 * **별칭만 바꾸고 다시 적용하면 새 세대를 낸다** (2026-11-14, web-01).
 *
 * 렌더 결과가 같으면 apply 는 멤버십만 옮긴다(`rerender-served.test.ts`). 조각은 digest 밖이라 그 판정만 보면 별칭을
 * 넣고 다시 적용해도 세대가 안 바뀌어 헤더가 영영 안 나간다. 서빙 중인 세대(`current/`)의 조각을 함께 본다.
 */
describe('노드 이름 — 별칭만 바뀐 다시 적용', () => {
  /** 리비전을 커밋하고 활성으로 적는다. 서빙 중인 conf 와 렌더가 같다(같은 렌더러). */
  async function activePlan(): Promise<string> {
    await reset(db);
    const head = await store.head();
    const cs = await store.createChangeset(head.revision, 't');
    await store.patchChangeset(cs, MODEL, 't');
    const plan = await store.plan(cs, 't');
    const out = await store.commit(cs, plan.id, 't');
    const epoch = String(out.activationEpoch);
    liveEpoch = epoch;
    await db.query(
      `INSERT INTO operations (id, plan_id, revision, activation_epoch, generation, phase, detail, created_by)
       VALUES ($1, $2, $3, $4, $5, 'activated', '{"phase":"activated"}', 't')`,
      [randomUUID(), plan.id, String(out.revision), epoch, `r${String(out.revision)}-e${epoch}`],
    );
    await db.query(`UPDATE plans SET state = 'applied' WHERE id = $1`, [plan.id]);
    return (await store.replanActiveHead('t')).planId;
  }

  /** `current/` 에 조각을 둔(또는 안 둔) 노드에서 apply 가 어느 길로 가는가. */
  async function pathOf(planId: string, servedBy: string | undefined, current: string | undefined): Promise<string> {
    const prefix = mkdtempSync(join(tmpdir(), 'bary-servedby-'));
    prefixes.push(prefix);
    mkdirSync(join(prefix, 'current', 'admin'), { recursive: true });
    if (current !== undefined) writeFileSync(join(prefix, 'current', SERVED_BY_FILE), servedByFragment(current));
    const control = new ControlPlane(db, store, driver, election, {
      prefix, adminSocket: join(prefix, 'admin.sock'), renderCaps: CAPS,
      ...(servedBy === undefined ? {} : { servedBy }),
    });
    const out = await control.apply(planId, 't').catch((e: unknown) => e);
    if (out instanceof Stop) return out.message;
    throw new Error(`드라이버까지 안 갔다: ${String(out instanceof Error ? out : JSON.stringify(out))}`);
  }

  it('별칭을 새로 켜면 렌더가 같아도 새 세대를 낸다 (멤버십만 옮기지 않는다)', async () => {
    expect(await pathOf(await activePlan(), 'az01-icn-own', undefined)).toBe('config');
  }, 240_000);

  it('별칭을 바꿔도, 끄도 새 세대를 낸다', async () => {
    expect(await pathOf(await activePlan(), 'icn-b2', 'icn-a1')).toBe('config');
    expect(await pathOf(await activePlan(), undefined, 'icn-a1')).toBe('config');
  }, 240_000);

  it('서빙 중인 조각이 원하는 것과 같으면 전처럼 멤버십만 옮긴다', async () => {
    expect(await pathOf(await activePlan(), 'icn-a1', 'icn-a1')).toBe('membership');
    expect(await pathOf(await activePlan(), undefined, undefined)).toBe('membership');
  }, 240_000);
});

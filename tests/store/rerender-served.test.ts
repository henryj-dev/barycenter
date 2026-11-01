/**
 * 다시 렌더한 plan 은 **실제로 서빙 중인 conf** 와 비교한다 (2026-11-01, web-01).
 *
 * #165 로 활성 r27 을 다시 렌더했더니 영향이 「reload 없음, conf 크기 같음」 이었다. apply 도 멤버십만 옮기고 끝날
 * 참이었다. 둘 다 「지금 서빙 중인 conf」 를 적용된 리비전을 **지금 판의 렌더러로** 다시 렌더해 구했기 때문이다.
 * 렌더러가 바뀐 뒤에는 그 값이 새 렌더와 언제나 같다. #163 의 X-Forwarded-For 는 그래서 nginx 에 나가지 않았다.
 *
 * 재는 것: 서빙 중인 plan 의 `render_digest` 가 지금 렌더와 다르면 — 옛 렌더러가 구운 세대 — 영향은 reload 이고,
 * apply 는 새 세대를 낸다(멤버십만 옮기지 않는다). 같으면 전처럼 멤버십만 옮긴다.
 *
 *   npm run test:store     (도커 필요)
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { ControlPlane } from '../../src/control/plane.js';
import { LeaderElection } from '../../src/control/leader.js';
import type { DataplaneDriver } from '../../src/dp/driver.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('rerender-served');
// barycenterd 처럼 store 와 control 이 **같은** 렌더 능력을 쓴다.
const CAPS = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };

let db: Db;
let store: ConfigStore;
let control: ControlPlane;
let election: LeaderElection;
let prefix = '';
let epochOfR1 = '';

/** apply 가 어느 길로 갔는가. 드라이버는 거기서 멈춘다 — 엔진은 없다. */
class Took extends Error { constructor(readonly path: 'config' | 'membership') { super(path); } }
const driver = {
  fence: () => Promise.resolve({ maxToken: '0' }),
  applyConfig: () => Promise.reject(new Took('config')),
  applyMembership: () => Promise.reject(new Took('membership')),
  recoverConfig: () => Promise.reject(new Error('안 쓴다')),
  abortConfig: () => Promise.resolve(),
  pushMembershipDirect: () => Promise.resolve(),
  reconcileConfig: () => Promise.reject(new Error('안 쓴다')),
  status: () => Promise.resolve({
    maxLeaderToken: '0',
    planes: {
      http: { activationEpoch: epochOfR1, membershipRevision: '1', payloadDigest: '' },
      stream: { activationEpoch: epochOfR1, membershipRevision: '1', payloadDigest: '' },
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

/** r1 을 커밋하고 활성으로 적는다. `digest` 를 주면 그 plan 을 옛 렌더러가 구운 것으로 만든다. */
async function activeR1(digest?: string): Promise<void> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, MODEL, 't');
  const plan = await store.plan(cs, 't');
  const out = await store.commit(cs, plan.id, 't');
  epochOfR1 = String(out.activationEpoch);
  await db.query(
    `INSERT INTO operations (id, plan_id, revision, activation_epoch, generation, phase, detail, created_by)
     VALUES ($1, $2, $3, $4, $5, 'activated', '{"phase":"activated"}', 't')`,
    [randomUUID(), plan.id, String(out.revision), epochOfR1, `r${String(out.revision)}-e${epochOfR1}`],
  );
  await db.query(`UPDATE plans SET state = 'applied' WHERE id = $1`, [plan.id]);
  if (digest !== undefined) await db.query(`UPDATE plans SET render_digest = $2 WHERE id = $1`, [plan.id, digest]);
}

async function pathOf(planId: string): Promise<string> {
  try {
    await control.apply(planId, 't');
    return 'none';
  } catch (e) {
    if (e instanceof Took) return e.path;
    throw e;
  }
}

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new ConfigStore(db, CAPS);
  election = new LeaderElection(PG.dsn, 'rerender-served-test');
  if (!(await election.tryAcquire())) throw new Error('리더 획득 실패');
}, 240_000);

afterAll(async () => {
  if (prefix !== '') rmSync(prefix, { recursive: true, force: true });
  await db?.close();
  stopPg(PG);
});

beforeEach(async () => {
  await reset(db);
  if (prefix !== '') rmSync(prefix, { recursive: true, force: true });
  prefix = mkdtempSync(join(tmpdir(), 'bary-rerender-'));
  control = new ControlPlane(db, store, driver, election, {
    prefix, adminSocket: join(prefix, 'admin.sock'), renderCaps: CAPS,
  });
});

describe('다시 렌더 — 서빙 중인 conf 와 비교', () => {
  it('**옛 렌더러가 구운 세대면 영향은 reload 이고, apply 는 새 세대를 낸다**', async () => {
    await activeR1('sha256:옛-렌더러');
    const again = await store.replanActiveHead('t');
    expect((await store.getPlan(again.planId)).impact.requiresReload).toBe(true);
    expect(await pathOf(again.planId)).toBe('config');
  }, 240_000);

  it('같은 렌더러가 구운 세대면 전처럼 멤버십만 옮긴다', async () => {
    await activeR1();
    const again = await store.replanActiveHead('t');
    expect((await store.getPlan(again.planId)).impact.requiresReload).toBe(false);
    expect(await pathOf(again.planId)).toBe('membership');
  }, 240_000);
});

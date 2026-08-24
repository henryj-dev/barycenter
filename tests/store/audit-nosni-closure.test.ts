/**
 * 영향 폐포에 `onNoSni` — 검수 2026-08-24 D17
 *
 * ── 무엇이 빠져 있었나
 *
 * `listenerClosure` 는 패스스루 리스너에서 `onUnmatchedSni` 의 풀은 폐포에 넣는데
 * **`onNoSni` 는 안 넣었다.** S9 가 그 필드를 열 때(2026-08-23) 이 자리를 같이 안 봤다.
 *
 * 결과: **SNI 없음 폴백 풀의 백엔드가 바뀌어도 그 리스너가 「영향받음」에 안 뜬다.**
 * 리스너 자체는 폐포에 통째로 들어가므로 `onNoSni` **필드**를 고치는 것은 잡힌다 —
 * 안 잡히는 것은 그 필드가 *가리키는 풀의 멤버십* 이 바뀌는 경우다.
 *
 * ── 왜 이것이 결함인가
 *
 * §5.4 가 `affected_listeners` 를 요구한 이유는 운영자가 **무엇이 끊길 수 있는지**
 * 커밋 앞에서 보게 하려는 것이다. 폴백 풀은 SNI 를 안 보내는 클라이언트가 가는 곳이라,
 * 거기 백엔드가 빠지는 것은 그 트래픽이 통째로 끊기는 일이다. plan 이 그 리스너를
 * 안 실으면 **그 사실이 커밋 앞에 안 보인다.**
 *
 *   npm run test:store     (도커 필요)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('nosni-closure');

let db: Db;
let store: ConfigStore;

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 이 스위트는 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new ConfigStore(db);
}, 180_000);

afterAll(async () => {
  await db?.close();
  stopPg(PG);
});

beforeEach(async () => {
  await reset(db);
});

const PUT = (kind: PatchOp extends { kind: infer K } ? K : never, key: string, body: unknown): PatchOp =>
  ({ op: 'put', kind, key, body });

/**
 * 패스스루 리스너 하나에 폴백 풀 **둘**.
 *
 *   `unmatched`  유효한 SNI 인데 매칭이 없다  (`onUnmatchedSni`)
 *   `nosni`      TLS 인데 SNI 가 없다        (`onNoSni`, S9 로 열렸다)
 *
 * 둘을 다른 풀로 두는 것이 요점이다 — 하나만 폐포에 들면 그 차이가 드러난다.
 */
const base: PatchOp[] = [
  PUT('pool', 'unmatched', { protocolClass: 'tcp', algorithm: 'round_robin' }),
  PUT('backend', 'unmatched-1', { pool: 'unmatched', host: '10.0.0.1', port: 443, weight: 1 }),
  PUT('pool', 'nosni', { protocolClass: 'tcp', algorithm: 'round_robin' }),
  PUT('backend', 'nosni-1', { pool: 'nosni', host: '10.0.0.2', port: 443, weight: 1 }),
  PUT('listener', 'pt', {
    protocol: 'tls_passthrough', bind: '0.0.0.0', port: 443, enabled: true,
    onUnmatchedSni: { pool: 'unmatched' },
    onNoSni: { pool: 'nosni' },
  }),
];

async function commitAll(ops: PatchOp[]): Promise<void> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, ops, 't');
  const plan = await store.plan(cs, 't');
  await store.commit(cs, plan.id, 't');
}

async function affectedBy(ops: PatchOp[]): Promise<string[]> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, ops, 't');
  const plan = await store.plan(cs, 't');
  return plan.impact.affectedListeners.map((a) => a.key).sort();
}

describe('패스스루 폴백 풀의 멤버십 변화', () => {
  it('**`onNoSni` 풀에 백엔드를 더하면 그 리스너가 영향받는다**', async () => {
    await commitAll(base);
    const affected = await affectedBy([
      PUT('backend', 'nosni-2', { pool: 'nosni', host: '10.0.0.3', port: 443, weight: 1 }),
    ]);
    expect(affected).toEqual(['pt']);
  });

  it('`onUnmatchedSni` 풀도 마찬가지다 — 원래 되던 쪽이 안 깨졌는지 함께 본다', async () => {
    await commitAll(base);
    const affected = await affectedBy([
      PUT('backend', 'unmatched-2', { pool: 'unmatched', host: '10.0.0.4', port: 443, weight: 1 }),
    ]);
    expect(affected).toEqual(['pt']);
  });

  it('무관한 풀은 안 싣는다 — 폐포가 넓기만 한 것이 아니다', async () => {
    await commitAll([
      ...base,
      PUT('pool', 'other', { protocolClass: 'tcp', algorithm: 'round_robin' }),
      PUT('backend', 'other-1', { pool: 'other', host: '10.0.0.9', port: 9999, weight: 1 }),
      PUT('listener', 'edge', {
        protocol: 'tcp', bind: '0.0.0.0', port: 9999, enabled: true, defaultPool: 'other',
      }),
    ]);
    const affected = await affectedBy([
      PUT('backend', 'other-2', { pool: 'other', host: '10.0.0.10', port: 9999, weight: 1 }),
    ]);
    expect(affected).toEqual(['edge']);
  });
});

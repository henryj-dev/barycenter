/**
 * 바인드가 이 서버의 주소가 아니면 plan 에서 막는다 (2026-10-31).
 *
 * 바인드는 수신할 소켓의 주소다. 할당 안 된 주소는 nginx 가 못 연다 — 전에는 apply 의 nginx 실패로만
 * 알았다. CLI · API 는 GUI 의 선택지를 안 지나므로 저장소가 본다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { hostAddressesFrom } from '../../src/engine/host-addresses.js';
import { ConfigStore, StoreError, type PatchOp } from '../../src/store/config-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('bind-local');
let db: Db;
let store: ConfigStore;
let nonlocal = false;

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new ConfigStore(db, { streamRealip: false }, undefined, () => hostAddressesFrom(
    { eth0: [{ address: '10.0.0.5', family: 'IPv4', internal: false }] },
    { v4: nonlocal, v6: false },
  ));
}, 180_000);

afterAll(async () => {
  await db?.close();
  stopPg(PG);
});

beforeEach(async () => {
  await reset(db);
  nonlocal = false;
});

async function plan(bind: string): Promise<unknown> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  const ops: PatchOp[] = [
    { op: 'put', kind: 'pool', key: 'web', body: { protocolClass: 'tcp', algorithm: 'round_robin' } },
    { op: 'put', kind: 'backend', key: 'w1', body: { pool: 'web', host: '10.0.0.1', port: 80, weight: 1 } },
    { op: 'put', kind: 'listener', key: 'l', body: { protocol: 'tcp', bind, port: 18081, enabled: true, defaultPool: 'web' } },
  ];
  await store.patchChangeset(cs, ops, 't');
  return store.plan(cs, 't');
}

describe('바인드는 이 서버의 주소여야 한다', () => {
  it('할당 안 된 주소는 plan 에서 bind_not_local 로 막는다', async () => {
    const e = await plan('10.0.0.6').then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(StoreError);
    expect((e as StoreError).code).toBe('bind_not_local');
    expect((e as StoreError).message).toContain("리스너 'l'");
    expect((e as StoreError).message).toContain('10.0.0.5');
  });

  it('할당된 주소와 와일드카드는 지난다', async () => {
    await expect(plan('10.0.0.5')).resolves.toBeDefined();
    await reset(db);
    await expect(plan('0.0.0.0')).resolves.toBeDefined();
  });

  it('ip_nonlocal_bind 가 켜지면 막지 않는다 (VIP)', async () => {
    nonlocal = true;
    await expect(plan('10.0.0.6')).resolves.toBeDefined();
  });
});

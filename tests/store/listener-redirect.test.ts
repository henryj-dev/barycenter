/**
 * HTTPS 리스너의 평문 리다이렉트가 저장소를 지나도 남는다 (030, 2026-10-31).
 *
 * 리스너는 칸마다 열이 있는 표에 산다. 새 칸은 열 · 읽기 · 쓰기가 모두 있어야 한다 — 029(호스트)가 랩에서
 * 열이 없어 저장이 안 된 적이 있다. 재는 것: 켜면 다시 읽은 모델에 그대로 있고, 끄면 사라진다. 그리고 DB 가
 * 범위 밖 포트와 https 밖의 값을 막는다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('listener-redirect');
let db: Db;
let store: ConfigStore;

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
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

async function commit(ops: PatchOp[]): Promise<string> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, ops, 't');
  const plan = await store.plan(cs, 't');
  return String((await store.commit(cs, plan.id, 't')).revision);
}

const V = 'a'.repeat(32);
const setup: PatchOp[] = [
  { op: 'put', kind: 'pool', key: 'web', body: { protocolClass: 'http', algorithm: 'round_robin' } },
  { op: 'put', kind: 'backend', key: 'w1', body: { pool: 'web', host: '10.0.0.1', port: 80, weight: 1 } },
  { op: 'put', kind: 'tlsPolicy', key: 'p', body: { minVersion: '1.2' } },
  { op: 'put', kind: 'certificate', key: 'c', body: { materialRef: `store://c@${V}`, chainDigest: `sha256:${'0'.repeat(64)}`, keyDigest: `sha256:${'1'.repeat(64)}` } },
];
const listener = (redirect?: number): PatchOp => ({
  op: 'put', kind: 'listener', key: 's',
  body: {
    protocol: 'https', bind: '0.0.0.0', port: 18443, enabled: true,
    tls: { policy: 'p', defaultCertificate: 'c' },
    http: { defaultAction: { pool: 'web' } },
    ...(redirect === undefined ? {} : { httpRedirect: { port: redirect } }),
  },
});

describe('평문 리다이렉트 저장', () => {
  it('켜면 다시 읽은 모델에 포트가 그대로 있다', async () => {
    const rev = await commit([...setup, listener(18080)]);
    expect((await store.modelAt(rev)).listeners.find((l) => l.key === 's')).toMatchObject({ httpRedirect: { port: 18080 } });
  });

  it('끄면 사라진다', async () => {
    await commit([...setup, listener(18080)]);
    const rev = await commit([listener()]);
    const s = (await store.modelAt(rev)).listeners.find((l) => l.key === 's');
    expect(s).toBeDefined();
    expect(s && 'httpRedirect' in s).toBe(false);
  });

  it('DB 가 범위 밖 포트와 https 밖의 값을 막는다', async () => {
    await commit([...setup, listener(18080)]);
    await expect(db.query("UPDATE listeners SET http_redirect_port=0 WHERE key='s'")).rejects.toThrow(/listener_http_redirect_port_range/);
    await expect(db.query(
      "INSERT INTO listeners (id,key,name,protocol,bind,port,enabled,http_default_reject,http_redirect_port,created_by,updated_by,revision) "
      + "VALUES (gen_random_uuid(),'h','h','http','0.0.0.0',18081,true,true,18082,'t','t',1)",
    )).rejects.toThrow(/listener_http_redirect_https_only/);
  });
});

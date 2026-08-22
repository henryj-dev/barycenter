/**
 * 검수 2026-08-22 · S-01b — **경로가 되는 key 는 저장되지 않는다**
 *
 * 리소스 `key` 에는 형식 검증이 하나도 없었다. 그런데 인증서 key 는
 * `certs/<key>/<version>/privkey.pem` 이라는 **파일 경로**가 된다. `../` 하나로 세대
 * 디렉토리 밖에 개인키를 쓸 수 있었다(재현: `audit-key-escape.test.ts`).
 *
 * ── 어디에 거는가가 이 수정의 전부다 ────────────────────────────────────
 *
 * **`decodeModel` 에는 안 건다.** `ConfigStore.modelAt` 이 `config_revisions.model`
 * 스냅샷을 그 해독기로 읽기 때문이다 — 문법을 좁히면 규칙을 벗어난 key 가 들어 있는
 * **옛 리비전이 통째로 해독 불가**가 되고, 그 리비전으로 **롤백할 수 없다.**
 *
 * 이 저장소는 같은 함정을 이미 한 번 밟았다: v0.6 이 컬렉션 셋을 더하자 그 이전 리비전
 * 롤백이 `undefined.map` 으로 죽었고, 그래서 `modelAt` 이 캐스팅 대신 해독으로 바뀌었다.
 * **해독기를 좁히는 것은 그 수정의 정반대 방향이다.**
 *
 * 그래서 문법은 **쓰기 경계**(`shapeCheck`)와 **DB CHECK** 에만 건다. 이미 저장된
 * 나쁜 key 에 대한 방어는 `materializeGeneration` 이 파일시스템 층에서 한다 — 두 겹이다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, StoreError, type PatchOp } from '../../src/store/config-store.js';
import { decodeModel } from '../../src/model/decode.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('audit-keysyntax');

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

const pool = (key: string): PatchOp => ({
  op: 'put', kind: 'pool', key,
  body: { protocolClass: 'http', algorithm: 'round_robin' },
});

async function patch(ops: PatchOp[]): Promise<void> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 'tester');
  await store.patchChangeset(cs, ops, 'tester');
}

describe('리소스 key 문법 (검수 S-01b)', () => {
  it('경로가 되는 key 는 저장되지 않는다', async () => {
    for (const bad of ['../../../../pwned', 'a/b', './x', '..', '', ' lead', 'x'.repeat(64)]) {
      await expect(patch([pool(bad)]), bad).rejects.toThrow(StoreError);
    }
    // 인증서가 특히 중요하다 — 이게 파일 경로가 된다.
    await expect(patch([{
      op: 'put', kind: 'certificate', key: '../escape',
      body: { acme: { account: 'le', domains: ['a.test'] } },
    }])).rejects.toThrow(/모양|key/);
  });

  it('평범한 key 는 그대로 지난다', async () => {
    // 좁히다가 쓰던 것까지 막으면 안 된다.
    await patch([pool('app'), pool('app-2'), pool('app_2'), pool('app.v2'), pool('A9')]);
  });

  it('DB 도 스스로 막는다 — 애플리케이션을 우회해도', async () => {
    // 저장 경계는 잊을 수 있다. §4.0 이 층을 나눈 이유다.
    await expect(db.query(
      `INSERT INTO pools (id,key,name,protocol_class,algorithm,created_by,updated_by,revision)
       VALUES (gen_random_uuid(),$1,$1,'http','round_robin','x','x',1)`,
      ['../evil'],
    )).rejects.toThrow();
  });

  it('해독기는 관대하게 둔다 — 옛 리비전이 읽혀야 롤백이 된다', async () => {
    // **여기가 이 수정에서 가장 위험한 자리다.** 문법을 해독기에 넣었으면 이 단언이
    // 깨지고, 그 순간 규칙을 벗어난 key 가 든 리비전으로 롤백할 수 없게 된다.
    const legacy = {
      listeners: [], httpRoutes: [], passthroughRoutes: [], pools: [], backends: [],
      certificates: [{
        key: '../legacy-cert',
        materialRef: `store://x@${'a'.repeat(32)}`,
        chainDigest: `sha256:${'a'.repeat(64)}`,
        keyDigest: `sha256:${'b'.repeat(64)}`,
      }],
      tlsPolicies: [], sniBindings: [],
    };
    expect(decodeModel(legacy).ok).toBe(true);

    // 그리고 `modelAt` 도 읽어야 한다 — 그게 롤백의 첫 걸음이다.
    await db.query(
      `INSERT INTO config_revisions (revision, model, created_by, note)
       VALUES (nextval('config_revision_seq'), $1::jsonb, 'legacy', '옛 리비전')`,
      [JSON.stringify(legacy)],
    );
    const rev = (await db.query(`SELECT currval('config_revision_seq')::text AS v`))
      .rows[0]?.['v'] as string;
    const read = await store.modelAt(rev);
    expect(read.certificates[0]?.key).toBe('../legacy-cert');
  });
});

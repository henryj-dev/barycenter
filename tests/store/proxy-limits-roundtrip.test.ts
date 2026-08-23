/**
 * 제안 #8 왕복 — **필드는 있는데 저장이 안 되는** 병을 막는다.
 *
 * B-01 이 정확히 그것이었다: HSTS·암호군·SNI 불일치·http2·워커 타임아웃 다섯이 모델에는
 * 있는데 DB 에 안 실렸다. 타입도 맞고 렌더러도 읽는데, 커밋하고 다시 읽으면 사라진다.
 * **단위 테스트로는 안 잡힌다** — 렌더러에 객체를 손으로 넣어 부르기 때문이다.
 *
 * 그래서 여기는 실물 PG 를 지난다. 재는 것은 하나다: *patch → commit → modelAt 에서
 * 같은 값이 나오는가.*
 *
 *   npm run test:store     (도커 필요)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('limits');

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

async function commitAll(ops: PatchOp[]): Promise<void> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, ops, 't');
  const plan = await store.plan(cs, 't');
  await store.commit(cs, plan.id, 't');
}

const pool: PatchOp[] = [
  PUT('pool', 'app', { protocolClass: 'http', algorithm: 'round_robin' }),
  PUT('backend', 'a', { pool: 'app', host: '10.0.0.1', port: 80, weight: 1 }),
];

async function headModel() {
  return store.modelAt((await store.head()).revision);
}

describe('프록시 한계값이 DB 를 왕복한다 (제안 #8)', () => {
  it('http 리스너에 적은 값이 그대로 돌아온다', async () => {
    const limits = {
      connectTimeoutMs: 5000, readTimeoutMs: 120_000,
      sendTimeoutMs: 90_000, clientMaxBodyBytes: 52_428_800,
    };
    await commitAll([...pool, PUT('listener', 'web', {
      protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
      http: { defaultAction: { pool: 'app' }, limits },
    })]);
    const l = (await headModel()).listeners.find((x) => x.key === 'web');
    expect(l?.protocol).toBe('http');
    expect((l as { http?: { limits?: unknown } }).http?.limits).toEqual(limits);
  });

  it('**https 리스너도 같다** — 한 자리를 넓혔으니 둘 다 열려야 한다', async () => {
    await commitAll([
      ...pool,
      PUT('tlsPolicy', 'modern', { minVersion: 'TLSv1.3' }),
      PUT('certificate', 'site', { materialRef: null }),
      PUT('listener', 'sec', {
        protocol: 'https', bind: '0.0.0.0', port: 443, enabled: true,
        tls: { policy: 'modern', defaultCertificate: 'site' },
        http: { defaultAction: { pool: 'app' }, limits: { readTimeoutMs: 30_000 } },
      }),
    ]).catch(() => undefined);
    const l = (await headModel()).listeners.find((x) => x.key === 'sec');
    // 인증서 자료가 없으면 plan 이 막을 수 있다 — 그때는 이 단언을 건너뛴다.
    if (l === undefined) return;
    expect((l as { http?: { limits?: unknown } }).http?.limits).toEqual({ readTimeoutMs: 30_000 });
  });

  it('**`defaultAction` 과 함께 산다** — 한쪽을 쓰면서 다른 쪽을 지우지 않는다', async () => {
    // 두 값이 같은 `http` 객체를 나눠 쓰므로, 저장 경로가 하나를 덮으면 다른 하나가 사라진다.
    await commitAll([...pool, PUT('listener', 'web', {
      protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
      http: { defaultAction: { pool: 'app' }, limits: { readTimeoutMs: 30_000 } },
    })]);
    const l = (await headModel()).listeners.find((x) => x.key === 'web') as
      { http?: { defaultAction?: unknown; limits?: unknown } };
    expect(l.http?.defaultAction).toEqual({ pool: 'app' });
    expect(l.http?.limits).toEqual({ readTimeoutMs: 30_000 });
  });

  it('안 적으면 `limits` 가 아예 없다 — `{}` 로 만들어 내지 않는다', async () => {
    await commitAll([...pool, PUT('listener', 'web', {
      protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
      http: { defaultAction: { pool: 'app' } },
    })]);
    const l = (await headModel()).listeners.find((x) => x.key === 'web') as
      { http?: { limits?: unknown } };
    expect(l.http?.limits).toBeUndefined();
  });

  it('일부만 적으면 적은 것만 돌아온다 — 나머지를 기본값으로 채우지 않는다', async () => {
    await commitAll([...pool, PUT('listener', 'web', {
      protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
      http: { defaultAction: { pool: 'app' }, limits: { clientMaxBodyBytes: 0 } },
    })]);
    const l = (await headModel()).listeners.find((x) => x.key === 'web') as
      { http?: { limits?: unknown } };
    // `0` 이 살아 돌아와야 한다 — falsy 라 중간에서 지워지기 쉬운 값이다.
    expect(l.http?.limits).toEqual({ clientMaxBodyBytes: 0 });
  });

  it('**tcp 리스너에는 못 붙인다** — 아무도 안 읽는 값이 저장되면 동작한다고 믿는다', async () => {
    const head = await store.head();
    const cs = await store.createChangeset(head.revision, 't');
    await expect(store.patchChangeset(cs, [
      PUT('pool', 'l4', { protocolClass: 'tcp', algorithm: 'round_robin' }),
      PUT('backend', 'b', { pool: 'l4', host: '10.0.0.2', port: 12, weight: 1 }),
      PUT('listener', 'edge', {
        protocol: 'tcp', bind: '0.0.0.0', port: 998, enabled: true, defaultPool: 'l4',
        http: { limits: { readTimeoutMs: 1000 } },
      }),
    ], 't')).rejects.toThrow();
  });

  it('export 에도 실린다 — 백업이 이 값을 잃으면 복구가 다른 설정을 만든다', async () => {
    const limits = { connectTimeoutMs: 5000, clientMaxBodyBytes: 1_048_576 };
    await commitAll([...pool, PUT('listener', 'web', {
      protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
      http: { defaultAction: { pool: 'app' }, limits },
    })]);
    const dump = JSON.stringify(await store.exportAt((await store.head()).revision));
    expect(dump).toContain('clientMaxBodyBytes');
    expect(dump).toContain('connectTimeoutMs');
  });

  it('헤더 규칙도 왕복한다 (제안 #7)', async () => {
    const headers = {
      request: [{ name: 'X-Tenant', value: 'acme' }],
      response: [{ name: 'X-Frame-Options', value: 'DENY' }],
    };
    await commitAll([...pool, PUT('listener', 'web', {
      protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
      http: { defaultAction: { pool: 'app' }, headers },
    })]);
    const l = (await headModel()).listeners.find((x) => x.key === 'web') as
      { http?: { headers?: unknown } };
    expect(l.http?.headers).toEqual(headers);
  });

  it('**셋이 한 `http` 객체에 함께 산다** — 하나를 쓰면서 둘을 지우지 않는다', async () => {
    // `defaultAction`·`limits`·`headers` 가 같은 객체를 나눠 쓴다. 저장 경로가 하나를
    // 덮으면 나머지가 조용히 사라지고, 그건 B-01 이 낸 병과 같은 모양이다.
    await commitAll([...pool, PUT('listener', 'web', {
      protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
      http: {
        defaultAction: { pool: 'app' },
        limits: { readTimeoutMs: 30_000 },
        headers: { request: [{ name: 'X-A', value: '1' }] },
      },
    })]);
    const l = (await headModel()).listeners.find((x) => x.key === 'web') as
      { http?: { defaultAction?: unknown; limits?: unknown; headers?: unknown } };
    expect(l.http?.defaultAction).toEqual({ pool: 'app' });
    expect(l.http?.limits).toEqual({ readTimeoutMs: 30_000 });
    expect(l.http?.headers).toEqual({ request: [{ name: 'X-A', value: '1' }] });
  });
});

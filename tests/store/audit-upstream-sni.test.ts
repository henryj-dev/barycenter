/**
 * `upstreamTls.sni` 도 디렉티브 문자열 검증을 지난다 — 검수 2026-08-24 N3
 *
 * ── S-11 이 세운 목록의 **네 번째 누락**
 *
 * `validate/strings.ts` 의 첫 줄이 이렇다:
 *
 * > 원칙: 어떤 사용자 문자열도 raw nginx 디렉티브로 흘러들지 않는다.
 *
 * S-11 이 그 원칙을 실제로 강제하는 자리(`assertDirectiveStrings`)를 만들며 셋을
 * 고쳤다 — `redirect.to` · `pathPrefix` · `backend.host`. **`upstream_tls` 는 그 뒤에
 * 들어왔고 목록에 안 올랐다.**
 *
 * `upstreamTls.sni` 는 `directive('proxy_ssl_name', [lit(tls.sni)])` 로 나간다.
 * `lit()` 이 제어 문자를 막고 인용하므로 디렉티브 **경계**는 안 깨진다. 그런데
 * `proxy_ssl_name` 은 nginx 의 **complex value** 라 `$` 변수가 보간된다 —
 * `redirect.to` 가 물렸던 것과 같은 성질이다. 그리고 호스트 문법을 아무도 안 보므로
 * 오타가 조용히 틀린 SNI 가 된다: 업스트림이 **다른 인증서를 제시하고** 그것을
 * `verify` 가 켜져 있으면 handshake 가 깨지고, 꺼져 있으면 **조용히 잘못된 곳에 붙는다.**
 *
 * ── 검증기는 촘촘한데 이 필드만 비었다
 *
 * `validateModel` 의 upstream_tls 절은 udp·패스스루를 막고 `verify`/`caBundle` 짝과
 * 번들의 자료 유무까지 본다. **`sni` 만 아무도 안 본다.**
 *
 *   npm run test:store     (도커 필요)
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, StoreError, type PatchOp } from '../../src/store/config-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('upstream-sni');

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

/** 풀 하나에 `upstreamTls.sni` 를 얹은 patch. */
const poolWithSni = (sni: string): PatchOp[] => [
  PUT('pool', 'web', {
    protocolClass: 'http', algorithm: 'round_robin',
    upstreamTls: { enabled: true, sni },
  }),
];

async function patch(ops: PatchOp[]): Promise<StoreError | undefined> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  return store.patchChangeset(cs, ops, 't')
    .then(() => undefined, (e: unknown) => e as StoreError);
}

describe('proxy_ssl_name 으로 나가는 문자열', () => {
  it('**변수 참조를 막는다** — `proxy_ssl_name` 은 complex value 라 보간된다', async () => {
    const err = await patch(poolWithSni('$http_host'));
    expect(err).toBeInstanceOf(StoreError);
    expect(err?.status).toBe(400);
  });

  it('호스트가 아닌 문자열을 막는다 — 오타가 조용히 틀린 SNI 가 된다', async () => {
    const err = await patch(poolWithSni('not a host'));
    expect(err).toBeInstanceOf(StoreError);
    expect(err?.status).toBe(400);
  });

  it('제어 문자를 막는다 — `lit()` 이 렌더에서 던지기 전에 저장에서 잡는다', async () => {
    // 여기서 안 막으면 실패가 **plan 시점의 500** 으로 옮겨간다 — `lit()` 이 던지는
    // 것은 `ModelValidationError` 가 아니라 맨 `Error` 라 400 으로 안 접힌다.
    const err = await patch(poolWithSni('a.test\nproxy_pass evil'));
    expect(err).toBeInstanceOf(StoreError);
    expect(err?.status).toBe(400);
  });

  it('멀쩡한 호스트는 그대로 받는다 — 되는 것을 못 쓰게 만들지 않는다', async () => {
    expect(await patch(poolWithSni('upstream.internal'))).toBeUndefined();
  });

  it('`sni` 가 없는 것은 그대로다 — 안 적으면 업스트림 주소가 쓰인다', async () => {
    expect(await patch([
      PUT('pool', 'web', {
        protocolClass: 'http', algorithm: 'round_robin',
        upstreamTls: { enabled: true },
      }),
    ])).toBeUndefined();
  });
});

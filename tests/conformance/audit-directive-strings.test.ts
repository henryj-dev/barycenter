/**
 * 검수 2026-08-22 · S-11 — **검증 안 된 문자열이 디렉티브로 안 간다**
 *
 * `src/validate/strings.ts` 가 첫 줄에 계약을 적어 뒀다:
 * *"어떤 사용자 문자열도 raw nginx 디렉티브로 흘러들지 않는다."*
 * 그런데 검증기를 안 지나는 값이 셋 있었다.
 *
 *   ① `redirect.to`   — `return 301 "<to>"` 로 나간다. nginx 는 **인용된 문자열 안에서도
 *                        변수를 보간한다.** `$http_x` 를 넣으면 그대로 치환되고, 제어문자를
 *                        넣으면 `lit()` 이 일반 `Error` 를 던져 422 가 아니라 **500** 이 된다.
 *   ② `pathPrefix`    — 문법 검사가 전혀 없다. `/` 로 시작 안 해도 되고, `^~` 같은 값이면
 *                        apply 시점 `nginx -t` 에서 터진다.
 *   ③ `backend.host`  — 인용 덕에 주입은 막히지만, 검증이 없어 실패가 저장이 아니라
 *                        **게시 시점**에 난다.
 *
 * 그리고 이미 만들어 둔 `validateHeaderValue`(변수 화이트리스트까지 구현돼 있다)는
 * **어디서도 호출되지 않았다.**
 *
 * ── 어디에 거는가 ──────────────────────────────────────────────────────
 *
 * **해독기가 아니라 쓰기 경계다.** key 문법(S-01b)과 같은 이유다 — `modelAt` 이 옛 리비전
 * 스냅샷을 `decodeModel` 로 읽으므로, 좁히면 그런 값이 든 리비전이 해독 불가가 되고
 * **롤백할 수 없다.** `validateModel` 도 안 된다: `render()` 가 그것을 부르므로 옛 리비전이
 * 렌더 불가가 되고, 롤백은 렌더를 지난다.
 */
import { describe, expect, it } from 'vitest';

import { ConfigStore, StoreError, type PatchOp } from '../../src/store/config-store.js';
import type { Db } from '../../src/store/pg.js';

/**
 * **DB 를 안 태운다.** `shapeCheck` 는 첫 쿼리보다 먼저 던지므로, 쿼리가 나가면 그것
 * 자체가 실패다 — 검사가 늦게 걸렸다는 뜻이다.
 */
const noDb = new Proxy({} as Db, {
  get: () => () => {
    throw new Error('여기까지 오면 안 된다 — shapeCheck 이 먼저 던져야 한다');
  },
});

const store = new ConfigStore(noDb);

const patch = async (op: PatchOp): Promise<void> => {
  await store.patchChangeset('cs', [op], 'tester');
};

const route = (body: Record<string, unknown>): PatchOp => ({
  op: 'put', kind: 'httpRoute', key: 'r1',
  body: { listener: 'front', hosts: ['a.test'], priority: 0, ...body },
});

const redirect = (to: string): PatchOp =>
  route({ action: { kind: 'redirect', to, status: 301 } });

const backend = (host: string): PatchOp => ({
  op: 'put', kind: 'backend', key: 'b1',
  body: { pool: 'app', host, port: 8080, weight: 1 },
});

describe('디렉티브로 가는 문자열 (검수 S-11)', () => {
  it('검증 안 된 문자열이 디렉티브로 안 간다', async () => {
    // ① 화이트리스트 밖의 변수. nginx 가 인용 안에서도 보간한다.
    await expect(patch(redirect('https://a.test/$http_authorization')))
      .rejects.toThrow(StoreError);
    await expect(patch(redirect('https://a.test/$http_authorization')))
      .rejects.toMatchObject({ status: 400 });
    // 변수 참조가 아닌 맨 `$` 도 nginx 가 거절한다.
    await expect(patch(redirect('https://a.test/$'))).rejects.toThrow(StoreError);
    // 제어문자 — 전에는 렌더에서 일반 Error 로 터져 500 이 됐다.
    await expect(patch(redirect('https://a.test/\nX'))).rejects.toThrow(StoreError);

    // ② 경로 접두사.
    await expect(patch(route({
      pathPrefix: 'api/', action: { kind: 'reject', status: 403 },
    }))).rejects.toThrow(StoreError);
    await expect(patch(route({
      pathPrefix: '^~', action: { kind: 'reject', status: 403 },
    }))).rejects.toThrow(StoreError);

    // ③ 백엔드 호스트.
    await expect(patch(backend('not a host'))).rejects.toThrow(StoreError);
    await expect(patch(backend('a; evil'))).rejects.toThrow(StoreError);
  });

  it('멀쩡한 값은 그대로 지난다', async () => {
    // 좁히다가 쓰던 것까지 막으면 안 된다.
    await expect(patch(redirect('https://a.test/new/'))).rejects.toThrow(/여기까지 오면 안 된다/);
    // 화이트리스트 안의 변수는 리다이렉트에서 실제로 쓸모가 있다.
    await expect(patch(redirect('https://a.test$request_uri')))
      .rejects.toThrow(/여기까지 오면 안 된다/);
    await expect(patch(route({
      pathPrefix: '/api/v1/', action: { kind: 'reject', status: 403 },
    }))).rejects.toThrow(/여기까지 오면 안 된다/);
    for (const host of ['10.0.0.1', 'backend.internal', 'bary-v01-pg', '::1', '2001:db8::1']) {
      await expect(patch(backend(host)), host).rejects.toThrow(/여기까지 오면 안 된다/);
    }
  });

  it('해독기는 관대하게 둔다 — 옛 리비전이 읽히고 렌더돼야 한다', async () => {
    // **key 문법과 같은 함정이다.** 여기 넣었으면 그런 값이 든 리비전으로 롤백할 수 없다.
    const { decodeModel } = await import('../../src/model/decode.js');
    const legacy = {
      listeners: [], httpRoutes: [{
        key: 'old', listener: 'front', hosts: ['a.test'], priority: 0,
        pathPrefix: 'no-slash',
        action: { kind: 'redirect', to: 'https://a.test/$http_x', status: 301 },
      }],
      passthroughRoutes: [], pools: [], backends: [],
      certificates: [], tlsPolicies: [], sniBindings: [],
    };
    expect(decodeModel(legacy).ok).toBe(true);
  });
});

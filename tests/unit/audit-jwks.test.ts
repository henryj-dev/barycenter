/**
 * 검수 2026-08-22 · S-06 나머지 — **키 회전을 따라갈 방법이 없다**
 *
 * RS256 은 열렸지만(`oidcKeyFrom`) 키를 **파일이나 환경변수로 한 번** 준다. 실물 IdP 는
 * 키를 돌리고, 돌리는 순간 그 배포의 로그인이 전부 막힌다 — 사람이 PEM 을 다시 받아
 * 넣을 때까지. 그건 "OIDC 를 지원한다" 는 말을 반쯤 거짓으로 만든다.
 *
 * ── 왜 kid 미스에 재조회하지 않는가
 *
 * OIDC 진영의 통상 조언은 "모르는 `kid` 를 보면 JWKS 를 다시 가져와라" 다. 여기서는
 * 안 한다. 이유가 둘이다.
 *
 *  1. **인증 안 된 공격자가 아웃바운드 요청을 유발한다.** 이 검증은 Bearer 를 확인하기
 *     *전에* 도는 자리다 — 아무나 임의 `kid` 를 담은 JWT 를 던져 우리 컨트롤 플레인이
 *     IdP 를 두드리게 만들 수 있다. 속도 제한을 붙여도 그건 표면을 좁힐 뿐 없애지 않는다.
 *  2. **`authenticate` 가 동기다.** 재조회를 넣으면 요청 경로 전체가 async 가 된다.
 *     전송을 바꾸면서 검증 경로의 모양까지 바꾸는 일이 되고, 그 대가가 위 1 번의 새
 *     표면과 맞바꿀 값이 아니다.
 *
 * 대신 **주기로 당긴다.** 회전 창은 갱신 주기만큼이고, OIDC 는 IdP 가 새 키를 *쓰기 전에*
 * 공개하도록 권하므로 그 창이 실무에서 맞는다. 그리고 이 설계에는 공격자가 흔들 수 있는
 * 손잡이가 없다.
 *
 * ── 못 가져오면 무엇이 되나
 *
 * **가진 것을 계속 쓴다.** IdP 가 잠깐 흔들렸다고 로그인이 끊기면 안 된다. 다만 처음부터
 * 하나도 못 가져왔으면 **아무도 못 들어온다** — 빈 캐시로 통과시키는 길은 만들지 않는다.
 */
import { createPublicKey, generateKeyPairSync, createSign } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { JwksCache, jwksKeys } from '../../src/api/jwks.js';
import { principalFromIdToken, type OidcSettings } from '../../src/api/auth.js';

const b64url = (b: Buffer): string =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 실제 RSA 키쌍에서 JWK 를 뽑는다 — 손으로 지어낸 n/e 로는 검증이 뜻을 잃는다. */
function keypair(kid: string): { jwk: Record<string, unknown>; sign: (p: object) => string } {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as Record<string, unknown>;
  return {
    jwk: { ...jwk, kid, alg: 'RS256', use: 'sig' },
    sign: (payload: object): string => {
      const head = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid })));
      const body = b64url(Buffer.from(JSON.stringify(payload)));
      const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey);
      return `${head}.${body}.${b64url(sig)}`;
    },
  };
}

const NOW = 1_700_000_000;
const claims = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: 'https://idp.example', aud: 'bary', exp: NOW + 600, sub: 'u1', role: 'operator', ...over,
});

const A = keypair('key-a');
const B = keypair('key-b');

const settings = (over: Partial<OidcSettings>): OidcSettings => ({
  issuer: 'https://idp.example', audience: 'bary', key: 'unused-hs256-secret',
  now: () => NOW, ...over,
});

const jwksJson = (...jwk: Record<string, unknown>[]): unknown => ({ keys: jwk });

describe('JWKS 해독 (검수 S-06 나머지)', () => {
  it('kid 로 공개키를 찾는다', () => {
    const keys = jwksKeys(jwksJson(A.jwk, B.jwk));
    expect([...keys.keys()].sort()).toEqual(['key-a', 'key-b']);
    expect(keys.get('key-a')?.type).toBe('public');
  });

  it('kid 가 없는 항목은 버린다 — 어느 키인지 말할 수 없다', () => {
    const { kid: _drop, ...noKid } = A.jwk;
    expect(jwksKeys(jwksJson(noKid)).size).toBe(0);
  });

  it('RSA 서명키가 아닌 것은 버린다', () => {
    // 암호화용(`use: "enc"`)이나 다른 알고리즘을 서명 검증에 쓰면 안 된다.
    expect(jwksKeys(jwksJson({ ...A.jwk, use: 'enc' })).size).toBe(0);
    expect(jwksKeys(jwksJson({ ...A.jwk, kty: 'oct', k: 'AAAA' })).size).toBe(0);
  });

  it('망가진 항목 하나가 나머지를 못 버리게 한다', () => {
    // IdP 가 우리가 모르는 키를 하나 끼워 넣었다고 전체 로그인이 막히면 안 된다.
    //
    // 필드가 **빠진** 것으로 잰다. 처음엔 `n` 을 깨진 문자열로 줬는데, Node 의 JWK
    // 해독은 그걸 **안 던지고 통과시킨다**(실측: `n:"!!!not-base64!!!"` → 키가 만들어진다).
    // 그 키는 어떤 서명도 검증하지 못하므로 결과는 fail closed 이고 해롭지 않다 — 다만
    // "버린다" 는 단언이 그 입력에 대해서는 거짓이라 재는 입력을 사실에 맞춘다.
    const { n: _dropped, ...brokenA } = A.jwk;
    const keys = jwksKeys(jwksJson(brokenA, B.jwk));
    expect([...keys.keys()]).toEqual(['key-b']);
  });

  it('모양이 아니면 빈 것이다 — 던지지 않는다', () => {
    // 던지면 갱신 타이머가 죽고, 죽은 타이머는 조용하다.
    expect(jwksKeys(null).size).toBe(0);
    expect(jwksKeys({ keys: 'nope' }).size).toBe(0);
  });
});

describe('JWKS 캐시 (검수 S-06 나머지)', () => {
  const okFetch = (...jwk: Record<string, unknown>[]): typeof fetch =>
    async () => new Response(JSON.stringify(jwksJson(...jwk)), {
      status: 200, headers: { 'content-type': 'application/json' },
    });

  it('당겨 오면 kid 로 답한다', async () => {
    const c = new JwksCache('https://idp.example/jwks', okFetch(A.jwk));
    await c.refresh();
    expect(c.keyFor('key-a')).toBeDefined();
    expect(c.keyFor('key-b')).toBeUndefined();
  });

  it('못 가져오면 가진 것을 계속 쓴다', async () => {
    /**
     * 여기가 요점이다. IdP 가 잠깐 흔들렸다고 로그인이 끊기면 안 된다 — 그건 우리가
     * 만드는 장애다.
     */
    let fail = false;
    const c = new JwksCache('https://idp.example/jwks', async () => {
      if (fail) throw new Error('네트워크가 끊겼다');
      return new Response(JSON.stringify(jwksJson(A.jwk)), { status: 200 });
    });
    await c.refresh();
    fail = true;
    await c.refresh();
    expect(c.keyFor('key-a')).toBeDefined();
  });

  it('처음부터 못 가져왔으면 아무도 못 들어온다', async () => {
    // 빈 캐시를 "검사 없음" 으로 떨어뜨리는 길은 만들지 않는다.
    const c = new JwksCache('https://idp.example/jwks', async () => {
      throw new Error('처음부터 안 된다');
    });
    await c.refresh();
    expect(c.keyFor('key-a')).toBeUndefined();
  });

  it('회전을 따라간다', async () => {
    let published = [A.jwk];
    const c = new JwksCache('https://idp.example/jwks',
      async () => new Response(JSON.stringify(jwksJson(...published)), { status: 200 }));
    await c.refresh();
    expect(c.keyFor('key-b')).toBeUndefined();

    published = [A.jwk, B.jwk];
    await c.refresh();
    expect(c.keyFor('key-b')).toBeDefined();
  });

  it('200 이 아니면 갈아 끼우지 않는다', async () => {
    // 502 본문을 JWKS 로 읽으면 빈 셋이 되고, 그건 멀쩡하던 키를 우리가 버리는 것이다.
    let bad = false;
    const c = new JwksCache('https://idp.example/jwks', async () =>
      bad
        ? new Response('gateway error', { status: 502 })
        : new Response(JSON.stringify(jwksJson(A.jwk)), { status: 200 }));
    await c.refresh();
    bad = true;
    await c.refresh();
    expect(c.keyFor('key-a')).toBeDefined();
  });
});

describe('검증기가 kid 로 키를 고른다 (검수 S-06 나머지)', () => {
  const keys = jwksKeys(jwksJson(A.jwk, B.jwk));
  const resolver = (kid: string | undefined): ReturnType<typeof createPublicKey> | undefined =>
    kid === undefined ? undefined : keys.get(kid);

  it('kid 에 맞는 키로 검증한다', () => {
    expect(principalFromIdToken(A.sign(claims()), settings({ keys: resolver }))?.name).toBe('u1');
    expect(principalFromIdToken(B.sign(claims()), settings({ keys: resolver }))?.name).toBe('u1');
  });

  it('모르는 kid 는 거절한다 — 고정 키로 떨어지지 않는다', () => {
    /**
     * 떨어지면 회전 뒤에도 옛 키로 서명한 토큰이 계속 지나간다. 그건 회전을 켠 배포가
     * 실제로는 안 켠 상태로 도는 것이다.
     */
    const C = keypair('key-c');
    expect(principalFromIdToken(C.sign(claims()), settings({ keys: resolver }))).toBeUndefined();
  });

  it('resolver 가 없으면 지금까지처럼 고정 키를 쓴다', () => {
    // JWKS 를 안 켠 배포가 깨지면 안 된다.
    const pem = createPublicKey({ key: A.jwk as never, format: 'jwk' })
      .export({ type: 'spki', format: 'pem' }).toString();
    expect(principalFromIdToken(A.sign(claims()),
      settings({ key: createPublicKey(pem) }))?.name).toBe('u1');
  });
});

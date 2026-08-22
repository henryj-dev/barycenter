/**
 * 검수 2026-08-22 · S-06 / S-07 — **OIDC 가 실물 IdP 를 못 만난다, 그리고 남의 토큰을 믿는다**
 *
 * 두 결함이 같은 함수에 산다.
 *
 * ── S-06 · RS256 이 도달 불가였다
 *
 * `verifyJwtSig` 는 RS256 을 구현해 뒀는데 `key` 가 `KeyObject` 일 때만 탄다. 그런데
 * 기동 코드는 `BARY_OIDC_KEY` 문자열을 그대로 넣는다 — **문자열이면 RS256 은 무조건
 * false 다.** 즉 구현은 있고 도달할 수 없다. 실물 IdP(Auth0·Okta·Entra·Google·Keycloak)
 * 는 id_token 을 RS256 으로 서명하므로, 이 상태의 OIDC 는 **HMAC 비밀을 나눠 갖는
 * 구성에서만** 동작한다. 그런 구성을 내주는 IdP 는 거의 없다.
 *
 * ── S-07 · `aud` 배열에 이름만 들어 있으면 통과했다
 *
 * `aud` 가 배열이면 우리 audience 가 *포함*되기만 하면 됐다. 같은 IdP 의 다른 클라이언트에
 * 발급된 토큰이 우리를 청중에 얹고 있으면 그대로 지난다. OIDC Core 는 이 경우를 위해
 * `azp`(authorized party)를 두고, **청중이 여럿이면 반드시 있어야 한다**고 못박는다.
 *
 * 역할도 같은 부류다. 최상위 `role` 클레임을 그대로 믿는데, 그 이름은 IdP 마다 다르고
 * 사용자가 프로필로 넣을 수 있는 자리와 충돌하기 쉽다. 어느 클레임이 역할인지는
 * **배포가 정해야** 한다.
 */
import { createSign, generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { oidcKeyFrom, principalFromIdToken, type OidcSettings } from '../../src/api/auth.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PEM = publicKey.export({ type: 'spki', format: 'pem' }).toString();

const b64url = (b: Buffer): string =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** RS256 으로 진짜 서명한다 — 서명 검증을 흉내로 대신하면 이 테스트가 뜻을 잃는다. */
function rs256(payload: Record<string, unknown>): string {
  const head = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const body = b64url(Buffer.from(JSON.stringify(payload)));
  const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(privateKey);
  return `${head}.${body}.${b64url(sig)}`;
}

const NOW = 1_700_000_000;
const base = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  iss: 'https://idp.example', aud: 'barycenter', exp: NOW + 600, sub: 'u1', role: 'operator',
  ...over,
});

const settings = (over: Partial<OidcSettings> = {}): OidcSettings => ({
  issuer: 'https://idp.example',
  audience: 'barycenter',
  key: oidcKeyFrom(PEM),
  now: () => NOW,
  ...over,
});

describe('OIDC 신뢰 경계 (검수 S-06 · S-07)', () => {
  describe('RS256 이 실제로 닿는다', () => {
    it('PEM 문자열은 공개키가 된다', () => {
      const key = oidcKeyFrom(PEM);
      expect(typeof key).not.toBe('string');
    });

    it('PEM 이 아닌 문자열은 HS256 비밀 그대로다', () => {
      // 자동 판별이 HS256 배포를 깨면 안 된다.
      expect(oidcKeyFrom('some-shared-secret')).toBe('some-shared-secret');
    });

    it('RS256 으로 서명한 id_token 을 받는다', () => {
      const p = principalFromIdToken(rs256(base()), settings());
      expect(p?.name).toBe('u1');
      expect(p?.role).toBe('operator');
    });

    it('다른 키로 서명한 것은 안 받는다', () => {
      const other = generateKeyPairSync('rsa', { modulusLength: 2048 });
      const head = b64url(Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
      const body = b64url(Buffer.from(JSON.stringify(base())));
      const sig = createSign('RSA-SHA256').update(`${head}.${body}`).sign(other.privateKey);
      expect(principalFromIdToken(`${head}.${body}.${b64url(sig)}`, settings())).toBeUndefined();
    });
  });

  /**
   * ⚠️ **테스트 이름에 정규식 메타문자를 쓰지 않는다.**
   *
   * 재현물 게이트(`scripts/pinned.mjs`)는 `vitest -t <이름>` 으로 핀을 다시 돌리는데,
   * `-t` 는 **정규식**이다. 처음 이 절의 한 이름을 `aud 배열 + azp 없음 = 거절` 로
   * 썼더니 `+` 가 "앞 문자 1회 이상" 이 되어 **아무 테스트에도 안 맞았고**, 0 건 실행은
   * 성공으로 끝나 게이트에는 "수정 전에도 초록" 으로 보였다 — 핀이 아무것도 안 지키는
   * 상태다. 게이트가 그걸 잡아서 알았다.
   */
  describe('청중이 여럿이면 azp 를 본다', () => {
    it('aud 가 배열인데 azp 가 없으면 거절한다', () => {
      // 여기가 S-07 이다. 전에는 "포함되면 통과" 라 남의 클라이언트 토큰이 지났다.
      const t = rs256(base({ aud: ['other-client', 'barycenter'] }));
      expect(principalFromIdToken(t, settings())).toBeUndefined();
    });

    it('aud 가 배열이고 azp 가 우리면 통과한다', () => {
      const t = rs256(base({ aud: ['other-client', 'barycenter'], azp: 'barycenter' }));
      expect(principalFromIdToken(t, settings())?.name).toBe('u1');
    });

    it('aud 가 배열인데 azp 가 남이면 거절한다', () => {
      const t = rs256(base({ aud: ['other-client', 'barycenter'], azp: 'other-client' }));
      expect(principalFromIdToken(t, settings())).toBeUndefined();
    });

    it('aud 가 하나면 azp 는 안 따진다', () => {
      // OIDC Core 는 단일 청중에서 azp 를 요구하지 않는다. 요구하면 멀쩡한 IdP 가 막힌다.
      expect(principalFromIdToken(rs256(base()), settings())?.name).toBe('u1');
    });

    it('aud 배열의 원소가 하나면 그것도 단일 청중이다', () => {
      const t = rs256(base({ aud: ['barycenter'] }));
      expect(principalFromIdToken(t, settings())?.name).toBe('u1');
    });
  });

  describe('어느 클레임이 역할인지는 배포가 정한다', () => {
    it('안 정하면 role 이다', () => {
      expect(principalFromIdToken(rs256(base()), settings())?.role).toBe('operator');
    });

    it('정하면 그 클레임만 본다', () => {
      const t = rs256(base({ 'https://barycenter/role': 'auditor' }));
      const p = principalFromIdToken(t, settings({ roleClaim: 'https://barycenter/role' }));
      expect(p?.role).toBe('auditor');
    });

    it('정했으면 최상위 role 은 무시한다', () => {
      /**
       * 이게 요점이다. 네임스페이스 클레임을 켜 놓고도 `role` 을 계속 보면, 사용자가
       * 프로필에 넣을 수 있는 자리가 그대로 권한 상승 경로로 남는다 — 고친 것이 아니라
       * **하나 더 늘린 것**이 된다.
       */
      const t = rs256(base({ role: 'admin', 'https://barycenter/role': 'auditor' }));
      const p = principalFromIdToken(t, settings({ roleClaim: 'https://barycenter/role' }));
      expect(p?.role).toBe('auditor');
    });

    it('정한 클레임이 없으면 거절이다 — role 로 안 떨어진다', () => {
      const t = rs256(base({ role: 'admin' }));
      expect(principalFromIdToken(t, settings({ roleClaim: 'https://barycenter/role' })))
        .toBeUndefined();
    });
  });
});

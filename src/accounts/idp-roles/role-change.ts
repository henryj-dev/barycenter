/**
 * **Role Change SET** — IdP 가 「이 사람의 권한이 지금 이렇다」 를 서명해 push 한다(lodestar 클라이언트 등록의 Role Change URI).
 * heliopause `src/set.ts` 와 같은 계약 · 같은 검증이다.
 *
 * ── ID Token 이 아니다
 * ID Token 은 「방금 인증했다」, SET 은 「권한이 지금 X 다」 다. 같은 키로 서명되므로 `typ: secevent+jwt` 를 **가장 먼저**(서명 다음)
 * 본다 — 안 보면 로그인 토큰이 권한 부여로 읽힌다. nonce 가 있는 토큰(ID Token 의 표식)도 거절한다.
 *
 * ── 재사용 · 순서
 * SET 에는 우리가 만든 nonce 가 없다. 그래서 잡아 둔 SET 을 다시 보내면 강등 뒤에 역할이 **되살아난다**. 신선도(iat · exp ·
 * 수명 상한)와 한 번만(jti)을 지킨다. 그리고 SET 은 바뀐 **뒤의 전체 상태**라 늦게 온 옛 것이 철회를 되돌릴 수 있다 — `txn`
 * (발급 밀리초)이 사람마다 마지막으로 적용한 것보다 새로워야 한다. jti 와 txn 은 여러 인스턴스가 함께 보도록 계정 PG 에 둔다
 * (`AccountService.applyRoleChange`). 여기는 저장소 없이 판정할 수 있는 것만 본다.
 *
 * **던지지 않는다** — 결과 객체다. 판정하지 못한 SET 은 아무것도 바꾸지 않는다.
 */
import type { KeyObject } from 'node:crypto';

import { verifiedJws } from '../../api/auth.js';

/** 토큰 수명의 상한 — `exp` 가 뭐라 하든. 1년짜리 SET 은 설정값으로 꾸민 재전송 창이다. */
export const MAX_SET_LIFETIME_S = 3600;
/** 미래에서 온 iat 를 봐주는 폭(시계 차). */
const CLOCK_SKEW_S = 60;
/** 받는 토큰 크기 상한. lodestar 의 SET 은 1KB 안팎이다. */
export const MAX_SET_BYTES = 16 * 1024;

/** Role Change SET 이 말한 것 — 서명 · iss · aud · 시각 · 모양을 지났다. 적용(jti · txn · 매핑)은 `AccountService.applyRoleChange`. */
export type RoleChange = { sub: string; jti: string; txn: bigint; exp: number; roles: string[]; entitlements: string[] };

export type RoleChangeSettings = {
  /** OIDC issuer — SET 의 iss 가 이것이어야 한다. */
  issuer: string;
  /** 우리 client_id — SET 의 aud 에 있어야 한다. */
  clientId: string;
  /**
   * SET 의 `events` 키. RFC 8417 은 정하지 않는다 — IdP 가 정하고 RP 에 알려 준다. **기본값을 두지 않는다**: 틀린 기본값은
   * 서명은 맞는데 이벤트가 없다며 모든 역할 변경을 버리는 조용한 실패가 된다.
   */
  eventKey: string;
  /** `kid` → 공개키(JWKS). **비대칭 키만** — 공유 비밀(HS256)로는 IdP 의 서명을 증명하지 못한다. */
  keyFor: (kid: string | undefined) => KeyObject | undefined;
  now?: () => number;
};

export type RoleChangeVerdict =
  | { ok: true; change: RoleChange }
  | { ok: false; status: 400 | 401; reason: string };

export function verifyRoleChange(token: string, o: RoleChangeSettings): RoleChangeVerdict {
  const no = (status: 400 | 401, reason: string): RoleChangeVerdict => ({ ok: false, status, reason });
  if (token === '' || token.length > MAX_SET_BYTES) return no(400, 'role_change_token 이 없거나 너무 크다');
  const jws = verifiedJws(token, (kid) => o.keyFor(kid));
  if (jws === undefined) return no(401, '서명을 확인하지 못했다(모양 · kid · 알고리즘 · 서명)');
  const { header, payload: p } = jws;
  // 서명 다음 **첫 검사.** 같은 키로 서명한 ID Token 을 권한 주장으로 받지 않는다.
  if (header['typ'] !== 'secevent+jwt') return no(401, `typ 이 secevent+jwt 가 아니다 (${String(header['typ'])})`);
  if ('nonce' in p) return no(401, 'nonce 가 있다 — ID Token 은 역할 변경이 아니다');
  if (p['iss'] !== o.issuer) return no(401, `iss 가 ${o.issuer} 가 아니다`);
  const aud = Array.isArray(p['aud']) ? p['aud'] : [p['aud']];
  if (!aud.includes(o.clientId)) return no(401, '다른 클라이언트에 보낸 SET 이다(aud)');
  const now = Math.floor((o.now?.() ?? Date.now()) / 1000);
  const iat = p['iat'];
  const exp = p['exp'];
  if (typeof iat !== 'number' || !Number.isFinite(iat)) return no(401, 'iat 가 없다');
  if (iat > now + CLOCK_SKEW_S) return no(401, '미래에 발급됐다(iat)');
  if (typeof exp !== 'number' || !Number.isFinite(exp)) return no(401, 'exp 가 없다');
  if (exp <= now) return no(401, '만료됐다(exp)');
  if (exp - iat > MAX_SET_LIFETIME_S) return no(401, `수명이 ${MAX_SET_LIFETIME_S}초를 넘는다`);
  const jti = p['jti'];
  if (typeof jti !== 'string' || jti === '' || jti.length > 200) return no(401, 'jti 가 없다');
  const sub = p['sub'];
  if (typeof sub !== 'string' || sub === '') return no(401, 'sub 가 없다');
  // 순서를 매길 수 없는 스냅숏은 철회를 되돌릴 수 있다 — 필수다.
  const txn = p['txn'];
  if (typeof txn !== 'string' || !/^[0-9]{1,30}$/.test(txn)) return no(401, 'txn 이 없다 — 적용한 것과 순서를 맞출 수 없다');
  const events = p['events'];
  if (events === null || typeof events !== 'object' || Array.isArray(events)) return no(400, 'events 가 없다');
  const ev = Object.hasOwn(events, o.eventKey) ? (events as Record<string, unknown>)[o.eventKey] : undefined;
  if (ev === null || typeof ev !== 'object' || Array.isArray(ev)) {
    // 받은 키를 말한다 — IdP 가 정한 키를 운영자가 모를 때 이 한 줄로 찾는다(`BARY_OIDC_ROLE_CHANGE_EVENT`).
    // 여기는 서명 · iss · aud · 시각을 이미 지난 자리다 — 위조가 아닌 IdP 의 SET 만 이 말을 남긴다. 키는 공개된 URI 다.
    const got = Object.keys(events).slice(0, 5).map((k) => JSON.stringify(k.slice(0, 200))).join(', ');
    return no(400, `역할 변경 이벤트가 없다(events 키가 설정과 다르다) — 받은 키: ${got === '' ? '없음' : got}`);
  }
  // 두 배열은 SET 에 **언제나** 있다 — 빈 배열은 「모두 철회」 다. 없는 키를 「안 바뀜」 으로 읽지 않는다.
  const e = ev as Record<string, unknown>;
  const roles = e['roles'];
  const entitlements = e['entitlements'];
  if (!Array.isArray(roles) || !roles.every((x) => typeof x === 'string')) return no(400, 'roles 가 문자열 배열이 아니다');
  if (!Array.isArray(entitlements) || !entitlements.every((x) => typeof x === 'string')) return no(400, 'entitlements 가 문자열 배열이 아니다');
  return { ok: true, change: { sub, jti, txn: BigInt(txn), exp, roles: roles as string[], entitlements: entitlements as string[] } };
}

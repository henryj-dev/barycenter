/**
 * IdP OTP 제공자 등록부 — `BARY_MFA_IDP_KIND` 의 이름으로 고른다.
 *
 * 다른 제공자를 붙이려면: `MfaProvider` 를 구현한 파일 하나 + 아래 표에 한 줄.
 */
import { lodestarOtp } from './lodestar.js';
import type { MfaProvider } from './provider.js';

export type IdpMfaConfig = {
  /** IdP 주소(https). 기본은 OIDC issuer — 설정이 정한다. */
  baseUrl: string;
  /** 서비스 토큰(파일에서 읽은 값). */
  serviceToken: string;
  fetch?: typeof fetch;
};

const PROVIDERS: Readonly<Record<string, (c: IdpMfaConfig) => MfaProvider>> = {
  lodestar: (c) => lodestarOtp(c),
};

export function idpMfaKinds(): string[] {
  return Object.keys(PROVIDERS);
}

/** 모르는 이름이면 던진다 — 기동이 거부된다(조용히 로컬로 떨어지지 않게). */
export function idpMfaProvider(kind: string, c: IdpMfaConfig): MfaProvider {
  const make = Object.hasOwn(PROVIDERS, kind) ? PROVIDERS[kind] : undefined;
  if (make === undefined) throw new Error(`모르는 IdP OTP 제공자: ${kind} (쓸 수 있는 것: ${idpMfaKinds().join(', ')})`);
  return make(c);
}

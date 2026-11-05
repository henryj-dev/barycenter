/**
 * 둘째 인증 수단의 **어댑터 계약** — 로컬 TOTP 와 IdP OTP(lodestar …)가 같은 모양으로 답한다.
 *
 * 다른 제공자를 붙이려면 이 인터페이스의 구현 하나와 `registry.ts` 의 등록 한 줄이면 된다.
 * 정책(누가 어느 수단을 쓰는가 · 실패를 어떤 상태로 돌려주는가)은 `AccountService` 가 정한다.
 *
 * **실패를 예외로 던지지 않는다** — 결과 객체다. 호출자가 try/catch 로 「틀린 코드」를 알아내야 하면
 * 언젠가 네트워크 실패를 틀린 코드로(또는 그 반대로) 읽고, 둘째 인증이 열린다.
 */
import type { Queryable } from '../../store/db.js';

/** 실패의 뜻 여섯 가지 (heliopause `OtpFailure` 와 같은 뜻). */
export type MfaFailure =
  /** 코드가 틀렸거나 이미 썼다. 사람이 다시 넣을 수 있는 유일한 실패다. */
  | 'wrong-code'
  /** 그 사람에게 등록된 OTP 가 없다. */
  | 'not-enrolled'
  /** 제공자가 그 계정을 활성으로 보지 않는다(비활성 · 잠김). 다시 넣어도 안 된다. */
  | 'account-inactive'
  /** 제공자가 시도를 제한했다. */
  | 'rate-limited'
  /** 제공자가 **우리** 서비스 토큰을 거절했다 — 배포 문제다. */
  | 'service-token'
  /** 제공자에 닿지 못했거나 알 수 없는 답을 받았다. */
  | 'unavailable';

export type MfaResult = { ok: true } | { ok: false; reason: MfaFailure; detail: string };

/** 감사(`account_audit`)에 남는 수단 이름. 복구 코드(`recovery`)는 제공자가 아니라 언제나 로컬이다. */
export type MfaMethod = 'totp' | 'idp_otp';

export type MfaCheck = {
  /** barycenter 사용자 id. */
  userId: string;
  /** IdP 주체(그 IdP 와의 연결의 OIDC `sub`). 로컬 제공자는 쓰지 않는다. */
  subject: string | undefined;
  /** 사람이 넣은 그대로. */
  code: string;
  /** 호출자의 트랜잭션 — 로컬 재사용 방지(last_step)를 같은 트랜잭션에서 갱신한다. */
  db: Queryable;
};

export interface MfaProvider {
  readonly method: MfaMethod;
  /** 결과를 돌려준다. 판정 때문에 던지지 않는다(프로그래밍 오류 · 저장소 장애만 던진다). */
  verify(check: MfaCheck): Promise<MfaResult>;
}

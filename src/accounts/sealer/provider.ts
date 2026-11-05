/**
 * 계정 PG 에 두는 비밀(TOTP 비밀키)을 **감싸는 쪽의 계약** — 로컬 AES-GCM 과 Vault transit 이 같은 모양으로 답한다.
 *
 * 다른 방식을 붙이려면 이 인터페이스의 구현 하나와 `registry.ts` 의 등록 한 줄이면 된다.
 *
 * **봉인값은 앞머리로 제 방식을 말한다** — 로컬은 `v1.`, Vault transit 은 `vault:`. 열 때는 설정이 아니라 **값의
 * 앞머리**로 구현을 고른다(`registry.ts` 의 `routedSealer`). 그래서 봉인 방식을 바꿔도 옛 값이 그대로 열린다.
 *
 * **실패를 예외로 던지지 않는다** — 결과 객체다. 「키가 틀렸다(값이 다른 행 · 다른 키의 것)」와 「저쪽에 닿지 못했다」를
 * 호출자가 가를 수 있어야 운영자가 원인을 안다.
 */

export type SealFailure =
  /** 봉인값이 어느 방식의 모양도 아니다 · 깨졌다. */
  | 'malformed'
  /** 그 앞머리의 방식이 이 배포에 설정돼 있지 않다(예: Vault 값인데 Vault 설정이 없다). */
  | 'no-sealer'
  /** 무결성 검사 실패 — 다른 키 · 다른 행(aad)의 값이다. 다시 해도 같다. */
  | 'integrity'
  /** 저쪽(Vault)이 우리 자격(토큰 · 정책)을 거절했다 — 배포 문제다. */
  | 'denied'
  /** 저쪽에 닿지 못했거나 알 수 없는 답을 받았다. 다시 하면 될 수 있다. */
  | 'unavailable';

export type SealResult = { ok: true; sealed: string } | { ok: false; reason: SealFailure; detail: string };
export type OpenResult = { ok: true; plain: Buffer } | { ok: false; reason: SealFailure; detail: string };

export interface Sealer {
  /** 등록부 이름(`local` · `vault-transit`). */
  readonly kind: string;
  /** 이 구현이 만드는 봉인값의 앞머리. 열 구현을 이것으로 고른다. */
  readonly prefix: string;
  /**
   * `aad` 는 그 값이 묶인 행(예: `totp:<사용자 id>`)이다 — 다른 행에 옮겨 붙인 봉인값은 안 열린다.
   * **detail 에 평문 · 키 · 토큰을 싣지 않는다.**
   */
  seal(plain: Buffer, aad: string): Promise<SealResult>;
  open(sealed: string, aad: string): Promise<OpenResult>;
}

/**
 * 인증 실패 제한의 **저장소 계약** — 인스턴스 메모리(`memory`, 기본)와 공유 PG(`pg`)가 같은 모양으로 답한다.
 *
 * 왜 바꿔 끼우나: 메모리는 인스턴스마다 따로 센다. 클러스터 · 전역+지역처럼 같은 이름이 여러 노드로 나뉘면 공격자는
 * 노드 수만큼 더 시도한다. `pg` 는 사람 계정 PG 의 `auth_throttle` 에서 **모두가 함께** 센다.
 *
 * 뜻(두 구현 공통): 실패 하나를 더하고, 정해진 횟수(기본 5)를 넘으면 지수로 늘어나는 대기(1초~60초)를 돌려준다.
 * 마지막 실패에서 10분이 지나면 처음부터 센다. 성공하면 그 키를 지운다.
 *
 * **실패는 결과다.** 저장소에 닿지 못하면 `unavailable` — 호출자(`server.ts`)가 정책대로 답한다.
 * **메모리로 떨어지지 않는다**: 떨어지면 「공유해서 센다」고 믿는 배포가 조용히 노드마다 센다.
 */

export type LimitResult =
  /** 기록했다. `retryAfterS` 가 있으면 그만큼 막는다(429). */
  | { ok: true; retryAfterS?: number }
  | { ok: false; reason: 'unavailable'; detail: string };

export interface RateLimitStore {
  /** 등록부 이름(`memory` · `pg`). */
  readonly kind: string;
  /** 실패 하나를 더한다. */
  record(key: string): Promise<LimitResult>;
  /** 성공 — 그 키의 계수를 지운다. **던지지 않는다**(실패는 결과). */
  clear(key: string): Promise<{ ok: true } | { ok: false; detail: string }>;
}

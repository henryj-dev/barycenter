/**
 * `pinned-lib.mjs` 의 타입 선언.
 *
 * `scripts/` 는 `.mjs` 다 — 게이트는 빌드 없이 `node scripts/x.mjs` 로 도는 것이 계약이고,
 * 그래야 `dist/` 가 없는 상태(그리고 부모 트리를 세운 worktree)에서도 선다.
 *
 * 그런데 `tests/unit/pinned-gate.test.ts` 는 이 모듈을 **import 한다** — 판정을 자식
 * 프로세스로 돌려서는 못 재기 때문이다. `scripts/` 의 다른 것들은 전부 `execFileSync`
 * 로 부르므로 이 문제가 없었고, 그래서 선언이 필요한 것도 여기가 처음이다.
 *
 * 구현을 `.ts` 로 옮기지 않는 이유: 그러면 게이트가 빌드에 의존하게 되고, **빌드가
 * 깨졌을 때 그것을 잡아야 할 게이트가 함께 죽는다.**
 */

/** 실행 결과의 판정. */
export type PinVerdict =
  /** 수정 전에 빨갛다 — 재현물이 무언가를 지킨다. */
  | 'red'
  /** 수정 전에도 초록이다 — 아무것도 안 지킨다. */
  | 'green'
  /** 고른 테스트가 0 건이다 — 표식이 틀렸다. */
  | 'empty'
  /** 러너가 기동에서 죽었다 — 아무 테스트도 안 돌았다. */
  | 'crashed';

/**
 * 표식 → vitest 인자. `-t` 값은 **이스케이프된다** — 표식은 사람이 읽는 리터럴이지
 * 정규식이 아니다.
 */
export function markerArgv(mark: string): { argv: string[] };

export function verdictOf(input: { threw: boolean; text: string }): PinVerdict;

/**
 * 핀 게이트의 **판정 부분** — 순수 함수로 뽑아 둔다 (2026-08-23).
 *
 * `pinned.mjs` 는 worktree 를 만들고 vitest 를 돌리므로 통째로는 못 잰다. 그런데 이
 * 게이트가 통과 신호를 위조하면 그 위에 쌓은 모든 회차의 "재현물이 있다" 가 근거를
 * 잃는다 — 그래서 **판정만 갈라서** 잰다.
 *
 * 제안 6 회차에서 구멍 둘이 한꺼번에 드러났다. 둘 다 여기 있다.
 */

/**
 * 표식 → vitest 인자.
 *
 * **`-t` 는 정규식이다.** 표식에 적은 이름은 사람이 읽는 리터럴이므로 이스케이프한다.
 *
 * 안 하면 두 가지로 터진다:
 *
 *   · `(제안 #6)` — 괄호가 캡처 그룹이 되어 **괄호를 리터럴로 가진 이름과 안 맞는다.**
 *     고른 테스트가 0 건이고 vitest 는 성공으로 끝낸다 → 게이트가 "수정 전에도 초록"
 *     으로 **거짓 실패**를 낸다.
 *   · `**실제로 막는다**` — `**` 가 `Nothing to repeat` 이라 vitest 가 **기동에서 죽는다.**
 *
 * 이스케이프한 뒤에도 원래 이름을 고른다 — 리터럴 매칭이 원래 의도였다.
 */
export function markerArgv(mark) {
  const m = /^(\S+)(?:\s+-t\s+"(.+)")?$/.exec(mark);
  if (m === null) return { argv: [mark] };
  const file = m[1];
  if (m[2] === undefined) return { argv: [file] };
  return { argv: [file, '-t', escapeRegExp(m[2])] };
}

/** 정규식 메타문자를 리터럴로. */
const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 실행 결과 → 판정.
 *
 *   `red`     수정 전에 빨갛다 — 재현물이 무언가를 지킨다
 *   `green`   수정 전에도 초록이다 — 아무것도 안 지킨다
 *   `empty`   고른 테스트가 0 건이다 — 표식이 틀렸다
 *   `crashed` 러너가 기동에서 죽었다 — **아무 테스트도 안 돌았다**
 *
 * ── `crashed` 를 왜 가르나
 *
 * 옛 코드는 `execFileSync` 가 던진 것을 **전부 빨강으로** 셌다. 그런데 잘못된 `-t`
 * 정규식이나 못 읽는 설정은 테스트를 한 건도 안 돌리고 던진다 — 그걸 "수정 전에
 * 빨갛다" 로 세는 것은 **통과 신호를 위조하는 것**이다. 게이트가 자기 실패를 성공으로
 * 읽으면 그 게이트는 없는 것보다 나쁘다.
 */
export function verdictOf({ threw, text }) {
  // ① 기동 실패가 먼저다 — 이 경우 테스트 요약 자체가 없다.
  if (/Startup Error|Invalid regular expression|Failed to load config/.test(text)) return 'crashed';

  // ② **모듈이 없어 못 선 것은 가장 강한 빨강이다.**
  //
  //    새 모듈을 낸 커밋에서는 부모 트리에 그 파일이 없다. 그러면 vitest 는 수집에서
  //    `Failed to load url …/src/…` 로 죽고 `Tests  no tests` 를 찍는다 — 문구만 보면
  //    "0 건" 과 같아서 옛 규칙은 "표식이 틀렸다" 로 오차단했다.
  //
  //    그런데 이건 재현물이 **수정 없이는 아예 못 선다**는 뜻이고, 게이트가 겨누는
  //    "고쳐도 안 고쳐도 초록" 의 정반대다. `src/` 를 못 읽은 것만 이렇게 센다 —
  //    `tests/` 안의 오타는 표식 문제이므로 아래 ③ 으로 떨어진다.
  if (threw && /Failed to load url [^\n]*\/src\//.test(text)) return 'red';

  // ③ 고른 테스트가 0 건. **`no tests` 를 함께 본다** — `-t` 가 아무것도 안 고르면
  //    vitest 는 이 문구를 찍고 **성공으로** 끝낸다. 옛 가드는 `Tests +0 …` 만 봐서
  //    그냥 지나갔고, 게이트가 멀쩡한 재현물을 "수정 전에도 초록" 으로 판정했다.
  if (/No test files found|Tests +0 (passed|failed)|Tests +no tests/.test(text)) return 'empty';

  return threw ? 'red' : 'green';
}

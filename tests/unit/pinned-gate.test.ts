/**
 * **핀 게이트 자체를 잰다** (2026-08-23).
 *
 * `scripts/pinned.mjs` 는 이 저장소가 "재현물 없이 고치지 않는다" 를 강제하는 장치다.
 * 그런데 **그 장치를 재는 것이 없었다.** 제안 6 회차에서 구멍 둘이 한꺼번에 드러났다.
 *
 * ── ① 정규식 메타문자가 필터를 조용히 비운다
 *
 * `-t` 는 vitest 에서 **정규식**이다. 표식에 `(제안 #6)` 처럼 괄호가 들어가면 그건
 * 캡처 그룹이 되고, 괄호를 **리터럴로 가진** 테스트 이름과는 안 맞는다. 그러면 고른
 * 테스트가 0 건이고, vitest 는 그것을 **성공으로** 끝낸다 — 게이트는 "수정 전에도
 * 초록이다" 로 읽는다. **재현물이 멀쩡한데 게이트가 거짓 실패를 낸다.**
 *
 * 0 건 가드가 있었지만 `Tests +0 (passed|failed)` 만 봤다. vitest 는 그 경우
 * **`Tests  no tests`** 라고 찍는다 — 문구가 달라 가드를 그냥 지나갔다.
 *
 * ── ② 러너가 죽으면 "빨갛다" 로 센다 (더 나쁘다)
 *
 * `**실제로 막는다**` 같은 표식은 `**` 가 유효한 정규식이 아니라 vitest 가 기동에서
 * **SyntaxError 로 죽는다.** 그러면 `execFileSync` 가 던지고, 게이트의 catch 는 그것을
 * 그대로 "수정 전에 빨갛다" 로 센다 — **아무 테스트도 안 돌았는데 통과한다.**
 *
 * 이게 이 파일이 존재하는 이유다: 게이트가 통과 신호를 위조하면, 그 위에 쌓은 모든
 * 회차의 "재현물이 있다" 가 근거를 잃는다.
 */
import { describe, expect, it } from 'vitest';

import { markerArgv, verdictOf } from '../../scripts/pinned-lib.mjs';

describe('핀 게이트 — 표식 해석', () => {
  it('파일만 있는 표식', () => {
    expect(markerArgv('tests/unit/a.test.ts')).toEqual({ argv: ['tests/unit/a.test.ts'] });
  });

  it('파일과 이름', () => {
    expect(markerArgv('tests/unit/a.test.ts -t "이름"'))
      .toEqual({ argv: ['tests/unit/a.test.ts', '-t', '이름'] });
  });

  it('표식의 선택적 띄어쓰기가 테스트 선택을 비우지 않는다', () => {
    const { argv } = markerArgv('tests/unit/a.test.ts -t "TLS 가 없다"');
    expect(new RegExp(argv[2]!).test('TLS가 없다')).toBe(true);
  });

  it('**정규식 메타문자를 이스케이프한다** — `-t` 는 정규식이다', () => {
    /**
     * 괄호를 그대로 넘기면 캡처 그룹이 되고, 괄호를 리터럴로 가진 테스트 이름과 안
     * 맞는다. 고른 테스트가 0 건이 되고 vitest 는 그걸 성공으로 끝낸다.
     */
    const { argv } = markerArgv('tests/unit/a.test.ts -t "레이트리밋 (제안 #6)"');
    expect(argv[2]).toBe('레이트리밋\\s*\\(제안\\s*#6\\)');
  });

  it('`*` 도 이스케이프한다 — 안 하면 러너가 기동에서 죽는다', () => {
    // `**실제로**` 는 `Nothing to repeat` 으로 vitest 가 SyntaxError 를 던진다.
    const { argv } = markerArgv('tests/unit/a.test.ts -t "**실제로 막는다**"');
    expect(argv[2]).toBe('\\*\\*실제로\\s*막는다\\*\\*');
    expect(() => new RegExp(argv[2]!)).not.toThrow();
  });

  it('이스케이프한 것이 원래 이름을 여전히 고른다', () => {
    const name = '레이트리밋·커넥션 제한 (제안 #6)';
    const { argv } = markerArgv(`tests/unit/a.test.ts -t "${name}"`);
    expect(new RegExp(argv[2]!).test(name)).toBe(true);
  });
});

describe('핀 게이트 — 판정', () => {
  const OUT_GREEN = ' Test Files  1 passed (1)\n      Tests  3 passed (3)\n';
  const OUT_RED = ' Test Files  1 failed (1)\n      Tests  2 failed | 1 passed (3)\n';

  it('빨가면 통과 — 그것이 재현물의 뜻이다', () => {
    expect(verdictOf({ threw: true, text: OUT_RED })).toBe('red');
  });

  it('초록이면 실패 — 아무것도 안 지킨다', () => {
    expect(verdictOf({ threw: false, text: OUT_GREEN })).toBe('green');
  });

  it('**0 건이면 표식이 틀린 것이다** — 성공으로 끝나도 통과가 아니다', () => {
    expect(verdictOf({ threw: false, text: ' Test Files  1 passed (1)\n      Tests  0 passed (0)\n' }))
      .toBe('empty');
    expect(verdictOf({ threw: false, text: 'No test files found' })).toBe('empty');
  });

  it('**vitest 의 `no tests` 문구도 0 건이다** — 이 문구를 놓쳐서 거짓 실패가 났다', () => {
    /**
     * `-t` 가 아무것도 안 고르면 vitest 는 `Tests  no tests` 라고 찍고 **성공으로**
     * 끝낸다. 옛 가드는 `Tests +0 (passed|failed)` 만 봐서 그냥 지나갔고, 게이트는
     * 멀쩡한 재현물을 "수정 전에도 초록" 으로 판정했다.
     */
    expect(verdictOf({ threw: false, text: ' Test Files  1 passed (1)\n      Tests  no tests\n' }))
      .toBe('empty');
  });

  it('모든 테스트가 건너뛰어져도 0건으로 판정한다', () => {
    expect(verdictOf({
      threw: false,
      text: ' Test Files  1 skipped (1)\n      Tests  5 skipped (5)\n',
    })).toBe('empty');
  });

  it('**러너가 기동에서 죽으면 빨강이 아니다** — 아무 테스트도 안 돌았다', () => {
    /**
     * 여기가 더 나쁜 구멍이었다. 표식의 `**` 가 정규식으로 안 서면 vitest 는
     * `SyntaxError: Invalid regular expression` 으로 **기동에서** 죽고, `execFileSync`
     * 가 던진다. 옛 코드는 던진 것을 전부 "빨갛다" 로 셌다 — **통과 신호를 위조한다.**
     */
    const crash = 'Startup Error\nSyntaxError: Invalid regular expression: /**x**/: Nothing to repeat';
    expect(verdictOf({ threw: true, text: crash })).toBe('crashed');
  });

  it('**모듈이 없어 못 선 것은 가장 강한 빨강이다**', () => {
    /**
     * 새 모듈을 낸 커밋에서는 부모 트리에 그 파일이 없다. vitest 는 수집에서
     * `Failed to load url …/src/…` 로 죽고 `Tests  no tests` 를 찍는다 — 문구만 보면
     * "0 건" 과 같아서 옛 규칙은 "표식이 틀렸다" 로 **오차단했다.**
     *
     * 그런데 이건 재현물이 수정 없이는 **아예 못 선다**는 뜻이고, 게이트가 겨누는
     * "고쳐도 안 고쳐도 초록" 의 정반대다.
     */
    const out = ' FAIL  tests/unit/a.test.ts\n'
      + 'Error: Failed to load url ../../src/control/x.js (resolved id: ../../src/control/x.js)\n'
      + ' Test Files  1 failed (1)\n      Tests  no tests\n';
    expect(verdictOf({ threw: true, text: out })).toBe('red');
  });

  it('`tests/` 안의 오타는 빨강이 아니다 — 그건 표식 문제다', () => {
    // `src/` 를 못 읽은 것만 ②로 센다. 테스트끼리의 import 오타까지 빨강으로 세면
    // 게이트가 오타를 재현물로 인정하게 된다.
    const out = 'Error: Failed to load url ./helpers/nope.js\n Test Files  1 failed (1)\n      Tests  no tests\n';
    expect(verdictOf({ threw: true, text: out })).toBe('empty');
  });

  it('설정을 못 읽어도 빨강이 아니다', () => {
    expect(verdictOf({ threw: true, text: 'Error: Failed to load config from vitest.config.ts' }))
      .toBe('crashed');
  });
});

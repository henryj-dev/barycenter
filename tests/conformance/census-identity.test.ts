/**
 * **신원 비교 census 를 기계화한다** (39차 검수의 처방 ③)
 *
 * 이 레포는 신원 비교(`operationId`/`transitionId`/`leaderToken`) 자리를 **여섯 번
 * 손으로 셌고 여섯 번 다 뭔가 나왔다.**
 *
 * ```
 * 34차 census → 35차가 한 자리 · 35차 → 36차가 하나
 * 36차 → 37차가 둘 · 37차 → 38차가 셋 · 38차 → 39차가 둘
 * ```
 *
 * **손으로 세는 census 로는 이 부류를 못 닫는다** — 그것이 여섯 번의 결론이다.
 * 그런데 이 자리들은 **구문적으로 열거 가능**하다. 그래서 목록을 못박는다:
 * 새 비교 자리가 생기면 이 테스트가 **분류되기 전에** 빨개진다.
 *
 * 잡는 것은 "이 자리가 옳은가" 가 아니라 **"이 자리를 누가 셌는가"** 다. 판정은 여전히
 * 사람이 하고, 이 테스트는 **판정 없이 지나가는 것**만 막는다.
 *
 * **한계**: `grep` 은 직접 비교만 잡는다. 헬퍼를 우회해 파생 키를 비교하면 빠져나간다.
 * 그래서 공인 헬퍼를 `ownsJournal`·`authoredBy` 둘로 좁혀 두는 것이 이 계측의 전제다.
 * 그 전제가 깨지면 이 테스트도 같이 눈이 먼다 — **계측기의 한계를 계측기 옆에 적는다.**
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(import.meta.dirname, '../../src/dp');

/** 직접 신원 비교가 있는 줄을 센다. */
const sites = (): { file: string; line: number; text: string }[] => {
  const out: { file: string; line: number; text: string }[] = [];
  for (const file of readdirSync(SRC).filter((f) => f.endsWith('.ts')).sort()) {
    const lines = readFileSync(join(SRC, file), 'utf8').split('\n');
    lines.forEach((text, i) => {
      // **줄이 아니라 자리를 센다.** 다중행 비교는 `operationId` 줄과 `transitionId`
      // 줄로 쪼개지므로 둘 다 세면 한 자리가 둘로 잡힌다(첫 시도가 74 를 셌다).
      // 신원 비교는 반드시 `operationId` 를 한 번 보므로 그것만 센다.
      if (/\.operationId (===|!==)/.test(text)) {
        out.push({ file, line: i + 1, text: text.trim() });
      }
    });
  }
  return out;
};

describe('신원 비교 자리는 세어져 있다', () => {
  /**
   * **숫자를 못박는 이유.** 파일:줄로 박으면 무관한 편집마다 깨져서 아무도 안 읽는
   * 테스트가 된다. 개수만 박으면 **자리가 늘거나 줄 때만** 깨진다 — 그때가 정확히
   * 사람이 판정해야 하는 순간이다.
   *
   * 늘었으면: 새 자리를 분류하고(토큰 봄 / 의도적 id-only / 위임) **근거를 코드에 적고**
   * 이 숫자를 올려라. 줄었으면: 무엇이 사라졌는지 확인하고 내려라.
   * **숫자만 고치고 지나가는 것이 이 테스트를 무력화하는 유일한 방법이고, 그건
   * 리뷰에서 보인다.**
   */
  it('직접 비교 자리가 22 곳이다', () => {
    const found = sites();
    expect(
      found.length,
      `신원 비교 자리가 바뀌었다 — 새 자리를 분류하고 근거를 적은 뒤 숫자를 고쳐라.\n`
        + found.map((s) => `  ${s.file}:${s.line}  ${s.text}`).join('\n'),
    ).toBe(22);
  });

  /**
   * **공인 헬퍼가 둘이라는 것**이 위 계측의 전제다. 셋째가 생기면 grep 이 놓치는
   * 우회로가 생긴다 — 그때 이 테스트가 알려 준다.
   */
  /**
   * ⚠️ **39차에 여기 적은 서사는 거짓이었다** (40차가 뒤집었다).
   *
   * 그때 이렇게 적었다 — *"계측기가 첫 실행에서 `assertInvariants` 의 I1 토큰 대조를
   * 찾았다. 일곱 번째다. 계측기가 나를 고쳤다."* **전부 틀렸다.**
   *
   * `assertInvariants` 는 720~935 행이고 그 안에 `normalizeNumeric` 이 **하나도 없다**
   * (I1 은 `big(x) !== max` 형이라 지문 밖이다). 계측기가 잡은 것은 `finishOperation` 의
   * 자리 — **10차부터 있던 것**이다. 첫 판이 최상위 `function` 선언만 찾아서 850 줄짜리
   * 클래스 구간을 직전 최상위 함수 이름으로 오귀속했고, **나는 그 잘못된 이름표에 맞는
   * 이야기를 지어 냈다.** I1 이 실제로 토큰을 보긴 하므로 이야기가 그럴듯했을 뿐이다.
   *
   * 그리고 **계측기의 초록이 계측기 자신의 버그에 의존했다** — 귀속을 고치자마자 빨개졌다.
   * 40차가 뮤턴트로 실증하기를, 그 850 줄 안에 새 토큰 대조를 넣어도 집합이 안 변해
   * **검출력이 정확히 0** 이었다.
   *
   * 이것이 이 시리즈에서 제일 나쁜 실패다. **"작성자가 새로 쓴 근거가 거짓" 병이
   * 재발하지 않았다고 선언한 바로 그 커밋에서, 그 병을 끝내려고 만든 계측기 안에서
   * 재발했다.** 지문도 `!==` 형을 빠뜨려 `releaseHolderSlots` 를 놓쳤다 — 그래서
   * "셋" 이라는 숫자도 틀렸다. 넷이다.
   */
  // **계측기가 제 몫을 했다** (41차). CE-41-A 를 고치며 `ownsSlotOp` 을 넣자 이 테스트가
  // 즉시 빨개졌다 — 새 자리가 판정 없이 지나가지 않는다는 것이 이 계측의 목적이고,
  // 그것이 실제로 일어난 첫 사례다. 넷 → 다섯.
  it('토큰까지 대조하는 자리는 다섯이다', () => {
    // 토큰 대조의 지문은 `=== normalizeNumeric(` 이다. 그 자리를 감싸는 함수 이름을
    // 역방향으로 찾는다. (첫 시도는 "본문 600 자 안에 `normalizeNumeric`" 으로 느슨하게
    // 잡아 `tupleFor` 까지 걸렸다 — **계측기가 자기 첫 판정에서 틀렸다.**)
    // **최상위 함수와 클래스 메서드를 둘 다 본다.** 첫 판(39차)은 최상위 `function`
    // 선언만 찾아서, `DpAgent` 메서드 안의 자리를 **직전 최상위 함수로 오귀속**했다 —
    // 그 구간이 850 줄이라 그 안의 모든 자리가 같은 이름표를 받았다.
    const owners: string[] = [];
    let current = '(모듈 최상위)';
    for (const file of ['agent.ts', 'apply.ts', 'driver.ts', 'operation.ts']) {
      readFileSync(join(SRC, file), 'utf8').split('\n').forEach((text) => {
        const top = /^(?:export )?(?:async )?function (\w+)\(/.exec(text);
        const method = /^  (?:private |readonly |static |async |#)*(\w+)[(<]/.exec(text);
        if (top !== null) current = top[1]!;
        else if (method !== null) current = method[1]!;
        if (/(===|!==) normalizeNumeric\(/.test(text)) owners.push(current);
      });
    }
    expect(
      [...new Set(owners)].sort(),
      '토큰을 대조하는 자리가 늘었다 — 늘리는 것 자체는 좋지만 census 의 전제가 바뀐다',
    ).toEqual(['authoredBy', 'finishOperation', 'ownsJournal', 'ownsSlotOp', 'releaseHolderSlots']);
  });
});

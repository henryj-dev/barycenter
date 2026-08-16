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
   * **전제가 틀렸다는 것을 계측기가 첫 실행에서 알려 줬다.** 39차 검수는 "공인 헬퍼는
   * `ownsJournal`·`authoredBy` 둘" 이라고 적었고 나도 그렇게 못박으려 했는데,
   * 실제로는 **셋**이다 — `assertInvariants` 안의 I1 검사가 토큰을 대조한다.
   *
   * 여섯 번의 손 census 가 이것도 안 셌다. **자리를 세는 계측기를 만들자마자 그 계측기가
   * 일곱 번째를 찾았다** — 손으로 세는 것을 그만두는 것이 옳았다는 증거다.
   */
  it('토큰까지 대조하는 자리는 셋이다', () => {
    // 토큰 대조의 지문은 `=== normalizeNumeric(` 이다. 그 자리를 감싸는 함수 이름을
    // 역방향으로 찾는다. (첫 시도는 "본문 600 자 안에 `normalizeNumeric`" 으로 느슨하게
    // 잡아 `tupleFor` 까지 걸렸다 — **계측기가 자기 첫 판정에서 틀렸다.**)
    const agent = readFileSync(join(SRC, 'agent.ts'), 'utf8');
    const owners = [...agent.matchAll(/=== normalizeNumeric\(/g)].map((m) => {
      const before = agent.slice(0, m.index);
      const fn = [...before.matchAll(/^(?:export )?function (\w+)\(/gm)].pop();
      return fn?.[1] ?? '(모듈 최상위)';
    });
    expect(
      [...new Set(owners)].sort(),
      '토큰을 대조하는 자리가 늘었다 — 늘리는 것 자체는 좋지만 census 의 전제가 바뀐다',
    ).toEqual(['assertInvariants', 'authoredBy', 'ownsJournal']);
  });
});

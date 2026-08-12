/**
 * 6차 검수 — DESIGN 과 실제 ABI 가 갈라지지 않는다
 *
 * 지적: §6.2 의 상태 enum, §6.3 의 판정 절차, §9.2 의 드라이버 계약이 코드와 다르다.
 * "이 enum 을 지금 고정하면 §6.2 구현 시 호환성 파괴가 필수다."
 *
 * 문서를 한 번 고치는 것으로는 부족하다. **문서는 조용히 어긋난다.** 코드를 바꿀 때
 * 문서를 안 고치면 아무도 모르고, 다음 검수가 다시 같은 지적을 한다.
 *
 * 그래서 대조를 테스트로 만든다. 갈라지면 여기가 깨진다.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { ALL_APPLY_PHASES } from '../../src/dp/operation.js';
import { LocalDataplaneDriver } from '../../src/dp/driver.js';

const design = readFileSync(
  join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'DESIGN.md'),
  'utf8',
);

/** `### 6.2 …` 부터 다음 같은 수준 제목 전까지. */
/** §6.2 의 **단계 표**만. 다이어그램·필드 표를 긁으면 이름이 오인된다. */
function phaseTable(): string[] {
  const body = section('### 6.2 ApplyOperation 상태기계');
  const normative = body.slice(0, body.indexOf('#### 6.2.1'));
  const table = normative.slice(
    normative.indexOf('| 단계 | 뜻 |'),
    normative.indexOf('**저널 항목**'),
  );
  return [...table.matchAll(/^\| `([a-z_]+)` \|/gm)].map((m) => m[1]!);
}

function section(heading: string): string {
  const start = design.indexOf(heading);
  expect(start, `DESIGN 에 '${heading}' 이 없다`).toBeGreaterThan(-1);
  const rest = design.slice(start + heading.length);
  const end = rest.search(/\n### /);
  return end === -1 ? rest : rest.slice(0, end);
}

describe('§6.2 — 문서의 단계와 코드의 단계가 같다', () => {
  it('모든 단계가 §6.2 **표에** 있다', () => {
    // 절 전체에서 이름을 찾으면 다이어그램에 남은 이름 때문에 표에서 지워도 통과한다.
    // 뮤테이션으로 확인했다 — 표를 직접 봐야 한다.
    const listed = phaseTable();
    const missing = ALL_APPLY_PHASES.filter(
      (p) => p !== 'no_operation' && !listed.includes(p),
    );
    expect(missing, `§6.2 단계 표에 없는 단계: ${missing.join(', ')}`).toEqual([]);
  });

  it('§6.2 가 코드에 없는 단계를 말하지 않는다', () => {
    const claimed = phaseTable();
    expect(claimed.length, '§6.2 에 단계 표가 없다').toBeGreaterThan(0);
    const unknown = claimed.filter((c) => !(ALL_APPLY_PHASES as readonly string[]).includes(c));
    expect(unknown, `코드에 없는 단계를 문서가 말한다: ${unknown.join(', ')}`).toEqual([]);
  });

  it('옛 상태기계는 **비규범으로 표시**돼 있다', () => {
    const body = section('### 6.2 ApplyOperation 상태기계');
    expect(body).toContain('#### 6.2.1');
    const legacy = body.slice(body.indexOf('#### 6.2.1'));
    expect(legacy, '옛 상태를 규범처럼 두면 무엇이 계약인지 모른다').toContain('비규범');
    // 코드에 없는 이름들이 거기 있는 것은 괜찮다 — 비규범이라고 적혀 있으므로.
    expect(legacy).toContain('rolling_back');
  });
});

describe('§9.2 — 문서의 드라이버와 코드의 드라이버가 같다', () => {
  const methods = Object.getOwnPropertyNames(LocalDataplaneDriver.prototype)
    .filter((m) => m !== 'constructor' && !m.startsWith('runner'));

  it('구현의 메서드가 전부 §9.2 에 있다', () => {
    const body = section('### 9.2 계약 — v0.1');
    const normative = body.slice(0, body.indexOf('#### 9.2.1'));
    const missing = methods.filter((m) => !normative.includes(`${m}(`));
    expect(missing, `§9.2 에 없는 메서드: ${missing.join(', ')}`).toEqual([]);
  });

  it('§9.2 가 구현에 없는 메서드를 말하지 않는다', () => {
    const body = section('### 9.2 계약 — v0.1');
    const normative = body.slice(0, body.indexOf('#### 9.2.1'));
    const iface = normative.slice(normative.indexOf('export interface DataplaneDriver'));
    const claimed = [...iface.matchAll(/^\s{2}([a-zA-Z]+)\(/gm)].map((m) => m[1]!);
    expect(claimed.length, '§9.2 에 인터페이스가 없다').toBeGreaterThan(0);
    const extra = claimed.filter((c) => !methods.includes(c));
    expect(extra, `구현에 없는 메서드를 문서가 말한다: ${extra.join(', ')}`).toEqual([]);
  });

  it('옛 계약도 비규범으로 표시돼 있다', () => {
    const body = section('### 9.2 계약 — v0.1');
    expect(body).toContain('#### 9.2.1');
    expect(body.slice(body.indexOf('#### 9.2.1'))).toContain('비규범');
  });
});

describe('§6.3 — 무엇을 구현했고 무엇을 안 했는지 문서가 말한다', () => {
  it('판정 절차 7 단계의 구현 여부가 적혀 있다', () => {
    const body = section('### 6.3 활성화를 어떻게 증명하는가');
    expect(body, 'v0.1 구현 여부 표가 없다').toContain('| 단계 | v0.1 | 어디 |');
    // 안 한 것을 안 했다고 적어야 한다. 전부 ✅ 면 그게 거짓말이다.
    expect(body, '전부 구현했다고 적혀 있다 — 실제로는 아니다').toContain('❌');
  });
});

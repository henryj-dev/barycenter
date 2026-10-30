/**
 * 롤백 plan 의 영향 화면 (#126 운영 화면 단계에서 찾았다).
 *
 * 롤백은 plan 을 만들지만 영향을 재지 않는다 — 저장소가 `impact` 에 `{ rollbackOf }` 만 넣는다.
 * 전에는 `viewOfImpact` 가 `socketChanges.added` 를 읽다가 터졌고, 롤백 뒤 적용 대기 화면이 열리지 않았다
 * (셸 배너: 「Cannot read properties of undefined (reading 'added')」). 그러면 롤백을 적용할 수 없다.
 *
 * 재는 것:
 *   · 롤백 plan 으로 화면 값을 만들 수 있다
 *   · 모르는 영향을 「영향 없음」 으로 그리지 않는다 — reload 가 필요하다고 보고, 롤백이라고 표시한다
 *   · 보통 plan 은 그대로다
 */
import { describe, expect, it } from 'vitest';
import { viewOfImpact, type Impact } from '../../src/web/impact-view.js';

const pending = { planId: 'p-1', revision: '7' };

describe('롤백 plan 의 영향', () => {
  it('영향이 `{ rollbackOf }` 뿐이어도 화면 값을 만든다', () => {
    const v = viewOfImpact(pending, { rollbackOf: '5' } as unknown as Impact);
    expect(v.planId).toBe('p-1');
    expect(v.revision).toBe('7');
    expect(v.headline).toContain('r5');
  });

  it('모르는 영향을 「영향 없음」 으로 그리지 않는다', () => {
    const v = viewOfImpact(pending, { rollbackOf: '5' } as unknown as Impact);
    expect(v.requiresReload, '모르면 reload 가 필요하다고 본다').toBe(true);
    expect(v.headline).not.toContain('세대 전환 없이');
    expect(v.rollbackOf, '화면이 「재지 않았다」 를 알 수 있다').toBe('5');
  });

  it('보통 plan 은 그대로다', () => {
    const v = viewOfImpact(pending, {
      requiresReload: false,
      affectedListeners: [],
      socketChanges: { added: ['tcp:0.0.0.0:80'], removed: [] },
      planes: ['http'],
    });
    expect(v.socketsAdded).toEqual(['tcp:0.0.0.0:80']);
    expect(v.headline).toContain('세대 전환 없이');
    expect(v.capabilityWarnings).toEqual([]);
    expect(v.rollbackOf).toBeUndefined();
  });
});

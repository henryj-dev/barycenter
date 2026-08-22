/**
 * 검수 2026-08-22 · B-09 — **peer 하나가 안 풀려도 나머지는 간다**
 *
 * `resolveSlots` 는 모든 peer 를 `Promise.all` 로 풀었다. 하나라도 던지면 **그 평면의
 * 멤버십 갱신 전체가 실패한다** — 헬스 프로젝션이든 apply 든.
 *
 * 호스트명 백엔드 하나가 잠깐 안 풀리면 나머지 전부의 헬스 반영이 멈춘다. 그리고 그건
 * §6.7 이 나눈 두 사건 중 **"갱신 실패"** 쪽이라, 옛 슬롯이 그대로 남아 죽은 백엔드가
 * 계속 트래픽을 받는다.
 *
 * 부분 실패는 부분 실패로 다룬다: 안 풀린 peer 만 빼고 나머지는 반영한다.
 */
import { describe, expect, it } from 'vitest';

import { resolveSlots } from '../../src/control/membership.js';

/** `10.x` 는 그대로, `bad.*` 는 던진다. 실제 DNS 를 안 쓴다 — 판정이 망 상태에 걸리면 안 된다. */
const lookup = async (hp: string): Promise<string> => {
  if (hp.startsWith('bad')) throw new Error(`ENOTFOUND ${hp}`);
  return hp;
};

describe('멤버십 peer 해석 (검수 B-09)', () => {
  it('peer 하나가 안 풀려도 나머지는 간다', async () => {
    const out = await resolveSlots({
      pool_a: ['10.0.0.1:80', 'bad.internal:80', '10.0.0.2:80'],
      pool_b: ['10.0.0.3:80'],
    }, lookup);

    expect(out['pool_a']).toEqual(['10.0.0.1:80', '10.0.0.2:80']);
    expect(out['pool_b']).toEqual(['10.0.0.3:80']);
  });

  it('전부 안 풀리면 빈 슬롯이다 — 던지지 않는다', async () => {
    // 빈 슬롯을 쓸지 말지는 `shouldPushMembership` 이 정한다 (§6.7 의 S3/S4 구분).
    // 여기서 던지면 그 판단이 아예 안 돈다.
    const out = await resolveSlots({ pool_a: ['bad.one:80', 'bad.two:80'] }, lookup);
    expect(out['pool_a']).toEqual([]);
  });

  it('멀쩡한 입력은 그대로다', async () => {
    const out = await resolveSlots({ pool_a: ['10.0.0.1:80'] }, lookup);
    expect(out).toEqual({ pool_a: ['10.0.0.1:80'] });
  });
});

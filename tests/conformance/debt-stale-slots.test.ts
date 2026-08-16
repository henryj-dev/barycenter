/**
 * **CE-41-A — 낡은 전환의 슬롯 반납이 신임의 살아 있는 예약을 지운다** (41차 검수)
 *
 * 40차에 이 자리(`releaseStaleSlots` 의 슬롯 대조)에 "불가지" 라벨을 붙이며 전제를
 * 이렇게 적었다 — *"신임의 슬롯은 홀더 없이 존재할 수 없으므로, 홀더가 없으면 남은
 * 슬롯은 낡은 것뿐이다."*
 *
 * **거짓이다. 그리고 반박이 같은 파일 100 줄 아래에 이미 적혀 있었다.**
 * `reclaimOperation` 의 주석: *"비종단 저널인데 실행권이 없는 상태가 만들어질 수 있다 …
 * **예약 슬롯은 그대로 남아 있으므로** 실행권만 되돌려 놓으면 이어서 밀 수 있다."*
 *
 * 그러면 같은 id 를 승계한 신임(토큰 11)의 슬롯이 홀더 없이 존재하고, 낡은 러너의 지연
 * `releaseStaleSlots(X/10)` 이 착지하면 **id 가 같아서 그것을 지운다.** 그 좌표를 다른
 * 오퍼레이션이 잡을 수 있게 되고, 신임은 자기 예약이 사라진 채 진행한다.
 * 9차 반례 ③ 부류다.
 *
 * **불가지 라벨이 검수를 이 자리로 인도했다** — "무해하다" 고 적었으면 아무도 안 봤다.
 * 그것이 40차 규칙("검증물 없으면 불가지로 적는다")의 값이다.
 */
import { describe, expect, it } from 'vitest';
import { DpAgent, MemoryStore, tupleFor } from '../../src/dp/agent.js';
import type { ApplyOperation } from '../../src/dp/operation.js';

const OP = (token: string): ApplyOperation => ({
  leaderToken: token,
  operationId: 'X',
  transitionId: 'X',
  affectedPlanes: ['http', 'stream'],
  targetGeneration: 'gen-1',
  generationDigest: 'sha256:gen-1',
  planes: {
    http: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: 'sha256:h',
    },
    stream: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: 'sha256:s',
    },
  },
});

describe('낡은 슬롯 반납이 신임의 예약을 지우지 않는다', () => {
  it('같은 id 를 승계한 신임의 슬롯은 홀더가 없어도 남는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const x10 = OP('10');
    const x11 = OP('11');

    await agent.fence('11');
    // **홀더 없이 슬롯만 있는 상태** — `reclaimOperation` 주석이 도달 가능하다고 적은 그것이다.
    for (const plane of ['http', 'stream'] as const) {
      await agent.reserve(tupleFor(x11, plane));
    }
    expect(agent.activeOperation(), '전제: 홀더가 없다').toBeUndefined();
    expect(
      new DpAgent(store).reservationOwner('http', '1')?.leaderToken,
      '전제: 신임의 슬롯이 있다',
    ).toBe('11');

    // 낡은 러너의 지연 반납이 착지한다.
    await agent.releaseStaleSlots(x10);

    expect(
      new DpAgent(store).reservationOwner('http', '1')?.leaderToken,
      '낡은 반납이 신임의 살아 있는 예약을 지웠다 — 그 좌표를 남이 잡을 수 있다',
    ).toBe('11');
  });
});

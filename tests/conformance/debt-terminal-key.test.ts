/**
 * **종단 원장의 키에 신원을 넣는다** (44차 — 부류를 채널째 닫는다)
 *
 * 이 부류는 마흔 회차 동안 여섯 번의 census 를 견뎠다. 뿌리는 **종단 원장의 키에 신원이
 * 없다**는 것이었다 — `opId:tid:plane`. 같은 이름을 승계한 신임과 옛 전환이 **같은 칸을
 * 다투고**, 고아 청소가 옛 것을 닫는 스탬프가 신임까지 죽였다.
 *
 * 고치는 시도가 두 번 빗나갔다.
 * ```
 * 34차 B  자기-찍기만 막았다              → 제3자 경유가 열려 있었다 (43차 CE-43-A)
 * 43차    "예약이 살아 있으면 안 찍는다"   → 낡은 잔존 슬롯이 방패가 되어
 *                                          찍었어야 할 고아가 부활했다 (44차 CE-44-A)
 * ```
 * **휴리스틱은 채널을 닫는 모양이 아니었다.** 43차 검수가 정확히 진단했다 —
 * *"닫으려면 이름 원장에 신원을 넣거나 스탬프 자체를 없애야 한다."*
 *
 * 넣으니 **세 반례가 한꺼번에 닫혔다**(R1 재시도 창 · R2 평면별 창 · R3 고아 부활).
 * 하나씩 막던 것이 채널을 닫자 같이 사라진 것 — 그게 "부류를 닫는다" 의 모양이다.
 */
import { describe, expect, it } from 'vitest';
import { DpAgent, MemoryStore, tupleFor } from '../../src/dp/agent.js';
import type { ApplyOperation } from '../../src/dp/operation.js';

const OP = (token: string, id = 'X'): ApplyOperation => ({
  leaderToken: token,
  operationId: id,
  transitionId: id,
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

describe('종단은 전환마다 자기 칸을 쓴다', () => {
  it('옛 토큰의 종단이 같은 이름 신임을 죽이지 않는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const x10 = OP('10');
    const x11 = OP('11');

    await agent.reserveAll(x10, {
      op: x10, phase: 'preflight', reloadAttempts: 0, progress: {},
    });
    await agent.abort(tupleFor(x10, 'http'));
    expect(agent.terminalOf(tupleFor(x10, 'http')), '전제: 옛 것은 닫혔다').toBe('aborted');

    await agent.fence('11');
    expect(
      new DpAgent(store).terminalOf(tupleFor(x11, 'http')),
      '같은 이름이라는 이유로 신임의 칸까지 닫혔다',
    ).toBeUndefined();
  });

  it('지연 RPC 는 자기 칸에서 여전히 거부된다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const x10 = OP('10');

    await agent.reserveAll(x10, {
      op: x10, phase: 'preflight', reloadAttempts: 0, progress: {},
    });
    await agent.abort(tupleFor(x10, 'http'));

    // 같은 토큰의 지연 RPC — `assertLeader` 는 못 막는다. 원장이 막아야 한다.
    const late = await agent.stage(tupleFor(x10, 'http'), null)
      .then(() => 'ok')
      .catch((e: unknown) => (e as { kind?: string }).kind ?? 'other');
    expect(late, '포기한 전환이 되살아났다').toBe('terminal');
  });
});

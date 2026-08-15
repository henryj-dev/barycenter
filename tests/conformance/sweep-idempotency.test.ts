/**
 * 뮤테이션 스윕이 찾은 것 — **중복 배달은 언제 와도 같은 답을 받는다**
 *
 * 외부 검수가 다섯 회차 연속 죽거나 한도에 막혔다. 적대자를 밖에서 못 구하니 안에서
 * 만들었다 — `scripts/mutate.mjs` 가 규칙으로 439 개를 생성한다.
 *
 * 셋째 뮤턴트에서 바로 나왔다.
 *
 * ```
 * agent.ts:1096  if (replay !== undefined) return replay;  →  void 0;   살아남았다
 * agent.ts:1205  if (replay !== undefined) return replay;  →  void 0;   살아남았다
 * ```
 *
 * `admit` 이 돌려주는 **재요청 캐시**를 아무도 검사하지 않았다. 재요청 자체는 테스트가
 * 있는데(P20), 그건 **좌표가 아직 그 자리에 있을 때**만 본다. 그 경우엔 뒤따르는
 * "이미 목표 좌표에 있으면 재요청이다" 검사가 같은 답을 내므로 캐시가 없어도 통과한다.
 *
 * 갈리는 자리는 **좌표가 지나간 뒤**다. 그때 캐시가 없으면 옛 요청이 거부된다 — 그런데
 * 그건 "한 번 답한 것은 그대로 답한다" 는 멱등 계약을 깨는 것이다. 중복 배달은 네트워크가
 * 정하지 우리가 정하지 않는다.
 */
import { describe, expect, it } from 'vitest';
import { DpAgent, MemoryStore, tupleFor } from '../../src/dp/agent.js';
import type { ApplyOperation } from '../../src/dp/operation.js';

const OP = (id: string, from: string, to: string): ApplyOperation => ({
  leaderToken: '10',
  operationId: id,
  transitionId: id,
  affectedPlanes: ['http', 'stream'],
  targetGeneration: `gen-${id}`,
  generationDigest: `sha256:gen-${id}`,
  planes: {
    http: {
      expectedCurrent: { activationEpoch: from, membershipRevision: from },
      target: { activationEpoch: to, membershipRevision: to },
      payloadDigest: `sha256:h-${id}`,
    },
    stream: {
      expectedCurrent: { activationEpoch: from, membershipRevision: from },
      target: { activationEpoch: to, membershipRevision: to },
      payloadDigest: `sha256:s-${id}`,
    },
  },
});

/** 전 평면을 넘기고 끝낸다. */
async function activate(agent: DpAgent, op: ApplyOperation): Promise<void> {
  await agent.reserveAll(op);
  for (const plane of ['http', 'stream'] as const) {
    await agent.stage(tupleFor(op, plane), null);
    await agent.commit(tupleFor(op, plane), { acceptingGeneration: op.targetGeneration });
  }
  await agent.finishOperation(op);
}

describe('좌표가 지나간 뒤에도 옛 요청은 같은 답을 받는다', () => {
  it('옛 commit 이 중복 배달되면 그때 준 ACK 를 그대로 돌려준다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const first = OP('A', '0', '1');
    await activate(agent, first);
    const originally = await agent.commit(tupleFor(first, 'http'), { acceptingGeneration: 'gen-A' });

    // 다음 오퍼레이션이 좌표를 2 로 옮긴다.
    await activate(agent, OP('B', '1', '2'));
    expect(agent.coordinate('http').activationEpoch, '전제가 성립하지 않는다').toBe('2');

    // 이제 A 의 commit 이 뒤늦게 한 번 더 배달된다.
    const again = await agent.commit(tupleFor(first, 'http'), { acceptingGeneration: 'gen-A' });

    expect(again, '좌표가 지나갔다고 옛 요청에 다른 답을 줬다').toEqual(originally);
    expect(again.cached, '캐시에서 온 답이 아니다').toBe(true);
    expect(agent.coordinate('http').activationEpoch, '중복 배달이 좌표를 움직였다').toBe('2');
  });

  it('옛 stage 가 중복 배달되면 그때 준 ACK 를 그대로 돌려준다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const first = OP('A', '0', '1');
    await agent.reserveAll(first);
    const originally = await agent.stage(tupleFor(first, 'http'), null);
    await agent.commit(tupleFor(first, 'http'), { acceptingGeneration: 'gen-A' });
    await agent.stage(tupleFor(first, 'stream'), null);
    await agent.commit(tupleFor(first, 'stream'), { acceptingGeneration: 'gen-A' });
    await agent.finishOperation(first);
    await activate(agent, OP('B', '1', '2'));

    const again = await agent.stage(tupleFor(first, 'http'), null);
    // `cached` 만 다르다 — 그게 캐시에서 왔다는 표시다. 나머지는 그때 준 것 그대로여야 한다.
    expect({ ...again, cached: undefined }, '좌표가 지나갔다고 옛 stage 에 다른 답을 줬다')
      .toEqual({ ...originally, cached: undefined });
    expect(again.cached, '캐시에서 온 답이 아니다').toBe(true);
  });

  it('옛 헬스 요청이 중복 배달되면 그때 준 ACK 를 그대로 돌려준다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const first = OP('A', '0', '1');
    await activate(agent, first);

    // 헬스는 **별개 오퍼레이션**이다. 끝난 전환의 id 로 보내면 `terminal` 로 막힌다 —
    // 처음엔 그렇게 짰다가 배웠다.
    const health = {
      ...tupleFor(first, 'http'),
      operationId: 'health-1',
      transitionId: 'health-1',
      expectedCurrent: { activationEpoch: '1', membershipRevision: '1' },
      target: { activationEpoch: '1', membershipRevision: '2' },
    };
    const originally = await agent.applyHealth(health, null);
    expect(agent.coordinate('http').membershipRevision, '헬스가 안 먹혔다').toBe('2');

    // 중복 배달. 좌표는 이미 revision 2 라 `expectedCurrent` 가 안 맞는다.
    const again = await agent.applyHealth(health, null);

    expect({ ...again, cached: undefined }, '중복 배달에 다른 답을 줬다')
      .toEqual({ ...originally, cached: undefined });
    expect(again.cached, '캐시에서 온 답이 아니다').toBe(true);
    expect(agent.coordinate('http').membershipRevision, '중복 배달이 revision 을 또 올렸다').toBe('2');
  });

  it('옛 reserveAll 이 중복 배달되면 그때 준 ACK 를 그대로 돌려준다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const first = OP('A', '0', '1');
    const originally = await agent.reserveAll(first);
    for (const plane of ['http', 'stream'] as const) {
      await agent.stage(tupleFor(first, plane), null);
      await agent.commit(tupleFor(first, plane), { acceptingGeneration: 'gen-A' });
    }
    await agent.finishOperation(first);
    await activate(agent, OP('B', '1', '2'));

    const again = await agent.reserveAll(first);

    expect(again.length).toBe(originally.length);
    for (const [i, ack] of again.entries()) {
      expect({ ...ack, cached: undefined }, '옛 예약 재요청에 다른 답을 줬다')
        .toEqual({ ...originally[i]!, cached: undefined });
      expect(ack.cached, '캐시에서 온 답이 아니다').toBe(true);
    }
    expect(agent.coordinate('http').activationEpoch, '중복 배달이 좌표를 움직였다').toBe('2');
  });

  it('옛 단일 평면 reserve 가 중복 배달되면 그때 준 ACK 를 그대로 돌려준다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const first = OP('A', '0', '1');
    const originally = await agent.reserve(tupleFor(first, 'http'));
    await agent.stage(tupleFor(first, 'http'), null);
    await agent.commit(tupleFor(first, 'http'), { acceptingGeneration: 'gen-A' });

    const again = await agent.reserve(tupleFor(first, 'http'));

    expect({ ...again, cached: undefined }, '옛 예약 재요청에 다른 답을 줬다')
      .toEqual({ ...originally, cached: undefined });
    expect(again.cached, '캐시에서 온 답이 아니다').toBe(true);
  });

  it('**다른 내용의 같은 좌표 요청은 여전히 거부한다** — 캐시가 문을 열지 않는다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const first = OP('A', '0', '1');
    await activate(agent, first);

    const forged = {
      ...tupleFor(first, 'http'),
      payloadDigest: 'sha256:다른-내용',
    };
    await expect(
      agent.commit(forged, { acceptingGeneration: 'gen-A' }),
      '같은 좌표에 다른 내용을 받아들였다',
    ).rejects.toMatchObject({ kind: expect.any(String) });
  });
});

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
import { ApplyRunner, FakeEffects } from '../../src/dp/apply.js';
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

// ── 스윕이 찾은 두 번째 무리 ──────────────────────────────────────────────

describe('부분 전환이 재시도로 완성되면 activated 로 끝난다', () => {
  /**
   * ```
   * apply.ts:532  if (stuck.length === 0) {  →  if (false) {   살아남았다
   * ```
   *
   * 정상 경로는 commit 루프에서 바로 `activated` 를 쓴다. 여기는 **재시도 경로**다 —
   * 한 라운드에서 일부만 넘어가 `partially_activated` 가 됐다가, 다음 라운드에서 나머지가
   * 넘어가는 자리. 아무도 그 길을 안 지났다.
   *
   * 그게 §6.2 #8 이 말하는 "partial 은 재시도다" 의 성공 쪽이다. 실패 쪽(소진)은
   * 12차 반례 ⑤ 가 짚는데 성공 쪽은 비어 있었다.
   *
   * ⚠️ **그 뮤턴트는 동치였다.** 아래 테스트를 넣고도 `if (false)` 가 살아남는다 —
   * 조기 반환을 없애면 한 바퀴 더 돌아 commit 루프에서 같은 `activated` 에 닿는다.
   * 지름길이지 판정이 아니다. 관측되는 차이는 durable write 하나뿐이고, 그건 이 경로가
   * 정상 경로가 아니라 크래시 지점 집합에도 안 잡힌다.
   *
   * 그래도 이 테스트는 둔다 — 재시도가 성공으로 끝나는 길과 어긋난 저널에서 회복하는
   * 길을 짚는다. **뮤턴트를 못 죽였다고 테스트가 값이 없는 것은 아니다.**
   */
  it('한 평면이 늦게 따라와도 전 평면이 넘어가면 activated 다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const op = OP('A', '0', '1');
    const fx = new FakeEffects();
    fx.publishedRecord = {
      generation: 'gen-A', leaderToken: '10', operationId: 'A',
      transitionId: 'A', generationDigest: 'sha256:gen-A',
    };
    fx.acceptingGeneration = 'gen-A';

    // http 만 넘어간 채 `partially_activated` 로 멈춰 있다. stream 은 아직 staged 다.
    await agent.reserveAll(op);
    for (const plane of ['http', 'stream'] as const) {
      await agent.stage(tupleFor(op, plane), null);
    }
    await agent.commit(tupleFor(op, 'http'), { acceptingGeneration: 'gen-A' });
    await agent.writeJournal({
      op, phase: 'partially_activated', reloadAttempts: 1, seq: 1,
      progress: { http: 'committed', stream: 'staged' },
    });

    const FAST_APPLY = { attempts: 2, intervalMs: 0, sleep: async () => {}, effectTimeoutMs: 1_000 };
    const r = await new ApplyRunner(new DpAgent(store), fx, FAST_APPLY).recover();

    expect(r.phase, '늦게 따라온 평면을 완성으로 인정하지 않았다').toBe('activated');
    expect(new DpAgent(store).coordinate('stream').activationEpoch, 'stream 이 안 넘어갔다').toBe('1');
    expect(
      new DpAgent(store).lastActivated()?.generation,
      '전 평면이 넘어갔는데 기준이 안 섰다',
    ).toBe('gen-A');
  });
  it('저널이 어긋나 있어도 — phase 는 partial 인데 progress 는 전부 committed', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const op = OP('A', '0', '1');
    const fx = new FakeEffects();
    fx.publishedRecord = {
      generation: 'gen-A', leaderToken: '10', operationId: 'A',
      transitionId: 'A', generationDigest: 'sha256:gen-A',
    };
    fx.acceptingGeneration = 'gen-A';

    await agent.reserveAll(op);
    for (const plane of ['http', 'stream'] as const) {
      await agent.stage(tupleFor(op, plane), null);
      await agent.commit(tupleFor(op, plane), { acceptingGeneration: 'gen-A' });
    }
    // **저널만 어긋나 있다.** 좌표는 둘 다 넘어갔는데 phase 가 partial 로 남았다 —
    // 단계와 progress 를 따로 쓰던 시절이 남긴 모양이거나, 그렇게 될 수 있는 자리다.
    await agent.writeJournal({
      op, phase: 'partially_activated', reloadAttempts: 1, seq: 1,
      progress: { http: 'committed', stream: 'committed' },
    });

    const FAST_APPLY = { attempts: 2, intervalMs: 0, sleep: async () => {}, effectTimeoutMs: 1_000 };
    const r = await new ApplyRunner(new DpAgent(store), fx, FAST_APPLY).recover();

    expect(r.phase, '더 밀 것이 없는데 재시도로 보냈다').toBe('activated');
    expect(new DpAgent(store).activeOperation(), '실행권이 남았다').toBeUndefined();
  });
});

describe('신원 비교는 한 자리만 같아도 같다고 하지 않는다', () => {
  /**
   * ```
   * agent.ts:797   holder.operationId === op.operationId && holder.transitionId === ...  → ||
   * agent.ts:470   a.operationId === b.operationId && ...                                → ||
   * ```
   *
   * 둘 다 살아남았다. **id 는 같은데 transition 이 다른 경우**를 아무도 안 만들었다.
   * 재시도가 새 transitionId 로 오는 것이 정상 운영이므로 실제로 생기는 모양이다.
   */
  it('operationId 가 같아도 transitionId 가 다르면 남의 실행권이다', async () => {
    const store = new MemoryStore();
    const first = OP('A', '0', '1');
    const retry: ApplyOperation = { ...first, transitionId: 'A-retry' };

    await new DpAgent(store).reserveAll(first);

    await expect(
      new DpAgent(store).reserveAll(retry),
      'transitionId 가 다른데 같은 실행권으로 봤다',
    ).rejects.toMatchObject({ kind: 'operation_in_flight' });
  });

  it('transitionId 가 같아도 operationId 가 다르면 남의 실행권이다', async () => {
    const store = new MemoryStore();
    const first = OP('A', '0', '1');
    const other: ApplyOperation = { ...first, operationId: 'B' };

    await new DpAgent(store).reserveAll(first);

    await expect(
      new DpAgent(store).reserveAll(other),
      'operationId 가 다른데 같은 실행권으로 봤다',
    ).rejects.toMatchObject({ kind: 'operation_in_flight' });
  });
});

describe('실패로 닫을 때도 실행권을 놓는다', () => {
  /**
   * ```
   * apply.ts  await this.agent.finishOperation(j.op);  →  void 0;   살아남았다
   * ```
   *
   * `failAll` 이 실행권을 안 놓아도 **501 개가 전부 초록이었다.** 6차 반례 ④ 와 16차
   * 반례 ② 가 정확히 이 부류였다 — 실행권이 남으면 그 뒤 모든 오퍼레이션이
   * `operation_in_flight` 로 막힌다. 두 번 물렸는데 세 번째 자리는 비어 있었다.
   *
   * ⚠️ **그 뮤턴트는 동치였다.** 아래 테스트를 넣고도 살아남는다 — `failAll` 이 안 놓아도
   * 곧바로 루프 머리의 종단 처리가 놓기 때문이다. 반납이 **두 자리에 있다.**
   *
   * 그래서 확인 방식을 바꿨다: **둘 다** 없애면 빨개진다(3 건). 이 테스트가 지키는 것은
   * "어느 줄이 놓는가" 가 아니라 **"실패로 닫힌 뒤에는 실행권도 예약도 남지 않는다"**
   * 는 계약이다. 그게 두 번 물렸던 것이고, 한 자리가 사라져도 다른 자리가 지킨다는 것도
   * 이제 안다.
   */
  it('두 평면이 다 막혀 실패로 닫혀도 실행권과 예약이 남지 않는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const op = OP('A', '0', '1');
    const fx = new FakeEffects();
    fx.publishedRecord = {
      generation: 'gen-A', leaderToken: '10', operationId: 'A',
      transitionId: 'A', generationDigest: 'sha256:gen-A',
    };
    fx.acceptingGeneration = 'gen-A';

    await agent.reserveAll(op);
    await agent.writeJournal({
      op, phase: 'published', reloadAttempts: 0, seq: 1,
      progress: { http: 'reserved', stream: 'reserved' },
    });
    // 남이 두 평면을 다 걷어찼다 — 이 전환은 더 갈 곳이 없다.
    await agent.abort(tupleFor(op, 'http'));
    await agent.abort(tupleFor(op, 'stream'));

    const FAST_APPLY = { attempts: 1, intervalMs: 0, sleep: async () => {}, effectTimeoutMs: 500 };
    const r = await new ApplyRunner(new DpAgent(store), fx, FAST_APPLY).recover();

    expect(r.phase, '종단으로 닫지 않았다').toBe('failed');
    expect(
      new DpAgent(store).activeOperation(),
      '실행권이 남았다 — 그 뒤 모든 오퍼레이션이 막힌다',
    ).toBeUndefined();
    for (const plane of ['http', 'stream'] as const) {
      expect(
        new DpAgent(store).reservationOwner(plane, '1'),
        `${plane} 예약이 남았다 — 좌표가 잠긴다`,
      ).toBeUndefined();
    }
  });

  it('그래서 실패 뒤에도 다음 오퍼레이션이 들어간다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const op = OP('A', '0', '1');
    await agent.reserveAll(op);
    await agent.writeJournal({
      op, phase: 'published', reloadAttempts: 0, seq: 1,
      progress: { http: 'reserved', stream: 'reserved' },
    });
    await agent.abort(tupleFor(op, 'http'));
    await agent.abort(tupleFor(op, 'stream'));

    const FAST_APPLY = { attempts: 1, intervalMs: 0, sleep: async () => {}, effectTimeoutMs: 500 };
    await new ApplyRunner(new DpAgent(store), new FakeEffects(), FAST_APPLY).recover();

    const next = await new ApplyRunner(new DpAgent(store), new FakeEffects(), FAST_APPLY)
      .run(OP('B', '0', '1'));
    expect(next.phase, '실패한 전환이 다음 것을 막고 있다').toBe('activated');
  });
});

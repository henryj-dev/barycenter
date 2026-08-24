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
import { FakeEffects } from '../../src/testing/apply-fakes.js';
import { DpAgent, MemoryStore, tupleFor } from '../../src/dp/agent.js';
import { ApplyRunner } from '../../src/dp/apply.js';
import { LocalDataplaneDriver } from '../../src/dp/driver.js';
import { provesActivation } from '../../src/dp/operation.js';
import { GenerationError, materializeGeneration, readManifest } from '../../src/dp/materialize.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('좌표 CAS 는 마지막 문이다 — 도달 불가가 아니다 (17차)', () => {
  /**
   * 스윕에서 `if (!sameCoordinate(current, op.expectedCurrent))` 가 살아남기에 **도달
   * 불가라고 적었다. 틀렸다.** 17차 검수가 반증했고 재현했다.
   *
   * 위의 `canonical` 비교는 **슬롯의 튜플과 요청 튜플** 사이다 — 슬롯 주인이 자기
   * 자신이면 통과한다. 이 검사는 **현재 좌표와 기대 좌표** 사이라 다른 것을 본다.
   *
   * 살아남은 이유는 도달 불가가 아니라 **그 시퀀스를 지나는 테스트가 없어서**였다.
   * 스윕 결과를 잘못 읽은 것이다 — 생존을 "도달 불가" 로 결론내기 전에 길을 찾아봐야 했다.
   */
  it('늦은 epoch 이 먼저 넘어간 뒤 옛 commit 은 좌표로 막힌다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const early = {
      leaderToken: '10', operationId: 'X', transitionId: 'X', plane: 'http' as const,
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: 'sha256:h-X', targetGeneration: 'gen-X', generationDigest: 'sha256:gen-X',
    };
    const late = { ...early, operationId: 'Y', transitionId: 'Y',
      target: { activationEpoch: '2', membershipRevision: '2' },
      payloadDigest: 'sha256:h-Y', targetGeneration: 'gen-Y', generationDigest: 'sha256:gen-Y' };

    // 같은 평면에 두 슬롯을 잡는다. `reserve` 원시 연산에는 실행권 검사가 없다.
    await agent.reserve(early);
    await agent.reserve(late);

    // 늦은 것을 먼저 넘긴다 — 좌표가 2 로 간다.
    await agent.stage(late, null);
    await agent.commit(late, { acceptingGeneration: 'gen-Y' });
    expect(agent.coordinate('http').activationEpoch, '전제가 성립하지 않는다').toBe('2');

    // 이제 옛 commit 이 온다. 슬롯 주인은 자기 자신이라 신원 검사는 통과한다.
    await agent.stage(early, null);
    await expect(
      agent.commit(early, { acceptingGeneration: 'gen-X' }),
      '좌표가 지나갔는데 옛 commit 을 받아들였다',
    ).rejects.toMatchObject({ kind: 'coordinate_mismatch' });

    expect(agent.coordinate('http').activationEpoch, '좌표가 되돌아갔다').toBe('2');
  });
});

// ── 스윕이 찾은 셋째 무리 — **통과하는 쪽**이 비어 있었다 ──────────────────

describe('활성화 증거는 막는 쪽만 있는 게 아니다', () => {
  /**
   * ```
   * operation.ts  evidence.workersReported < evidence.workersExpected  →  <=   살아남았다
   * ```
   *
   * 워커가 **모자랄 때** 거부하는 것은 테스트가 있다(3/4). 그런데 **전부 보고했을 때
   * 인정하는지**는 아무도 안 봤다. `<` 를 `<=` 로 바꾸면 4/4 도 거부하게 되는데 초록이다.
   *
   * 열일곱 라운드가 "한쪽만 짚고 반대편으로 넘어가는 것" 을 반복했다. 여기도 같다.
   */
  it('워커가 전부 보고하면 증거로 인정한다', () => {
    expect(
      provesActivation({ acceptingGeneration: 'gen-A', workersExpected: 4, workersReported: 4 }, 'gen-A'),
      '전부 보고했는데 증거가 아니라고 했다',
    ).toBe(true);
  });

  it('워커가 더 많이 보고해도 인정한다 — 옛 워커가 남아 있을 수 있다', () => {
    expect(
      provesActivation({ acceptingGeneration: 'gen-A', workersExpected: 4, workersReported: 5 }, 'gen-A'),
      'HUP 뒤 워커가 겹치는 순간을 실패로 읽었다',
    ).toBe(true);
  });

  it('하나라도 모자라면 거부한다 — 반대편', () => {
    expect(
      provesActivation({ acceptingGeneration: 'gen-A', workersExpected: 4, workersReported: 3 }, 'gen-A'),
      '모자란데 증거라고 했다',
    ).toBe(false);
  });

  it('관측하지 못한 것은 반증이 아니다', () => {
    expect(
      provesActivation({ acceptingGeneration: 'gen-A' }, 'gen-A'),
      '관측 못 한 것을 실패로 읽었다',
    ).toBe(true);
  });
});

describe('모르는 manifest 스키마는 거부한다', () => {
  /**
   * ```
   * materialize.ts  if (parsed.schema !== MANIFEST_SCHEMA) {  →  if (false) {   살아남았다
   * ```
   *
   * 스키마가 다른 manifest 를 그대로 읽으면, 우리가 모르는 모양을 아는 척 해석하게 된다.
   * 6차 검수가 "경계에서 unknown 을 해독한다" 고 세운 것과 같은 자리인데 여기는 비어 있었다.
   */
  it('스키마가 다르면 읽지 않는다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'barycenter-manifest-'));
    try {
      const gen = join(dir, 'generations', 'gen-A');
      mkdirSync(gen, { recursive: true });
      writeFileSync(join(gen, 'manifest.json'), JSON.stringify({
        schema: 999, generation: 'gen-A', files: {}, digest: 'sha256:x', planes: ['http'],
      }));

      expect(() => readManifest(dir, 'gen-A'), '모르는 스키마를 읽었다').toThrow(GenerationError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('아는 스키마는 읽는다 — 막기만 하는 게 아니다', () => {
    const dir = mkdtempSync(join(tmpdir(), 'barycenter-manifest-'));
    try {
      const manifest = materializeGeneration({
        prefix: dir, generation: 'gen-A',
        files: { 'nginx.conf': 'events {}' }, planes: ['http'],
      });
      expect(readManifest(dir, 'gen-A').digest, '방금 만든 것을 못 읽는다').toBe(manifest.digest);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 스윕이 찾은 넷째 무리 — 신원 비교가 통째로 미검사였다 ────────────────

describe('수렴의 신원 비교는 한 자리만 달라도 남의 것이다', () => {
  /**
   * ```
   * driver.ts  sameRecord 의 네 절(digest · operationId · transitionId · leaderToken)
   *            → 어느 하나를 무력화해도 534 개가 전부 초록
   * ```
   *
   * 수렴은 **바깥에 올라간 기록**과 기준을 이걸로 견준다. 절이 헐거우면 **남이 같은 이름
   * 으로 올린 세대를 "내 것" 으로 읽고** `converged` 를 답한다 — 9차가 `publishedByMe`
   * 에서 고친 "조용한 거짓 성공" 과 같은 병인데, 수렴 쪽은 비어 있었다.
   *
   * 21차가 짚은 병형("새 판정 자리마다 신원 비교를 빠뜨린다")이 **검사 쪽에도** 있었던
   * 셈이다. 자리를 만들 때만이 아니라 **자리를 검사할 때도** 빠뜨렸다.
   */
  const BASE = {
    generation: 'gen-A',
    generationDigest: 'sha256:gen-A',
    operationId: 'A',
    transitionId: 'A',
    leaderToken: '10',
  };

  const activated = async (): Promise<{ store: MemoryStore; effects: FakeEffects }> => {
    const store = new MemoryStore();
    const effects = new FakeEffects();
    await LocalDataplaneDriver.create({ store, effects }).applyConfig({
      leaderToken: '10', operationId: 'A', transitionId: 'A',
      affectedPlanes: ['http', 'stream'],
      targetGeneration: 'gen-A', generationDigest: 'sha256:gen-A',
      planes: {
        http: {
          expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
          target: { activationEpoch: '1', membershipRevision: '1' },
          payloadDigest: 'sha256:h-A',
        },
        stream: {
          expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
          target: { activationEpoch: '1', membershipRevision: '1' },
          payloadDigest: 'sha256:s-A',
        },
      },
    });
    return { store, effects };
  };

  for (const field of ['generationDigest', 'operationId', 'transitionId', 'leaderToken'] as const) {
    it(`${field} 만 달라도 내 것이 아니다`, async () => {
      const { store, effects } = await activated();
      // 세대 **이름은 같고** 한 자리만 다른 기록이 바깥에 올라가 있다.
      effects.publishedRecord = { ...BASE, [field]: `${BASE[field]}-남의것` };
      const before = effects.publishCalls;

      const r = await LocalDataplaneDriver.create({ store, effects }).reconcileConfig();

      expect(r.kind, `${field} 가 다른데 수렴했다고 답했다`).not.toBe('converged');
      expect(
        effects.publishCalls - before,
        '남의 것을 내 것으로 읽어 아무것도 안 했다',
      ).toBeGreaterThan(0);
    });
  }

  it('전부 같으면 수렴이다 — 막기만 하는 게 아니다', async () => {
    const { store, effects } = await activated();
    const r = await LocalDataplaneDriver.create({ store, effects }).reconcileConfig();
    expect(r.kind, '정합한데 갈라졌다고 답했다').toBe('converged');
  });
});

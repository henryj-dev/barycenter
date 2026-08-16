/**
 * **빚 갚기 — `completed` 가지치기와 신원 비교는 한 커밋이다**
 *
 * 22~27차가 여섯 번 지적했다. `completed` 는 전환마다 영구 누적돼 **무한히 자란다.**
 * 그런데 이 표는 자라면서 **우연히 방패 노릇도 하고 있었다** — id 만 비교하는 자리들이
 * 안전한 이유는 비교가 옳아서가 아니라 "같은 id 의 옛 전환이 늘 이 표에 남아 있어서
 * `admit` 이 먼저 시끄럽게 거부한다" 였다. 방어가 아니라 부작용이다.
 *
 * 그래서 STATUS 의 한계 목록에 이렇게 적어 뒀다: **"가지치기를 설계할 때 같은 커밋에서
 * 신원 비교로 바꾸는 것이 옳다. 그 전에는 캐시를 건드리지 마라."** 이 파일이 그 커밋의
 * 계측이다 — 자라지 않는 것과, 방패가 사라져도 안전한 것을 **둘 다** 본다.
 *
 * 스윕이 매 회차 같은 자리들을 생존자로 찍어 왔다(`agent.ts` 1106·1008·1243·1629 …).
 * 그것들이 여기서 하중을 받는다.
 */
import { describe, expect, it } from 'vitest';
import { DpAgent, DpRejection, MemoryStore, tupleFor } from '../../src/dp/agent.js';
import type { ApplyOperation } from '../../src/dp/operation.js';

const OP = (id: string, from: string, to: string): ApplyOperation => ({
  leaderToken: '10',
  operationId: id,
  transitionId: id,
  affectedPlanes: ['http'],
  targetGeneration: `gen-${id}`,
  generationDigest: `sha256:gen-${id}`,
  planes: {
    http: {
      expectedCurrent: { activationEpoch: from, membershipRevision: from },
      target: { activationEpoch: to, membershipRevision: to },
      payloadDigest: `sha256:h-${id}`,
    },
  },
});

/** 전환 하나를 끝까지 민다. */
async function transition(agent: DpAgent, op: ApplyOperation): Promise<void> {
  await agent.reserveAll(op, { op, phase: 'preflight', reloadAttempts: 0, progress: {} });
  await agent.stage(tupleFor(op, 'http'), null);
  await agent.commit(tupleFor(op, 'http'), { acceptingGeneration: op.targetGeneration });
  await agent.finishOperation(op, ['http']);
}

const completedSize = (store: MemoryStore): number =>
  Object.keys((store.load()!.payload as { completed: Record<string, unknown> }).completed).length;

describe('completed 는 무한히 자라지 않는다', () => {
  it('전환을 많이 흘려도 기록이 유계다', async () => {
    // **숫자가 아니라 유계성을 잰다.** 처음엔 "≤ 140" 이라고 썼다가 틀렸다 — 전환당
    // 단계가 셋(reserve·stage·commit)인데 둘로 셌다. 상수를 못박으면 그 상수가
    // 바뀔 때마다 테스트가 거짓말을 하거나 깨진다. **자라지 않는다는 것**이 재려는
    // 성질이므로 두 지점을 재서 비교한다.
    const at = async (n: number): Promise<number> => {
      const store = new MemoryStore();
      const agent = new DpAgent(store);
      for (let i = 1; i <= n; i += 1) {
        await transition(agent, OP(`op-${i}`, String(i - 1), String(i)));
      }
      return completedSize(store);
    };
    const small = await at(90);
    const large = await at(180);
    expect(large, '전환을 두 배로 흘렸더니 기록도 자랐다 — 유계가 아니다').toBe(small);
  });

  it('진행 중인 전환의 기록은 자르지 않는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    for (let i = 1; i <= 90; i += 1) {
      await transition(agent, OP(`op-${i}`, String(i - 1), String(i)));
    }
    // 91 번째를 **끝내지 않고** 연다 — 이건 지금 답해야 할 재요청이다.
    const live = OP('op-91', '90', '91');
    await agent.reserveAll(live, { op: live, phase: 'preflight', reloadAttempts: 0, progress: {} });
    const ack = await agent.stage(tupleFor(live, 'http'), null);
    expect(ack.cached, '전제가 틀렸다').toBe(false);

    // 같은 요청을 다시 보낸다 — 캐시가 답해야 한다.
    const again = await agent.stage(tupleFor(live, 'http'), null);
    expect(again.cached, '진행 중인 전환의 재요청 판정이 잘렸다').toBe(true);
  });
});

describe('방패가 사라진 뒤 — 측정한 것만 적는다', () => {
  /**
   * 22~27차가 여섯 회차에 걸쳐 이렇게 적었다: `completed` 캐시가 id-only 비교 자리들을
   * **우연히 지키고 있고**, 가지치기를 넣는 순간 그 자리들이 열린다. 23차는 캐시 삭제를
   * **모의**해서 영구 봉쇄까지 재현했다고 적었다.
   *
   * **가지치기를 실물로 넣고 그 경로를 다시 밟아 봤다 — 안 열렸다.** 이유가 있다:
   * 가지치기가 돌려면 전환이 64 개 지나가야 하는데, **그 전환들이 각각 옛 저널을 청소한다.**
   * 즉 "캐시는 잘렸는데 옛 저널은 남아 있는" 상태가 표면 경로로는 안 만들어진다.
   * 23차의 모의는 캐시만 지우고 그 사이 시간이 흐르지 않은 것으로 쳤다 — 실제보다 거칠었다.
   *
   * **그래서 여기서는 재현된 것만 단언한다.** 여섯 회차의 서술을 그대로 테스트로 옮기면
   * 이 레포가 스스로 금지한 짓(재현 안 되는 주장을 자산처럼 쌓는 것)이 된다.
   */
  it('fence 뒤 같은 id 를 새 토큰으로 내면 그 전환의 것으로 자리를 잡는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);

    const x = OP('X', '0', '1');
    await agent.reserveAll(x, { op: x, phase: 'preflight', reloadAttempts: 0, progress: {} });
    await agent.stage(tupleFor(x, 'http'), null);

    await agent.fence('11');
    for (let i = 1; i <= 90; i += 1) {
      await transition(agent, { ...OP(`f-${i}`, String(i - 1), String(i)), leaderToken: '11' });
    }

    const reissued: ApplyOperation = { ...OP('X', '90', '91'), leaderToken: '11' };
    await agent.reserveAll(reissued, {
      op: reissued, phase: 'preflight', reloadAttempts: 0, progress: {},
    });

    // 실행권과 저널이 **새 전환의 것**이어야 한다. 옛 토큰의 것이 남으면
    // `finishOperation` 이 그것을 못 지우고 다음 오퍼레이션이 영구히 막힌다.
    const after = new DpAgent(store);
    expect(after.activeOperation()?.leaderToken, '옛 토큰의 실행권이 남았다').toBe('11');
    expect(after.readJournal()?.op.leaderToken, '옛 토큰의 저널이 남았다').toBe('11');

    // 그리고 끝내면 자리가 비어야 한다.
    await after.finishOperation(reissued, ['http']);
    expect(new DpAgent(store).activeOperation(), '끝냈는데 실행권이 남았다').toBeUndefined();
  });

  it('잘린 뒤 늦게 온 재요청은 거짓말 대신 종단을 답한다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const first = OP('op-1', '0', '1');
    await transition(agent, first);
    for (let i = 2; i <= 90; i += 1) {
      await transition(agent, OP(`op-${i}`, String(i - 1), String(i)));
    }

    // op-1 의 기록은 잘렸다. 그 전환의 commit 이 이제야 도착한다.
    const late = await agent
      .commit(tupleFor(first, 'http'), { acceptingGeneration: first.targetGeneration })
      .then(() => 'ok' as const)
      .catch((e: unknown) => (e instanceof DpRejection ? e.kind : 'other'));

    // 캐시가 있었으면 `cached: true` 로 성공을 답했다. 잘린 뒤에는 `terminal` 이다 —
    // **둘 다 참이다.** 그 전환은 실제로 끝났다. 거짓 성공만 아니면 된다.
    expect(late, '잘린 기록 자리에서 새 전환이 시작됐다 — 되살아났다').toBe('terminal');
  });
});

describe('근거 기록도 자란다 — 절반만 자를 수 있다', () => {
  /**
   * `completed` 를 자르고 나서 재 봤더니 **`terminal` 과 `activationEvidence` 도 선형으로
   * 자라고 있었다.** 빚이 하나인 줄 알았는데 셋이었다.
   *
   * ```
   * n=50   completed=150  terminal=50   evidence=50
   * n=200  completed=192  terminal=200  evidence=200
   * ```
   *
   * `activationEvidence` 는 잘랐다 — **사후 감사용이고 프로덕션 독자가 없다**
   * (`evidenceFor` 를 부르는 것은 테스트뿐이다). 다만 **지금 서 있는 좌표의 근거**는
   * 창 밖이어도 안 지운다. 그건 과거가 아니라 현재에 대한 물음이다.
   *
   * `terminal` 은 **못 잘랐다.** 그건 감사 기록이 아니라 부활 방지 장치다 — 지우면
   * 운영자가 포기한 전환이 되살아난다. 토큰이 낡은 것만 자르는 규칙도 안전하지 않다:
   * 후보가 fence 를 건너 승계될 수 있어 낡은 토큰의 종단 기록을 지금 후보가 읽는다.
   * **자를 규칙을 못 찾은 것이지 안 자라는 것이 아니다** — 한계 목록에 그렇게 적었다.
   */
  it('근거 기록이 유계다', async () => {
    const at = async (n: number): Promise<number> => {
      const store = new MemoryStore();
      const agent = new DpAgent(store);
      for (let i = 1; i <= n; i += 1) {
        await transition(agent, OP(`op-${i}`, String(i - 1), String(i)));
      }
      const p = store.load()!.payload as { activationEvidence: Record<string, unknown> };
      return Object.keys(p.activationEvidence).length;
    };
    expect(await at(200), '근거 기록이 전환 수만큼 자란다').toBe(await at(100));
  });

  it('지금 서 있는 자리의 근거는 자르지 않는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    for (let i = 1; i <= 200; i += 1) {
      await transition(agent, OP(`op-${i}`, String(i - 1), String(i)));
    }
    expect(
      new DpAgent(store).evidenceFor('http', '200'),
      '지금 여기 있는 이유를 답할 수 없게 됐다',
    ).toBeDefined();
  });
});

/**
 * `terminal` 원장 가지치기 — **추월된 것만** (35차 스케치, 2026-08-24)
 *
 * `agent.ts` 의 `prune` 머리말이 이 일을 이렇게 남겨 두었다:
 *
 * > 다만 **"자를 규칙이 없다" 는 과장이었다** (35차 검수). 규칙의 얼개는 있다 —
 * > **목표 epoch 이 좌표에 추월된 항목은 구조적으로 부활 불가**다 … 걸리는 것은 지금
 * > `terminal` **키에 epoch 이 없다**는 것이고, I7 첫 절도 같이 좁혀야 하며, 서 있는
 * > epoch 의 `activated` 와 후보가 참조하는 것은 보존해야 한다.
 * >
 * > **설계 스케치이고 프로토타입은 안 했다.** … 다음 회차의 일로 남긴다.
 *
 * 세 걸림돌을 다 넘었다: 좌표를 **값에** 적고(`terminalAt`), I7 을 근거 절과 같은
 * 모양으로 좁히고, 보존해야 할 것들을 판정식 하나에 모았다.
 *
 * ── 이 파일의 무게중심은 **안 자르는 것**이다
 *
 * 이 표는 감사 기록이 아니라 **부활 방지 장치**다. 잘못 자르면 운영자가 포기한 전환이
 * 되살아난다. 그래서 자르는 검사보다 안 자르는 검사가 많다 — 이 표에서 틀리는 방향은
 * 하나뿐이어야 한다.
 */
import { describe, expect, it } from 'vitest';
import { DpAgent, DpRejection, MemoryStore, tupleFor } from '../../src/dp/agent.js';
import type { ApplyOperation } from '../../src/dp/operation.js';

const OP = (id: string, from: string, to: string, token = '10'): ApplyOperation => ({
  leaderToken: token,
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

async function transition(agent: DpAgent, op: ApplyOperation): Promise<void> {
  await agent.reserveAll(op, { op, phase: 'preflight', reloadAttempts: 0, progress: {} });
  await agent.stage(tupleFor(op, 'http'), null);
  await agent.commit(tupleFor(op, 'http'), { acceptingGeneration: op.targetGeneration });
  await agent.finishOperation(op, ['http']);
}

const terminalCount = (store: MemoryStore): number => {
  const payload = store.load()?.payload as { terminal?: Record<string, unknown> } | undefined;
  return Object.keys(payload?.terminal ?? {}).length;
};

describe('원장이 유계다', () => {
  /**
   * **이것이 이 커밋의 이유다.** 전에는 전환마다 평면 수만큼 늘고 지우는 코드가 하나도
   * 없었다 — 측정돼 있다: *"n=200 → terminal=200."*
   */
  it('전환을 많이 흘려도 원장이 유계다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    for (let i = 1; i <= 60; i += 1) {
      await transition(agent, OP(`op-${i}`, String(i - 1), String(i)));
    }
    // 서 있는 좌표(60)와 그 뒤 몇 개만 남는다. 선형이면 60 이다.
    expect(terminalCount(store), '원장이 전환 수만큼 자란다').toBeLessThan(10);
  });

  it('자르고도 진행이 막히지 않는다 — 다음 전환이 정상으로 선다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    for (let i = 1; i <= 40; i += 1) {
      await transition(agent, OP(`op-${i}`, String(i - 1), String(i)));
    }
    await expect(transition(agent, OP('op-41', '40', '41'))).resolves.toBeUndefined();
  });
});

describe('안 자르는 것들 — 이 표에서 틀리는 방향은 하나뿐이어야 한다', () => {
  /**
   * **서 있는 좌표의 기록은 남는다.** 베이스라인 승격(`candidateArrived` 의 원장 폴백)이
   * 그 자리를 읽는다 — 잘리면 레거시 상태에서 승격이 영영 실패한다(46차가 실측했다).
   */
  it('서 있는 epoch 의 기록은 안 자른다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    for (let i = 1; i <= 30; i += 1) {
      await transition(agent, OP(`op-${i}`, String(i - 1), String(i)));
    }
    // 마지막 전환은 좌표 30 에서 끝났다 — 그 기록이 살아 있어야 한다.
    expect(agent.terminalOf(tupleFor(OP('op-30', '29', '30'), 'http'))).toBe('activated');
  });

  /**
   * **예약이 살아 있는 자리는 안 자른다** — 판정식의 셋째 절.
   *
   * ⚠️ **이 절은 지금 도달 경로가 없다.** 예약을 남기려면 그 오퍼레이션이 apply 경로를
   * 쥔 채여야 하고, 그러면 다음 오퍼레이션이 `operation_in_flight` 로 막혀 좌표가 못
   * 나간다 — 즉 "예약은 살아 있는데 좌표가 추월했다" 를 공개 API 로 못 만든다.
   * 실제로 만들어 보다 확인했다.
   *
   * **그래도 절을 남긴다.** I7 이 자기 자리에 적어 둔 것과 같은 성격이다:
   *
   * > 이 불변식은 지금 코드의 버그를 잡는 게 아니라, **앞으로 이 기록들을 지우기
   * > 시작하는 변경**을 막는다.
   *
   * 홀더 게이트가 언젠가 바뀌면 그 상태가 열리고, 그때 이 절이 없으면 fence 스윕이
   * 빈 원장 위에 `aborted` 를 덮어 찍는다. 여기서는 **도달 못 한다는 사실**을 못 박아
   * 다음 사람이 "왜 이 절이 안 잡히나" 를 다시 조사하지 않게 한다.
   */
  it('예약을 남긴 채로는 좌표가 못 나간다 — 그래서 그 절은 아직 도달 불가다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    for (let i = 1; i <= 5; i += 1) {
      await transition(agent, OP(`op-${i}`, String(i - 1), String(i)));
    }
    const held = OP('held', '5', '6');
    await agent.reserveAll(held, { op: held, phase: 'preflight', reloadAttempts: 0, progress: {} });
    expect(agent.reservationOwner('http', '6'), '전제: 예약이 섰다').toBeDefined();

    // 좌표를 더 밀려 하면 홀더가 막는다.
    const next = OP('after', '5', '7');
    const kind = await agent
      .reserveAll(next, { op: next, phase: 'preflight', reloadAttempts: 0, progress: {} })
      .then(() => 'ok' as const)
      .catch((e: unknown) => (e instanceof DpRejection ? e.kind : 'other'));
    expect(kind, '홀더가 안 막았다 — 그러면 예약 절이 도달 가능해진다').toBe('operation_in_flight');
  });

  /**
   * **아직 안 추월된 것은 안 자른다.** 좌표와 같거나 그 앞이면 부활 경로가 아직 열려
   * 있다 — `epoch_not_monotonic` 이 막는 것은 **뒤로 가는** 예약뿐이다.
   */
  it('아직 안 추월된 기록은 그대로다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const op = OP('only', '0', '1');
    await transition(agent, op);
    expect(agent.terminalOf(tupleFor(op, 'http')), '한 전환만으로는 안 잘린다').toBe('activated');
  });

  /**
   * **이것이 추월 조건이 하중을 받는 자리다.**
   *
   * `aborted` 는 좌표를 안 옮긴다 — 포기한 전환의 목표 epoch 은 **좌표보다 앞**에 남는다.
   * 그 기록을 자르면 `admit` 이 막을 근거를 잃고, 운영자가 포기한 전환이 같은 좌표로
   * **다시 선다.** 그게 이 표를 오래 못 자른 이유 전부다.
   *
   * 처음에 추월 조건만 빼는 뮤테이션이 살아남았다 — 활성화 기록은 `lastActivated` 가
   * 따로 지켜서 조건이 없어도 안 잘렸기 때문이다. **abort 가 그 가림막 밖에 있다.**
   */
  it('포기한 전환은 좌표가 아직 그 앞이면 안 자르고, 부활도 막는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    for (let i = 1; i <= 5; i += 1) {
      await transition(agent, OP(`op-${i}`, String(i - 1), String(i)));
    }
    // 좌표는 5. epoch 6 을 예약했다가 포기한다 — 좌표는 5 에 그대로다.
    const given = OP('given-up', '5', '6');
    await agent.reserveAll(given, {
      op: given, phase: 'preflight', reloadAttempts: 0, progress: {},
    });
    await agent.abort(tupleFor(given, 'http'));
    // **홀더를 놓는다.** `abort` 는 슬롯만 반납하고 apply 경로는 안 놓는다 — 안 놓으면
    // 다음 오퍼레이션이 `operation_in_flight` 로 막힌다.
    await agent.finishOperation(given, ['http']);
    expect(agent.terminalOf(tupleFor(given, 'http')), '전제: 포기가 기록됐다').toBe('aborted');

    // 그 뒤로도 계속 돌린다. 좌표는 6 을 건너뛰고 앞으로 간다.
    await transition(agent, OP('op-7', '5', '7'));
    // **90 회다.** 적게 돌리면 `completed` 창 안이라 멱등 캐시가 `ok` 를 답하고, 그건
    // 부활이 아니라 같은 요청의 재생이다 — 그 가림막을 걷어야 원장을 재는 것이 된다.
    for (let i = 8; i <= 90; i += 1) {
      await transition(agent, OP(`op-${i}`, String(i - 1), String(i)));
    }

    // 이제는 추월됐으니 잘려도 된다 — 그런데 **잘려도 부활이 막혀야** 한다.
    const revived = await agent
      .reserveAll(given, { op: given, phase: 'preflight', reloadAttempts: 0, progress: {} })
      .then(() => 'ok' as const)
      .catch((e: unknown) => (e instanceof DpRejection ? e.kind : 'other'));
    expect(revived, '포기한 전환이 되살아났다').not.toBe('ok');
  });

  /**
   * 같은 상황에서 **아직 추월 전**이면 원장이 그대로여야 한다. 위 검사가 "잘린 뒤에도
   * 안전하다" 를 보고, 이 검사가 "아직 자르면 안 된다" 를 본다.
   */
  it('포기한 전환은 좌표가 그 앞일 동안 원장에 남는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    for (let i = 1; i <= 5; i += 1) {
      await transition(agent, OP(`op-${i}`, String(i - 1), String(i)));
    }
    const given = OP('given-up', '5', '6');
    await agent.reserveAll(given, {
      op: given, phase: 'preflight', reloadAttempts: 0, progress: {},
    });
    await agent.abort(tupleFor(given, 'http'));

    // 좌표를 5 에 둔 채로 다른 일을 시킨다 — 원장은 그대로여야 한다.
    for (let i = 0; i < 3; i += 1) await agent.fence(String(11 + i));
    expect(
      agent.terminalOf(tupleFor(given, 'http')),
      '좌표가 아직 그 앞인데 포기 기록이 잘렸다 — 되살아날 수 있다',
    ).toBe('aborted');
  });

  /**
   * **좌표를 모르는 항목은 안 자른다.** 업그레이드 전에 쌓인 기록은 `terminalAt` 이
   * 없고, 모르는 것을 자르면 운영자가 포기한 전환이 되살아난다.
   */
  it('좌표를 모르는 옛 기록은 안 자른다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    for (let i = 1; i <= 5; i += 1) {
      await transition(agent, OP(`op-${i}`, String(i - 1), String(i)));
    }
    // 업그레이드 전 상태를 흉내 낸다 — 원장은 있는데 좌표 표가 없다.
    const raw = store.load()!;
    const payload = raw.payload as { terminal: Record<string, string>; terminalAt?: unknown };
    const legacyKey = 'legacy-op:legacy-op:9:http';
    payload.terminal[legacyKey] = 'aborted';
    delete payload.terminalAt;
    await store.save({ version: raw.version + 1, payload });

    const after = new DpAgent(store);
    for (let i = 6; i <= 30; i += 1) {
      await transition(after, OP(`op-${i}`, String(i - 1), String(i)));
    }
    const left = store.load()!.payload as { terminal: Record<string, string> };
    expect(left.terminal[legacyKey], '좌표를 모르는 기록이 잘렸다').toBe('aborted');
  });
});

describe('부활 방지는 그대로다', () => {
  /**
   * **문이 바뀌었지 열린 것이 아니다.** 잘린 뒤에는 `terminal` 대신 `not_staged` 나
   * `coordinate_mismatch` 가 막는다 — `agent.ts` 의 세 문 중 나머지 둘이다.
   *
   * 이 검사가 지키는 것은 종류가 아니라 **성공이 아님**이다.
   */
  it('잘린 좌표로 온 늦은 commit 은 여전히 거절이다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const first = OP('op-1', '0', '1');
    await transition(agent, first);
    // **90 회다.** 40 회로는 `completed` 창 안이라 멱등 캐시가 `ok` 를 답한다 —
    // 그건 되살아남이 아니라 **같은 요청의 재생**이고, 정상 동작이다. 캐시까지
    // 밀어내야 "원장이 잘린 뒤" 를 재는 것이 된다.
    for (let i = 2; i <= 90; i += 1) {
      await transition(agent, OP(`op-${i}`, String(i - 1), String(i)));
    }
    const late = await agent
      .commit(tupleFor(first, 'http'), { acceptingGeneration: first.targetGeneration })
      .then(() => 'ok' as const)
      .catch((e: unknown) => (e instanceof DpRejection ? e.kind : 'other'));
    expect(late, '잘린 자리에서 늦은 commit 이 성공했다 — 되살아났다').not.toBe('ok');
    expect(['terminal', 'not_staged', 'coordinate_mismatch'], `막은 문: ${late}`).toContain(late);
  });

  /**
   * **뒤로 가는 예약은 애초에 안 선다.** 이것이 가지치기를 안전하게 만드는 근거이고,
   * 원장이 아니라 `reserve` 의 단조성이 막는다는 것을 여기서 못 박는다 — 이 문이
   * 사라지면 가지치기의 전제가 무너진다.
   */
  it('추월된 epoch 으로는 다시 예약할 수 없다 — 가지치기의 전제다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    for (let i = 1; i <= 20; i += 1) {
      await transition(agent, OP(`op-${i}`, String(i - 1), String(i)));
    }
    const back = OP('again', '0', '1');
    const kind = await agent
      .reserveAll(back, { op: back, phase: 'preflight', reloadAttempts: 0, progress: {} })
      .then(() => 'ok' as const)
      .catch((e: unknown) => (e instanceof DpRejection ? e.kind : 'other'));
    expect(kind, '뒤로 가는 예약이 섰다 — 가지치기의 근거가 무너진다').not.toBe('ok');
  });
});

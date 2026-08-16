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

/**
 * **CE-42 — 부류를 이름 붙이고 한 자리만 고쳤다** (42차 검수)
 *
 * 41차에 CE-41-A 를 고치며 *"9차 반례 ③ 부류다"* 라고 **부류를 지목해 놓고 한 자리만
 * 고쳤다.** 같은 id-only 슬롯 대조가 `supersede` 에 그대로 남아 있었다.
 *
 * 그리고 CE-41-A 가 **승인한 바로 그 전제**(신임의 슬롯이 홀더 없이 존재한다)에서 같은
 * 피해가 난다 — 제3자가 같은 좌표로 들어오면 고아 청소가 `supersede` 를 부르고, 그것이
 * id 만 보고 **신임의 살아 있는 예약을 지운다.** 게다가 청소가 `terminal` 을 찍는데
 * `transitionKey` 에 토큰이 없어 **신임까지 죽는다** — 34차 B 가 자기-찍기만 막았고
 * 제3자 경유는 열려 있었다.
 *
 * *"이름을 붙이는 것과 전 자리를 고치는 것은 다른 일이다"* — 40차가 이름 붙이고
 * 41차가 재연을 짚은 그 병을, **41차 커밋 자신이 세 번째로 재연했다.**
 */
it('제3자가 들어와도 신임의 예약과 전환이 살아남는다', async () => {
  const store = new MemoryStore();
  const agent = new DpAgent(store);
  const x10 = OP('10');
  const x11 = OP('11');
  const y11: ApplyOperation = { ...OP('11'), operationId: 'Y', transitionId: 'Y' };

  // 14차가 인정한 상태: 비종단 저널 + 실행권 없음.
  await agent.reserveAll(x10, {
    op: x10, phase: 'preflight', reloadAttempts: 0, progress: {},
  });
  // **슬롯까지 놓는다.** 기본값은 빈 배열이라 예약이 남는다 — 그러면 신임이 아예
  // 자리를 못 잡아 이 무대가 안 선다(첫 시도가 그렇게 죽었다).
  await agent.finishOperation(x10, ['http', 'stream']);
  expect(agent.readJournal()?.phase, '전제: 저널이 비종단으로 남았다').toBe('preflight');

  await agent.fence('11');
  // 신임이 같은 id 로 자리를 잡는다. `release` 를 먼저 부르는 이유는 `completed` 캐시가
  // `tuple_mismatch` 로 막기 때문이고 — 그 캐시가 이 레포가 **"방어가 아니라 부작용"**
  // 이라 부른 우연한 방패다. `release` 의 주석이 바로 이 용도를 적어 놓았다:
  // *"같은 operationId 로 다시 시도할 수 있어야 한다."*
  for (const plane of ['http', 'stream'] as const) {
    await agent.release(tupleFor(x11, plane));
    await agent.reserve(tupleFor(x11, plane));
  }
  expect(
    new DpAgent(store).reservationOwner('http', '1')?.leaderToken,
    '전제: 신임의 슬롯이 섰다',
  ).toBe('11');

  // 제3자가 같은 좌표로 들어온다 — 고아 청소가 돌고 supersede 가 불린다.
  const outcome = await agent
    .reserveAll(y11, { op: y11, phase: 'preflight', reloadAttempts: 0, progress: {} })
    .then(() => 'acquired')
    .catch(() => 'rejected');

  const after = new DpAgent(store);
  expect(
    {
      outcome,
      slotOwner: after.reservationOwner('http', '1')?.operationId,
      xTerminal: after.terminalOf(tupleFor(x11, 'http')),
    },
    '제3자가 신임의 좌표를 가로채고 신임의 전환까지 죽였다',
  ).toEqual({ outcome: 'rejected', slotOwner: 'X', xTerminal: undefined });
});

/**
 * **CE-43-A — 제3자가 신임의 전환에 종단을 찍는다** (43차 검수)
 *
 * CE-42 를 고치며 커밋 메시지에 이렇게 적었다 — *"청소가 `terminal` 을 찍는데
 * `transitionKey` 에 토큰이 없어 신임의 전환까지 죽는다. 34차 B 가 자기-찍기만 막았고
 * **제3자 경유는 열려 있었다**."* **그리고 그 줄을 안 고쳤다.** 슬롯 대조만 고쳤다.
 *
 * *"이름을 붙이는 것과 전 자리를 고치는 것은 다른 일이다"* 의 **네 번째 재연**이다.
 *
 * 게다가 **CE-42 테스트가 우연한 방패로 초록이었다.** 거기서는 제3자가 같은 좌표를
 * 겨눠 `acquire` 가 `slot_taken` 을 던지고, `serial()` 이 임계구역을 통째로 버려
 * **종단 스탬프까지 롤백**된다. 좌표를 한 칸만 비켜 놓으면 아무것도 안 던지고 전부
 * 저장된다 — 이 레포가 이름 붙인 "우연한 방패" 가 자기 회귀 테스트 안에서 재발했다.
 */
it('제3자가 다른 좌표를 잡아도 신임의 전환을 죽이지 않는다', async () => {
  const store = new MemoryStore();
  const agent = new DpAgent(store);
  const x10 = OP('10');
  const x11 = OP('11');
  // **좌표를 한 칸 비킨다** — 다음 세대를 미는 지극히 정상적인 오퍼레이션이다.
  const y11: ApplyOperation = {
    ...OP('11'),
    operationId: 'Y',
    transitionId: 'Y',
    planes: {
      http: {
        expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
        target: { activationEpoch: '2', membershipRevision: '2' },
        payloadDigest: 'sha256:hy',
      },
      stream: {
        expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
        target: { activationEpoch: '2', membershipRevision: '2' },
        payloadDigest: 'sha256:sy',
      },
    },
  };

  await agent.reserveAll(x10, {
    op: x10, phase: 'preflight', reloadAttempts: 0, progress: {},
  });
  await agent.finishOperation(x10, ['http', 'stream']);
  await agent.fence('11');
  for (const plane of ['http', 'stream'] as const) {
    await agent.release(tupleFor(x11, plane));
    await agent.reserve(tupleFor(x11, plane));
  }

  await agent.reserveAll(y11, {
    op: y11, phase: 'preflight', reloadAttempts: 0, progress: {},
  });

  expect(
    new DpAgent(store).terminalOf(tupleFor(x11, 'http')),
    '제3자가 신임의 전환을 aborted 로 찍었다 — 운영자는 포기한 적이 없다',
  ).toBeUndefined();
});

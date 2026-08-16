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

/**
 * **CE-45-A — 창의 방향이 반대였다** (45차 검수)
 *
 * 44차에 키 변경의 대가를 이렇게 적었다 — *"26차 `by` 의 창과 같은 부류이고 **방향도
 * 같다**."* **거짓이다.** `by` 의 창은 **비관**(덜 인정)이고 34차 캐시 창도 비관이었는데,
 * 이 창은 **낙관**이다: 토큰 없는 옛 키가 조회에 안 걸려 **운영자가 포기한 전환이
 * 업그레이드 뒤 좌표를 옮긴다.**
 *
 * 이 시리즈가 1 회성 창을 축 밖 '한계' 로 승인해 온 근거는 매번 **방향의 안전**이었다.
 * 그 근거가 무너졌으므로 가격표 오류가 아니라 반례다.
 *
 * 비관으로 되돌렸다 — 조회가 옛 키도 본다. **새 쓰기는 옛 키를 안 만들므로** CE-43-A
 * (정당한 승계 오살)는 다시 안 열린다: 옛 키에 걸리는 것은 44차 이전 코드가 남긴
 * 기록뿐이다. 아래 둘이 그 양쪽을 잰다.
 */
describe('구버전 원장의 창은 비관이어야 한다', () => {
  it('옛 포맷으로 포기된 전환은 업그레이드 뒤에도 되살아나지 않는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const x10 = OP('10');
    await agent.reserveAll(x10, {
      op: x10, phase: 'preflight', reloadAttempts: 0, progress: {},
    });

    // 44차 이전 코드가 남긴 모양 — 키에 토큰이 없다.
    const raw = store.load()!;
    const payload = raw.payload as { terminal: Record<string, string> };
    payload.terminal['X:X:http'] = 'aborted';
    await store.save({ ...raw, version: raw.version + 1, payload });

    const late = await new DpAgent(store).stage(tupleFor(x10, 'http'), null)
      .then(() => 'ok')
      .catch((e: unknown) => (e as { kind?: string }).kind ?? 'other');
    expect(late, '운영자가 포기한 전환이 업그레이드 뒤 되살아났다').toBe('terminal');
  });

  it('옛 키 조회가 정당한 승계를 다시 막지는 않는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const x10 = OP('10');
    const x11 = OP('11');

    await agent.reserveAll(x10, {
      op: x10, phase: 'preflight', reloadAttempts: 0, progress: {},
    });
    await agent.abort(tupleFor(x10, 'http'));
    await agent.fence('11');

    // 신임은 **자기 칸**을 본다 — 옛 키에는 44차 이후 코드가 아무것도 안 쓴다.
    expect(
      new DpAgent(store).terminalOf(tupleFor(x11, 'http')),
      '옛 키 조회가 정당한 승계까지 막았다 — CE-43-A 가 다시 열렸다',
    ).toBeUndefined();
  });
});

/**
 * **포기는 전환에 붙지 이름에 붙지 않는다** (45차 계약 판정을 못박는다)
 *
 * 44차에 키에 토큰을 넣으면서 원장의 뜻이 바뀌었다 — "이 **이름**은 끝났다" 에서
 * "이 **전환(토큰 포함)**은 끝났다" 로. 45차가 *"어느 쪽이 계약인지 적고 지키는 쪽을
 * 테스트로 핀해라"* 고 요구했다. 그 핀이다.
 *
 * 이름에 붙이면 **정당한 승계가 오살된다**(43차 CE-43-A). 옛 리더의 포기는 **그 리더의
 * 시도**에 대한 판단이고, 신임이 같은 이름을 다시 내는 것은 **컨트롤 플레인의 결정**이다.
 * DP 가 막아야 하는 것은 낡은 행위자의 부활뿐이고 토큰 범위 원장이 그것만 막는다.
 *
 * **대가를 적는다**: 운영자 abort 뒤 신임의 같은-이름 재발급을 DP 는 통과시킨다.
 * 그 게이트는 v0.2 컨트롤 플레인에 있어야 한다.
 */
describe('포기의 범위 — 계약', () => {
  it('낡은 행위자의 부활은 막고, 신임의 재발급은 막지 않는다', async () => {
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const x10 = OP('10');
    const x11 = OP('11');

    await agent.reserveAll(x10, {
      op: x10, phase: 'preflight', reloadAttempts: 0, progress: {},
    });
    await agent.abort(tupleFor(x10, 'http'));

    // ① 낡은 행위자 자신 — 같은 토큰이라 `assertLeader` 가 못 막는다. 원장이 막는다.
    const revive = await agent.stage(tupleFor(x10, 'http'), null)
      .then(() => 'ok').catch((e: unknown) => (e as { kind?: string }).kind ?? 'other');

    // ② 신임의 재발급 — 컨트롤 플레인의 결정이므로 DP 는 안 막는다.
    //
    // **48차에 고쳤다.** 전에는 `terminalOf === undefined` 만 보고 **재발급을 실행하지
    // 않았다** — 픽스처가 통과시킨 것이다. 그 사이 멱등 캐시(두 번째 이름 원장)가 실제
    // 재발급을 `tuple_mismatch` 로 막고 있었고, **이 테스트가 지키던 계약이 거짓이었는데
    // 초록이었다**(48차 CE-48-A). 이제 실제로 재발급해 본다.
    await agent.fence('11');
    const reissue = await agent
      .reserveAll(x11, { op: x11, phase: 'preflight', reloadAttempts: 0, progress: {} })
      .then(() => 'ok')
      .catch((e: unknown) => (e as { kind?: string }).kind ?? 'other');

    expect({ revive, reissue }, '포기의 범위가 계약과 다르다')
      .toEqual({ revive: 'terminal', reissue: 'ok' });
  });
});

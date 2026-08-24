/**
 * `agent.json` 의 성장이 상한 안이다 — 검수 2026-08-24 W3-5
 *
 * ── 소크 관측은 **결함이 아니었다**
 *
 * 6 분 소크(설정 변경 37 회)에서 `agentStateKb` 가 6 → 147 로 자랐고, 같은 실행에서
 * `generations`·`generationKb`·`rssMb` 는 전부 평탄해졌다. 그래서 **「상한이 없다」로
 * 읽었다.** 재 보니 아니다:
 *
 *   n      total    completed  #completed
 *    50   56,593      48,891      150
 *   175   76,667      66,817      192   ← 여기서 멈춘다
 *   400   76,668      66,817      192
 *
 * `COMPLETED_RETENTION`(64 전환 × 단계 3 = 192 항목)에서 **평탄해진다.** 소크는 37 회
 * 뿐이어서 그 창에 못 닿았고, 내가 램프업을 무한 성장으로 읽은 것이다.
 *
 * ── 그래서 이 파일이 재는 것
 *
 * 「자라나」가 아니라 **「어디서 멈추나」**다. 그게 값이 있는 이유는 이 저장소가 이 축을
 * **이미 한 번 열었기 때문**이다 — `prune` 의 주석이 적어 뒀다:
 *
 * > 48차 이전에는 키에 토큰이 없어 재발급이 **같은 키를 덮어썼으므로** 이 축이 없었다.
 * > 내가 키를 바꾸면서 그 축을 열었다. **"자리를 다 안 센다" 의 재연이다.**
 *
 * 그때 실측이 「재발급 80 회에 240 항목, 160 회에 480 — 정확히 선형」이었다. 새 축이
 * 열리면 이 파일이 그것을 잡는다.
 *
 * ── 왜 크기로 재나
 *
 * 소크가 그렇게 재고(`agentStateBytes` 게이지도 같다), 저장소가 payload 를 불투명하게
 * 다루기로 한 계약(9차 검수)을 안 깨기 때문이다. **그리고 이 파일은 오퍼레이션마다
 * 통째로 읽고 쓰인다** — 크기가 곧 지연이다.
 */
import { describe, expect, it } from 'vitest';

import {
  DpAgent, MemoryStore, type AgentState, type OperationTuple,
} from '../../src/dp/agent.js';
import type { ActivationEvidence } from '../../src/dp/operation.js';

/** epoch `n` 으로 넘어가는 한 평면 오퍼레이션. */
const op = (n: number, over: Partial<OperationTuple> = {}): OperationTuple => ({
  leaderToken: '10',
  operationId: `op-${n}`,
  transitionId: `t-${n}`,
  plane: 'http',
  expectedCurrent: { activationEpoch: String(n - 1), membershipRevision: String(n - 1) },
  target: { activationEpoch: String(n), membershipRevision: String(n) },
  payloadDigest: `sha256:p${n}`,
  targetGeneration: `gen-${n}`,
  generationDigest: `sha256:g${n}`,
  ...over,
});

const evidence = (n: number): ActivationEvidence => ({
  acceptingGeneration: `gen-${n}`,
  configTestPassed: true,
  errorLogGrowth: 0,
  masterPid: '1',
  workersReported: 2,
  workersExpected: 2,
});

/** 한 오퍼레이션을 끝까지 굴린다 — 예약 · staging · commit. */
async function cycle(a: DpAgent, n: number): Promise<void> {
  const o = op(n);
  await a.reserve(o);
  await a.stage(o, { slots: {} });
  await a.commit(o, evidence(n));
}

/** 저장소가 들고 있는 상태. **소크가 재는 것과 같은 값**이다. */
function stateOf(store: MemoryStore): { bytes: number; entries: number; state: AgentState } {
  const stored = store.load();
  if (stored === undefined) throw new Error('상태가 없다');
  const state = stored.payload as AgentState;
  return {
    bytes: JSON.stringify(stored).length,
    // **항목 수를 따로 센다.** 바이트는 epoch 자릿수가 늘면 움직이지만, 항목 수는
    // 보존 창이 서는지에만 반응한다.
    entries: Object.keys(state.completed).length
      + Object.keys(state.activationEvidence).length
      + Object.keys(state.terminal).length,
    state,
  };
}

/** 키별 직렬화 크기. **실패 메시지가 답을 들고 있어야 한다.** */
function bySize(state: AgentState): string {
  const rows = Object.entries(state as unknown as Record<string, unknown>)
    .map(([k, v]) => [k, JSON.stringify(v ?? null).length] as const)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([k, n]) => `${k}=${n}`);
  return rows.join(' · ');
}

describe('durable 상태의 성장', () => {
  /**
   * **평탄해지는 지점을 못 박는다.**
   *
   * 200 회와 400 회가 같아야 한다 — 보존 창이 서면 그 뒤로는 들어온 만큼 나간다.
   * 새 성장 축이 열리면(키에 필드가 하나 더 들어가는 것으로 충분하다) 여기가 갈린다.
   */
  it('오퍼레이션을 많이 돌려도 상태가 평탄해진다', async () => {
    const store = new MemoryStore();
    const a = new DpAgent(store);
    await a.fence('10');

    for (let n = 1; n <= 200; n += 1) await cycle(a, n);
    const at200 = stateOf(store);

    for (let n = 201; n <= 400; n += 1) await cycle(a, n);
    const at400 = stateOf(store);

    // **완전히 같아야 한다.** 「거의 같다」로 두면 항목당 몇 바이트씩 새는 축을 놓친다.
    expect(
      at400.entries,
      `200회 ${at200.bytes}B / ${at200.entries}항목 → 400회 ${at400.bytes}B / ${at400.entries}항목\n`
      + `  200회 ${bySize(at200.state)}\n`
      + `  400회 ${bySize(at400.state)}`,
    ).toBe(at200.entries);
    // 바이트는 epoch 자릿수가 늘면 몇 바이트 움직인다(`gen-200` → `gen-400`).
    // 항목 수가 같은데 바이트가 크게 벌어지면 그건 다른 이야기다.
    expect(at400.bytes).toBeLessThan(at200.bytes + 1024);
  }, 180_000);

  /**
   * **상한이 절대값으로도 있어야 한다.** 비율·항목 수만 보면 시작이 크면 통과한다.
   *
   * 지금 평탄값은 ~77 KB 다(`completed` 가 87%). 128 KB 로 잡는 것은 **여유를 두되
   * 새 축을 못 숨길 만큼**이라는 뜻이다 — 항목당 몇 바이트가 아니라 축이 하나 열리면
   * 실측처럼 선형이 되고, 그러면 이 상한을 금방 넘는다.
   */
  it('많이 굴려도 절대 크기가 상한 안이다', async () => {
    const store = new MemoryStore();
    const a = new DpAgent(store);
    await a.fence('10');
    for (let n = 1; n <= 400; n += 1) await cycle(a, n);

    const at = stateOf(store);
    expect(at.bytes, `400회 ${at.bytes}B — ${bySize(at.state)}`).toBeLessThan(128 * 1024);
  }, 180_000);
});

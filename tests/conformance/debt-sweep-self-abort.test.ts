/**
 * 34차 검수 — 재현 B 정본. **가지치기와 무관하다.**
 *
 * 코디네이터 트레이스와의 갈림 지점:
 *   · 나는 `finishOperation(x10)` 을 썼다 — holder 는 놓고 **저널은 비종단으로 남긴다**.
 *   · 코디네이터는 `releaseIdleHolder` 를 썼다 — 저널이 있으면 **no-op** 이라 holder 가
 *     남았고, 그래서 fence 의 supersede 가 저널을 'superseded'(종단)로 닫아 버려
 *     청소의 전제(`!isTerminalPhase(stale.phase)`)가 사라졌다.
 *   · X 의 completed 캐시는 **잘린 적이 없다.** admit 의 terminal 검사가 캐시 조회보다
 *     먼저이고, 그 terminal 은 같은 mutate 안에서 청소가 방금 적은 것이다.
 */
import { expect, it } from 'vitest';
import { DpAgent, DpRejection, MemoryStore } from '../../src/dp/agent.js';
import type { ApplyOperation } from '../../src/dp/operation.js';

const X = (token: string): ApplyOperation => ({
  leaderToken: token,
  operationId: 'X',
  transitionId: 'X',
  affectedPlanes: ['http'],
  targetGeneration: 'gen-X',
  generationDigest: 'sha256:gen-X',
  planes: {
    http: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: 'sha256:h-X',
    },
  },
});

it('재현 B — 같은-id 비종단 고아 저널 위의 재발급은 자기 청소에 걸린다', async () => {
  const store = new MemoryStore();
  const agent = new DpAgent(store);
  const x10 = X('10');

  // 1. X/10 이 실행권과 저널을 잡는다.
  await agent.reserveAll(x10, { op: x10, phase: 'preflight', reloadAttempts: 0, progress: {} });

  // 2. holder 만 놓는다 — finishOperation 은 저널을 닫지 않는다.
  //    (14차가 인정한 상태다: "비종단 저널인데 실행권이 없는 상태가 만들어질 수 있다"
  //     — reclaimOperation 이 존재하는 이유. 여기서는 공개 메서드로 직접 만든다.)
  await agent.finishOperation(x10);
  expect(agent.activeOperation(), '전제: holder 없음').toBeUndefined();
  expect(
    { op: agent.readJournal()?.op.operationId, phase: agent.readJournal()?.phase },
    '전제: 같은-id 저널이 비종단으로 남았다',
  ).toEqual({ op: 'X', phase: 'preflight' });

  // 3. fence — holder 가 없으므로 supersede 가 안 돌고 저널은 그대로다.
  //    (코디네이터 트레이스는 여기서 갈렸다: holder 가 남아 있어 저널이 종단으로 닫혔다.)
  await agent.fence('11');
  expect(agent.readJournal()?.phase, 'fence 뒤에도 저널은 비종단').toBe('preflight');

  // 4. 같은 id 를 새 토큰으로 재발급. 가지치기는 한 번도 안 돌았다(전환 2 개뿐).
  const x11 = X('11');
  const attempt = (): Promise<string> => agent
    .reserveAll(x11, { op: x11, phase: 'preflight', reloadAttempts: 0, progress: {} })
    .then(() => 'ok')
    .catch((e: unknown) => (e instanceof DpRejection ? `${e.kind}:${e.terminalState ?? ''}` : 'other'));

  const first = await attempt();
  const second = await attempt(); // 결정적 반복 — 매번 같다
  const after = store.load()!.payload as {
    terminal: Record<string, string>;
    completed: Record<string, unknown>;
    journal?: { phase: string; op: { leaderToken: string } };
  };
  expect(
    {
      first,
      second,
      // **키가 바뀌었다** (44차 — 토큰이 들어갔다). 옛 포맷으로 조회하면 무엇이 찍혀도
      // `undefined` 라 이 단언이 **공허해진다** — 45차가 짚었다. 두 포맷을 다 본다.
      ledger: after.terminal['X:X:10:http'] ?? after.terminal['X:X:http'],
      cacheAlive: 'X:X:http:reserve' in after.completed, // 캐시는 멀쩡하다 — 가지치기 무관
      journal: after.journal?.phase,
    },
    '청소가 자기 이름을 찍어 스스로를 거부한다 — 진단과 원장이 갈린다',
  ).toEqual({
    // **정직한 거부다.** 캐시가 "같은 키에 다른 요청" 이라고 답한다 — 그건 원장과
    // 어긋나지 않는다. 고치기 전에는 `terminal:aborted` 였는데, 그 진단이 가리키는
    // 원장 기록은 **존재한 적이 없었다**(쓰기가 예외와 함께 버려진다).
    first: 'tuple_mismatch:',
    second: 'tuple_mismatch:',
    ledger: undefined,
    cacheAlive: true,
    journal: 'preflight',
  });
});

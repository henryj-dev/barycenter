/**
 * 34차 검수 — 재현 A 정본.
 *
 * 핵심 두 가지 (코디네이터의 반박 지점):
 *   ① 진행 중 전환은 **가장 오래된** 그룹이다 — 먼저 열고, 그 뒤에 90 개를 흘렸다.
 *   ② 90 개는 **applyHealth** 전환이다 — 헬스는 실행권(activeOperation)을 잡지도,
 *      검사하지도, 저널을 열지도 않는다. 그래서 config 전환이 실행권을 쥔 동안에도
 *      completed 그룹 수가 는다.
 */
import { describe, expect, it } from 'vitest';
import { DpAgent, MemoryStore, tupleFor } from '../../src/dp/agent.js';
import type { OperationTuple } from '../../src/dp/agent.js';
import type { ApplyOperation } from '../../src/dp/operation.js';

const LIVE: ApplyOperation = {
  leaderToken: '10',
  operationId: 'a:b', // 콜론 — 미검증 string 계약 안의 입력
  transitionId: 't',
  affectedPlanes: ['http'],
  targetGeneration: 'gen-x',
  generationDigest: 'sha256:gen-x',
  planes: {
    http: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: 'sha256:h-x',
    },
  },
};

const health = (i: number): OperationTuple => ({
  leaderToken: '10',
  operationId: `h-${i}`,
  transitionId: `h-${i}`,
  plane: 'http',
  expectedCurrent: { activationEpoch: '0', membershipRevision: String(i - 1) },
  target: { activationEpoch: '0', membershipRevision: String(i) },
  payloadDigest: 'sha256:hp',
  targetGeneration: 'gen-h',
  generationDigest: 'sha256:gen-h',
});

it('재현 A — 진행 중(실행권+저널) 전환이 콜론 id 면 잘리는가', async () => {
  const store = new MemoryStore();
  const agent = new DpAgent(store);

  // ① 진행 중 전환을 **먼저** 연다 → completed 의 첫(가장 오래된) 그룹이 된다.
  await agent.reserveAll(LIVE, { op: LIVE, phase: 'preflight', reloadAttempts: 0, progress: {} });
  await agent.stage(tupleFor(LIVE, 'http'), null);
  expect(agent.activeOperation()?.operationId, '전제: 실행권을 쥐고 있다').toBe('a:b');
  expect(agent.readJournal()?.op.operationId, '전제: 저널이 가리킨다').toBe('a:b');

  // ② 실행권을 쥔 채로 헬스 전환 90 개 — applyHealth 는 실행권을 안 본다.
  for (let i = 1; i <= 90; i += 1) await agent.applyHealth(health(i), null);

  // 전제 확인: 여전히 진행 중이다.
  expect(agent.activeOperation()?.operationId).toBe('a:b');
  expect(agent.readJournal()?.op.operationId).toBe('a:b');

  // 잘렸는가? — 진행 중 전환의 재요청 판정.
  const completed = (store.load()!.payload as { completed: Record<string, unknown> }).completed;
  const mine = Object.keys(completed).filter((k) => k.startsWith('a:b:t:'));
  const again = await agent.stage(tupleFor(LIVE, 'http'), null);
  expect(
    { cachedReplay: again.cached, myEntries: mine.length },
    '진행 중 전환의 기록이 잘렸다',
  ).toEqual({ cachedReplay: true, myEntries: 2 });
});

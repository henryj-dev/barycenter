/**
 * **CE-46-A 재현 정본** (47차) — 46차가 "내 손으로 재현 못 했다" 고 적은 뒤집기.
 *
 * 시나리오(레거시 상태는 44차 이전 코드가 실제로 만들 수 있는 모양이다):
 *   · 44차 이전 세계에서 전환 X/10 이 http 를 commit 했다 — 원장에는 옛 포맷
 *     `X:X:http = 'activated'` 가 남는다(그 시절 키에는 토큰이 없다).
 *   · stream 을 밀기 전에 죽었다 — 저널은 비종단으로 남고 실행권은 없다(고아).
 *   · 업그레이드. 같은 리더(토큰 10)가 **다른 이름** Z 를 낸다 — fence 가 없어 원장이 유일한 방패다.
 *
 * `reserveAll(Z)` 의 고아 스윕이 X 의 평면마다 종단 스탬프를 찍는다. 46차 이전 코드는
 * **새 키만** 보고 비었다고 판단해 `X:X:10:http = 'aborted'` 를 찍는다 — `terminalOf`
 * 는 새 키를 먼저 보므로, **이미 activated 로 끝난 평면의 판정이 aborted 로 뒤집힌다.**
 *
 * 그 뒤집기는 I7("판정은 바뀌지 않는다")에 안 걸린다 — I7 은 키 단위 비교인데 여기서는
 * 기존 키가 바뀐 것이 아니라 **새 키가 얹혀서 조회 결과가 바뀐다.** 계측이 지키던 자리
 * 밖에서 판정이 뒤집히는 것, 그것이 이 반례의 몸통이다.
 *
 * 하류 증상까지 잰다: 실제로 일어난 commit 의 지연 replay 가
 *   · 고친 뒤(46차)  → 캐시된 ACK (멱등 성공 — 참말)
 *   · 고치기 전      → `terminal:aborted` ("이 전환은 일어나지 않았다" — 좌표는
 *                      이미 옮겨져 있는데. 거짓 진단)
 */
import { expect, it } from 'vitest';
import { DpAgent, MemoryStore, tupleFor } from '../../src/dp/agent.js';
import type { AgentState } from '../../src/dp/agent.js';
import type { ApplyOperation } from '../../src/dp/operation.js';

const X10: ApplyOperation = {
  leaderToken: '10',
  operationId: 'X',
  transitionId: 'X',
  affectedPlanes: ['http', 'stream'],
  targetGeneration: 'gen-X',
  generationDigest: 'sha256:gen-X',
  planes: {
    http: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: 'sha256:h-X',
    },
    stream: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: 'sha256:s-X',
    },
  },
};

const Z10: ApplyOperation = {
  leaderToken: '10',
  operationId: 'Z',
  transitionId: 'Z',
  affectedPlanes: ['http'],
  targetGeneration: 'gen-Z',
  generationDigest: 'sha256:gen-Z',
  planes: {
    http: {
      // X 가 http 를 1 로 옮겨 놓았다 — 신임은 그 위에서 다음 epoch 을 민다.
      expectedCurrent: { activationEpoch: '1', membershipRevision: '1' },
      target: { activationEpoch: '2', membershipRevision: '2' },
      payloadDigest: 'sha256:h-Z',
    },
  },
};

it('고아 스윕은 레거시 activated 위에 aborted 를 덮어 찍지 않는다 (CE-46-A)', async () => {
  const store = new MemoryStore();
  const agent = new DpAgent(store);

  // 1. X/10 이 실행권·저널을 잡고 http 를 실제로 commit 한다.
  await agent.reserveAll(X10, { op: X10, phase: 'preflight', reloadAttempts: 0, progress: {} });
  await agent.stage(tupleFor(X10, 'http'), null);
  await agent.commit(tupleFor(X10, 'http'), { acceptingGeneration: 'gen-X' });

  // 2. holder 만 놓는다 — 저널은 비종단('preflight')으로 남는다. 34차 재현 B 와 같은
  //    공개 경로다("비종단 저널 + 실행권 없음" 은 14차가 인정한 실재 상태다).
  await agent.finishOperation(X10);
  expect(agent.activeOperation(), '전제: holder 없음').toBeUndefined();
  expect(agent.readJournal()?.phase, '전제: 저널 비종단').toBe('preflight');

  // 3. **업그레이드 시뮬레이션** — 44차 이전 코드가 남긴 모양으로 되감는다.
  //    (debt-terminal-key.test.ts 의 레거시 시딩과 같은 수법. 새 키를 지우고 옛 키를
  //    남기는 것은 "그 기록을 옛 코드가 적었다" 를 뜻한다.)
  const raw = store.load()!;
  const payload = raw.payload as AgentState;
  delete payload.terminal['X:X:10:http'];
  payload.terminal['X:X:http'] = 'activated';
  delete payload.planes.http.by; // 옛 좌표에는 서명이 없다
  await store.save({ version: raw.version + 1, payload });

  expect(
    agent.terminalOf(tupleFor(X10, 'http')),
    '전제: 업그레이드 직후 원장은 activated 라고 답한다 (45차 폴백)',
  ).toBe('activated');

  // 4. 같은 리더(토큰 10)가 다른 이름 Z 를 낸다 — fence 없음, 원장이 유일한 방패다 — reserveAll 의 고아 스윕이 X 를 접는다.
  await agent.reserveAll(Z10, { op: Z10, phase: 'preflight', reloadAttempts: 0, progress: {} });

  // 5. **판정이 뒤집히면 안 된다.** 46차 이전 코드는 새 키만 보고
  //    `X:X:10:http = 'aborted'` 를 찍어, 같은 질문의 답이 activated → aborted 로 바뀐다.
  expect(
    agent.terminalOf(tupleFor(X10, 'http')),
    '스윕이 activated 로 끝난 평면을 aborted 로 뒤집었다 — I7 은 키 단위라 못 본다',
  ).toBe('activated');

  // 6. 하류 증상 — 실제로 일어난 commit 의 지연 replay.
  //    고친 뒤: 캐시된 ACK(멱등 성공). 고치기 전: terminal:aborted ("일어나지 않았다").
  const replay = await agent.commit(tupleFor(X10, 'http'), { acceptingGeneration: 'gen-X' })
    .then((ack) => (ack.cached ? 'cached-ok' : 'fresh-ok'))
    .catch((e: unknown) => {
      const r = e as { kind?: string; terminalState?: string };
      return `${r.kind}:${r.terminalState ?? ''}`;
    });
  expect(replay, '일어난 전환의 replay 가 "일어나지 않았다(aborted)" 로 거부된다')
    .toBe('cached-ok');

  // 7. 원장 원시 상태 — 옛 기록은 그대로, 새 키에 거짓이 얹히지 않았다.
  const after = store.load()!.payload as AgentState;
  expect(
    { legacy: after.terminal['X:X:http'], overlay: after.terminal['X:X:10:http'] },
    '새 포맷 칸에 거짓 aborted 가 남았다',
  ).toEqual({ legacy: 'activated', overlay: undefined });
});

/**
 * **46차 둘째 다리의 재현** — `candidateArrived` 의 수동 조립 키가 옛 포맷을 못 봐서
 * 레거시 상태의 승격이 실패하던 것 (46차가 "실측했다: baseline = undefined" 라고
 * 적었지만 **재현물을 커밋하지 않았다** — 46차 직전 코드는 전 스위트가 초록이다).
 *
 * 시나리오: 44차 이전 세계에서 X/10 이 http 를 commit 하고(옛 포맷 activated 스탬프 ·
 * 서명 없는 좌표) finalize 전에 죽었다. 업그레이드 뒤 복구가 후보를 완결한다.
 *   · 고친 뒤(46차)  → 원장 폴백이 옛 키를 보고 승격 — baseline = gen-X
 *   · 고치기 전      → 새 키만 조회해 미도착 판정 → 기준 폐위 — baseline = undefined
 */
it('레거시 activated 증거로도 후보가 승격된다 (46차 candidateArrived 폴백)', async () => {
  const store = new MemoryStore();
  const agent = new DpAgent(store);
  const x10http: ApplyOperation = {
    ...X10, affectedPlanes: ['http'],
    planes: { http: X10.planes.http! },
  };

  // 1. X/10 이 http 를 commit 한다 — pendingActivation(gen-X) 이 생긴다.
  await agent.reserveAll(x10http, { op: x10http, phase: 'preflight', reloadAttempts: 0, progress: {} });
  await agent.stage(tupleFor(x10http, 'http'), null);
  await agent.commit(tupleFor(x10http, 'http'), { acceptingGeneration: 'gen-X' });
  expect(agent.pendingActivation()?.generation, '전제: 후보가 있다').toBe('gen-X');

  // 2. 업그레이드 시뮬레이션 — 스탬프를 옛 포맷으로, 좌표에서 서명을 뗀다.
  const raw = store.load()!;
  const payload = raw.payload as AgentState;
  delete payload.terminal['X:X:10:http'];
  payload.terminal['X:X:http'] = 'activated';
  delete payload.planes.http.by;
  await store.save({ version: raw.version + 1, payload });

  // 3. 후보를 완결한다 — 판정 재료는 서명이 없어 원장 폴백으로 간다.
  await agent.finishOperation(x10http);

  expect(
    agent.lastActivated()?.generation,
    '레거시 증거를 못 봐 승격이 실패했다 — baseline = undefined (46차 실측 그대로)',
  ).toBe('gen-X');
});

/**
 * **레거시 범위의 계약 예외를 못박는다** (47차 E-47-1)
 *
 * 45차에 계약을 적었다 — *"포기는 전환에 붙지 이름에 붙지 않는다. 신임 리더가 같은
 * 이름을 다시 내면 DP 는 통과시킨다."* **레거시 기록에서는 거짓이다.**
 *
 * 44차 이전 키(`opId:tid:plane`)에는 토큰이 없어 **신원을 복원할 수 없고**, 조회가
 * 그것을 **이름 단위**로 본다. 옛 `aborted` 가 있는 이름은 **어떤 토큰의 재발급도
 * 영구히 거부**된다. 이주는 불가능하다 — 옛 키에서 토큰을 되살릴 방법이 없다.
 *
 * 비관 영구가 유일한 건전 선택이지만, **계약을 적은 자리에 예외를 안 적으면 그 계약은
 * 절반만 참이다.** 46차가 "영구" 를 확정하고도 DESIGN.md 에 안 적었고 47차가 짚었다.
 * 여기서 그 예외를 못박는다 — 다음 사람이 계약만 읽고 이 경로를 만나면 버그로 읽는다.
 */
it('레거시 aborted 는 이름 단위로 영구히 막는다 — 계약의 예외다', async () => {
  const store = new MemoryStore();
  const agent = new DpAgent(store);
  const x11: ApplyOperation = {
    leaderToken: '11', operationId: 'L', transitionId: 'L', affectedPlanes: ['http', 'stream'],
    targetGeneration: 'gen-L', generationDigest: 'sha256:gen-L',
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
  };

  // 상태를 정상 경로로 세운 뒤 레거시 기록만 얹는다 — 빈 payload 로는 상태가 안 선다.
  await agent.fence('11');
  const raw = store.load()!;
  const payload = raw.payload as { terminal: Record<string, string> };
  payload.terminal['L:L:http'] = 'aborted';
  await store.save({ ...raw, version: raw.version + 1, payload });

  const outcome = await new DpAgent(store)
    .reserveAll(x11, { op: x11, phase: 'preflight', reloadAttempts: 0, progress: {} })
    .then(() => 'ok')
    .catch((e: unknown) => (e as { kind?: string }).kind ?? 'other');

  expect(outcome, '계약은 "신임 재발급을 통과시킨다" 인데 레거시에서는 막는다').toBe('terminal');
});

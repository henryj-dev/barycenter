/**
 * 45차 프로브 P4 — CE-44-A 재현 시도 (커밋된 재현물이 없다는 것의 검증).
 *
 * 무대: 고아 X/11(비종단 저널·홀더 없음) + 같은 이름의 더 낡은 잔존 슬롯 X/10.
 * 제3자 Y/11 이 들어오면 고아 청소가 X/11 을 찍어야 한다. 43차 휴리스틱은 X/10 슬롯을
 * "승계된 신임" 으로 오인해 안 찍었고, 그 사이 X/11 의 지연 RPC(같은 토큰 — assertLeader
 * 가 못 막는다)가 슬롯을 되잡고 좌표를 옮겨 Y 의 진행 중 commit 을 깨뜨린다.
 *
 * HEAD 에서는 통과해야 하고, 휴리스틱을 되살린 뮤턴트에서는 빨개져야 한다.
 * (빨개지지 않으면 뮤턴트가 동치라는 뜻이고, 빨개지면 이 시나리오가 곧 CE-44-A 의
 * 커밋 가능한 재현물이다.)
 */
import { expect, it } from 'vitest';
import { DpAgent, MemoryStore, tupleFor } from '../../src/dp/agent.js';
import type { ApplyOperation } from '../../src/dp/operation.js';

const OP = (token: string, id: string, epoch: string, digest: string): ApplyOperation => ({
  leaderToken: token,
  operationId: id,
  transitionId: id,
  affectedPlanes: ['http'],
  targetGeneration: `gen-${id}`,
  generationDigest: `sha256:gen-${id}`,
  planes: {
    http: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: epoch, membershipRevision: epoch },
      payloadDigest: digest,
    },
  },
});

it('P4 — 낡은 잔존 슬롯이 방패가 되어도 고아는 부활하지 못한다 (CE-44-A)', async () => {
  const store = new MemoryStore();
  const agent = new DpAgent(store);
  const x10 = OP('10', 'X', '1', 'sha256:x10');
  const x11 = OP('11', 'X', '1', 'sha256:x11');
  const y11 = OP('11', 'Y', '2', 'sha256:y');

  // 1. 낡은 잔존 슬롯 X/10 — epoch 1 을 토큰 10 이 잡아 두고 방치했다.
  await agent.reserve(tupleFor(x10, 'http'));

  // 2. fence 11. 신임이 같은 이름 X 를 재발급하려다 저널만 열고 죽었다:
  //    비종단 저널 X/11 + 홀더 없음 (14차가 인정한 상태).
  await agent.fence('11');
  // X/10 슬롯이 남아 있으므로 X/11 은 다른 좌표를 못 잡는다 — 저널만 남기는 상태를
  // 공개 표면으로 만든다: reserveAll(slot 은 X/10 것이라 실패) 대신, 저널을 직접 연다.
  // (reserveAll 은 slot_taken 으로 통째로 굴러 떨어지므로, X/11 이 epoch 1 대신
  //  잔존 슬롯과 안 겹치는 좌표를 목표로 저널을 여는 변형을 쓴다 — CE-44-A 서술의
  //  "고아" 는 어떤 좌표든 상관없다.)
  const x11b = OP('11', 'X', '3', 'sha256:x11');
  // completed 캐시(토큰 없는 키)가 tuple_mismatch 로 막으므로, CE-42/43 테스트가 쓴
  // 정당화된 경로 그대로 release 로 캐시를 지운다.
  await agent.release(tupleFor(x11b, 'http'));
  await agent.reserveAll(x11b, { op: x11b, phase: 'preflight', reloadAttempts: 0, progress: {} });
  await agent.finishOperation(x11b); // 홀더만 놓는다 — 저널은 비종단으로 남는다.
  expect(agent.readJournal()?.phase).toBe('preflight');
  expect(agent.activeOperation()).toBeUndefined();

  // 3. 제3자 Y/11 이 들어온다 — 고아 청소가 X/11 을 찍어야 한다.
  await agent.reserveAll(y11, { op: y11, phase: 'preflight', reloadAttempts: 0, progress: {} });

  // 4. X/11 의 지연 RPC (같은 토큰 11 — assertLeader 는 못 막는다).
  const lateStage = await agent.stage(tupleFor(x11b, 'http'), null)
    .then(() => 'ok').catch((e: unknown) => (e as { kind?: string }).kind ?? 'other');
  const lateCommit = lateStage === 'ok'
    ? await agent.commit(tupleFor(x11b, 'http'), { acceptingGeneration: 'gen-X' })
      .then(() => 'ok').catch((e: unknown) => (e as { kind?: string }).kind ?? 'other')
    : 'skipped';

  // 5. Y 의 진행 중 commit — 고아가 좌표를 옮겼으면 여기가 깨진다.
  await agent.stage(tupleFor(y11, 'http'), null);
  const yCommit = await agent.commit(tupleFor(y11, 'http'), { acceptingGeneration: 'gen-Y' })
    .then(() => 'ok').catch((e: unknown) => (e as { kind?: string }).kind ?? 'other');

  console.log('P4:', {
    lateStage, lateCommit, yCommit, coord: agent.coordinate('http').activationEpoch,
  });
  expect(lateStage, '고아의 지연 stage 가 원장에 막히지 않았다').toBe('terminal');
  expect(yCommit, '제3자의 진행 중 commit 이 깨졌다').toBe('ok');
});

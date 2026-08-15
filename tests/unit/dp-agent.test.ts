/**
 * DP Agent 상태기계 — DESIGN.md §3.5 · §3.6
 *
 * S11 이 게이트 FAIL 인 이유는 하네스가 순차 테스트만 했기 때문이다. 4차 검수가 재현한
 * 실패는 이렇다.
 *
 *   T1 token=10 → 토큰 검사 통과 → **yield** → 재개 → 재검사 없이 슬롯 쓰기
 *   T2 token=11 → 그 사이에 완주
 *   결과: 낮은 토큰의 쓰기가 살아남아 트래픽이 오염됐다
 *
 * 그래서 여기서는 **검사와 적용을 하나의 임계구역**으로 묶는다 (§3.6-4). 그게 지켜지는지
 * 확인하려면 durable 저장이 느릴 때 동시 요청을 섞어야 한다 — 순차 테스트로는 못 잡는다.
 */
import type { ActivationEvidence } from '../../src/dp/operation.js';
import { describe, expect, it } from 'vitest';
import {
  DpAgent,
  DpRejection,
  MemoryStore,
  type OperationTuple,
} from '../../src/dp/agent.js';

const op = (over: Partial<OperationTuple> = {}): OperationTuple => ({
  leaderToken: '10',
  operationId: 'op-1',
  transitionId: 't-1',
  plane: 'http',
  expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
  target: { activationEpoch: '1', membershipRevision: '1' },
  payloadDigest: 'sha256:aaa',
  // 증거는 **이 세대**에 대한 것이어야 한다 — Agent 가 직접 판정한다 (6차 반례 ②).
  targetGeneration: 'gen-1',
  generationDigest: 'sha256:gen',
  ...over,
});

const agent = (delayMs = 0) => new DpAgent(new MemoryStore(delayMs));

/** 거부 사유를 꺼낸다. 통과하면 실패시킨다. */
async function rejectionOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof DpRejection) return e.kind;
    throw e;
  }
  throw new Error('거부되지 않았다');
}

/** 좌표를 옮기려면 근거가 있어야 한다 (§6.3). 단위 테스트에서는 최소 증거를 쓴다. */
const EVIDENCE: ActivationEvidence = { acceptingGeneration: 'gen-1' };

describe('§3.5 리더 펜싱', () => {
  it('더 높은 토큰을 수용하고 최대값을 올린다', async () => {
    const a = agent();
    expect(await a.fence('10')).toEqual({ maxToken: '10' });
    expect(await a.fence('11')).toEqual({ maxToken: '11' });
  });

  it('더 낮은 토큰은 거부한다', async () => {
    const a = agent();
    await a.fence('11');
    expect(await rejectionOf(a.fence('10'))).toBe('stale_leader');
  });

  it('낮은 토큰의 operation 도 전부 거부한다', async () => {
    const a = agent();
    await a.fence('11');
    expect(await rejectionOf(a.stage(op({ leaderToken: '10' }), 'payload'))).toBe('stale_leader');
    expect(await rejectionOf(a.commit(op({ leaderToken: '10' }), EVIDENCE))).toBe('stale_leader');
    expect(await rejectionOf(a.abort(op({ leaderToken: '10' })))).toBe('stale_leader');
  });

  // P21 — 토큰은 side effect **전에** fsync 된다. 재시작해도 판정이 남는다.
  it('P21 재시작 후에도 최대 토큰을 기억한다', async () => {
    const store = new MemoryStore();
    await new DpAgent(store).fence('11');
    const revived = new DpAgent(store);
    expect(await rejectionOf(revived.fence('10'))).toBe('stale_leader');
  });

  it('큰 수를 안전하게 다룬다 — decimal string 이라 number 범위를 넘어도 된다', async () => {
    const a = agent();
    const big = '9007199254740993';           // Number.MAX_SAFE_INTEGER + 2
    await a.fence(big);
    expect(await rejectionOf(a.fence('9007199254740992'))).toBe('stale_leader');
  });
});

describe('§3.6 stage → commit', () => {
  it('정상 경로', async () => {
    const a = agent();
    await a.fence('10');
    await a.stage(op(), 'payload');
    const ack = await a.commit(op(), EVIDENCE);
    expect(ack.activationEpoch).toBe('1');
    expect(ack.payloadDigest).toBe('sha256:aaa');
    // **서명이 계약의 일부다** (26차). 좌표는 "누가 놨는지" 를 같이 적는다 — 그게 없으면
    // "내가 옮겼는가" 를 닮음으로 추론하게 되고, 그 추론이 §3.4 를 여섯 번 재발시켰다.
    expect(a.coordinate('http')).toEqual({
      activationEpoch: '1', membershipRevision: '1', payloadDigest: 'sha256:aaa',
      by: { operationId: 'op-1', transitionId: 't-1', leaderToken: '10' },
    });
  });

  it('staging 없이 commit 하면 거부한다', async () => {
    const a = agent();
    await a.fence('10');
    expect(await rejectionOf(a.commit(op(), EVIDENCE))).toBe('not_staged');
  });

  it('expected_current 가 다르면 거부한다 — "더 높으니까"가 아니라 CAS 다', async () => {
    const a = agent();
    await a.fence('10');
    const wrong = op({ expectedCurrent: { activationEpoch: '5', membershipRevision: '0' } });
    expect(await rejectionOf(a.stage(wrong, 'payload'))).toBe('coordinate_mismatch');
  });

  it('epoch 는 엄격 단조여야 한다', async () => {
    const a = agent();
    await a.fence('10');
    await a.stage(op(), 'p'); await a.commit(op(), EVIDENCE);
    const back = op({
      operationId: 'op-2', transitionId: 't-2',
      expectedCurrent: { activationEpoch: '1', membershipRevision: '1' },
      target: { activationEpoch: '1', membershipRevision: '2' },
    });
    expect(await rejectionOf(a.stage(back, 'p'))).toBe('epoch_not_monotonic');
  });

  // P19 — 취소된 미래 epoch 의 지연 RPC
  it('P19 abort 한 epoch 의 늦은 commit 은 거부한다', async () => {
    const a = agent();
    await a.fence('10');
    await a.stage(op(), 'payload');
    await a.abort(op());
    // `not_staged` 가 아니라 `terminal` 이다 — 슬롯이 없는 것과 전환이 끝난 것은 다르다.
    // 5차 검수 뒤 abort/failed/activated 를 **상호 배타적인 종단 상태 하나**로 합쳤다.
    // 어떻게 끝났는지는 `DpRejection.terminalState` 가 들고 있다 (§9.1.1 blocker 1).
    // 전자는 아직 안 왔을 수도 있지만 후자는 되살아나면 안 된다.
    expect(await rejectionOf(a.commit(op(), EVIDENCE))).toBe('terminal');
  });

  it('P19 좌표가 지나간 뒤 도착한 옛 stage 도 거부한다', async () => {
    const a = agent();
    await a.fence('10');
    await a.stage(op(), 'p'); await a.commit(op(), EVIDENCE);          // 이제 E1
    // E0 을 기대하는 지연된 stage 가 뒤늦게 도착
    expect(await rejectionOf(a.stage(op({ operationId: 'late' }), 'evil'))).toBe('coordinate_mismatch');
  });
});

describe('§3.6-3 재요청은 digest 가 같을 때만', () => {
  it('P20 같은 좌표·같은 digest 재요청은 cached ACK', async () => {
    const a = agent();
    await a.fence('10');
    const first = await a.stage(op(), 'payload');
    const again = await a.stage(op(), 'payload');
    expect(first.cached).toBe(false);
    expect(again.cached).toBe(true);
  });

  it('P20 같은 좌표에 다른 digest 는 거부한다', async () => {
    const a = agent();
    await a.fence('10');
    await a.stage(op(), 'payload');
    const tampered = op({ payloadDigest: 'sha256:bbb' });
    expect(await rejectionOf(a.stage(tampered, 'evil'))).toBe('digest_mismatch');
  });
});

describe('헬스 델타 — 같은 epoch 안에서만', () => {
  it('membership_revision 을 올린다', async () => {
    const a = agent();
    await a.fence('10');
    await a.stage(op(), 'p'); await a.commit(op(), EVIDENCE);
    const h = op({
      operationId: 'h-1', transitionId: 'ht-1',
      expectedCurrent: { activationEpoch: '1', membershipRevision: '1' },
      target: { activationEpoch: '1', membershipRevision: '2' },
      payloadDigest: 'sha256:health',
    });
    const ack = await a.applyHealth(h, 'delta');
    expect(ack.membershipRevision).toBe('2');
  });

  it('다른 epoch 로는 못 간다 — 헬스는 topology 를 바꾸지 않는다', async () => {
    const a = agent();
    await a.fence('10');
    await a.stage(op(), 'p'); await a.commit(op(), EVIDENCE);
    const h = op({
      operationId: 'h-2', transitionId: 'ht-2',
      expectedCurrent: { activationEpoch: '1', membershipRevision: '1' },
      target: { activationEpoch: '2', membershipRevision: '2' },
    });
    expect(await rejectionOf(a.applyHealth(h, 'delta'))).toBe('coordinate_mismatch');
  });
});

describe('평면은 독립이다 (§3.4)', () => {
  it('http 를 옮겨도 stream 좌표는 그대로다', async () => {
    const a = agent();
    await a.fence('10');
    await a.stage(op(), 'p'); await a.commit(op(), EVIDENCE);
    expect(a.coordinate('stream')).toEqual({
      activationEpoch: '0', membershipRevision: '0', payloadDigest: '',
    });
  });

  it('평면마다 따로 진행할 수 있다', async () => {
    const a = agent();
    await a.fence('10');
    const st = op({ plane: 'stream', operationId: 'op-s', transitionId: 't-s' });
    await a.stage(st, 'p'); await a.commit(st, EVIDENCE);
    expect(a.coordinate('stream').activationEpoch).toBe('1');
    expect(a.coordinate('http').activationEpoch).toBe('0');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// P18 — 4차 검수가 재현한 실패. 순차 테스트로는 절대 안 잡힌다.
// ─────────────────────────────────────────────────────────────────────────
describe('P18 동시성 — 검사와 적용은 하나의 임계구역이다', () => {
  it('나중에 시작한 낮은 토큰이 앞선 높은 토큰을 덮어쓰지 못한다 (lost update)', async () => {
    // 임계구역이 없으면 둘 다 같은 상태를 읽고 각자 쓴다. 늦게 착지한 쪽이 이긴다.
    // 여기서는 낮은 토큰이 나중에 착지하도록 타이밍을 고정한다.
    const a = agent(20);

    const first = a.fence('12');
    await new Promise((r) => setTimeout(r, 5));   // first 가 저장 중일 때
    const second = a.fence('11').catch(() => 'rejected');

    await Promise.all([first, second]);

    // 직렬이면 11 은 12 를 본 뒤라 거부된다. 비직렬이면 11 이 12 를 덮어써
    // 최대 토큰이 되돌아가고, 아래 fence 가 통과해 버린다.
    expect(await rejectionOf(a.fence('11')), '최대 토큰이 되돌아갔다').toBe('stale_leader');
  });

  it('무작위로 섞인 동시 요청에서도 불변식이 깨지지 않는다', async () => {
    const a = agent(1);
    await a.fence('1');

    const accepted: { token: bigint; digest: string }[] = [];
    const calls: Promise<unknown>[] = [];
    for (let i = 1; i <= 40; i += 1) {
      // 토큰을 뒤섞어 낮은 것이 늦게 도착하는 상황을 만든다.
      const token = String(((i * 7) % 13) + 1);
      const o = op({
        leaderToken: token,
        operationId: `op-${i}`,
        transitionId: `t-${i}`,
        payloadDigest: `sha256:${i}`,
        expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
        target: { activationEpoch: '1', membershipRevision: '1' },
      });
      calls.push(
        a
          .stage(o, `p${i}`)
          .then(() => accepted.push({ token: BigInt(token), digest: o.payloadDigest }))
          .catch(() => undefined),
      );
    }
    await Promise.all(calls);

    // 수용된 것이 있다면, 그 시점 이후 더 낮은 토큰이 수용된 적이 없어야 한다.
    let seen = 0n;
    for (const acc of accepted) {
      expect(acc.token >= seen, `토큰이 역행했다: ${acc.token} < ${seen}`).toBe(true);
      seen = acc.token > seen ? acc.token : seen;
    }
    // 마지막으로 남은 staged payload 는 반드시 수용된 것 중 하나다.
    const staged = a.stagedDigest('http', '1');
    if (staged !== undefined) {
      expect(accepted.map((x) => x.digest)).toContain(staged);
    }
  });

  it('동시 commit 이 좌표를 두 번 옮기지 않는다', async () => {
    const a = agent(3);
    await a.fence('10');
    await a.stage(op(), 'payload');

    const results = await Promise.all([
      a.commit(op(), EVIDENCE).then(() => 'ok').catch(() => 'rejected'),
      a.commit(op(), EVIDENCE).then(() => 'ok').catch(() => 'rejected'),
      a.commit(op(), EVIDENCE).then(() => 'ok').catch(() => 'rejected'),
    ]);

    // 같은 operation 의 재요청이므로 전부 성공(cached)이거나 하나만 성공해야 한다.
    // 어느 쪽이든 좌표는 한 번만 움직인다.
    expect(a.coordinate('http').activationEpoch).toBe('1');
    expect(results).toContain('ok');
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 5차 검수가 지목한 반례. 검수 자체는 제공자 필터에 걸려 중단됐지만, 중단 직전에
// 네 가지를 지목했고 셋이 즉시 재현됐다.
// ─────────────────────────────────────────────────────────────────────────
describe('5차 검수 반례', () => {
  it('멱등 키에 plane 이 들어간다 — 평면이 서로의 ACK 를 훔치면 안 된다', async () => {
    const a = agent();
    await a.fence('10');
    await a.stage(op({ plane: 'http' }), 'p');
    const s = await a.stage(op({ plane: 'stream' }), 'p');   // 같은 op/transition, 다른 평면
    expect(s.plane).toBe('stream');
    expect(s.cached, 'http 의 ACK 를 재사용했다').toBe(false);
    expect(a.stagedDigest('stream', '1'), 'stream 에 staging 되지 않았다').toBe('sha256:aaa');
  });

  it('abort 한 전환은 되살아나지 않는다 — 지연 stage 가 캐시로 성공을 돌려주면 안 된다', async () => {
    const a = agent();
    await a.fence('10');
    await a.stage(op(), 'p');
    await a.abort(op());
    // abort 는 이 전환을 끝낸다. 뒤늦게 도착한 stage 는 "성공했다" 고 답해서도,
    // 슬롯을 되살려서도 안 된다.
    expect(await rejectionOf(a.stage(op(), 'p'))).toBe('terminal');
    expect(a.stagedDigest('http', '1')).toBeUndefined();
  });

  it('같은 store 를 보는 두 인스턴스가 서로의 상태를 되감지 못한다', async () => {
    const store = new MemoryStore();
    const a = new DpAgent(store);
    const b = new DpAgent(store);            // b 는 a 가 쓴 것을 모른다
    await a.fence('20');
    // b 가 자기 기억으로 덮어쓰면 최대 토큰이 되감긴다 — 펜싱이 통째로 무너진다.
    await expect(b.fence('11')).rejects.toThrow();
    expect((store.load()?.payload as { maxLeaderToken: string } | undefined)?.maxLeaderToken).toBe('20');
  });

  it('한 인스턴스가 다른 컴포넌트의 durable 상태를 지우지 못한다', async () => {
    const store = new MemoryStore();
    const agentFirst = new DpAgent(store);   // 기동 시점에 만들어졌다
    await agentFirst.fence('10');
    // 그 사이 다른 컴포넌트가 같은 store 에 무언가를 썼다.
    // 남의 쓰기도 CAS 를 지킨다 — 버전을 올려야 저장된다.
    // 저장소는 payload 를 해석하지 않으므로 그 안에 무엇을 넣든 보존돼야 한다.
    const loaded = store.load()!;
    const withExtra = {
      version: loaded.version + 1,
      payload: { ...(loaded.payload as Record<string, unknown>), journal: { marker: 'keep-me' } },
    };
    await store.save(withExtra as never);
    // 이제 agent 가 다시 쓴다. 자기 기억으로 덮으면 남의 것이 날아간다.
    await agentFirst.fence('11');
    expect(
      (store.load()?.payload as Record<string, unknown> | undefined)?.['journal'],
      '다른 컴포넌트의 상태를 날렸다',
    ).toBeDefined();
  });
});

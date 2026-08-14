/**
 * 9차 검수 뒤 방향 전환 — 막지 말고 **수렴시킨다**
 *
 * 아홉 라운드 동안 "부작용 앞에서 막는" 방식으로 아홉 번 시도했고 여섯 번 뚫렸다.
 * 외부 효과는 **취소할 수 없고** nginx 는 리더 토큰을 모른다. 검사와 실제 착지 사이에는
 * 어떤 식으로든 틈이 남는다 — 주입된 콜백이 그 안에서 `await` 하기만 해도 그렇다(9차 ①).
 *
 * 그래서 전제를 바꾼다. **늦게 착지할 수 있다고 인정한다.**
 *
 *   · 게시할 때 **누가 게시했는지 함께 적는다** (`PublishRecord`).
 *   · 관측이 세대뿐 아니라 **소유자**를 답한다 (`PublishedState`).
 *   · 리더는 자기 것이 아니면 **다시 게시한다.**
 *
 * 그러면 "늦게 착지한 옛 게시" 는 막아야 할 것이 아니라 **관측되고 덮이는 것**이 된다.
 * 그건 테스트할 수 있다 — 그게 이 파일이다.
 */
import { describe, expect, it } from 'vitest';
import { DpAgent, MemoryStore } from '../../src/dp/agent.js';
import { ApplyRunner, FakeEffects, recordOf } from '../../src/dp/apply.js';
import { publishedByMe } from '../../src/dp/operation.js';
import type { ApplyOperation, PublishRecord } from '../../src/dp/operation.js';

const OP = (id: string, gen: string, o: Partial<ApplyOperation> = {}): ApplyOperation => ({
  leaderToken: '10',
  operationId: id,
  transitionId: id,
  affectedPlanes: ['http'],
  targetGeneration: gen,
  generationDigest: `sha256:${gen}`,
  planes: {
    http: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: 'sha256:h',
    },
  },
  ...o,
});

const FAST = { attempts: 1, intervalMs: 0, sleep: async () => {} };

// ── 관측이 소유자를 말한다 ──────────────────────────────────────────────

describe('게시물이 누구 것인지 관측된다', () => {
  it('세대 이름이 같아도 남이 게시한 것은 내 것이 아니다', () => {
    const mine = OP('mine', 'gen-1');
    const theirs: PublishRecord = { ...recordOf(mine), operationId: 'theirs', transitionId: 'theirs' };

    expect(publishedByMe({ kind: 'owned', record: recordOf(mine) }, mine)).toBe(true);
    expect(
      publishedByMe({ kind: 'owned', record: theirs }, mine),
      '이름만 보면 남의 게시를 내 것으로 센다',
    ).toBe(false);
  });

  it('내용이 다르면 같은 이름이어도 내 것이 아니다', () => {
    const mine = OP('mine', 'gen-1');
    const swapped: PublishRecord = { ...recordOf(mine), generationDigest: 'sha256:바꿔치기' };
    expect(publishedByMe({ kind: 'owned', record: swapped }, mine)).toBe(false);
  });

  it('소유 기록이 없거나 어긋나면 정합하지 않다', () => {
    const mine = OP('mine', 'gen-1');
    expect(publishedByMe({ kind: 'none' }, mine)).toBe(false);
    expect(publishedByMe({ kind: 'inconsistent', generation: 'gen-1' }, mine)).toBe(false);
  });
});

// ── 늦게 착지한 게시를 덮는다 ───────────────────────────────────────────

describe('늦게 착지한 옛 게시가 관측되고 덮인다', () => {
  it('활성화를 인정하기 전에 게시가 아직 내 것인지 다시 본다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const op = OP('mine', 'gen-1');

    /** `reload_observed` 직전에 옛 리더의 게시가 뒤늦게 착지한다. */
    class LateLanding extends FakeEffects {
      landed = false;
      override async observeActivation() {
        const seen = await super.observeActivation();
        if (!this.landed && seen?.acceptingGeneration === 'gen-1') {
          this.landed = true;
          // 옛 리더가 같은 이름으로, 그러나 자기 오퍼레이션으로 게시했다.
          this.publishedRecord = {
            generation: 'gen-1',
            leaderToken: '9',
            operationId: '옛-리더',
            transitionId: '옛-리더',
            generationDigest: 'sha256:gen-1',
          };
        }
        return seen;
      }
    }

    const fx = new LateLanding();
    const r = await new ApplyRunner(agent, fx, FAST).run(op);

    expect(r.phase, '늦은 게시를 못 보고 활성화로 끝냈다').toBe('activated');
    // 다시 게시해서 덮었어야 한다.
    expect(fx.publishedRecord?.operationId, '옛 게시가 그대로 남았다').toBe('mine');
    expect(fx.publishCalls, '덮으려면 게시가 한 번 더 일어난다').toBeGreaterThan(1);
  });

  it('정합하면 다시 게시하지 않는다 — 수렴은 무한 루프가 아니다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const fx = new FakeEffects();
    const r = await new ApplyRunner(agent, fx, FAST).run(OP('mine', 'gen-1'));
    expect(r.phase).toBe('activated');
    expect(fx.publishCalls, '정합한데 다시 게시했다').toBe(1);
  });

  it('소유 기록이 사라진 상태(부분 크래시)도 다시 게시한다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const fx = new FakeEffects();
    // 포인터는 있는데 주인을 모른다 — 게시 도중 죽은 모양이다.
    fx.publishedRecord = undefined;
    const r = await new ApplyRunner(agent, fx, FAST).run(OP('mine', 'gen-1'));
    expect(r.phase).toBe('activated');
    expect(fx.publishedRecord).toMatchObject({ operationId: 'mine' });
  });
});

// ── 갈라진 상태가 드러난다 ──────────────────────────────────────────────

describe('컨트롤 플레인이 갈라짐을 볼 수 있다', () => {
  it('status 가 게시된 것과 그 소유자를 답한다', async () => {
    const { LocalDataplaneDriver } = await import('../../src/dp/driver.js');
    const store = new MemoryStore();
    const fx = new FakeEffects();
    const driver = LocalDataplaneDriver.create({ store, effects: fx });

    expect((await driver.status()).published.kind, '게시 전인데 뭔가 있다고 한다').toBe('none');

    await driver.applyConfig(OP('mine', 'gen-1'));
    const after = await driver.status();
    expect(after.published).toMatchObject({
      kind: 'owned',
      record: { generation: 'gen-1', operationId: 'mine' },
    });

    // 옛 리더가 뒤늦게 착지했다고 치자 — 그러면 status 가 그것을 드러내야 한다.
    fx.publishedRecord = {
      generation: 'gen-옛',
      leaderToken: '9',
      operationId: '옛-리더',
      transitionId: '옛-리더',
      generationDigest: 'sha256:gen-옛',
    };
    const diverged = await driver.status();
    expect(diverged.published).toMatchObject({ kind: 'owned', record: { operationId: '옛-리더' } });
    expect(diverged.planes.http.activationEpoch, '좌표는 내 것이다').toBe('1');
    // **갈라짐이 보인다.** 좌표는 1(내 것)인데 게시는 옛 리더의 것 — CP 가 판단할 수 있다.
  });
});

// ── 9차의 평범한 버그 셋 ────────────────────────────────────────────────
//
// 수렴과 별개로 고친 것들이다. **고치고 반례를 고정하지 않으면 뮤테이션이 잡지 못한다** —
// 실제로 처음엔 셋 다 안 잡혔다. 아홉 라운드 동안 반복해 온 실수라 여기 적어 둔다.

describe('② 같은 id 로 다른 세대를 내면 거부된다 — 조용한 거짓 성공을 막는다', () => {
  it('1차가 gen-A 로 끝난 뒤 같은 id 의 gen-B 는 통과하지 못한다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const fx = new FakeEffects();

    const first = await new ApplyRunner(agent, fx, FAST).run(OP('same', 'gen-A'));
    expect(first.phase).toBe('activated');

    let kind = '통과';
    try {
      await new ApplyRunner(agent, fx, FAST).run(OP('same', 'gen-B'));
    } catch (e) {
      kind = (e as { kind?: string }).kind ?? (e as Error).name;
    }

    // **활성화됐다고 답하면서 gen-A 를 서빙하는 것이 최악이다.**
    expect(
      kind !== '통과' || fx.publishedRecord?.generation === 'gen-B',
      `2차가 ${kind} 인데 게시된 것은 ${fx.publishedRecord?.generation} 다`,
    ).toBe(true);
  });
});

describe('③ 실행권이 없으면 lease 도 무효다', () => {
  it('abort 로 실행권을 놓은 뒤에는 멈춰 있던 부작용이 착지하지 못한다', async () => {
    const { LocalDataplaneDriver } = await import('../../src/dp/driver.js');
    const store = new MemoryStore();
    const agent = new DpAgent(store);
    const op = OP('old', 'gen-1');

    await agent.reserveAll(op);
    const lease = agent.lease(op); // 멈춰 있던 부작용이 들고 있던 것

    await LocalDataplaneDriver.create({ store, effects: new FakeEffects() }).abortConfig(op);

    let kind = '유효';
    try {
      lease.assertValid();
    } catch (e) {
      kind = (e as { kind?: string }).kind ?? (e as Error).name;
    }
    expect(kind, 'abort 뒤에도 lease 가 유효하면 늦은 부작용이 착지한다').not.toBe('유효');
  });
});

describe('⑤ abort 는 오퍼레이션 단위다', () => {
  it('한 평면이 이미 종단이어도 나머지 정리를 멈추지 않는다', async () => {
    const { LocalDataplaneDriver } = await import('../../src/dp/driver.js');
    const { tupleFor } = await import('../../src/dp/agent.js');
    const store = new MemoryStore();
    const agent = new DpAgent(store);

    const both: ApplyOperation = {
      ...OP('both', 'gen-1'),
      affectedPlanes: ['http', 'stream'],
      planes: {
        http: OP('x', 'gen-1').planes.http!,
        stream: OP('x', 'gen-1').planes.http!,
      },
    };

    await agent.reserveAll(both);
    await agent.stage(tupleFor(both, 'http'), null);
    await agent.commit(tupleFor(both, 'http'), { acceptingGeneration: 'gen-1' });

    // http 는 이미 activated 라 abort 가 거부된다. 그래도 stream 과 실행권은 정리돼야 한다.
    await LocalDataplaneDriver.create({ store, effects: new FakeEffects() })
      .abortConfig(both)
      .catch(() => undefined);

    expect(agent.reservationOwner('stream', '1'), 'stream 예약이 남았다').toBeUndefined();
    expect(agent.activeOperation(), '실행권이 남아 다음 작업이 막힌다').toBeUndefined();
  });
});

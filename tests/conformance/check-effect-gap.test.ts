/**
 * ▲ ① · ② — **확인과 부작용 사이의 `await`** (8차 ① · 9차 ① · 15차 표 `Checked`)
 *
 * 두 회차가 같은 창을 서로 다른 쪽에서 적었고, 넷 회차 동안 ▲ 로 남았다:
 *
 * > **여전히 못 막는 것.** 확인과 부작용 **사이**에 `await` 를 두는 것은 못 막는다.
 * > 표는 "불렀는가" 를 강제할 뿐 **"언제 불렀는가"** 를 강제하지 못한다.
 * > 그건 여전히 규약이다 — **수렴이 덮는다.**
 *
 * 그 문장 전체가 지금까지 **산문**이었다. 두 절이 각각 참인지 재 본 적이 없다:
 *
 *   ㉠ 창이 정말 열리는가 — 표를 얻고 나서 `await` 하면 부작용이 정말 나가는가
 *   ㉡ 수렴이 정말 덮는가 — 그렇게 나간 것을 관측하고 되돌리는가
 *
 * **㉠ 을 안 재면 ㉡ 은 아무것도 안 지킨다.** 창이 사실은 안 열리는데(예: 다른 이유로
 * 막혀 있는데) ㉡ 만 초록이면, 나중에 그 다른 이유가 사라졌을 때 아무도 모른다.
 *
 * ── 왜 "못 막는다" 가 결함이 아닌가
 *
 * `assertValid()` 는 **동기 함수**다 — 그 자체는 await 를 안 만든다. 그런데 `Effects` 는
 * 주입이고, 주입된 구현이 표를 받은 뒤 무엇을 하든 프레임워크는 못 본다. 막으려면
 * 프레임워크가 되돌릴 수 없는 쓰기를 **직접** 해야 하는데, 그러면 `Effects` 가 추상이
 * 아니게 되고 원격 드라이버가 불가능해진다. 그래서 답을 **막기**에서 **수렴**으로
 * 바꾼 것이고(9차), 이 파일은 그 결정이 지금도 성립하는지를 잰다.
 */
import { describe, expect, it } from 'vitest';
import { DpAgent, MemoryStore } from '../../src/dp/agent.js';
import { ApplyRunner, FakeEffects } from '../../src/dp/apply.js';
import type { Checked } from '../../src/dp/operation.js';
import type { ApplyLease, ApplyOperation, PublishRecord } from '../../src/dp/operation.js';

const OP = (id: string, gen: string, o: Partial<ApplyOperation> = {}): ApplyOperation => ({
  leaderToken: '10',
  operationId: id,
  transitionId: id,
  affectedPlanes: ['http', 'stream'],
  targetGeneration: gen,
  generationDigest: `sha256:${gen}`,
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
  ...o,
});

const FAST = { attempts: 1, intervalMs: 0, sleep: async () => {} };

/**
 * **창을 실제로 여는 구현.** 표를 먼저 받고, `await` 하고, 그 다음에 쓴다.
 *
 * 이게 곧 8차 ①·9차 ① 이 말한 그 모양이다. 타입은 이걸 못 막는다 — `Checked` 를
 * 돌려주므로 계약을 만족한다.
 */
class GapEffects extends FakeEffects {
  /** `await` 중에 무슨 일이 일어나는가. */
  duringGap: (() => Promise<void>) | undefined;
  /** 표를 받은 뒤 lease 가 무효가 됐는데도 썼는가. */
  wroteAfterInvalid = false;

  override async publish(record: PublishRecord, lease: ApplyLease): Promise<Checked> {
    // ① 되돌릴 수 없는 쓰기 **전에** 확인한다. 여기까지는 규약대로다.
    const checked = lease.assertValid();
    // ② …그리고 여기서 await 한다. **이 한 줄이 그 창이다.**
    if (this.duringGap !== undefined) await this.duringGap();
    // ③ 그 사이에 세상이 바뀌었어도 쓰기는 그대로 나간다.
    try {
      lease.assertValid();
    } catch {
      this.wroteAfterInvalid = true;
    }
    this.publishCalls += 1;
    this.publishedRecord = record;
    return checked;
  }
}

describe('▲ 확인과 부작용 사이의 await', () => {
  /**
   * ㉠ **창이 정말 열린다.** 이 검사가 없으면 아래 ㉡ 들은 아무것도 안 지킨다.
   */
  it('표를 받은 뒤 lease 가 무효가 돼도 부작용은 나간다 — 못 막는다는 것이 사실이다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const op = OP('mine', 'gen-1');
    const fx = new GapEffects();

    fx.duringGap = async () => {
      // 창 안에서 리더가 바뀐다. 더 높은 토큰이 fence 를 지나면 옛 lease 는 죽는다.
      await agent.fence('99');
    };

    await new ApplyRunner(agent, fx, FAST).run(op).catch(() => undefined);

    expect(
      fx.wroteAfterInvalid,
      'lease 가 무효인데도 쓰기가 나가야 창이 열린 것이다 — 안 나갔다면 다른 무언가가 '
      + '막고 있고, 그러면 아래 수렴 검사들은 아무것도 안 지킨다',
    ).toBe(true);
    expect(fx.publishedRecord?.operationId, '쓰기가 아예 안 일어났다').toBe('mine');
  });

  /**
   * ㉡-1 **표를 안 부르면 타입이 막는다** (15차에 닫힌 절반). 이건 지금도 성립한다.
   *
   * 값으로는 못 재고 타입으로 재야 하는데, 컴파일이 게이트에 있으므로 여기서는
   * `assertValid` 가 **동기** 라는 것 — 즉 그 자체는 창을 만들지 않는다는 것 — 을 잰다.
   * 비동기였다면 규약을 지킨 구현조차 창을 열게 된다.
   */
  it('assertValid 는 동기다 — 확인 자체가 창을 만들지 않는다', async () => {
    const agent = new DpAgent(new MemoryStore());
    let sawPromise = false;
    class Probe extends FakeEffects {
      override async publish(record: PublishRecord, lease: ApplyLease): Promise<Checked> {
        const r = lease.assertValid() as unknown;
        sawPromise = typeof (r as { then?: unknown })?.then === 'function';
        this.publishCalls += 1;
        this.publishedRecord = record;
        return r as Checked;
      }
    }
    const fx = new Probe();
    await new ApplyRunner(agent, fx, FAST).run(OP('mine', 'gen-1'));
    expect(sawPromise, 'assertValid 가 Promise 를 준다 — 규약을 지켜도 창이 열린다').toBe(false);
  });

  /**
   * ㉡-2 **수렴이 덮는다.** 창으로 새어 나간 옛 게시를 관측하고 되돌린다.
   *
   * 이것이 9차의 방향 전환 전체다 — 막는 대신 **누가 게시했는지 적고** 내 것이 아니면
   * 다시 게시한다. 그 계약이 깨지면 창은 그대로인데 덮을 것이 없어진다.
   */
  it('창으로 새어 나간 남의 게시를 수렴이 덮는다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const op = OP('mine', 'gen-1');

    class LateFromGap extends GapEffects {
      landed = false;
      override async observeActivation() {
        const seen = await super.observeActivation();
        if (!this.landed && seen?.acceptingGeneration === 'gen-1') {
          this.landed = true;
          // 옛 리더가 자기 창에서 늦게 착지했다 — 같은 세대 이름, 다른 주인.
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

    const fx = new LateFromGap();
    const r = await new ApplyRunner(agent, fx, FAST).run(op);

    expect(r.phase, '늦은 게시를 못 보고 끝냈다').toBe('activated');
    expect(fx.publishedRecord?.operationId, '옛 게시가 그대로 남았다').toBe('mine');
    expect(fx.publishCalls, '덮으려면 게시가 한 번 더 일어난다').toBeGreaterThan(1);
  });

  /**
   * ㉡-3 **덮는 것에 끝이 있다.** 정합하면 다시 안 게시한다 — 수렴이 무한 루프가 되면
   * "덮는다" 는 답이 못 된다.
   */
  it('정합하면 다시 게시하지 않는다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const fx = new GapEffects();
    const r = await new ApplyRunner(agent, fx, FAST).run(OP('mine', 'gen-1'));
    expect(r.phase).toBe('activated');
    expect(fx.publishCalls, '정합한데 다시 게시했다').toBe(1);
  });

  /**
   * ㉡-4 **창은 `signalReload` 에도 똑같이 있다.** 8차 ① 이 예로 든 것이 이쪽이다
   * (`FsEffects.signalReload` 가 확인 뒤 주입된 `reload()` 를 await 한다).
   * 게시만 재고 넘어가면 그 예시가 안 지켜진다.
   */
  it('signalReload 에도 같은 창이 있다 — 표를 받고 await 해도 HUP 은 나간다', async () => {
    const agent = new DpAgent(new MemoryStore());
    let signalledAfterInvalid = false;
    class ReloadGap extends FakeEffects {
      override async signalReload(lease: ApplyLease): Promise<Checked> {
        const checked = lease.assertValid();
        await agent.fence('99');
        try { lease.assertValid(); } catch { signalledAfterInvalid = true; }
        this.reloadSignals += 1;
        if (this.reloadTakesEffect) this.acceptingGeneration = this.publishedRecord?.generation;
        return checked;
      }
    }
    const fx = new ReloadGap();
    await new ApplyRunner(agent, fx, FAST).run(OP('mine', 'gen-1')).catch(() => undefined);
    expect(signalledAfterInvalid, 'HUP 쪽 창이 안 열렸다').toBe(true);
    expect(fx.reloadSignals, 'HUP 이 아예 안 나갔다').toBeGreaterThan(0);
  });
});

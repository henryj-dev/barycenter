/**
 * 11차 검수 반례 — 수렴이 **활성 상태**까지 가야 한다
 *
 * 10차 뒤에 `reconcileConfig()` 를 뒀다. 그런데 그건 **포인터만** 되돌렸다.
 *
 *   · 재시작 중 옛 `current` 로 nginx 가 올라오면, 첫 호출은 `repaired` 를 내고
 *     그다음부터는 포인터만 보고 `converged` 라고 한다. **실제 accepting 세대는
 *     계속 옛 값이다.**
 *   · 기준을 한 번만 읽고 **항상 유효한 가짜 lease** 로 게시한다. reconcile 이 A 를
 *     읽은 뒤 B 가 fence·활성화해도 A 를 다시 게시하고 `repaired` 라고 답한다.
 *   · preflight 도 우회한다.
 *
 * 게시 상태와 활성 상태는 다르다. 심볼릭 링크를 되돌려도 **HUP 을 보내지 않으면 nginx 는
 * 옛 설정으로 계속 돈다.** 그걸 수렴이라고 부를 수 없다.
 */
import { describe, expect, it } from 'vitest';
import { FakeEffects } from '../../src/testing/apply-fakes.js';
import { DpAgent, MemoryStore } from '../../src/dp/agent.js';
import { ApplyRunner } from '../../src/dp/apply.js';
import { LocalDataplaneDriver } from '../../src/dp/driver.js';
import type { ApplyOperation } from '../../src/dp/operation.js';

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

async function activated() {
  const store = new MemoryStore();
  const fx = new FakeEffects();
  const driver = LocalDataplaneDriver.create({ store, effects: fx });
  expect((await driver.applyConfig(OP('mine', 'gen-1'))).phase).toBe('activated');
  return { store, fx, driver };
}

describe('① reconcile 은 활성 상태까지 되돌린다', () => {
  it('**포인터만 맞고 accepting 이 옛 값이면 converged 가 아니다**', async () => {
    const { fx, driver } = await activated();
    // 재시작 중 옛 설정으로 nginx 가 올라왔다. 포인터는 내 것인데 서빙은 옛 세대다.
    fx.acceptingGeneration = 'gen-옛';

    const r = await driver.reconcileConfig();
    expect(r.kind, '포인터만 보고 수렴했다고 답했다').not.toBe('converged');
  });

  it('되돌릴 때 HUP 을 보낸다 — 게시만으로는 nginx 가 안 바뀐다', async () => {
    const { fx, driver } = await activated();
    const before = fx.reloadSignals;
    fx.publishedRecord = {
      generation: 'gen-옛', leaderToken: '9', operationId: '옛',
      transitionId: '옛', generationDigest: 'sha256:gen-옛',
    };

    await driver.reconcileConfig();
    expect(fx.reloadSignals, '게시만 하고 신호를 안 보냈다').toBeGreaterThan(before);
  });

  it('활성화 증거로 확인한 뒤에만 repaired 라고 한다', async () => {
    const { fx, driver } = await activated();
    // 포인터도 서빙도 옛 것이고, HUP 을 보내도 먹히지 않는다.
    // (accepting 을 그대로 두면 "이미 맞는" 상태라 아무것도 검증하지 못한다 —
    //  처음에 그렇게 써서 red 가 안 나왔다.)
    fx.publishedRecord = {
      generation: 'gen-옛', leaderToken: '9', operationId: '옛',
      transitionId: '옛', generationDigest: 'sha256:gen-옛',
    };
    fx.acceptingGeneration = 'gen-옛';
    fx.reloadTakesEffect = false;

    const r = await driver.reconcileConfig();
    expect(r.kind, 'accepting 이 안 바뀌었는데 repaired 라고 했다').toBe('diverged');
  });
});

describe('② reconcile 이 신임 apply 를 덮어쓰지 않는다', () => {
  it('기준을 읽은 뒤 새 리더가 활성화하면 옛 기준을 다시 게시하지 않는다', async () => {
    const store = new MemoryStore();
    const fx = new FakeEffects();
    const driver = LocalDataplaneDriver.create({ store, effects: fx });
    await driver.applyConfig(OP('A', 'gen-A'));

    // reconcile 이 기준을 읽는 순간 새 리더가 들어와 gen-B 를 활성화한다.
    const other = new DpAgent(store);
    class Racing extends FakeEffects {
      raced = false;
      override async observePublished() {
        if (!this.raced) {
          this.raced = true;
          await other.fence('11');
          await new ApplyRunner(other, this, FAST).run(
            OP('B', 'gen-B', {
              leaderToken: '11',
              planes: {
                http: {
                  expectedCurrent: { activationEpoch: '1', membershipRevision: '1' },
                  target: { activationEpoch: '2', membershipRevision: '2' },
                  payloadDigest: 'sha256:h',
                },
                stream: {
                  expectedCurrent: { activationEpoch: '1', membershipRevision: '1' },
                  target: { activationEpoch: '2', membershipRevision: '2' },
                  payloadDigest: 'sha256:s',
                },
              },
            }),
          );
        }
        return super.observePublished();
      }
    }
    const racing = Object.assign(new Racing(), {
      publishedRecord: fx.publishedRecord,
      acceptingGeneration: fx.acceptingGeneration,
    });
    const racingDriver = LocalDataplaneDriver.create({ store, effects: racing });

    await racingDriver.reconcileConfig();
    expect(
      racing.publishedRecord?.generation,
      'reconcile 이 신임 활성화를 옛 기준으로 덮었다',
    ).toBe('gen-B');
  });
});

// ── manifest 의 planes 를 변조할 수 있는가 (11차) ───────────────────────

describe('③ manifest 의 평면 기록도 digest 가 덮는다', () => {
  it('내용은 그대로 두고 planes 만 바꾸면 거부된다', async () => {
    const { mkdtempSync, readFileSync, rmSync, writeFileSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { materializeGeneration, verifyGeneration, GenerationError, MANIFEST_NAME } =
      await import('../../src/dp/materialize.js');

    const prefix = mkdtempSync(join(tmpdir(), 'bary-planes-'));
    try {
      const m = materializeGeneration({
        prefix,
        generation: 'gen-1',
        files: { 'nginx.conf': 'events {}\n' },
        planes: ['http', 'stream'],
      });

      // 파일은 그대로 두고 **무엇을 바꾸는지만** 거짓말하게 만든다.
      const path = join(prefix, 'generations', 'gen-1', MANIFEST_NAME);
      const raw = JSON.parse(readFileSync(path, 'utf8')) as { planes: string[] };
      raw.planes = ['http'];
      writeFileSync(path, JSON.stringify(raw), 'utf8');

      let kind = '통과';
      try {
        verifyGeneration(prefix, 'gen-1', m.digest, ['http']);
      } catch (e) {
        kind = e instanceof GenerationError ? e.kind : (e as Error).name;
      }
      expect(kind, 'planes 만 변조해도 통과한다').not.toBe('통과');
    } finally {
      rmSync(prefix, { recursive: true, force: true });
    }
  });
});

// ── ② 설정 전환은 항상 두 평면을 옮긴다 ────────────────────────────────

describe('② planes 는 delta 여야 한다 — 없어지는 평면도 전환이다', () => {
  /**
   * `render().planes` 는 **목표에 있는** 평면을 답한다. 그래서 `http+stream → http`
   * 전환은 stream 을 **없애는데도** `['http']` 로 통과하고, stream 좌표는 옛 값으로
   * 남는다 — 설정은 바뀌었는데 컨트롤 플레인은 모른다.
   *
   * 답은 하나다. **하나의 `nginx.conf` 가 두 평면을 지배한다.** 세대를 활성화하면
   * 두 평면이 함께 바뀐다 — 한쪽이 비게 되더라도 그것 역시 전환이다.
   * 그러므로 설정 apply 는 **항상 두 평면을 선언한다.**
   */
  it('한 평면만 선언한 설정 apply 는 거부된다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const fx = new FakeEffects();
    let kind = '통과';
    try {
      await new ApplyRunner(agent, fx, FAST).run(
        OP('half', 'gen-1', { affectedPlanes: ['http'], planes: { http: OP('x', 'gen-1').planes.http! } }),
      );
    } catch (e) {
      kind = (e as { kind?: string }).kind ?? (e as Error).name;
    }
    expect(kind, '한 평면만 선언했는데 통과했다 — 나머지 좌표가 옛 값으로 남는다')
      .toBe('envelope_mismatch');
    expect(fx.publishCalls).toBe(0);
  });

  it('두 평면을 선언하면 통과한다 — 막는 것만 하는 게 아니다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const both = OP('both', 'gen-1', {
      affectedPlanes: ['http', 'stream'],
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
    const r = await new ApplyRunner(agent, new FakeEffects(), FAST).run(both);
    expect(r.phase).toBe('activated');
    expect(agent.coordinate('stream').activationEpoch, 'stream 좌표가 안 움직였다').toBe('1');
  });
});

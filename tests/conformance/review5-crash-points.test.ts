/**
 * 5차 검수 반례 — 크래시 지점을 §6.2 표에 **매핑**한다
 *
 * 지적은 이랬다: `CrashClock` 이 "전 지점" 을 계측한다고 주장하는데, 검사는
 * `steps >= 9` 라는 **개수** 뿐이다. 개수는 집합의 일치를 증명하지 않는다. 실제로 정상
 * 경로 22 지점 중 18 개가 구분 없는 `save` 였으므로 **publish·reload 지점을 통째로 빼도
 * 통과했다.**
 *
 * 그래서 두 가지를 바꿨다.
 *
 *   1. 모든 durable 쓰기에 **안정된 이름**을 준다. 쓰는 쪽이 라벨을 들고 다니는 대신
 *      상태의 차이로 분류한다 — 프로덕션 코드에 테스트용 인자가 새지 않는다.
 *   2. 개수가 아니라 **집합 일치**를 검사하고, §6.2 표의 각 행이 어느 지점 쌍에
 *      대응하는지 명시한다.
 *
 * **범위를 정직하게 적는다.** §6.2 표는 11 행이지만 v0.1 의 apply 경로가 덮는 것은
 * 3~8 행이다 (§9.1.1 로 범위를 줄였다).
 *
 *   1·2행  렌더·검증 — apply 앞이다. `ApplyRunner` 의 크래시 표면이 아니다.
 *   9행    시크릿 materialize — TLS 는 v0.6.
 *   10행   GC — v0.6.
 *   11행   롤백 — **같은 경로다.** §3.3 에 따라 롤백은 새 활성화 사건이므로 3~8 행을
 *          그대로 지난다. e2e 의 "롤백도 새 오퍼레이션으로 수렴한다" 가 그걸 본다.
 */
import { describe, expect, it } from 'vitest';
import { DpAgent, MemoryStore } from '../../src/dp/agent.js';
import { ApplyRunner, CrashClock, CrashInjected, FakeEffects, FaultStore } from '../../src/dp/apply.js';
import type { ApplyOperation } from '../../src/dp/operation.js';

const OP: ApplyOperation = {
  leaderToken: '10',
  operationId: 'op-1',
  transitionId: 't-1',
  affectedPlanes: ['http', 'stream'],
  targetGeneration: 'gen-2',
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

const FAST = { attempts: 1, intervalMs: 0, sleep: async () => {} };

function sweep(crashAt: number | undefined) {
  const clock = new CrashClock();
  clock.crashAt = crashAt;
  const store = new FaultStore(new MemoryStore(), clock);
  const effects = new FakeEffects(clock);
  return { clock, store, effects, run: () => new ApplyRunner(new DpAgent(store), effects, FAST).run(OP) };
}

/** 정상 경로가 지나는 **모든** 지점. 이름이 하나라도 바뀌면 여기가 깨진다. */
const NORMAL_PATH = [
  'reserve:http',
  'reserve:stream',
  'journal:publish_intent',
  'publish',
  'journal:published',
  'stage:http',
  'stage:stream',
  'journal:membership_staged',
  'journal:reload_intent',
  'journal:reload_intent:update',
  'reload',
  'journal:reload_observed',
  'commit:http',
  'commit:stream',
  'journal:activated',
] as const;

async function observedPoints(): Promise<string[]> {
  const { clock, run } = sweep(undefined);
  await run();
  return clock.seen;
}

describe('크래시 지점은 이름을 갖는다 — 개수가 아니라 집합으로 판정한다', () => {
  it('정상 경로의 지점 집합이 정확히 일치한다', async () => {
    const seen = await observedPoints();
    const names = [...new Set(seen.map((p) => p.replace(/:(before|after)$/, '')))].sort();
    expect(names).toEqual([...NORMAL_PATH].sort());
  });

  it('모든 지점이 직전/직후 **쌍**으로 존재한다', async () => {
    const seen = await observedPoints();
    for (const name of NORMAL_PATH) {
      expect(seen, `${name}:before 가 없다`).toContain(`${name}:before`);
      expect(seen, `${name}:after 가 없다`).toContain(`${name}:after`);
    }
  });

  it('전 지점에서 죽여도 복구가 같은 세대로 수렴한다', async () => {
    const total = (await observedPoints()).length;
    expect(total, '지점이 너무 적다 — 계측이 빠졌다').toBeGreaterThanOrEqual(NORMAL_PATH.length * 2);

    for (let n = 0; n < total; n += 1) {
      const { clock, store, effects, run } = sweep(n);
      let crashed = false;
      try {
        await run();
      } catch (e) {
        if (!(e instanceof CrashInjected)) throw e;
        crashed = true;
      }
      expect(crashed, `지점 ${n} (${clock.seen[n]}) 에서 죽지 않았다`).toBe(true);

      clock.crashAt = undefined;
      const agent = new DpAgent(store);
      let result = await new ApplyRunner(agent, effects, FAST).recover();
      if (result.phase === 'no_operation') {
        // 저널 이전에 죽었다 — 부작용이 없어야 하고, CP 가 다시 시도한다.
        expect(effects.publishCalls, `지점 ${n}: 기록 없이 게시했다`).toBe(0);
        result = await new ApplyRunner(agent, effects, FAST).run(OP);
      }
      expect(result.phase, `지점 ${n} (${clock.seen[n]}): activated 로 끝나지 않았다`).toBe('activated');
      expect(effects.acceptingGeneration, `지점 ${n}: 최종 세대가 틀리다`).toBe('gen-2');
      expect(agent.coordinate('http').activationEpoch, `지점 ${n}: http 좌표`).toBe('1');
      expect(agent.coordinate('stream').activationEpoch, `지점 ${n}: stream 좌표`).toBe('1');
    }
  });
});

// ── §6.2 표와의 대응 ─────────────────────────────────────────────────────

/** 표의 한 행이 요구하는 "A 후 B 전" 구간이 실제로 존재하는가. */
const gapExists = (seen: string[], after: string, before: string): boolean => {
  const i = seen.indexOf(after);
  const j = seen.indexOf(before);
  return i >= 0 && j > i;
};

describe('§6.2 크래시 표의 각 행에 대응하는 지점이 있다', () => {
  const rows: Array<{ row: number; label: string; after: string; before: string }> = [
    { row: 3, label: 'publish_intent 기록 후, symlink 교체 전',
      after: 'journal:publish_intent:after', before: 'publish:before' },
    { row: 4, label: 'symlink 교체 후, published 기록 전',
      after: 'publish:after', before: 'journal:published:before' },
    { row: 5, label: 'reload_intent 기록 후, HUP 전',
      after: 'journal:reload_intent:update:after', before: 'reload:before' },
    { row: 6, label: 'HUP 후, reload_observed 기록 전',
      after: 'reload:after', before: 'journal:reload_observed:before' },
    // 7행은 설계와 **순서가 다르다.** §6.5-4 가 "활성화 확인 뒤에 좌표를 옮긴다" 로
    // 바꿨으므로, 구현에서는 commit 이 `activated` 기록보다 앞이다. 대응하는 구간은
    // "마지막 평면 commit 후, activated 기록 전" 이다.
    { row: 7, label: '평면 좌표 이동 후, activated 기록 전',
      after: 'commit:stream:after', before: 'journal:activated:before' },
    { row: 8, label: 'http 평면 후, stream 전',
      after: 'commit:http:after', before: 'commit:stream:before' },
  ];

  for (const r of rows) {
    it(`${r.row}행 — ${r.label}`, async () => {
      const seen = await observedPoints();
      expect(
        gapExists(seen, r.after, r.before),
        `${r.after} 와 ${r.before} 사이 구간이 없다`,
      ).toBe(true);
    });
  }

  it('덮지 않는 행은 **왜 안 덮는지** 말한다', () => {
    // 통과만 하는 테스트가 아니다. 범위를 코드에 적어 두면 범위가 바뀔 때 여기가 걸린다.
    const outOfScope: Record<number, string> = {
      1: '렌더 전 — apply 앞이다',
      2: '검증 전 — apply 앞이다',
      9: '시크릿 materialize — TLS 는 v0.6 (§9.1.1)',
      10: 'GC — v0.6 (§9.1.1)',
      11: '롤백 — 3~8 행과 같은 경로다 (§3.3, e2e 가 확인)',
    };
    const covered = [3, 4, 5, 6, 7, 8];
    const all = [...covered, ...Object.keys(outOfScope).map(Number)].sort((a, b) => a - b);
    expect(all, '§6.2 표는 11 행이다 — 빠진 행이 있다').toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });
});

/**
 * 세대 보존 상한 (DESIGN.md §8.4 · §9.1.1)
 *
 * §9.1.1 이 v0.1 에 배정한 것은 GC 원장(S13)이 아니라 **수동 상한**이다. 그런데 그
 * 상한을 안 넣고 v0.1 을 냈다 — 제품화 초안을 띄우고 apply 를 세 번 돌리니
 * `bootstrap r2-e1 r3-e2 r4-e3` 가 그대로 쌓여 있었고 지우는 코드가 한 줄도 없었다.
 *
 * 여기서 재는 것은 **무엇을 안 지우는가**가 대부분이다. 지우는 쪽으로 틀리면 S8 이
 * 실측한 그 실패가 난다 — 트래픽은 계속 흐르고 **다음 reload 만 실패한다.**
 */
import { mkdirSync, existsSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { sweepGenerations } from '../../src/dp/retention.js';

let prefix: string;

/** 세대 하나를 만든다. `age` 초만큼 과거로 mtime 을 민다. */
function gen(name: string, ageSeconds: number): void {
  const dir = join(prefix, 'generations', name);
  mkdirSync(join(dir, 'admin'), { recursive: true });
  writeFileSync(join(dir, 'nginx.conf'), `# ${name}\n`);
  writeFileSync(join(dir, 'admin', 'marker.conf'), `# ${name}\n`);
  const t = Date.now() / 1000 - ageSeconds;
  utimesSync(dir, t, t);
}

const present = (): string[] => readdirSync(join(prefix, 'generations')).sort();

beforeEach(() => {
  prefix = mkdtempSync(join(tmpdir(), 'bary-retention-'));
});

afterEach(() => {
  rmSync(prefix, { recursive: true, force: true });
});

describe('세대 보존 상한', () => {
  it('세대가 없으면 실패가 아니다', () => {
    const out = sweepGenerations({ prefix, keep: 3, protect: [] });
    expect(out).toEqual({ kept: [], removed: [], failed: [] });
  });

  it('최근 `keep` 개를 남기고 나머지를 지운다', () => {
    for (let i = 1; i <= 6; i += 1) gen(`r${i}-e${i}`, (6 - i) * 100);
    const out = sweepGenerations({ prefix, keep: 3, protect: [] });
    expect(out.removed.sort()).toEqual(['r1-e1', 'r2-e2', 'r3-e3']);
    expect(present()).toEqual(['r4-e4', 'r5-e5', 'r6-e6']);
  });

  it('**이름 순이 아니라 시각 순이다**', () => {
    // 문자열로 비교하면 `r10-e10` 이 `r9-e9` 보다 앞선다 — 그러면 가장 최근 세대를
    // 지운다. 활성 세대를 지우는 사고가 정확히 이렇게 난다.
    gen('r9-e9', 1000);
    gen('r10-e10', 10);
    const out = sweepGenerations({ prefix, keep: 1, protect: [] });
    expect(out.removed).toEqual(['r9-e9']);
    expect(present()).toEqual(['r10-e10']);
  });

  it('**보호 대상은 오래됐어도 안 지운다** (§8.4 GC root)', () => {
    gen('r1-e1', 9999);          // 제일 오래됐지만 활성이다
    for (let i = 2; i <= 5; i += 1) gen(`r${i}-e${i}`, (5 - i) * 10);
    const out = sweepGenerations({ prefix, keep: 1, protect: ['r1-e1'] });
    expect(out.removed).not.toContain('r1-e1');
    expect(existsSync(join(prefix, 'generations', 'r1-e1'))).toBe(true);
    expect(out.kept).toContain('r1-e1');
  });

  it('보호 대상은 **`keep` 정원을 차지하지 않는다**', () => {
    // 활성 세대가 정원을 먹으면 "최근 3개를 남긴다" 가 실제로는 2개가 된다.
    gen('활성', 9999);
    gen('r1-e1', 300);
    gen('r2-e2', 200);
    gen('r3-e3', 100);
    const out = sweepGenerations({ prefix, keep: 3, protect: ['활성'] });
    expect(out.removed).toEqual([]);
    expect(present()).toEqual(['r1-e1', 'r2-e2', 'r3-e3', '활성'].sort());
  });

  it('**`bootstrap` 은 안 지운다** — 다음 콜드 스타트가 설 자리다', () => {
    gen('bootstrap', 99999);
    for (let i = 1; i <= 4; i += 1) gen(`r${i}-e${i}`, (4 - i) * 10);
    const out = sweepGenerations({ prefix, keep: 1, protect: [] });
    expect(out.removed).not.toContain('bootstrap');
    expect(existsSync(join(prefix, 'generations', 'bootstrap'))).toBe(true);
  });

  it('디렉토리를 통째로 지운다 — 안에 하위 디렉토리가 있어도', () => {
    gen('r1-e1', 100);
    gen('r2-e2', 10);
    sweepGenerations({ prefix, keep: 1, protect: [] });
    expect(existsSync(join(prefix, 'generations', 'r1-e1'))).toBe(false);
  });

  it('`keep` 이 0 이면 아무것도 안 지운다 — 그리고 그건 디버깅용이다', () => {
    // 컨트롤 플레인이 이 값을 0 으로 두면 디스크가 무한히 자란다. 여기서는 "0 은
    // 청소 안 함" 이라는 뜻만 고정한다.
    for (let i = 1; i <= 5; i += 1) gen(`r${i}-e${i}`, (5 - i) * 10);
    const out = sweepGenerations({ prefix, keep: 0, protect: [] });
    expect(out.removed).toEqual([]);
    expect(present()).toHaveLength(5);
  });
});

describe('시간 보호 — 개수 상한만으로는 옛 워커를 못 지킨다 (S13)', () => {
  /**
   * S13 이 실측했다: **마커로는 옛 워커를 셀 수 없다.** 그래서 개수 상한은 **우연한
   * 보호**다 — 오래 사는 연결을 든 워커가 전환 N 회를 넘겨 살아남으면 그 세대가 지워지고,
   * S8 이 실측한 대로 **트래픽은 계속 흐르면서 다음 reload 가 깨진다.**
   *
   * `worker_shutdown_timeout` 이 걸려 있으면 잔존 창이 유계이므로, **"비활성이 된 지
   * 그만큼 지난 세대는 아무도 안 든다"** 를 쓸 수 있다.
   */
  const mkGens = (names: readonly string[], stepMs: number): number => {
    // 오래된 것부터 만든다. mtime 을 손으로 밀어 "언제 만들어졌나" 를 정한다.
    const base = Date.now() - names.length * stepMs;
    names.forEach((name, i) => {
      const dir = join(prefix, 'generations', name);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'nginx.conf'), 'x');
      const t = (base + i * stepMs) / 1000;
      utimesSync(dir, t, t);
    });
    return base + names.length * stepMs;
  };

  it('**방금 비활성이 된 세대는 개수 상한 밖이어도 남는다**', () => {
    // 1초 간격으로 다섯 개. keep=2 면 원래 셋이 지워진다.
    const now = mkGens(['g1', 'g2', 'g3', 'g4', 'g5'], 1000);
    const out = sweepGenerations({
      prefix, keep: 2, protect: ['g5'],
      // 잔존 창 10 초 — 최근 것들은 아직 워커가 들고 있을 수 있다.
      workerLingerMs: 10_000, now: () => now,
    });
    expect(out.removed).toEqual([]);
    expect(out.kept).toEqual(expect.arrayContaining(['g1', 'g2', 'g3', 'g4', 'g5']));
  });

  it('**창이 지난 세대는 지운다** — 보호가 영원하면 상한이 없는 것과 같다', () => {
    const now = mkGens(['g1', 'g2', 'g3', 'g4', 'g5'], 1000);
    const out = sweepGenerations({
      prefix, keep: 2, protect: ['g5'],
      // 창이 아주 짧으면 옛 것들은 이미 아무도 안 든다.
      workerLingerMs: 1, now: () => now,
    });
    expect(out.removed.sort()).toEqual(['g1', 'g2']);
  });

  it('**창을 안 주면 시간 보호가 없다** — 없는 보호를 있는 척하지 않는다', () => {
    // `worker_shutdown_timeout` 이 없는 배포가 이렇다. 개수 상한만 남는다.
    const now = mkGens(['g1', 'g2', 'g3', 'g4', 'g5'], 1000);
    void now;
    const out = sweepGenerations({ prefix, keep: 2, protect: ['g5'] });
    expect(out.removed.sort()).toEqual(['g1', 'g2']);
  });

  it('가장 새 후보는 비활성 시각을 모른다 — 그래서 개수 상한이 진다', () => {
    // `candidates[0]` 은 아직 활성일 수 있어 "언제 비활성이 됐나" 가 없다. 개수 상한
    // 안에 있으므로 어차피 남지만, 그 이유를 여기 못 박는다.
    const now = mkGens(['g1', 'g2'], 1000);
    const out = sweepGenerations({
      prefix, keep: 1, protect: [], workerLingerMs: 1, now: () => now,
    });
    expect(out.kept).toContain('g2');
    expect(out.removed).toEqual(['g1']);
  });
});

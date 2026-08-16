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

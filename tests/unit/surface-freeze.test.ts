import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('A 표면 동결 게이트', () => {
  let dir: string;
  let baseline: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'barycenter-freeze-a-'));
    baseline = join(dir, 'SURFACE.txt');
    writeFileSync(baseline, readFileSync('SURFACE.txt', 'utf8'));
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (mode: string) => spawnSync(process.execPath, ['scripts/surface.mjs', mode], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, BARYCENTER_SURFACE_BASELINE: baseline },
  });

  const mutate = (from: string | RegExp, to: string) => {
    const original = readFileSync(baseline, 'utf8');
    const changed = original.replace(from, to);
    expect(changed).not.toBe(original);
    writeFileSync(baseline, changed);
  };

  it('임계값 3 미만은 동결하지 않는다', () => {
    mutate('동결 카운터: 3', '동결 카운터: 2');
    expect(run('--freeze').status).toBe(1);
  });

  it('동결 선언이 없으면 freeze-check 가 거부한다', () => {
    mutate('A 동결: 선언', 'A 동결: 미선언');
    expect(run('--freeze-check').status).toBe(1);
  });

  it('선언 문자열을 포함한 잘못된 행과 중복 선언을 거부한다', () => {
    mutate('A 동결: 선언 (', 'A 동결: 선언취소 (');
    expect(run('--freeze-check').status).toBe(1);

    writeFileSync(baseline, readFileSync('SURFACE.txt', 'utf8'));
    mutate('# A 동결: 선언 (선언 기준 3 회차)', '# A 동결: 선언 (선언 기준 3 회차)\n# A 동결: 선언 (선언 기준 3 회차)');
    expect(run('--freeze-check').status).toBe(1);
  });

  it('본문 드리프트를 거부한다', () => {
    mutate('\n── ApplyOperation\n', '\n── ApplyOperation-tampered\n');
    expect(run('--freeze-check').status).toBe(1);
  });

  it('헤더 심볼 수와 digest 위조를 각각 거부한다', () => {
    mutate('# 111 심볼', '# 999 심볼');
    expect(run('--check').status).toBe(1);
    writeFileSync(baseline, readFileSync('SURFACE.txt', 'utf8'));
    mutate(/sha256:[0-9a-f]{64}/, `sha256:${'d'.repeat(64)}`);
    expect(run('--freeze-check').status).toBe(1);
  });

  it('동결 후 기준 재작성을 거부한다', () => {
    expect(run('--write').status).toBe(1);
    expect(readFileSync(baseline, 'utf8')).toBe(readFileSync('SURFACE.txt', 'utf8'));
  });
});

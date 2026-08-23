/**
 * A 표면 동결 게이트 — 그리고 **푸는 길**.
 *
 * ⚠️ 전에 이 파일은 라이브 `SURFACE.txt` 가 *동결돼 있다는 것*에 기대고 있었다.
 * `mutate('동결 카운터: 3', ...)` 처럼 지금 파일의 값을 문자열로 집어서 썼으므로,
 * **실제로 동결이 풀리자 5 건이 한꺼번에 빨개졌다.** 게이트를 재는 테스트가 게이트의
 * 현재 상태에 묶여 있으면, 그 상태가 바뀌는 날 테스트가 무엇을 지키던 것인지 알 수 없다.
 *
 * 그래서 **자기 기준을 스스로 세운다.** 본문은 라이브 파일에서 가져오되(표면 본문이
 * 진짜여야 `--check` 가 뜻을 갖는다) 머리는 이 파일이 원하는 상태로 찍는다.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

describe('A 표면 동결 게이트', () => {
  let dir: string;
  let baseline: string;

  /** 라이브 본문 + 이 테스트가 정한 머리. */
  const stamp = (opts: { rounds: number; frozen: boolean; released?: string }): string => {
    const raw = readFileSync('SURFACE.txt', 'utf8');
    const at = raw.indexOf('\n\n');
    const body = raw.slice(at);
    const claimed = /^# (\d+) 심볼 · (sha256:[0-9a-f]{64})$/m.exec(raw);
    if (claimed === null) throw new Error('라이브 SURFACE.txt 의 머리를 못 읽었다');
    return `# barycenter v0.1 공개 표면\n`
      + `# ${claimed[1]} 심볼 · ${claimed[2]}\n`
      + `# 동결 카운터: ${opts.rounds} 회차 (표면이 안 움직인 검수 회차 수)\n`
      + `# A 동결: ${opts.frozen ? '선언' : '미선언'} (선언 기준 3 회차)\n`
      + (opts.released === undefined ? '' : `# 해제 근거: ${opts.released}\n`)
      + `#\n`
      + `# 이 파일은 scripts/surface.mjs 가 만든다. 손으로 고치지 않는다.\n`
      + `# 13차 검수가 준 동결 기준: 여러 적대적 회차 동안 이 파일이 변하지 않을 것.\n`
      + `# 계약이 움직이면 카운터는 0 부터 다시 센다.${body}`;
  };

  const frozen = (): void => { writeFileSync(baseline, stamp({ rounds: 3, frozen: true })); };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'barycenter-freeze-a-'));
    baseline = join(dir, 'SURFACE.txt');
    frozen();
  });

  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const run = (...args: string[]) => spawnSync(process.execPath, ['scripts/surface.mjs', ...args], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, BARYCENTER_SURFACE_BASELINE: baseline },
  });

  const mutate = (from: string | RegExp, to: string): void => {
    const original = readFileSync(baseline, 'utf8');
    const changed = original.replace(from, to);
    expect(changed).not.toBe(original);
    writeFileSync(baseline, changed);
  };

  it('임계값 3 미만은 동결하지 않는다', () => {
    writeFileSync(baseline, stamp({ rounds: 2, frozen: false }));
    expect(run('--freeze').status).toBe(1);
  });

  it('동결 선언이 없으면 freeze-check 가 거부한다', () => {
    writeFileSync(baseline, stamp({ rounds: 3, frozen: false }));
    expect(run('--freeze-check').status).toBe(1);
  });

  it('선언 문자열을 포함한 잘못된 행과 중복 선언을 거부한다', () => {
    mutate('A 동결: 선언 (', 'A 동결: 선언취소 (');
    expect(run('--freeze-check').status).toBe(1);

    frozen();
    mutate('# A 동결: 선언 (선언 기준 3 회차)', '# A 동결: 선언 (선언 기준 3 회차)\n# A 동결: 선언 (선언 기준 3 회차)');
    expect(run('--freeze-check').status).toBe(1);
  });

  it('본문 드리프트를 거부한다', () => {
    mutate('\n── ApplyOperation\n', '\n── ApplyOperation-tampered\n');
    expect(run('--freeze-check').status).toBe(1);
  });

  it('헤더 심볼 수와 digest 위조를 각각 거부한다', () => {
    mutate(/^# \d+ 심볼/m, '# 999 심볼');
    expect(run('--check').status).toBe(1);
    frozen();
    mutate(/sha256:[0-9a-f]{64}/, `sha256:${'d'.repeat(64)}`);
    expect(run('--freeze-check').status).toBe(1);
  });

  it('동결 후 기준 재작성을 거부한다', () => {
    const before = readFileSync(baseline, 'utf8');
    expect(run('--write').status).toBe(1);
    expect(readFileSync(baseline, 'utf8')).toBe(before);
  });

  /**
   * ── 해제 (2026-08-23)
   *
   * 동결에는 **푸는 길이 아예 없었다.** 그건 의도였지만, 결정이 실제로 나자 남은 길이
   * `SURFACE.txt` 를 손으로 고치는 것뿐이었고 그 파일 머리에는 *"손으로 고치지 않는다"*
   * 가 적혀 있다. 막다른 길은 규칙을 지키게 하는 게 아니라 어기게 만든다.
   */
  describe('해제', () => {
    it('근거 없는 해제는 거부한다', () => {
      const before = readFileSync(baseline, 'utf8');
      expect(run('--unfreeze').status).toBe(1);
      // 공백만 준 것도 근거가 아니다.
      expect(run('--unfreeze', '   ').status).toBe(1);
      expect(readFileSync(baseline, 'utf8')).toBe(before);
    });

    it('여러 줄 근거를 거부한다 — 헤더가 한 줄에 산다', () => {
      /**
       * 헤더는 `#` 로 시작하는 줄들이고 파서는 `^# 해제 근거: (.+)$` 를 **정확히 하나**
       * 요구한다. 개행이 든 근거를 그대로 쓰면 둘째 줄이 `#` 없이 남아 헤더가 깨지고,
       * 그 다음부터 `--check` 가 파일을 아예 못 읽는다 — **게이트를 무력화하는 입력**이다.
       *
       * 실제로 그렇게 됐다: `--unfreeze "한 줄\n두 줄"` 이 `두 줄` 을 맨 줄로 남겼다.
       */
      const before = readFileSync(baseline, 'utf8');
      expect(run('--unfreeze', '한 줄\n두 줄').status).toBe(1);
      expect(run('--unfreeze', '캐리지\r리턴').status).toBe(1);
      expect(readFileSync(baseline, 'utf8')).toBe(before);
    });

    it('동결되지 않은 기준은 풀 것이 없다', () => {
      writeFileSync(baseline, stamp({ rounds: 1, frozen: false }));
      expect(run('--unfreeze', '아무 근거').status).toBe(1);
    });

    it('풀면 카운터가 0 이 되고 근거가 파일에 남는다', () => {
      const why = '설정 셋을 들이기로 결정했다';
      expect(run('--unfreeze', why).status).toBe(0);
      const after = readFileSync(baseline, 'utf8');
      expect(after).toContain('# A 동결: 미선언');
      expect(after).toContain('# 동결 카운터: 0 회차');
      expect(after).toContain(`# 해제 근거: ${why}`);
      // 푸는 것과 옮기는 것은 다른 일이다 — 본문은 안 건드린다.
      expect(after.slice(after.indexOf('\n\n'))).toBe(
        readFileSync('SURFACE.txt', 'utf8').slice(readFileSync('SURFACE.txt', 'utf8').indexOf('\n\n')),
      );
    });

    it('푼 뒤에는 --write 가 지나가고, 근거는 살아남는다', () => {
      const why = '왜 풀었는지가 남아야 한다';
      expect(run('--unfreeze', why).status).toBe(0);
      expect(run('--write').status).toBe(0);
      // **지난 해제를 지우지 않는다.** "한 번 풀린 적 있다" 는 다음 사람이 이 숫자를
      // 얼마나 믿을지 정할 때 쓰는 사실이다.
      expect(readFileSync(baseline, 'utf8')).toContain(`# 해제 근거: ${why}`);
    });

    it('푼 뒤 3 회차를 다시 쌓아야 재동결된다', () => {
      expect(run('--unfreeze', '근거').status).toBe(0);
      expect(run('--write').status).toBe(0);
      expect(run('--freeze').status).toBe(1);      // 0 회차
      expect(run('--round').status).toBe(0);
      expect(run('--round').status).toBe(0);
      expect(run('--freeze').status).toBe(1);      // 2 회차 — 아직 모자라다
      expect(run('--round').status).toBe(0);
      expect(run('--freeze').status).toBe(0);      // 3 회차
      expect(run('--freeze-check').status).toBe(0);
    });
  });
});

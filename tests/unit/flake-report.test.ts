/**
 * `scripts/flake-report.mjs` — 흔들림 장부를 실행 요약으로 낸다.
 *
 * 이 도구가 하는 일은 **세는 것이 안 보이던 자리를 보이게 하는 것**이다. 그래서 두 가지
 * 실패 모양이 특히 나쁘다:
 *
 *   · 흔들렸는데 아무것도 안 낸다   — 조용한 0 은 「없다」로 읽힌다
 *   · 안 흔들렸는데 뭔가 낸다       — 매 실행 요약에 잡음이 쌓이면 아무도 안 본다
 *
 * 그리고 워크플로 쪽 `if:` 조건 하나가 이 도구의 값을 통째로 정한다 — 아래 마지막
 * 케이스가 그것이다.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(root, 'scripts', 'flake-report.mjs');

/** 장부를 임시 디렉터리에 두고 도구를 **실제로 돌린다.** */
function report(ledger: string | undefined, label = 'unit'): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-flake-'));
  try {
    const log = join(dir, 'flakes.jsonl');
    if (ledger !== undefined) writeFileSync(log, ledger);
    return execFileSync('node', [SCRIPT, label], {
      encoding: 'utf8',
      env: { ...process.env, BARY_FLAKE_LOG: log },
    });
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

const ONE = '{"at":"2026-08-31T02:01:39Z","suite":"unit","seconds":399}\n';

describe('흔들림 요약', () => {
  /** 안 흔들린 실행에 잡음을 안 남긴다 — 남기면 다음부터 아무도 안 본다. */
  it('장부가 없으면 아무것도 안 낸다', () => {
    expect(report(undefined)).toBe('');
  });

  it('장부가 비었으면 아무것도 안 낸다', () => {
    expect(report('')).toBe('');
    expect(report('\n\n')).toBe('');
  });

  /** 흔들린 스위트의 **이름과 초**가 나와야 한다 — 그게 다음 사람이 쫓을 실마리다. */
  it('흔들린 스위트를 이름과 초로 낸다', () => {
    const out = report(ONE);
    expect(out).toContain('unit');
    expect(out).toContain('399');
    expect(out).toContain('2026-08-31T02:01:39Z');
  });

  it('여러 줄이면 전부 낸다', () => {
    const out = report(ONE + '{"at":"2026-08-30T09:47:18Z","suite":"store (실물 PG)","seconds":3664}\n');
    expect(out).toContain('unit');
    expect(out).toContain('store (실물 PG)');
  });

  /**
   * **못 읽은 줄을 조용히 버리지 않는다.** 세는 도구가 조용히 0 을 말하면 그건
   * 「흔들린 것이 없다」로 읽힌다 — 이 저장소가 반복해서 피해 온 실패 모양이다.
   */
  it('깨진 줄이 있으면 그 사실을 말한다 — 조용히 버리지 않는다', () => {
    const out = report(`${ONE}이건 JSON 이 아니다\n`);
    expect(out).toContain('unit');
    expect(out).toMatch(/못 읽은 줄 1 개/);
  });

  /** 라벨은 어느 조각이 흔들렸는지다. 조각이 다섯이라 없으면 못 가른다. */
  it('라벨을 제목에 싣는다', () => {
    expect(report(ONE, 'e2e')).toContain('e2e');
  });

  /**
   * **`if: always()` 여야 한다.**
   *
   * 흔들림은 **잡이 빨간 채로** 끝날 때만 나온다 — 재실행이 초록이어도 판정을 안 바꾸는
   * 것이 `scripts/lib/flake.sh` 의 결정이기 때문이다. `success()` 에 걸면 이 도구는
   * **영영 안 불린다.** 조건 하나가 이 회차 전체의 값을 정하므로 여기서 못 박는다.
   */
  it('워크플로가 실패했을 때도 부른다 — `success()` 면 영영 안 찍힌다', () => {
    const wf = readFileSync(join(root, '.github', 'workflows', 'verify.yml'), 'utf8');
    const steps = wf.split('- name: 흔들림 요약').slice(1);
    expect(steps.length, '흔들림 요약 단계가 없다').toBeGreaterThanOrEqual(2);
    for (const s of steps) {
      // 그 단계의 바로 다음 줄들에 조건이 있다.
      expect(s.slice(0, 200)).toContain('if: always()');
    }
  });
});

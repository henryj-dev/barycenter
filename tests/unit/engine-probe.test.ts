/**
 * 엔진 capability 조회 (DESIGN.md §7.6)
 *
 * `capabilities.ts` 는 `nginx -V` 출력을 해석하는 순수 함수로 오래 있었는데 **아무도
 * 부르지 않았다.** 컨트롤 플레인이 `streamRealip: false` 를 상수로 가정했고, PROXY 신뢰
 * 경계를 넣은 뒤로 **stream PROXY 수신이 엔진과 무관하게 항상 막혔다** —
 * capability 로 좁힌다고 해 놓고 capability 를 안 물어본 셈이었다.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { probeEngine } from '../../src/engine/probe.js';

let dir: string;

/** `nginx -V` 를 흉내 내는 가짜 실행 파일. */
function fakeEngine(name: string, body: string, exitCode = 0): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${body}\nexit ${exitCode}\n`);
  chmodSync(path, 0o755);
  return path;
}

const REAL_V = `nginx version: openresty/1.27.1.1
built by gcc 13.2.1
configure arguments: --with-stream --with-stream_ssl_preread_module --with-http_realip_module`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bary-probe-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('엔진 조회', () => {
  it('**`-V` 는 stderr 로 나온다** — stdout 만 읽으면 언제나 빈 답이다', () => {
    // 이걸 놓치면 "모든 모듈이 없다" 는 **그럴듯한 거짓말**이 나온다. 조회가 실패했다는
    // 신호조차 없이 보수적 답이 나오므로 아무도 이상하다고 생각하지 않는다.
    const bin = fakeEngine('only-stderr', `cat >&2 <<'EOF'\n${REAL_V}\nEOF`);
    const r = probeEngine(bin);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.capabilities.flavor).toBe('openresty');
      expect(r.capabilities.supports.sniPassthrough).toBe(true);
    }
  });

  it('종료 코드가 0 이 아니어도 출력이 있으면 읽는다', () => {
    const bin = fakeEngine('nonzero', `cat >&2 <<'EOF'\n${REAL_V}\nEOF`, 1);
    expect(probeEngine(bin).ok).toBe(true);
  });

  it('`stream_realip` 유무를 가른다 — 이 값이 저장 단계의 판정을 바꾼다', () => {
    const without = probeEngine(fakeEngine('a', `cat >&2 <<'EOF'\n${REAL_V}\nEOF`));
    const with_ = probeEngine(fakeEngine('b',
      `cat >&2 <<'EOF'\n${REAL_V} --with-stream_realip_module\nEOF`));
    expect(without.ok && without.capabilities.supports.streamRealip).toBe(false);
    expect(with_.ok && with_.capabilities.supports.streamRealip).toBe(true);
  });

  it('**없는 실행 파일은 실패로 답한다** — 조용히 보수적으로 넘어가지 않는다', () => {
    const r = probeEngine(join(dir, '없는것'));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/못 읽었다/);
  });

  it('버전이 없는 출력은 실패다 — 파싱된 척하지 않는다', () => {
    const bin = fakeEngine('garbage', `echo "안녕" >&2`);
    const r = probeEngine(bin);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/버전/);
  });

  it('실제 엔진 이미지에서도 읽힌다', () => {
    // 가짜만으로는 "출력 모양이 정말 그런가" 를 못 잰다.
    let out: string;
    try {
      out = execFileSync('docker', ['run', '--rm', '--entrypoint',
        '/usr/local/openresty/bin/openresty',
        process.env['BARY_ENGINE_IMAGE'] ?? 'openresty/openresty:alpine', '-V'],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    }
    if (!out.includes('nginx version')) return;   // 도커가 없으면 이 단언은 건너뛴다
    const bin = fakeEngine('realish', `cat >&2 <<'EOF'\n${out}\nEOF`);
    const r = probeEngine(bin);
    expect(r.ok).toBe(true);
    // E63.4 가 실측한 사실: 이 이미지에는 stream_realip 이 없다.
    if (r.ok) expect(r.capabilities.supports.streamRealip).toBe(false);
  }, 120_000);
});

/**
 * 작은 것 넷 — 검수 2026-08-24 G7
 *
 * 각각 독립이지만 부류가 하나다: **경계에서 아무도 안 읽는다.**
 *
 *   ① `readManifest` 가 `JSON.parse` 를 안 감싼다 — 깨진 manifest 가 raw `SyntaxError`
 *   ② `BARY_LISTEN` 을 `split(':')` 으로 쪼갠다 — **IPv6 를 표현할 수 없다**
 *   ③ 진입점 퍼미션 게이트 — `package.json` 의 `bin` 과 빌드 산출물을 대조한다
 *
 * (`build.sh` 의 `gui/package-lock.json` 감시는 W4-7 원문의 넷째다. 셸 스크립트라
 * 여기서 못 재고, 그 자리에서 잰다.)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { GenerationError, readManifest } from '../../src/dp/materialize.js';
import { parseListen } from '../../src/validate/sockets.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** 세대 하나에 manifest 를 손으로 쓴다. */
function generationWith(body: string): { prefix: string; generation: string } {
  const prefix = mkdtempSync(join(tmpdir(), 'bary-g7-'));
  dirs.push(prefix);
  const generation = 'r1-e1';
  mkdirSync(join(prefix, 'generations', generation), { recursive: true });
  writeFileSync(join(prefix, 'generations', generation, 'manifest.json'), body, 'utf8');
  return { prefix, generation };
}

describe('① 깨진 manifest', () => {
  /**
   * **깨진 manifest 가 `GenerationError` 로 온다.**
   *
   * 전에는 `JSON.parse` 가 raw `SyntaxError` 를 던졌다. 호출자
   * (`verifyGeneration` → `preflight`)는 `GenerationError` 의 `kind` 로 분기하는데,
   * 그 예외는 거기 안 걸려 **apply 가 「알 수 없는 오류」로 끝난다.** 운영자가 보는
   * 것은 `Unexpected token` 한 줄이고, 그것이 세대 이야기라는 것이 어디에도 없다.
   */
  it('깨진 manifest 가 `manifest_missing` 으로 온다 — raw SyntaxError 가 아니다', () => {
    const { prefix, generation } = generationWith('{ 이건 JSON 이 아니다');
    let thrown: unknown;
    try { readManifest(prefix, generation); } catch (e) { thrown = e; }
    expect(thrown, '안 던졌다').toBeInstanceOf(GenerationError);
    expect((thrown as GenerationError).kind).toBe('manifest_missing');
  });

  /**
   * **`files` 가 없으면 그것도 깨진 것이다.** 스키마 번호만 보면 `{"schema":1}` 이
   * 통과하고, 그러면 `verifyGeneration` 이 **빈 파일 목록을 대조해 초록**을 낸다 —
   * 아무 파일도 안 보고 「맞다」고 답하는 것이다.
   */
  it('`files` 가 없으면 거절한다 — 빈 목록을 대조해 초록을 내지 않는다', () => {
    const { prefix, generation } = generationWith('{"schema":1,"generation":"r1-e1"}');
    expect(() => readManifest(prefix, generation)).toThrow(GenerationError);
  });

  it('`files` 가 객체가 아니어도 거절한다', () => {
    const { prefix, generation } = generationWith(
      '{"schema":1,"generation":"r1-e1","files":[],"digest":"x"}');
    expect(() => readManifest(prefix, generation)).toThrow(GenerationError);
  });

  /** **되는 것을 안 깬다.** */
  it('멀쩡한 manifest 는 그대로 읽는다', () => {
    const { prefix, generation } = generationWith(JSON.stringify({
      schema: 1, generation: 'r1-e1', files: { 'nginx.conf': 'sha256:x' }, digest: 'sha256:d',
    }));
    expect(readManifest(prefix, generation).files['nginx.conf']).toBe('sha256:x');
  });
});

describe('② `BARY_LISTEN` 과 IPv6', () => {
  it('IPv6 를 표현할 수 있다 — `split(":")` 으로는 못 한다', () => {
    expect(parseListen('[::1]:8088')).toEqual({ host: '::1', port: 8088 });
    expect(parseListen('[2001:db8::1]:443')).toEqual({ host: '2001:db8::1', port: 443 });
  });

  it('IPv4 와 호스트 이름은 그대로다 — 기존 배포가 안 깨진다', () => {
    expect(parseListen('127.0.0.1:8088')).toEqual({ host: '127.0.0.1', port: 8088 });
    expect(parseListen('0.0.0.0:8088')).toEqual({ host: '0.0.0.0', port: 8088 });
  });

  /** **모양이 틀리면 던진다.** `NaN` 포트로 `listen` 하면 무작위 포트가 열린다. */
  it.each(['8088', '127.0.0.1', '127.0.0.1:', ':8088', '127.0.0.1:abc', '[::1]8088', ''])(
    '모양이 틀리면 던진다: %s', (bad) => {
      expect(() => parseListen(bad)).toThrow();
    });

  it('포트 범위 밖은 던진다', () => {
    expect(() => parseListen('127.0.0.1:0')).toThrow();
    expect(() => parseListen('127.0.0.1:65536')).toThrow();
  });
});

describe('③ 진입점 퍼미션', () => {
  /**
   * **`package.json` 의 `bin` 을 읽어 대조한다** (W0-9 가 남긴 것).
   *
   * `build.sh` 가 진입점 목록을 손으로 들고 있다가 `bary-dp-agent` 를 빠뜨렸다 —
   * 선언은 있는데 실행 권한이 없는 산출물이 나갔다. 그때 `chmod +x dist/bin/*.js` 로
   * 목록을 없앴는데, **그것이 정말 도는지는 아무도 안 쟀다.**
   *
   * 빌드를 돌려야 해서 `verify:quick` 밖이다 — `dist/` 가 없으면 건너뛴다.
   */
  it('선언된 모든 진입점이 실행 가능하다', () => {
    const root = new URL('../../', import.meta.url).pathname;
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      bin?: Record<string, string>;
    };
    const bins = Object.values(pkg.bin ?? {});
    expect(bins.length, '`bin` 이 비었다 — 이 검사가 아무것도 안 잰다').toBeGreaterThan(0);

    const missing = bins.filter((rel) => !existsSync(join(root, rel)));
    if (missing.length === bins.length) return;   // 빌드 전이다

    for (const rel of bins) {
      const path = join(root, rel);
      expect(existsSync(path), `${rel} 이 없다 — \`bin\` 에 선언됐는데 안 나왔다`).toBe(true);
      // 0o111 — 소유자·그룹·기타 중 하나라도 실행 비트가 있어야 한다.
      expect(statSync(path).mode & 0o111, `${rel} 에 실행 권한이 없다`).not.toBe(0);
    }
  });

  /** 그리고 **정말 실행된다** — 권한 비트와 실행 가능은 다르다(shebang 이 있어야 한다). */
  it('선언된 진입점이 실제로 실행된다 — shebang 이 있다', () => {
    const root = new URL('../../', import.meta.url).pathname;
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      bin?: Record<string, string>;
    };
    for (const rel of Object.values(pkg.bin ?? {})) {
      const path = join(root, rel);
      if (!existsSync(path)) return;              // 빌드 전이다
      expect(readFileSync(path, 'utf8').startsWith('#!'), `${rel} 에 shebang 이 없다`).toBe(true);
    }
  });
});

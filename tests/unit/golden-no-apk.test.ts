/**
 * **골든은 `docker run` 마다 망에서 받지 않는다** (2026-11-02)
 *
 * CI 41347907696 의 `verify (render)` 가 빨갰다. `next-upstream` 「무대가 선다」 가
 * 64 초를 돌고 `slots=""` 로 졌다. 원인은 엔진이 아니라 프로브 앞의
 * `apk add --no-cache curl >/dev/null 2>&1;` 이었다 — 거울에서 못 받았고, 출력은
 * 지워졌고, `set -e` 가 `curl: not found` 에서 프로브를 끝냈다.
 *
 * 그 줄이 골든 스무 파일에 있었고, 스위트 한 번에 수십 번 망을 탔다. 이제 도구는
 * `tests/golden/tools-image.ts` 가 **한 번** 얹는다. 이 검사는 그 줄이 다시 들어오는
 * 것을 막는다 — 새 골든이 옛 파일을 베끼면 그 순간 빨개진다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { TOOLS } from '../golden/tools-image.js';

const GOLDEN = join(dirname(fileURLToPath(import.meta.url)), '..', 'golden');
const files = readdirSync(GOLDEN).filter((f) => f.endsWith('.ts') && f !== 'tools-image.ts');
/** 주석 줄은 뺀다 — 옛 방식을 설명하는 글은 남아도 된다. 막는 것은 실행되는 줄이다. */
const src = (f: string): string => readFileSync(join(GOLDEN, f), 'utf8')
  .split('\n').filter((l) => !/^\s*(\/\/|\/?\*)/.test(l)).join('\n');

describe('골든의 도구는 한 번만 설치한다', () => {
  it('골든 파일 어디에도 `apk add` 가 없다', () => {
    const offenders = files.filter((f) => /apk\s+add/.test(src(f)));
    expect(offenders, '도구는 tests/golden/tools-image.ts 의 TOOLS 에 적는다').toEqual([]);
  });

  it('골든 프로브가 부르는 도구는 전부 도구 이미지에 있다', () => {
    const used = new Set<string>();
    for (const f of files) {
      for (const t of ['curl', 'openssl', 'socat']) {
        if (new RegExp(`\\b${t}\\s+-`).test(src(f))) used.add(t);
      }
    }
    expect(used.size).toBeGreaterThan(0);
    for (const t of used) expect(TOOLS, t).toContain(t);
  });
});

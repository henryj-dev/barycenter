/**
 * **GUI 번들에 노드 내장이 들어가면 화면이 안 만들어진다.**
 *
 * 실물로 겪은 것이다. `desk.svelte.ts → @web/routes-view → route/compile →
 * validate/strings` 가 `node:net` 을 끌고 들어가서 `vite build` 가 죽었다:
 *
 * ```
 * [vite-plugin-sveltekit-compile] ../src/validate/strings.ts (12:9):
 * "isIP" is not exported by "__vite-browser-external"
 * ```
 *
 * 그런데 **아무 스위트도 그 사실을 말하지 않았다.** `gui/` 는 `verify.sh` 밖이고
 * 테스트가 0 개다. 게다가 데몬은 `gui/build` 가 없으면 조용히 GUI 없이 뜬다
 * (`barycenterd.ts` 의 `serveRoot`) — 배포하면 API 만 서고 화면이 없다.
 *
 * 진짜 판정은 `vite build` 이고 그건 게이트에 넣었다(`scripts/build.sh`). 이 테스트는
 * 그보다 **빠르고 원인을 짚어 주는** 층이다: 어느 파일이 무엇을 끌고 들어왔는지 말한다.
 * 빌드는 "번들이 안 선다" 까지만 말한다.
 *
 * ── 왜 정적 훑기인가 ────────────────────────────────────────────────────
 *
 * 번들러를 흉내 내지 않는다. 딱 하나만 본다 — **값 import 로 닿는 모듈에 `node:`
 * 스펙파이어가 있는가.** `import type` 은 컴파일에서 지워지므로 따라가지 않는다
 * (실제로 GUI 의 대부분은 타입만 가져간다).
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

const IMPORT = /^\s*import\s+(type\s+)?[^;]*?from\s+['"]([^'"]+)['"]/gm;

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    if (statSync(p).isDirectory()) out.push(...sourceFiles(p));
    else if (/\.(svelte|ts)$/.test(p)) out.push(p);
  }
  return out;
}

/** `@web/x` 와 상대 경로만 푼다. 그 밖(패키지)은 번들러의 몫이다. */
function resolveSpec(spec: string, from: string): string | undefined {
  if (spec.startsWith('@web/')) return join(ROOT, 'src/web', `${spec.slice(5)}.ts`);
  if (!spec.startsWith('.')) return undefined;
  const base = resolve(dirname(from), spec).replace(/\.js$/, '');
  for (const cand of [`${base}.ts`, join(base, 'index.ts')]) {
    if (existsSync(cand)) return cand;
  }
  return undefined;
}

function nodeImportsReachableFromGui(): string[] {
  const seen = new Set<string>();
  const found: string[] = [];

  const scan = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const m of readFileSync(file, 'utf8').matchAll(IMPORT)) {
      const typeOnly = m[1] !== undefined;
      const spec = m[2]!;
      if (spec.startsWith('node:')) {
        if (!typeOnly) found.push(`${file.replace(`${ROOT}/`, '')} → ${spec}`);
        continue;
      }
      if (typeOnly) continue;
      const target = resolveSpec(spec, file);
      if (target !== undefined && existsSync(target)) scan(target);
    }
  };

  for (const f of sourceFiles(join(ROOT, 'gui/src'))) scan(f);
  return found;
}

describe('GUI 번들 (§10)', () => {
  it('GUI 가 값으로 닿는 모듈에 노드 내장이 없다', () => {
    expect(nodeImportsReachableFromGui()).toEqual([]);
  });

  it('훑기가 실제로 무언가를 훑는다', () => {
    // 계측기부터 검증한다 (S16 이 준 규칙). 경로가 어긋나 0 개를 훑으면 위 검사는
    // **언제나 초록**이고, 그건 아무것도 안 지키는 게이트다.
    const files = sourceFiles(join(ROOT, 'gui/src'));
    expect(files.length).toBeGreaterThan(20);
    expect(files.some((f) => f.endsWith('desk.svelte.ts'))).toBe(true);
  });
});

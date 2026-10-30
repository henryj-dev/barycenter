/**
 * 디자인 시스템 (#126) — 토큰과 글꼴의 계약.
 *
 * 재는 것:
 *   · 토큰이 의미 색 7쌍(전경 · 배경)을 **다크와 라이트 둘 다** 정의한다 — 한쪽만 있으면 그 테마에서
 *     배지·배너가 다른 테마 색으로 그려진다
 *   · 시스템 설정 라이트(`prefers-color-scheme`)도 같은 값을 쓴다 — 라이트 값이 두 벌로 갈리지 않는다
 *   · 공통 컴포넌트 묶음(`#lib/ui`)이 내보내는 파일이 실제로 있다
 *   · GUI 가 외부 글꼴을 참조하지 않고, 서버 CSP 가 외부 출처를 열지 않는다 — 글꼴은 빌드가
 *     자기 자산으로 들인다. 다시 외부 출처를 쓰면 이 화면이 남의 가용성에 매달린다
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { serveGui } from '../../src/web/serve-gui.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const UI = join(root, 'gui/src/lib/ui');
const SEMANTIC = ['ok', 'warn', 'danger', 'info', 'neutral', 'pending', 'drain'] as const;

/** 선택자 블록 하나의 `--이름: 값` 들. */
function varsOf(css: string, selector: RegExp): Map<string, string> {
  const m = selector.exec(css);
  expect(m, `${selector} 블록이 없다`).not.toBeNull();
  const start = m!.index + m![0].length;
  const body = css.slice(start, css.indexOf('}', start));
  return new Map([...body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)].map((x) => [x[1]!, x[2]!.trim()]));
}

/**
 * 파일은 **테스트 안에서** 읽는다. `describe` 에서 읽으면 파일이 없을 때(수정 전 트리) 수집이
 * 터져서 테스트가 0 건이 된다 — 빨강이 아니라 「아무것도 안 돌았다」 가 된다.
 */
const tokens = (): { dark: Map<string, string>; light: Map<string, string>; systemLight: Map<string, string> } => {
  const css = readFileSync(join(UI, 'tokens.css'), 'utf8');
  return {
    dark: varsOf(css, /:root\s*\{/),
    light: varsOf(css, /:root\[data-theme='light'\]\s*\{/),
    systemLight: varsOf(css, /:root:not\(\[data-theme='dark'\]\):not\(\[data-theme='light'\]\)\s*\{/),
  };
};

describe('디자인 토큰', () => {
  it('의미 색 7쌍을 다크와 라이트 둘 다 정의한다', () => {
    const { dark, light } = tokens();
    for (const k of SEMANTIC) {
      for (const v of [`--${k}`, `--${k}-bg`]) {
        expect(dark.get(v), `다크 ${v}`).toMatch(/^#[0-9a-f]{6}$/);
        expect(light.get(v), `라이트 ${v}`).toMatch(/^#[0-9a-f]{6}$/);
        expect(light.get(v), `${v} 가 두 테마에서 같다`).not.toBe(dark.get(v));
      }
    }
  });

  it('시스템 설정 라이트는 고른 라이트와 같은 값이다', () => {
    const { light, systemLight } = tokens();
    expect(Object.fromEntries(systemLight)).toEqual(Object.fromEntries(light));
  });

  it('공통 컴포넌트 묶음이 내보내는 파일이 다 있다', () => {
    const index = readFileSync(join(UI, 'index.ts'), 'utf8');
    const files = [...index.matchAll(/from '\.\/([^']+)'/g)].map((m) => m[1]!);
    expect(files.length).toBeGreaterThan(30);
    for (const f of files) expect(existsSync(join(UI, f)), f).toBe(true);
  });
});

describe('글꼴은 자기 자산이다', () => {
  let dir: string | undefined;
  let server: Server | undefined;
  afterEach(async () => {
    await new Promise<void>((r) => (server === undefined ? r() : server.close(() => r())));
    server = undefined;
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  it('GUI 셸이 외부 글꼴 스타일시트를 참조하지 않는다', () => {
    const html = readFileSync(join(root, 'gui/src/app.html'), 'utf8');
    expect(html).not.toMatch(/https?:\/\//);
    const pkg = JSON.parse(readFileSync(join(root, 'gui/package.json'), 'utf8')) as { devDependencies: Record<string, string> };
    expect(pkg.devDependencies['pretendard']).toBeDefined();
    expect(pkg.devDependencies['@fontsource-variable/jetbrains-mono']).toBeDefined();
  });

  it('서버 CSP 가 스타일·글꼴에 외부 출처를 열지 않는다', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bary-ds-'));
    writeFileSync(join(dir, 'index.html'), '<p>ok</p>');
    const gui = dir;
    server = createServer((req, res) => {
      if (!serveGui(res, new URL(req.url ?? '/', 'http://x').pathname, gui)) { res.writeHead(404); res.end(); }
    });
    await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    const csp = (await fetch(`http://127.0.0.1:${port}/`)).headers.get('content-security-policy') ?? '';
    const directive = (name: string): string => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `)) ?? '';
    expect(directive('style-src')).not.toMatch(/https?:/);
    expect(directive('font-src')).toBe("font-src 'self'");
  });
});

/**
 * 로그인 뒤에 화면이 넘어간다 (2026-10-30, web-01 에서 찾았다).
 *
 * `desk.connect()` 는 실시간 스트림을 붙들고 **끊길 때까지 끝나지 않는다**(재연결 고리). 로그인 화면이
 * `await desk.connect()` 뒤에 `goto('/')` 를 두었더니, 스트림이 붙는 순간 영원히 기다려서 로그인해도
 * 로그인 화면에 머물렀다. 지역 화면의 「보기」 도 같은 모양이었다.
 *
 * 재는 것: GUI 어디에서도 `connect()` 를 기다린 뒤 다음 일을 하지 않는다.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const GUI = join(dirname(fileURLToPath(import.meta.url)), '../../gui/src');
const sources = (dir = GUI): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  (e.isDirectory() ? sources(join(dir, e.name)) : /\.(svelte|ts)$/.test(e.name) ? [join(dir, e.name)] : []));

describe('스트림 연결을 기다리지 않는다', () => {
  it('로그인 · 지역 화면이 연결을 띄우고 바로 이동한다', () => {
    for (const f of ['routes/login/+page.svelte', 'routes/regions/+page.svelte']) {
      const src = readFileSync(join(GUI, f), 'utf8');
      expect(src, f).toContain('void desk.connect()');
      expect(src, f).toContain("goto('/')");
    }
  });

  it('GUI 어디에도 `await …connect()` 가 없다', () => {
    for (const f of sources()) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/await\s+[\w.]*\bconnect\(\)/);
    }
  });
});

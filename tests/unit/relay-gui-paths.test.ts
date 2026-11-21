/**
 * 전역 모드의 중계가 **GUI 가 부르는 지역 API 를 모두** 넘기는지 (2026-11-20).
 *
 * GUI 는 지역 API 를 부를 때 `scope.api()` 로 경로를 `/api/v1/regions/<지역>/…` 로 바꾼다. 중계 허용 목록
 * (`RELAY_PATHS` · `RELAY_WRITES`)에 없는 경로는 전역에서 404 다. 풀의 출처 · 주소 집합 갱신 기록 · 다시 받기가
 * 그렇게 빠져 있었다. 이 시험은 GUI 소스에서 경로를 모아 목록과 맞춘다 — 새 호출을 넣고 목록을 잊으면 여기서 깨진다.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { apiRouteTable } from '../../src/api/server.js';
import { RELAY_PATHS, RELAY_WRITES } from '../../src/global/relay.js';

const GUI = join(import.meta.dirname, '../../gui/src');

/** 계정 · 세션 · 전역 자신의 경로 — 바꾸지 않는다(`scope.svelte.ts` 의 `OWN`). */
const OWN = ['me', 'session', 'oidc', 'invitations', 'users', 'account', 'account-audit', 'sso-providers', 'regions'];

function files(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return files(p);
    return /\.(ts|svelte)$/.test(n) ? [p] : [];
  });
}

/**
 * `api('/api/v1/…')` · `call('POST', '/api/v1/…')` 의 경로. 구간 하나를 차지하는 `${…}` 는 `:x`(맨 앞도 —
 * `${base}/:id/…`), 구간에 덧붙은 `${…}`(질의)는 버린다.
 */
function guiPaths(): { file: string; path: string }[] {
  const out: { file: string; path: string }[] = [];
  const re = /\b(?:api|call)\((?:'[A-Z]+',\s*)?[`']\/api\/v1\/([^`']*)[`']/g;
  for (const f of files(GUI)) {
    for (const m of readFileSync(f, 'utf8').matchAll(re)) {
      const path = m[1]!
        .replace(/(^|\/)\$\{[^}]+\}/g, '$1:x')
        .replace(/\$\{[^}]+\}/g, '')
        .replace(/\?.*$/, '');
      out.push({ file: f.slice(GUI.length + 1), path });
    }
  }
  return out;
}

const segs = (p: string): string[] => p.split('/');
const matches = (gui: string, allowed: string): boolean => {
  const a = segs(gui);
  const b = segs(allowed);
  return a.length === b.length && a.every((s, i) => s === b[i] || s.startsWith(':') || b[i]!.startsWith(':'));
};

describe('GUI 가 부르는 지역 API 는 모두 전역 중계에 있다', () => {
  const found = guiPaths();

  it('GUI 소스에서 경로를 찾는다 (모으기가 깨지지 않았다)', () => {
    expect(found.length).toBeGreaterThan(30);
  });

  it('계정 경로를 뺀 모든 경로가 읽기 또는 쓰기 허용 목록에 맞는다', () => {
    const allowed = [...RELAY_PATHS, ...RELAY_WRITES.map((w) => w.path)];
    const missing = found
      .filter((f) => !OWN.includes(f.path.split('/')[0]!))
      .filter((f) => !allowed.some((a) => matches(f.path, a)))
      .map((f) => `${f.path} (${f.file})`);
    expect(missing).toEqual([]);
  });

  it('빠져 있던 셋과 「지금 다시 찾기」 가 들어 있다', () => {
    expect(RELAY_PATHS).toContain('pools/:id/discovery');
    expect(RELAY_PATHS).toContain('address-sets/refresh-status');
    expect(RELAY_WRITES).toContainEqual({ method: 'POST', path: 'address-sets/:id/refresh', scope: 'write' });
    expect(RELAY_WRITES).toContainEqual({ method: 'POST', path: 'pools/:id/discovery/refresh', scope: 'write' });
  });
});

/**
 * 허용 목록과 전역 라우트가 **서로 같은지** (2026-11-21). 목록에 있어도 `GLOBAL_ROUTES` 에 라우트가 없으면 전역은
 * 404 다 — 트래픽 통계(`traffic`, `traffic/:kind/:id`)가 그렇게 빠져 있었다. 반대로 라우트만 있고 목록에 없으면
 * 중계가 거부한다.
 */
describe('중계 허용 목록과 전역 라우트가 하나씩 맞는다', () => {
  const PREFIX = '/api/v1/regions/:name/';
  const global = apiRouteTable()
    .filter((r) => r.path.startsWith(PREFIX))
    .map((r) => `${r.method} ${r.path.slice(PREFIX.length)}`)
    .sort();
  const allowed = [
    ...RELAY_PATHS.map((p) => `GET ${p}`),
    ...RELAY_WRITES.map((w) => `${w.method} ${w.path}`),
  ].sort();

  it('허용 목록의 모든 경로에 전역 라우트가 있다', () => {
    expect(allowed.filter((a) => !global.includes(a))).toEqual([]);
  });

  it('모든 전역 라우트가 허용 목록에 있다', () => {
    expect(global.filter((g) => !allowed.includes(g))).toEqual([]);
  });
});

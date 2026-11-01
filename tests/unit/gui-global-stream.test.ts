/**
 * **전역 화면은 지역을 고르기 전에 스트림에 붙지 않는다** (2026-11-01 web-01).
 *
 * 전역에는 `/api/v1/events` 가 없다(404 `global_mode`). 로그인 직후 GUI 가 거기에 붙어
 * 404 를 끝없이 다시 불렀고, 상단에 「실시간 연결이 끊겼어요」가 계속 떴다.
 * 지역을 고르면 `/api/v1/regions/<지역>/events` 로 붙는다.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { connStateOf, hasStream } from '../../src/web/reconnect.js';

describe('전역 화면의 실시간 연결', () => {
  it('전역에서 지역을 고르기 전에는 붙을 스트림이 없다', () => {
    expect(hasStream({ mode: 'global' })).toBe(false);
    expect(hasStream({ mode: 'global', region: { name: 'util-icn-vtr' } })).toBe(true);
    expect(hasStream({ mode: 'region' })).toBe(true);
    expect(hasStream({ mode: 'unknown' })).toBe(true);
  });

  it('붙을 스트림이 없으면 끊김이 아니라 대기다', () => {
    expect(connStateOf({ live: false, signedIn: true, hasStream: false })).toBe('idle');
    expect(connStateOf({ live: false, signedIn: true, hasStream: true })).toBe('reconnecting');
    expect(connStateOf({ live: true, signedIn: true, hasStream: true })).toBe('live');
    expect(connStateOf({ live: false, signedIn: false, hasStream: true })).toBe('down');
  });

  it('desk.connect 는 붙을 스트림이 없으면 부르지 않는다', () => {
    const src = readFileSync(new URL('../../gui/src/lib/desk.svelte.ts', import.meta.url), 'utf8');
    const body = src.slice(src.indexOf('const connect = async'), src.indexOf('let attempt = 0'));
    expect(body).toMatch(/!hasStream\(scope\)\) return;/);
    const layout = readFileSync(new URL('../../gui/src/routes/+layout.svelte', import.meta.url), 'utf8');
    expect(layout).toMatch(/connStateOf\(/);
  });
});

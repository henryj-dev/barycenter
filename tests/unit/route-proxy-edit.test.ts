/**
 * 프록시 라우트 옵션의 저작 표면 — GUI 폼과 CLI 가 같은 자리를 쓴다 (#109).
 */
import { describe, expect, it } from 'vitest';

import { parseHeaderLines, putHttpRoutePatch } from '../../src/web/edit.js';
import { routeCreatePatch } from '../../src/cli/route.js';

const base = { key: 'api', listener: 'web', hosts: ['a.test'], pool: 'ext', pathPrefix: '/api/' };

describe('parseHeaderLines', () => {
  it('첫 : 에서 끊는다 — 값에 : 가 있어도 된다', () => {
    expect(parseHeaderLines('Host: api.example.com\nAuthorization: Basic a:b'))
      .toEqual([{ name: 'Host', value: 'api.example.com' }, { name: 'Authorization', value: 'Basic a:b' }]);
  });
  it('빈 줄은 버리고, 비면 undefined', () => {
    expect(parseHeaderLines('\n  \n')).toBeUndefined();
    expect(parseHeaderLines(undefined)).toBeUndefined();
  });
  it('이름이 없으면 거절한다', () => {
    expect(() => parseHeaderLines(': x')).toThrow(/이름: 값/);
    expect(() => parseHeaderLines('Host')).toThrow(/이름: 값/);
  });
});

describe('putHttpRoutePatch', () => {
  it('둘을 action 에 싣는다', () => {
    const [op] = putHttpRoutePatch({
      ...base, rewritePrefix: '/v1/', requestHeaders: [{ name: 'Host', value: 'api.example.com' }],
    });
    expect(op!.body.action).toEqual({
      kind: 'proxy', pool: 'ext', websocket: false,
      requestHeaders: [{ name: 'Host', value: 'api.example.com' }], rewritePrefix: '/v1/',
    });
  });
  it('안 적으면 키가 없다', () => {
    const [op] = putHttpRoutePatch({ ...base, rewritePrefix: '  ', requestHeaders: [] });
    expect(op!.body.action).toEqual({ kind: 'proxy', pool: 'ext', websocket: false });
  });
  it('끝 / 가 접두사와 다르면 저장 전에 거절한다', () => {
    expect(() => putHttpRoutePatch({ ...base, rewritePrefix: '/v1' })).toThrow(/끝/);
    const { pathPrefix: _drop, ...noPrefix } = base;
    expect(() => putHttpRoutePatch({ ...noPrefix, rewritePrefix: '/v1' })).toThrow(/끝/);
  });
});

describe('CLI — bary route create --route-header --rewrite-prefix', () => {
  it('플래그가 action 에 실린다', () => {
    const ops = routeCreatePatch({
      name: 'api', listener: 'web', hosts: 'a.test', pool: 'ext', pathPrefix: '/api/',
      requestHeaders: ['Host: api.example.com'], rewritePrefix: '/',
    });
    expect(ops?.[0]?.body.action).toMatchObject({ requestHeaders: [{ name: 'Host', value: 'api.example.com' }], rewritePrefix: '/' });
  });
});

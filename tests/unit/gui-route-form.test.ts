/**
 * GUI 라우트 폼 (#126 3단계 후속, `gui/src/lib/forms/route-edit.ts`) — 시안 `fieldsFor('routes')` 와의 차이를 메운 것.
 *
 * 재는 것:
 *   · 호스트 · 경로 · 우선순위 칸 검사가 **서버와 같은 판정**이다 — 화면이 「괜찮아요」 하고 저장에서 거절되면(전에는
 *     빈 호스트가 「호스트가 비어 있다」 로 터졌다) 사람이 화면을 믿지 않는다. 문구는 해요체다.
 *   · 수정 폼: head 의 라우트를 폼 값으로 폈다가 다시 지으면 **같은 몸통**이 나오고, 해독기가 받는다.
 *     폼이 그리지 못하는 칸이 있으면 `lossy` 로 알린다(저장하면 사라지므로).
 *   · 풀 공유 경고(시안 「이 풀을 라우트 N개가 함께 써요.」).
 *   · 화면 배선 — 설정 탭이 라우트에 폼을 쓰고 JSON 은 접어 둔다 · 목록이 분할 상세다 · 메뉴 문구 · reject 배지 ✕.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  HOST_REQUIRED, httpRouteBody, httpRouteStateOf, passthroughBody, passthroughStateOf, poolShareCount, poolShareText,
  priorityError, routeHostsError, routePathsError,
} from '../../gui/src/lib/forms/route-edit.js';
import { compileHostRoutes } from '../../src/route/compile.js';
import { validatePathPrefix } from '../../src/validate/strings.js';
import { decodeModel } from '../../src/model/decode.js';

const LIB = join(dirname(fileURLToPath(import.meta.url)), '../../gui/src/lib');
const read = (p: string): string => readFileSync(join(LIB, p), 'utf8');

/** 서버가 이 호스트를 라우트 호스트로 받는가 — 라우트 컴파일러의 판정. */
const serverHostOk = (h: string): boolean =>
  compileHostRoutes([{ key: 'r', host: h, priority: 0 }]).errors.every((e) => e.kind !== 'invalid_host');

describe('호스트 칸', () => {
  it('비면 시안 문구 「호스트를 입력해요.」', () => {
    expect(routeHostsError('')).toBe(HOST_REQUIRED);
    expect(routeHostsError(' ,  ')).toBe('호스트를 입력해요.');
  });

  it('**서버 판정과 같다** — 받는 것 · 거절하는 것', () => {
    const cases = [
      'app.example.com', '*.example.com', 'APP.Example.com', 'localhost', '10.0.0.5', 'a-b.c',
      '*', '*.', 'a.*.com', 'mail.*', '**.x.com', 'a_b.com', 'a..b', '127.1', 'a/b.com',
    ];
    for (const h of cases) {
      const form = routeHostsError(h) === undefined;
      expect(form, h).toBe(serverHostOk(h));
    }
  });

  it('하나라도 틀리면 시안 문구로 말한다', () => {
    expect(routeHostsError('app.example.com, *')).toBe('호스트는 정확한 이름이나 *.example.com 형태만 써요. 모든 호스트는 리스너의 기본 동작으로 정해요.');
  });
});

describe('경로 접두사 칸', () => {
  it('비면 / 라 오류가 아니다', () => {
    expect(routePathsError('')).toBeUndefined();
  });

  it('/ 로 시작하지 않으면 · 같은 경로를 두 번 적으면 시안 문구', () => {
    expect(routePathsError('/api/, v2/')).toBe('v2/ · 경로는 /로 시작해요.');
    expect(routePathsError('/a /b, /a')).toBe('같은 경로를 두 번 적었어요: /a');
  });

  it('**서버 판정과 같다** — 서버에 없는 `//` 규칙은 두지 않는다', () => {
    for (const p of ['/', '/api/', '//x', '/a*b', "/a!$&'()+;=:@%20", '/a"b', '/a#b', '/a?b', '/한글', 'api']) {
      expect(routePathsError(p) === undefined, p).toBe(validatePathPrefix(p).ok);
    }
  });
});

describe('우선순위 칸', () => {
  it('해독기와 같은 범위 — 0–1000000 의 정수', () => {
    expect(priorityError('0')).toBeUndefined();
    expect(priorityError('1000000')).toBeUndefined();
    expect(priorityError('')).toBe('0 이상의 정수를 입력해요.');
    expect(priorityError('-1')).toBe('0 이상의 정수를 입력해요.');
    expect(priorityError('1.5')).toBe('0 이상의 정수를 입력해요.');
    expect(priorityError('1000001')).toBe('우선순위는 1000000까지예요.');
  });
});

const decodes = (httpRoutes: unknown[], passthroughRoutes: unknown[] = []): boolean => decodeModel({
  listeners: [], httpRoutes, passthroughRoutes, pools: [], backends: [], certificates: [], tlsPolicies: [], sniBindings: [], addressSets: [],
}).ok;

describe('수정 폼 — head ↔ 폼 값', () => {
  const HTTP: Record<string, unknown>[] = [
    {
      key: 'app', listener: 'web', hosts: ['app.example.com', '*.example.com'], priority: 7, pathPrefixes: ['/api/', '/v2/'],
      action: { kind: 'proxy', pool: 'api', websocket: true, requestHeaders: [{ name: 'Host', value: 'up.internal' }], rewritePrefix: '/v1/' },
      sourceRules: [
        { from: ['10.0.0.0/8', '@office'], action: { kind: 'reject', status: 403 } },
        { from: ['192.168.0.0/16'], address: 'connection', action: { kind: 'proxy', pool: 'other', websocket: false } },
        { from: ['172.16.0.0/12'], action: { kind: 'redirect', to: 'https://x.example/', status: 308 } },
      ],
    },
    { key: 'go', listener: 'web', hosts: ['go.example.com'], priority: 0, pathPrefix: '/old', action: { kind: 'redirect', to: 'https://new.example/', status: 301 } },
    { key: 'deny', listener: 'web', hosts: ['x.example.com'], priority: 3, action: { kind: 'reject', status: 444 } },
  ];

  for (const item of HTTP) {
    it(`HTTP ${String(item['key'])} — 폈다가 다시 지으면 같은 몸통 · 해독기가 받는다`, () => {
      const { state, lossy } = httpRouteStateOf(item);
      expect(lossy).toBe(false);
      const { key: _k, ...want } = item;
      const body = httpRouteBody(String(item['key']), state);
      expect(body).toEqual(want);
      expect(decodes([{ key: item['key'], ...body }])).toBe(true);
    });
  }

  it('우선순위 · 호스트를 고치면 몸통에 그대로 실린다', () => {
    const { state } = httpRouteStateOf(HTTP[1]!);
    const body = httpRouteBody('go', { ...state, priority: '42', hosts: 'a.example.com b.example.com' });
    expect(body['priority']).toBe(42);
    expect(body['hosts']).toEqual(['a.example.com', 'b.example.com']);
  });

  it('출발지 규칙 동작에 폼에 없는 칸이 있으면 lossy', () => {
    const item = { ...HTTP[2]!, sourceRules: [{ from: ['10.0.0.0/8'], action: { kind: 'proxy', pool: 'p', websocket: false, rewritePrefix: '/x' } }] };
    expect(httpRouteStateOf(item).lossy).toBe(true);
  });

  it('패스스루 — 풀로 보내기 · 끊기', () => {
    for (const item of [
      { key: 'db', listener: 'tls', snis: ['db.example.com', 'db2.example.com'], priority: 5, action: { kind: 'proxy', pool: 'pg' } },
      { key: 'no', listener: 'tls', snis: ['no.example.com'], priority: 0, action: { kind: 'reject' } },
    ]) {
      const { key, ...want } = item;
      const body = passthroughBody(key, passthroughStateOf(item));
      expect(body).toEqual(want);
      expect(decodes([], [{ key, ...body }])).toBe(true);
    }
  });
});

describe('풀 공유 경고', () => {
  const routes = [
    { key: 'a', action: { kind: 'proxy', pool: 'api' } },
    { key: 'b', action: { kind: 'proxy', pool: 'api' } },
    { key: 'c', action: { kind: 'reject', status: 403 } },
  ];
  it('자기를 뺀 수 · 문구는 자기를 더한 수', () => {
    expect(poolShareCount(routes, 'api', 'a')).toBe(1);
    expect(poolShareCount(routes, 'api')).toBe(2);
    expect(poolShareCount(routes, 'none')).toBe(0);
    expect(poolShareCount(routes, undefined)).toBe(0);
    expect(poolShareText(0)).toBeUndefined();
    expect(poolShareText(2)).toBe('이 풀을 라우트 3개가 함께 써요. 풀을 바꾸면 모두 바뀌어요.');
  });
});

describe('화면 배선', () => {
  it('설정 탭 — 라우트는 수정 폼 + 접은 JSON', () => {
    const src = read('detail/Settings.svelte');
    expect(src).toMatch(/kind === 'httpRoute' \|\| kind === 'passthroughRoute'/);
    expect(src).toContain('<HttpRouteForm edit />');
    expect(src).toContain('<PassthroughRouteForm edit />');
  });

  it('수정 폼은 putResource 로 저장하고 그 라우트로 돌아간다 · 우선순위 칸이 있다', () => {
    const http = read('forms/HttpRouteForm.svelte');
    expect(http).toContain("desk.putResource('httpRoute', editKey, body).then(after(resourcePath('httpRoute', editKey)))");
    expect(http).toContain('label="우선순위"');
    const pt = read('forms/PassthroughRouteForm.svelte');
    expect(pt).toContain("desk.putResource('passthroughRoute', editKey, body).then(after(resourcePath('passthroughRoute', editKey)))");
    expect(pt).toContain('label="우선순위"');
  });

  it('경로별 묶음은 빌더의 오류 문구를 보이지 않는다', () => {
    const src = read('forms/RouteGroupForm.svelte');
    expect(src).not.toMatch(/error: e instanceof Error \? e\.message/);
    expect(src).toContain('routePathsError(r.paths)');
    expect(src).toContain('routeHostsError(hosts)');
  });

  for (const [file, kind] of [['lists/HttpRouteList.svelte', 'httpRoute'], ['lists/PassthroughRouteList.svelte', 'passthroughRoute']] as const) {
    it(`${file} — 분할 상세 · 메뉴 문구 · reject 배지 ✕`, () => {
      const src = read(file);
      expect(src).toContain(`<ListSplit kind="${kind}"`);
      expect(src).toContain("'상세 페이지 열기'");
      expect(src).toContain("label: '수정'");
      expect(src).not.toMatch(/상세를 봐요|수정해요|다시 만들어요/);
      expect(src).not.toContain('⊘');
      expect(src).toContain('icon="✕"');
    });
  }

  it('HTTP 라우트 분할 상세에 「URL로 다시 만들기」 (풀로 보내는 라우트만)', () => {
    const src = read('lists/HttpRouteList.svelte');
    expect(src).toContain('actions={rebuild}');
    // 합산이면 주소를 그 행의 지역으로 좁힌다(at(r, …)) — 닫는 괄호가 하나 더 붙는다.
    expect(src).toMatch(/isProxy\(key\)\}<Button[^>]*rebuild'\)\)?\}>URL로 다시 만들기/);
  });
});

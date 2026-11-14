/**
 * **응답 이름과 오류 페이지 — 렌더 문자열** (DESIGN.md §4.10, 2026-11-08)
 *
 * 실제 응답은 `tests/golden/error-pages.test.ts` 가 잰다. 여기는 산출물의 모양이다: 몇 번 · 어디에 · 무엇이 없나.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { render, type RenderCapabilities } from '../../src/conf/render.js';
import { parseEngineCapabilities } from '../../src/engine/capabilities.js';
import { decodeModel } from '../../src/model/decode.js';
import type { Model } from '../../src/model/provisional.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const ok = (m: unknown): Model => {
  const d = decodeModel(m);
  if (!d.ok) throw new Error(JSON.stringify(d.issues));
  return d.model;
};

/** 호스트 없는 http · 호스트 https(합성 기본 server 둘 다) · 출발지 규칙 프록시. */
const model = ok({
  listeners: [
    { key: 'web', protocol: 'http', bind: '127.0.0.1', port: 18080, enabled: true, http: { defaultAction: 'reject' } },
    { key: 'sec', protocol: 'https', bind: '127.0.0.1', port: 18443, enabled: true, hosts: ['s.test'],
      tls: { policy: 'p', defaultCertificate: 'c' }, http: { defaultAction: 'reject' } },
  ],
  httpRoutes: [
    { key: 'app', listener: 'web', hosts: ['app.test'], priority: 0, pathPrefix: '/api/',
      action: { kind: 'proxy', pool: 'pub', websocket: false },
      sourceRules: [{ from: ['10.0.0.0/8'], action: { kind: 'proxy', pool: 'pub', websocket: false } }] },
  ],
  passthroughRoutes: [],
  pools: [{ key: 'pub', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [{ key: 'p1', pool: 'pub', host: '10.0.0.1', port: 80, weight: 1 }],
  certificates: [{ key: 'c', materialRef: `store://c@${'a'.repeat(32)}`,
    chainDigest: `sha256:${'0'.repeat(64)}`, keyDigest: `sha256:${'1'.repeat(64)}` }],
  tlsPolicies: [{ key: 'p', minVersion: '1.2' }],
  sniBindings: [{ key: 'b', listener: 'sec', hosts: ['s.test'], certificate: 'c' }],
});

const empty: Model = {
  listeners: [], httpRoutes: [], passthroughRoutes: [], pools: [], backends: [],
  certificates: [], tlsPolicies: [], sniBindings: [],
};

const caps: RenderCapabilities = { streamRealip: true, sslRejectHandshake: true };
const count = (s: string, re: RegExp): number => s.match(new RegExp(re.source, 'gm'))?.length ?? 0;
/** http 블록 바로 아래(들여쓰기 4칸)의 server 블록 수. */
const servers = (conf: string): number => count(conf, /^ {4}server \{$/);

describe('응답 이름 — `server_tokens` · `more_set_headers`', () => {
  it('`server_tokens off` 는 어느 엔진에서도 http 블록에 정확히 한 번이다 (빈 모델 포함)', () => {
    for (const m of [model, empty]) {
      for (const c of [caps, { ...caps, headersMore: true, serverVersion: '1.2.3' }]) {
        const conf = render(m, c).conf;
        expect(count(conf, /^ {4}server_tokens off;$/)).toBe(1);
        expect(count(conf, /server_tokens/)).toBe(1);
      }
    }
  });

  it('headers-more 가 있으면 `Server: barycenter/<버전>` 이 http 블록에 정확히 한 번이다', () => {
    const conf = render(model, { ...caps, headersMore: true, serverVersion: '1.2.3' }).conf;
    expect(count(conf, /^ {4}more_set_headers "Server: barycenter\/1\.2\.3";$/)).toBe(1);
    expect(count(conf, /more_set_headers "Server/)).toBe(1);
    // 나머지 하나는 노드 이름(served-by.ts) — 값이 비면 헤더가 안 나간다.
    expect(count(conf, /more_set_headers/)).toBe(2);
  });

  it('버전을 모르면 이름만 낸다 — 지어낸 버전을 내지 않는다', () => {
    const conf = render(model, { ...caps, headersMore: true }).conf;
    expect(conf).toContain('more_set_headers "Server: barycenter";');
  });

  it('**모듈이 없으면 `more_set_headers` 가 없다** — 있으면 nginx 가 모르는 지시어로 기동을 거절한다', () => {
    expect(render(model, caps).conf).not.toContain('more_set_headers');
    expect(render(model, { ...caps, headersMore: false, serverVersion: '1.2.3' }).conf).not.toContain('more_set_headers');
  });

  it('같은 입력이면 같은 digest — 버전은 입력이다', () => {
    const c = { ...caps, headersMore: true, serverVersion: '1.2.3' };
    expect(render(model, c).digest).toBe(render(model, c).digest);
    expect(render(model, c).digest).not.toBe(render(model, { ...c, serverVersion: '1.2.4' }).digest);
  });

  it('엔진 탐지 — OpenResty 는 headers-more 를 갖고, 공식 nginx 는 안 갖는다', () => {
    const v = (f: string): string => readFileSync(join(ROOT, 'tests/fixtures', f), 'utf8');
    expect(parseEngineCapabilities(v('nginx-V.openresty-alpine.txt')).supports.headersMore).toBe(true);
    expect(parseEngineCapabilities(v('nginx-V.nginx-alpine.txt')).supports.headersMore).toBe(false);
    // 동적 모듈은 `load_module` 없이 못 쓴다 — 치지 않는다.
    expect(parseEngineCapabilities('nginx version: nginx/1.27.0\nconfigure arguments: --add-dynamic-module=../headers-more-nginx-module-0.38')
      .supports.headersMore).toBe(false);
  });
});

describe('오류 페이지 — `error_page` · named location', () => {
  const conf = render(model, caps).conf;
  const EP = /^ {8}error_page 400 403 404 405 413 414 421 429 494 495 496 497 500 501 502 503 504 \$bary_err_loc;$/;

  it('server 마다 정확히 한 번 — 합성 기본 server(평문 444 · HTTPS 핸드셰이크 거절)까지', () => {
    const n = servers(conf);
    expect(n).toBeGreaterThanOrEqual(4);
    expect(count(conf, EP)).toBe(n);
    expect(count(conf, /^ {8}location @bary_err_html \{$/)).toBe(n);
    expect(count(conf, /^ {8}location @bary_err_json \{$/)).toBe(n);
  });

  it('자기 `error_page` 를 가진 location(출발지 규칙 570)은 한 벌을 다시 갖고, 재귀를 켠다', () => {
    const loc = conf.slice(conf.indexOf('location /api/ {'));
    const body = loc.slice(0, loc.indexOf('\n        }'));
    expect(body).toMatch(/error_page 570 = @bary_rule_/);
    expect(count(body, /error_page 400 403 .* \$bary_err_loc;/)).toBe(1);
    expect(count(body, /recursive_error_pages on;/)).toBe(1);
    // 규칙이 없으면 재선언도 재귀도 없다.
    expect(count(conf, /recursive_error_pages/)).toBe(1);
  });

  it('**업스트림 오류를 가로채지 않는다** — `proxy_intercept_errors` 가 어디에도 없다', () => {
    expect(conf).not.toContain('proxy_intercept_errors');
  });

  it('**named location 에 `add_header` 가 없다** — 하나라도 있으면 HSTS · 사용자 응답 헤더가 오류 페이지에서 사라진다', () => {
    for (const name of ['@bary_err_html', '@bary_err_json']) {
      for (const at of conf.split(`location ${name} {`).slice(1)) {
        const body = at.slice(0, at.indexOf('\n        }'));
        expect(body).not.toContain('add_header');
        expect(body).toMatch(/types \{\s*\}/);
        expect(body).toMatch(/return 200 /);
      }
    }
  });

  it('**값 하나가 4 KB 를 안 넘는다** — nginx 설정 파서의 토큰 버퍼', () => {
    for (const line of conf.split('\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThan(4000);
  });

  it('본문 템플릿이 쓰는 변수는 정해진 것뿐이다 — CSS 의 `$` 가 nginx 변수로 읽히지 않는다', () => {
    const maps = conf.split('\n').filter((l) => /^\s+(default|\d{3}) ".*"[;]$/.test(l) && l.includes('<'));
    expect(maps.length).toBeGreaterThan(0);
    const vars = new Set(maps.flatMap((l) => [...l.matchAll(/\$([A-Za-z_][A-Za-z0-9_]*)/g)].map((m) => m[1])));
    for (const v of vars) expect(['status', 'request_id', 'bary_err_title', 'bary_err_served', 'bary_served_by']).toContain(v);
  });

  it('외부 요청이 없다 — 글꼴 · 스크립트 · 이미지 · 링크', () => {
    const maps = conf.split('\n').filter((l) => l.includes('<'));
    const all = maps.join('\n');
    expect(all).not.toMatch(/<script|<link|<img|@import|url\(|https?:\/\//i);
  });
});

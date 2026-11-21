/**
 * 리스너 기본 동작의 업그레이드 헤더 (2026-11-21). 실물 판정은 tests/golden/default-action-upstream.test.ts 다.
 * 여기서는 렌더 모양만 본다 — 기본 풀로 보내는 리스너가 없으면 map 도 없다.
 */
import { describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

const caps = { streamRealip: false };

const base = (defaultAction: 'reject' | { pool: string }): Model => ({
  listeners: [{ key: 'web', protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true, http: { defaultAction } }],
  httpRoutes: [{ key: 'r', listener: 'web', hosts: ['a.test'], priority: 1, action: { kind: 'proxy', pool: 'app', websocket: false } }],
  passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [{ key: 'app-1', pool: 'app', host: '127.0.0.1', port: 9000, weight: 1 }],
  certificates: [], tlsPolicies: [], sniBindings: [],
});

describe('기본 동작 — 업그레이드를 넘긴다', () => {
  it('기본 풀로 보내면 HTTP/1.1 · Upgrade · Connection 을 낸다', () => {
    const conf = render(base({ pool: 'app' }), caps).conf;
    const loc = conf.slice(conf.indexOf('location / {'));
    const body = loc.slice(0, loc.indexOf('}'));
    expect(body).toContain('proxy_http_version 1.1;');
    expect(body).toContain('proxy_set_header Upgrade $http_upgrade;');
    expect(body).toContain('proxy_set_header Connection $bary_default_conn;');
  });

  it('업그레이드를 안 물으면 `Connection` 을 비운다 — 라우트의 map 처럼 `close` 를 넣지 않는다', () => {
    const conf = render(base({ pool: 'app' }), caps).conf;
    expect(conf).toMatch(/map \$http_upgrade \$bary_default_conn \{\n\s+default upgrade;\n\s+"" "";\n\s+\}/);
  });

  it('기본 동작이 거부면 map 이 없다 — 렌더가 그대로다', () => {
    expect(render(base('reject'), caps).conf).not.toContain('bary_default_conn');
  });
});

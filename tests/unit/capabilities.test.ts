/**
 * §7.6 엔진 계약 — capability 탐지
 *
 * 왜 필요한가: E0 이 실증했다. 기본 OpenResty 이미지에 `stream_realip_module` 이 없어
 * 설계가 필수로 적은 모듈 목록을 충족하지 못한다. 그런데 어떤 공개 이미지도 우리가 필요한
 * 두 모듈(`ngx_stream_lua`, `stream_realip`)을 **동시에** 갖고 있지 않다.
 *
 *   공식 nginx : stream_realip ✅ / ngx_stream_lua ❌
 *   OpenResty  : stream_realip ❌ / ngx_stream_lua ✅
 *
 * 따라서 "필수 모듈 목록"을 하드코딩하는 대신, 엔진이 무엇을 할 수 있는지 읽어서
 * 모델이 표현 가능한 것을 제한한다. 커스텀 이미지를 쓰든 안 쓰든 같은 코드가 동작한다.
 *
 * 픽스처는 실제 이미지에서 뜬 `nginx -V` 원문이다 (tests/fixtures/).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { parseEngineCapabilities } from '../../src/engine/capabilities.js';

const fixture = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../fixtures/${name}`, import.meta.url)), 'utf8');

const openresty = parseEngineCapabilities(fixture('nginx-V.openresty-alpine.txt'));
const stockNginx = parseEngineCapabilities(fixture('nginx-V.nginx-alpine.txt'));

describe('버전 파싱', () => {
  it('OpenResty 를 인식하고 core 버전을 뽑는다', () => {
    expect(openresty.flavor).toBe('openresty');
    expect(openresty.version.startsWith('1.')).toBe(true);
  });

  it('stock nginx 를 인식한다', () => {
    expect(stockNginx.flavor).toBe('nginx');
    expect(stockNginx.version.startsWith('1.')).toBe(true);
  });
});

describe('모듈 탐지 — 두 이미지 계열의 갈림', () => {
  it('OpenResty 는 stream lua 를 갖고 stream realip 을 갖지 않는다', () => {
    expect(openresty.supports.streamLua).toBe(true);
    expect(openresty.supports.streamRealip).toBe(false);
  });

  it('stock nginx 는 정반대다', () => {
    expect(stockNginx.supports.streamLua).toBe(false);
    expect(stockNginx.supports.streamRealip).toBe(true);
  });

  it('둘 다 ssl_preread 와 http/2 는 갖는다', () => {
    for (const caps of [openresty, stockNginx]) {
      expect(caps.supports.sniPassthrough).toBe(true);
      expect(caps.supports.http2).toBe(true);
    }
  });

  it('둘 다 stream 서브시스템을 갖는다', () => {
    expect(openresty.supports.stream).toBe(true);
    expect(stockNginx.supports.stream).toBe(true);
  });
});

describe('버전에 걸린 capability', () => {
  it('1.27.3+ 이면 upstream resolve 가 OSS 로 열려 있다 (대안 B 의 전제)', () => {
    expect(openresty.supports.dnsResolve).toBe(true);
    expect(stockNginx.supports.dnsResolve).toBe(true);
  });

  it('구버전은 resolve 와 http2 를 못 쓴다', () => {
    const old = parseEngineCapabilities('nginx version: nginx/1.24.0\nconfigure arguments: --with-stream');
    expect(old.supports.dnsResolve).toBe(false);
    expect(old.supports.http2).toBe(false);
  });
});

describe('멤버십 평면 판정', () => {
  it('stream lua 가 없으면 런타임 멤버십을 stream 에서 못 한다 — 대안 B 만 남는다', () => {
    expect(stockNginx.supports.runtimeMembership).toEqual({ http: false, stream: false });
  });

  it('OpenResty 는 양쪽 다 가능하다 (실증은 S1/S5)', () => {
    expect(openresty.supports.runtimeMembership).toEqual({ http: true, stream: true });
  });
});

describe('알 수 없는 입력', () => {
  it('파싱 불가면 전부 false 로 떨어진다 — 모르는 것을 할 수 있다고 하지 않는다', () => {
    const unknown = parseEngineCapabilities('그냥 쓰레기');
    expect(unknown.supports.stream).toBe(false);
    expect(unknown.supports.streamRealip).toBe(false);
    expect(unknown.version).toBe('');
  });
});

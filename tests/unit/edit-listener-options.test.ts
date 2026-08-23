/**
 * 리스너 옵션의 **저작 표면** — 제안 6·7·8 이 GUI·CLI 로 닿는다 (2026-08-23).
 *
 * 셋을 모델·검증·렌더까지만 열어 두고 끝냈었다. 넣을 수는 있었다 — raw JSON patch 로.
 * 그런데 §12.1 이 *"GUI 는 맨 뒤로 미루지 않는다 — 제품 명제가 GUI 이므로"* 라고 적어
 * 뒀고, **쓸 수 있는 것과 이 제품의 방식으로 쓸 수 있는 것은 다르다.**
 *
 * ── 왜 한 자리인가
 *
 * `web/edit.ts` 는 GUI 가 얹는 patch 를 만드는 유일한 자리이고, CLI 도 같은 모양을
 * 낸다. 옵션을 리스너 put 에 **선택 인자**로 붙이면 둘이 같은 계약을 쓴다 — 두 자리에
 * 각자 만들면 "GUI 로는 되는데 CLI 로는 안 되는" 것이 생긴다.
 *
 * ── 안 적으면 안 실린다
 *
 * 이게 이 파일이 제일 많이 재는 것이다. 빈 값을 `{}` 로라도 실으면 렌더 바이트가
 * 바뀌고, 그러면 설정을 안 건드린 배포가 다음 apply 에서 세대 전환을 한다.
 */
import { describe, expect, it } from 'vitest';

import { putHttpListenerPatch, putHttpsListenerPatch } from '../../src/web/edit.js';
import { decodeModel } from '../../src/model/decode.js';

const base = { bind: '0.0.0.0', port: 80, pool: 'app' };

/** patch 의 body 를 실제 해독기에 통과시킨다 — 모양만 맞고 안 받는 것을 막는다. */
const decodes = (body: unknown): boolean => decodeModel({
  listeners: [body],
  httpRoutes: [], passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [{ key: 'a', pool: 'app', host: '10.0.0.1', port: 80, weight: 1 }],
  certificates: [], tlsPolicies: [], sniBindings: [],
}).ok;

describe('리스너 옵션이 patch 에 실린다 (제안 6·7·8)', () => {
  it('**안 적으면 안 실린다** — 빈 객체도 안 만든다', () => {
    const [op] = putHttpListenerPatch('web', base);
    expect(op!.body.http).toEqual({ defaultAction: { pool: 'app' } });
    expect(JSON.stringify(op!.body)).not.toContain('limits');
    expect(JSON.stringify(op!.body)).not.toContain('headers');
    expect(JSON.stringify(op!.body)).not.toContain('rateLimit');
  });

  it('프록시 한계값이 실린다 (제안 #8)', () => {
    const [op] = putHttpListenerPatch('web', {
      ...base, limits: { readTimeoutMs: 120_000, clientMaxBodyBytes: 52_428_800 },
    });
    expect(op!.body.http.limits).toEqual({ readTimeoutMs: 120_000, clientMaxBodyBytes: 52_428_800 });
    expect(decodes({ key: 'web', ...op!.body })).toBe(true);
  });

  it('헤더 규칙이 실린다 (제안 #7)', () => {
    const [op] = putHttpListenerPatch('web', {
      ...base,
      headers: { request: [{ name: 'X-Tenant', value: 'acme' }], response: [{ name: 'X-Frame-Options', value: 'DENY' }] },
    });
    expect(op!.body.http.headers?.request).toEqual([{ name: 'X-Tenant', value: 'acme' }]);
    expect(decodes({ key: 'web', ...op!.body })).toBe(true);
  });

  it('레이트리밋이 실린다 (제안 #6)', () => {
    const [op] = putHttpListenerPatch('web', {
      ...base, rateLimit: { requestsPerSecond: 10, burst: 20, nodelay: true },
    });
    expect(op!.body.http.rateLimit).toEqual({ requestsPerSecond: 10, burst: 20, nodelay: true });
    expect(decodes({ key: 'web', ...op!.body })).toBe(true);
  });

  it('셋을 함께 적어도 서로 안 지운다', () => {
    const [op] = putHttpListenerPatch('web', {
      ...base,
      limits: { readTimeoutMs: 30_000 },
      headers: { request: [{ name: 'X-A', value: '1' }] },
      rateLimit: { requestsPerSecond: 5 },
    });
    expect(op!.body.http.defaultAction).toEqual({ pool: 'app' });
    expect(op!.body.http.limits).toBeDefined();
    expect(op!.body.http.headers).toBeDefined();
    expect(op!.body.http.rateLimit).toBeDefined();
    expect(decodes({ key: 'web', ...op!.body })).toBe(true);
  });

  it('**https 도 같다** — 한 자리를 넓혔으니 둘 다 열려야 한다', () => {
    const [op] = putHttpsListenerPatch('sec', {
      bind: '0.0.0.0', port: 443, pool: 'app', policy: 'modern', certificate: 'site',
      rateLimit: { requestsPerSecond: 10 },
    });
    expect(op!.body.http.rateLimit).toEqual({ requestsPerSecond: 10 });
  });

  describe('빈 값은 안 싣는다 — 폼이 빈 칸을 그대로 보낸다', () => {
    it('빈 헤더 목록은 안 싣는다', () => {
      const [op] = putHttpListenerPatch('web', { ...base, headers: { request: [], response: [] } });
      expect(JSON.stringify(op!.body)).not.toContain('headers');
    });

    it('아무 값도 없는 한계값은 안 싣는다', () => {
      const [op] = putHttpListenerPatch('web', { ...base, limits: {} });
      expect(JSON.stringify(op!.body)).not.toContain('limits');
    });

    it('아무 값도 없는 레이트리밋은 안 싣는다', () => {
      // 해독기가 빈 객체를 거부하므로, 여기서 안 거르면 폼이 저장 못 하는 patch 를 만든다.
      const [op] = putHttpListenerPatch('web', { ...base, rateLimit: {} });
      expect(JSON.stringify(op!.body)).not.toContain('rateLimit');
    });
  });

  describe('폼이 못 넘길 값을 여기서 막는다', () => {
    it('이름 없는 헤더 줄은 버린다 — 폼의 빈 행이다', () => {
      const [op] = putHttpListenerPatch('web', {
        ...base, headers: { request: [{ name: '', value: 'x' }, { name: 'X-A', value: '1' }] },
      });
      expect(op!.body.http.headers?.request).toEqual([{ name: 'X-A', value: '1' }]);
    });

    it('`burst` 만 있는 레이트리밋을 거부한다 — 해독기와 같은 규칙이다', () => {
      expect(() => putHttpListenerPatch('web', { ...base, rateLimit: { burst: 10 } }))
        .toThrow();
    });
  });
});

/**
 * CLI 가 리스너 옵션을 받는다 — 제안 6·7·8 (2026-08-23).
 *
 * `bary changeset patch <id> <파일.json>` 으로는 넣을 수 있었다. 그건 **API 를 얇게 감싼
 * 것**이고, 이 CLI 가 `listener create --pool` 같은 플래그를 가진 이유는 사람이 JSON 을
 * 손으로 쓰지 않게 하기 위해서다. 새 옵션만 raw JSON 으로 남겨 두면 그 계약이 반쪽이 된다.
 *
 * ── 파싱이 계약이다
 *
 * 플래그는 문자열로 온다. `--max-body 50m` 을 바이트로 바꾸는 것, `--header` 를 여러 번
 * 받는 것, `--rate 10r/s` 를 숫자로 읽는 것 — 여기서 틀리면 사용자가 적은 것과 저장되는
 * 것이 달라지고, 그 차이는 트래픽이 물리는 날에만 드러난다.
 */
import { describe, expect, it } from 'vitest';

import { listenerCreatePatch, parseListenerOptions } from '../../src/cli/listener.js';

const base = { name: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, pool: 'app' };

describe('CLI 리스너 옵션 파싱 (제안 6·7·8)', () => {
  describe('--max-body', () => {
    it('단위를 읽는다 — `50m` · `512k` · 바이트', () => {
      expect(parseListenerOptions({ maxBody: '50m' }).limits?.clientMaxBodyBytes).toBe(52_428_800);
      expect(parseListenerOptions({ maxBody: '512k' }).limits?.clientMaxBodyBytes).toBe(524_288);
      expect(parseListenerOptions({ maxBody: '1500' }).limits?.clientMaxBodyBytes).toBe(1500);
    });

    it('**`0` 은 무제한이다** — 안 적은 것과 다르다', () => {
      expect(parseListenerOptions({ maxBody: '0' }).limits?.clientMaxBodyBytes).toBe(0);
      expect(parseListenerOptions({}).limits).toBeUndefined();
    });

    it('모르는 단위를 거부한다 — 조용히 바이트로 읽지 않는다', () => {
      expect(() => parseListenerOptions({ maxBody: '50mb' })).toThrow();
      expect(() => parseListenerOptions({ maxBody: '50g' })).toThrow();
      expect(() => parseListenerOptions({ maxBody: 'x' })).toThrow();
    });
  });

  describe('--connect-timeout · --read-timeout · --send-timeout', () => {
    it('초와 밀리초를 읽는다', () => {
      expect(parseListenerOptions({ readTimeout: '120s' }).limits?.readTimeoutMs).toBe(120_000);
      expect(parseListenerOptions({ readTimeout: '1500ms' }).limits?.readTimeoutMs).toBe(1500);
    });

    it('단위가 없으면 거부한다 — 초인지 밀리초인지 모르는 채로 저장하지 않는다', () => {
      expect(() => parseListenerOptions({ readTimeout: '120' })).toThrow();
    });
  });

  describe('--header', () => {
    it('`요청:이름:값` 과 `응답:이름:값` 을 가른다', () => {
      const o = parseListenerOptions({ header: ['req:X-Tenant:acme', 'res:X-Frame-Options:DENY'] });
      expect(o.headers?.request).toEqual([{ name: 'X-Tenant', value: 'acme' }]);
      expect(o.headers?.response).toEqual([{ name: 'X-Frame-Options', value: 'DENY' }]);
    });

    it('값에 콜론이 있어도 된다 — 첫 두 개만 가른다', () => {
      const o = parseListenerOptions({ header: ['req:X-Url:https://a/b'] });
      expect(o.headers?.request).toEqual([{ name: 'X-Url', value: 'https://a/b' }]);
    });

    it('모르는 방향을 거부한다', () => {
      expect(() => parseListenerOptions({ header: ['both:X-A:1'] })).toThrow();
      expect(() => parseListenerOptions({ header: ['X-A:1'] })).toThrow();
    });
  });

  describe('--rate · --burst · --nodelay · --max-conn', () => {
    it('`10r/s` 를 읽는다', () => {
      expect(parseListenerOptions({ rate: '10r/s' }).rateLimit?.requestsPerSecond).toBe(10);
    });

    it('맨 숫자도 받는다 — `r/s` 는 nginx 표기이지 사용자의 것이 아니다', () => {
      expect(parseListenerOptions({ rate: '10' }).rateLimit?.requestsPerSecond).toBe(10);
    });

    it('burst 와 nodelay 와 max-conn', () => {
      const o = parseListenerOptions({ rate: '5', burst: '10', nodelay: true, maxConn: '100' });
      expect(o.rateLimit).toEqual({
        requestsPerSecond: 5, burst: 10, nodelay: true, maxConnections: 100,
      });
    });

    it('**`--burst` 만 주면 거부한다** — 무엇의 burst 인지 없다', () => {
      expect(() => parseListenerOptions({ burst: '10' })).toThrow();
      expect(() => parseListenerOptions({ nodelay: true })).toThrow();
    });
  });

  it('아무 플래그도 없으면 아무것도 안 만든다', () => {
    expect(parseListenerOptions({})).toEqual({});
  });

  it('**patch 까지 이어진다** — 파싱만 되고 안 실리면 소용없다', () => {
    const patch = listenerCreatePatch({
      ...base,
      options: parseListenerOptions({ rate: '10', maxBody: '50m', header: ['req:X-A:1'] }),
    });
    const body = (patch as { body: { http: Record<string, unknown> } }[])[0]!.body.http;
    expect(body.rateLimit).toEqual({ requestsPerSecond: 10 });
    expect(body.limits).toEqual({ clientMaxBodyBytes: 52_428_800 });
    expect(body.headers).toEqual({ request: [{ name: 'X-A', value: '1' }] });
  });

  it('https 도 같다', () => {
    const patch = listenerCreatePatch({
      ...base, protocol: 'https', port: 443, policy: 'modern', certificate: 'site',
      options: parseListenerOptions({ rate: '10' }),
    });
    const body = (patch as { body: { http: Record<string, unknown> } }[])[0]!.body.http;
    expect(body.rateLimit).toEqual({ requestsPerSecond: 10 });
  });

  it('tcp·udp 리스너에는 안 붙는다 — 모델이 그 자리를 안 준다', () => {
    const patch = listenerCreatePatch({
      ...base, protocol: 'tcp', options: parseListenerOptions({ rate: '10' }),
    });
    expect(JSON.stringify(patch)).not.toContain('rateLimit');
  });
});

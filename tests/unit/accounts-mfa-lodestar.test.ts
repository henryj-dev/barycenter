/**
 * IdP OTP 어댑터 — lodestar `POST /api/totp/verify` 계약(heliopause `src/otp.ts` 와 같은 뜻).
 *
 * 재는 것: 상태코드 여섯 뜻 · 200 인데 ok 아님 · http 거절 · 형식 거절(보내지 않음) · 응답 상한 · **던지지 않음**.
 */
import { describe, expect, it } from 'vitest';

import { lodestarOtp, MAX_OTP_RESPONSE_BYTES, verifyLodestarOtp } from '../../src/accounts/mfa/lodestar.js';
import { idpMfaKinds, idpMfaProvider } from '../../src/accounts/mfa/registry.js';

const BASE = 'https://idp.test';
const TOKEN = 'fake-service-token';

type Call = { url: string; init: RequestInit };
function fakeFetch(respond: () => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  }) as typeof fetch;
  return { fetch: f, calls };
}
const ask = (respond: () => Response | Promise<Response>, code = '123456', subject: string | null = 'sub-1') => {
  const f = fakeFetch(respond);
  return { calls: f.calls, result: verifyLodestarOtp({ baseUrl: BASE, serviceToken: TOKEN, fetch: f.fetch }, subject ?? undefined, code) };
};
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('lodestar IdP OTP 어댑터', () => {
  it('요청 모양 — POST {base}/api/totp/verify · Bearer 서비스 토큰 · {userId, code} · redirect: error', async () => {
    const { calls, result } = ask(() => json(200, { ok: true }), ' 123 456 ');
    expect(await result).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://idp.test/api/totp/verify');
    const init = calls[0]!.init;
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>)['authorization']).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(init.body))).toEqual({ userId: 'sub-1', code: '123456' });
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('상태코드 여섯 뜻 — 401{ok:false} 틀린 코드 · 401 본문 없음 서비스 토큰 · 403 · 404 · 429 · 그 밖 unavailable', async () => {
    const cases: [() => Response, string][] = [
      [() => json(401, { ok: false }), 'wrong-code'],
      [() => new Response(null, { status: 401 }), 'service-token'],
      [() => json(401, { message: 'Unauthorized' }), 'service-token'],
      [() => json(403, { ok: false }), 'account-inactive'],
      [() => json(404, { ok: false }), 'not-enrolled'],
      [() => json(429, { ok: false }), 'rate-limited'],
      [() => json(500, { ok: false }), 'unavailable'],
      [() => json(302, {}), 'unavailable'],
    ];
    for (const [respond, reason] of cases) {
      expect(await ask(respond).result).toMatchObject({ ok: false, reason });
    }
  });

  it('**200 인데 ok:true 가 아니면 실패**(프록시의 200 오류 페이지로 열리지 않게)', async () => {
    for (const body of ['<html>ok</html>', '{"ok":"true"}', '{}', 'null', '{"ok":1}']) {
      expect(await ask(() => new Response(body, { status: 200 })).result).toMatchObject({ ok: false, reason: 'unavailable' });
    }
  });

  it('**https 가 아니면 보내지 않는다**', async () => {
    const f = fakeFetch(() => json(200, { ok: true }));
    const r = await verifyLodestarOtp({ baseUrl: 'http://idp.test', serviceToken: TOKEN, fetch: f.fetch }, 'sub-1', '123456');
    expect(r).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(f.calls).toHaveLength(0);
  });

  it('**6–8자리 숫자가 아니면 보내지 않는다** — IdP 시도 제한을 아낀다', async () => {
    for (const code of ['', '12345', '123456789', 'abcdef', 'abcd-1234', '12a456']) {
      const { calls, result } = ask(() => json(200, { ok: true }), code);
      expect(await result).toMatchObject({ ok: false, reason: 'wrong-code' });
      expect(calls).toHaveLength(0);
    }
    expect(await ask(() => json(200, { ok: true }), '12345678').result).toEqual({ ok: true });
  });

  it('IdP 연결(subject)이 없으면 보내지 않고 not-enrolled', async () => {
    const { calls, result } = ask(() => json(200, { ok: true }), '123456', null);
    expect(await result).toMatchObject({ ok: false, reason: 'not-enrolled' });
    expect(calls).toHaveLength(0);
  });

  it(`**응답 상한 ${MAX_OTP_RESPONSE_BYTES} 바이트** — 선언이 넘어도, 선언 없이 흘려 넘겨도 unavailable`, async () => {
    const big = '{"ok":true,"pad":"' + 'x'.repeat(MAX_OTP_RESPONSE_BYTES) + '"}';
    expect(await ask(() => new Response(big, { status: 200 })).result).toMatchObject({ ok: false, reason: 'unavailable' });
    // Content-Length 없이 조각으로 — 세면서 읽어야 잡힌다
    const stream = (): Response => new Response(new ReadableStream<Uint8Array>({
      pull(c) { c.enqueue(new TextEncoder().encode('x'.repeat(16 * 1024))); },
    }), { status: 200 });
    expect(await ask(stream).result).toMatchObject({ ok: false, reason: 'unavailable' });
    const declared = (): Response => new Response('{"ok":true}', { status: 200, headers: { 'content-length': String(MAX_OTP_RESPONSE_BYTES + 1) } });
    expect(await ask(declared).result).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('**던지지 않는다** — 네트워크 실패 · 타임아웃 · 읽기 실패 · 이상한 fetch 모두 unavailable', async () => {
    const throwing = [
      () => { throw new TypeError('fetch failed'); },
      () => Promise.reject(new DOMException('The operation was aborted due to timeout', 'TimeoutError')),
      () => new Response(new ReadableStream<Uint8Array>({ pull(c) { c.error(new Error('socket hang up')); } }), { status: 200 }),
      () => null as unknown as Response,
    ];
    for (const t of throwing) {
      const r = await ask(t as () => Response).result;
      expect(r).toMatchObject({ ok: false, reason: 'unavailable' });
    }
  });

  it('실패 설명(detail)에 서비스 토큰이 없다', async () => {
    for (const respond of [() => new Response(null, { status: 401 }), () => { throw new Error('boom'); }, () => json(500, {})]) {
      const r = await ask(respond as () => Response).result;
      expect(JSON.stringify(r)).not.toContain(TOKEN);
    }
  });

  it('제공자 — method 는 idp_otp, 검증은 check.subject · code 를 쓴다', async () => {
    const f = fakeFetch(() => json(200, { ok: true }));
    const p = lodestarOtp({ baseUrl: BASE, serviceToken: TOKEN, fetch: f.fetch });
    expect(p.method).toBe('idp_otp');
    expect(await p.verify({ userId: 'local-id', subject: 'idp-sub', code: '654321', db: { query: async () => ({ rows: [], rowCount: 0 }) } })).toEqual({ ok: true });
    expect(JSON.parse(String(f.calls[0]!.init.body))).toEqual({ userId: 'idp-sub', code: '654321' });
  });

  it('등록부 — 이름으로 고르고, 모르는 이름 · 프로토타입 이름은 던진다', () => {
    expect(idpMfaKinds()).toContain('lodestar');
    expect(idpMfaProvider('lodestar', { baseUrl: BASE, serviceToken: TOKEN }).method).toBe('idp_otp');
    expect(() => idpMfaProvider('nope', { baseUrl: BASE, serviceToken: TOKEN })).toThrow(/모르는/);
    expect(() => idpMfaProvider('toString', { baseUrl: BASE, serviceToken: TOKEN })).toThrow(/모르는/);
  });
});

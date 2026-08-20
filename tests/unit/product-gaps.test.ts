/**
 * 제품으로 없던 다섯 — HTTP 본문 프로브 · 드레인 관측 · EAB · 인증서/정책 삭제 · Discovery.
 * 숫자를 짓지 않고, 광고한 Discovery 가 비면 정적 peer 를 안 남긴다.
 */
import { createHmac } from 'node:crypto';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { newEcKey } from '../../src/acme/der.js';
import {
  AcmeClient, b64url, b64urlDecode, retryAfterMs, type AcmeOptions,
} from '../../src/acme/client.js';
import { backoffSeconds } from '../../src/control/acme-store.js';
import { applyDiscoveredEndpoints } from '../../src/control/discovery.js';
import { drainStatusOf, parsePeerObservation } from '../../src/control/drain.js';
import { HTTP_PROBE_PATH, probeBackend, probeHttp, probeTcp } from '../../src/control/health.js';
import { slotsOf } from '../../src/control/membership.js';
import { certificateDeletePatch, tlsPolicyDeletePatch } from '../../src/cli/tls.js';
import { deletePatch } from '../../src/web/edit.js';
import type { Model } from '../../src/model/provisional.js';

const closers: Array<() => void> = [];
afterEach(() => {
  for (const c of closers.splice(0)) c();
});

function httpBody(body: string): Promise<number> {
  return new Promise((resolve) => {
    const s = createHttpServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end(body);
    });
    s.listen(0, '127.0.0.1', () => {
      closers.push(() => s.close());
      resolve((s.address() as AddressInfo).port);
    });
  });
}

function tcpOnly(): Promise<number> {
  return new Promise((resolve) => {
    const s = createNetServer((c) => { c.end(); });
    s.listen(0, '127.0.0.1', () => {
      closers.push(() => s.close());
      resolve((s.address() as AddressInfo).port);
    });
  });
}

const model = (backends: Model['backends']): Model => ({
  listeners: [{
    key: 'web', protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true,
    http: { defaultAction: { pool: 'p' } },
  }],
  httpRoutes: [], passthroughRoutes: [], certificates: [], tlsPolicies: [], sniBindings: [],
  pools: [{ key: 'p', protocolClass: 'http', algorithm: 'round_robin' }],
  backends,
});

describe('HTTP 본문 프로브', () => {
  it('HTTP 본문이 맞으면 살고 틀리거나 비면 죽는다', async () => {
    const ok = await httpBody('ok');
    const nope = await httpBody('nope');
    const empty = await httpBody('');
    const tcp = await tcpOnly();

    expect(await probeHttp('127.0.0.1', ok, 500, { path: HTTP_PROBE_PATH, expectBody: 'ok' }))
      .toBeUndefined();
    expect(await probeHttp('127.0.0.1', nope, 500, { path: HTTP_PROBE_PATH, expectBody: 'ok' }))
      .toMatch(/기대와 다르다/);
    expect(await probeHttp('127.0.0.1', empty, 500, { path: HTTP_PROBE_PATH, expectBody: 'ok' }))
      .toMatch(/비어/);

    expect(await probeTcp('127.0.0.1', nope, 500)).toBeUndefined();
    expect(await probeTcp('127.0.0.1', empty, 500)).toBeUndefined();
    expect(await probeTcp('127.0.0.1', tcp, 500)).toBeUndefined();

    expect(await probeBackend('http', '127.0.0.1', nope, 500, { path: '/', expectBody: 'ok' }))
      .toMatch(/기대와 다르다/);
    expect(await probeBackend('tcp', '127.0.0.1', nope, 500)).toBeUndefined();
    expect(await probeBackend('http', '127.0.0.1', tcp, 500)).not.toBeUndefined();
    expect(await probeBackend('tcp', '127.0.0.1', tcp, 500)).toBeUndefined();
  });
});

describe('드레인 관측', () => {
  it('관측이 있으면 숫자를 싣고 없으면 안 싣는다', () => {
    const seen = drainStatusOf({ backend: 'a', draining: true, inflight: 2, sessions: 1 });
    expect(seen).toEqual({
      backend: 'a', drain_condition: 'no_new_traffic', inflight: 2, active_sessions: 1,
    });
    const omitted = drainStatusOf({ backend: 'a', draining: true });
    expect(omitted).toEqual({ backend: 'a', drain_condition: 'no_new_traffic' });
    expect(omitted).not.toHaveProperty('inflight');
    expect(omitted).not.toHaveProperty('active_sessions');
    expect(JSON.stringify(omitted)).not.toMatch(/inflight":0/);
    expect(drainStatusOf({ backend: 'a', draining: true, inflight: 0, sessions: 0 }))
      .toEqual({
        backend: 'a', drain_condition: 'quiesced', inflight: 0, active_sessions: 0,
      });
    expect(parsePeerObservation({ inflight: 2, active_sessions: 1 }))
      .toEqual({ inflight: 2, sessions: 1 });
    expect(parsePeerObservation({})).toBeUndefined();
    expect(parsePeerObservation({ inflight: 0 })).toBeUndefined();
    expect(parsePeerObservation(undefined)).toBeUndefined();
  });
});

function fakeAcme(opts: {
  onPost?: (url: string, body: string) => Response;
  eab?: AcmeOptions['eab'];
  sleep?: (ms: number) => Promise<void>;
}): AcmeClient {
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    if (url.endsWith('/dir')) {
      return new Response(JSON.stringify({
        newNonce: 'http://ca.test/new-nonce',
        newAccount: 'http://ca.test/new-account',
        newOrder: 'http://ca.test/new-order',
      }), { headers: { 'content-type': 'application/json' } });
    }
    if (init?.method === 'HEAD') {
      return new Response(null, { headers: { 'replay-nonce': 'n1' } });
    }
    const body = typeof init?.body === 'string' ? init.body : '';
    return opts.onPost?.(url, body) ?? new Response('{}', {
      status: 201,
      headers: {
        location: 'http://ca.test/acct/1',
        'replay-nonce': 'n2',
        'content-type': 'application/json',
      },
    });
  };
  return new AcmeClient({
    directoryUrl: 'http://ca.test/dir',
    accountKey: newEcKey(),
    fetchImpl,
    ...(opts.eab === undefined ? {} : { eab: opts.eab }),
    ...(opts.sleep === undefined ? {} : { sleep: opts.sleep }),
  });
}

describe('ACME EAB · 레이트리밋', () => {
  it('EAB 는 kid/hmac 이 있을 때만 newAccount 에 붙는다', async () => {
    const hmacKey = b64url(Buffer.from('eab-hmac-secret-key-bytes!!!!'));
    const posts: string[] = [];
    const withEab = fakeAcme({
      eab: { kid: 'kid-1', hmacKey },
      onPost: (_url, body) => {
        posts.push(body);
        return new Response('{}', {
          status: 201,
          headers: {
            location: 'http://ca.test/acct/1',
            'replay-nonce': 'n2',
            'content-type': 'application/json',
          },
        });
      },
    });
    await withEab.register();
    const outer = JSON.parse(posts[0] ?? '{}') as { payload: string };
    const payload = JSON.parse(b64urlDecode(outer.payload).toString()) as {
      externalAccountBinding?: { protected: string; payload: string; signature: string };
    };
    expect(payload.externalAccountBinding).toBeDefined();
    const hdr = JSON.parse(b64urlDecode(payload.externalAccountBinding!.protected).toString()) as {
      alg: string; kid: string; url: string;
    };
    expect(hdr).toMatchObject({ alg: 'HS256', kid: 'kid-1', url: 'http://ca.test/new-account' });
    const mac = createHmac('sha256', b64urlDecode(hmacKey))
      .update(`${payload.externalAccountBinding!.protected}.${payload.externalAccountBinding!.payload}`)
      .digest();
    expect(payload.externalAccountBinding!.signature).toBe(b64url(mac));

    posts.length = 0;
    await fakeAcme({
      onPost: (_url, body) => {
        posts.push(body);
        return new Response('{}', {
          status: 201,
          headers: {
            location: 'http://ca.test/acct/2',
            'replay-nonce': 'n2',
            'content-type': 'application/json',
          },
        });
      },
    }).register();
    const plain = JSON.parse(b64urlDecode(
      (JSON.parse(posts[0] ?? '{}') as { payload: string }).payload,
    ).toString()) as { externalAccountBinding?: unknown };
    expect(plain.externalAccountBinding).toBeUndefined();
  });

  it('Retry-After 가 다음 시도 대기를 바꾼다', async () => {
    const slept: number[] = [];
    let posts = 0;
    const client = fakeAcme({
      sleep: async (ms) => { slept.push(ms); },
      onPost: () => {
        posts += 1;
        if (posts === 1) {
          return new Response(JSON.stringify({ type: 'urn:ietf:params:acme:error:rateLimited' }), {
            status: 429,
            headers: {
              'retry-after': '2',
              'replay-nonce': 'n2',
              'content-type': 'application/problem+json',
            },
          });
        }
        return new Response('{}', {
          status: 201,
          headers: {
            location: 'http://ca.test/acct/1',
            'replay-nonce': 'n3',
            'content-type': 'application/json',
          },
        });
      },
    });
    await client.register();
    expect(slept).toEqual([2000]);
    expect(retryAfterMs(new Headers({ 'retry-after': '3' }), 1000)).toBe(3000);
    expect(retryAfterMs(new Headers(), 1000)).toBe(1000);
    expect(backoffSeconds(1, 7)).toBe(7);
    expect(backoffSeconds(1)).toBe(60);
  });
});

describe('인증서·TLS 정책 삭제', () => {
  it('certificate·tlsPolicy delete 는 한 줄이고 빈 키는 패치가 없다', () => {
    expect(deletePatch('certificate', 'site')).toEqual([
      { op: 'delete', kind: 'certificate', key: 'site' },
    ]);
    expect(deletePatch('tlsPolicy', 'modern')).toEqual([
      { op: 'delete', kind: 'tlsPolicy', key: 'modern' },
    ]);
    expect(certificateDeletePatch('site')).toEqual([
      { op: 'delete', kind: 'certificate', key: 'site' },
    ]);
    expect(tlsPolicyDeletePatch('modern')).toEqual([
      { op: 'delete', kind: 'tlsPolicy', key: 'modern' },
    ]);
    expect(certificateDeletePatch('')).toBeUndefined();
    expect(tlsPolicyDeletePatch('')).toBeUndefined();
  });
});

describe('BackendDiscovery', () => {
  it('발견한 엔드포인트를 쓰고 빈 광고는 정적 peer 를 안 남긴다', () => {
    const staticModel = model([
      { key: 'static', pool: 'p', host: '10.0.0.1', port: 11, weight: 1 },
    ]);
    const replaced = applyDiscoveredEndpoints(staticModel, {
      advertised: true,
      endpoints: [{ pool: 'p', host: '10.9.9.9', port: 90 }],
    });
    expect(replaced.backends.map((b) => `${b.host}:${b.port}`)).toEqual(['10.9.9.9:90']);
    expect(applyDiscoveredEndpoints(staticModel, { advertised: true, endpoints: [] }).backends)
      .toEqual([]);
    expect(applyDiscoveredEndpoints(staticModel, { advertised: false }).backends)
      .toEqual(staticModel.backends);

    const caps = { streamRealip: false, httpLua: true, streamLua: true };
    const stale = slotsOf(staticModel, caps);
    expect(JSON.stringify(stale)).toContain('10.0.0.1:11');
    const discovered = slotsOf(staticModel, caps, {
      advertised: true,
      endpoints: [{ pool: 'p', host: '10.9.9.9', port: 90 }],
    });
    expect(JSON.stringify(discovered)).toContain('10.9.9.9:90');
    expect(JSON.stringify(discovered)).not.toContain('10.0.0.1:11');
    const empty = slotsOf(staticModel, caps, { advertised: true, endpoints: [] });
    expect(JSON.stringify(empty)).not.toContain('10.0.0.1:11');
  });
});

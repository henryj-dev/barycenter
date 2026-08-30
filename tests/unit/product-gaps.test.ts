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
import { currentHealth, HealthProber, HTTP_PROBE_PATH, probeBackend, probeHttp, probeTcp } from '../../src/control/health.js';
import { slotsOf } from '../../src/control/membership.js';
import { certificateDeletePatch, tlsPolicyDeletePatch } from '../../src/cli/tls.js';
import { deletePatch } from '../../src/web/edit.js';
import type { Model } from '../../src/model/provisional.js';
import type { Db, Queryable, Row } from '../../src/store/pg.js';
import * as surface from '../../src/index.js';

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

/** HealthProber.sweep 가 치는 SQL 만 받는다. 본체를 안 돌린다. */
function fakeHealthDb(): Db {
  const health = new Map<string, {
    state: string; seq: number; consecutive: number; last_ok: boolean;
  }>();
  let cursor = 1;
  const query: Queryable['query'] = async (text, values) => {
    const rows = (): { rows: Row[]; rowCount: number } => {
      if (text.includes('MAX(probe_start_seq)')) {
        let m = 0;
        for (const r of health.values()) m = Math.max(m, r.seq);
        return { rows: [{ m: String(m) }], rowCount: 1 };
      }
      if (text.includes('FROM backend_health') && text.includes('FOR UPDATE')) {
        const row = health.get(String(values?.[0]));
        if (row === undefined) return { rows: [], rowCount: 0 };
        return {
          rows: [{
            state: row.state, probe_start_seq: row.seq,
            consecutive: row.consecutive, last_ok: row.last_ok,
          }],
          rowCount: 1,
        };
      }
      if (text.includes('INSERT INTO backend_health')) {
        health.set(String(values?.[0]), {
          state: String(values?.[1]),
          seq: Number(values?.[2]),
          consecutive: Number(values?.[3]),
          last_ok: Boolean(values?.[4]),
        });
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('FROM health_cursor')) {
        return { rows: [{ n: String(cursor) }], rowCount: 1 };
      }
      if (text.includes('UPDATE health_cursor')) {
        cursor += 1;
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('INSERT INTO health_events')) {
        return { rows: [], rowCount: 1 };
      }
      // 풀별 주기가 마지막 관측 시각을 본다 (§4.3.1). **가짜도 그 질의를 알아야 한다** —
      // 모르면 `unexpected sql` 로 죽고, 그건 코드가 아니라 이 이중이 낡은 것이다.
      if (text.includes('SELECT backend_key, observed_at FROM backend_health')) {
        return {
          rows: [...health.keys()].map((backend_key) => ({
            backend_key, observed_at: new Date(0).toISOString(),
          })),
          rowCount: health.size,
        };
      }
      if (text.includes('SELECT backend_key, state FROM backend_health')) {
        return {
          rows: [...health.entries()].map(([backend_key, r]) => ({ backend_key, state: r.state })),
          rowCount: health.size,
        };
      }
      throw new Error(`unexpected sql: ${text}`);
    };
    return rows();
  };
  return { query, tx: async <T>(fn: (c: Queryable) => Promise<T>): Promise<T> => fn({ query }) } as unknown as Db;
}

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

    // 계획으로 찌른다 (§4.3.1). 옛 인자(`protocolClass`)가 정하던 것을 이제 계획이 든다.
    const HTTP = { mode: 'active', protocol: 'http', http: { path: '/' } } as const;
    const TCP = { mode: 'active', protocol: 'tcp_connect' } as const;
    expect(await probeBackend(
      { ...HTTP, http: { path: '/', expectBody: 'ok' } } as never, '127.0.0.1', nope, 500))
      .toMatch(/기대와 다르다/);
    expect(await probeBackend(TCP as never, '127.0.0.1', nope, 500)).toBeUndefined();
    expect(await probeBackend(HTTP as never, '127.0.0.1', tcp, 500)).not.toBeUndefined();
    expect(await probeBackend(TCP as never, '127.0.0.1', tcp, 500)).toBeUndefined();
  });

  it('스위퍼는 HTTP 풀에 HTTP 프로브를 쓴다 — TCP 만 열린 서버는 죽는다', async () => {
    const body = await httpBody('ok');
    const empty = await httpBody('');
    const tcp = await tcpOnly();
    const db = fakeHealthDb();
    const prober = new HealthProber(db, { failThreshold: 1, riseThreshold: 1, timeoutMs: 500 });
    await prober.sweep({
      listeners: [], httpRoutes: [], passthroughRoutes: [], certificates: [], tlsPolicies: [], sniBindings: [],
      pools: [
        { key: 'h', protocolClass: 'http', algorithm: 'round_robin' },
        { key: 't', protocolClass: 'tcp', algorithm: 'round_robin' },
      ],
      backends: [
        { key: 'ok', pool: 'h', host: '127.0.0.1', port: body, weight: 1 },
        { key: 'empty', pool: 'h', host: '127.0.0.1', port: empty, weight: 1 },
        { key: 'http-tcp', pool: 'h', host: '127.0.0.1', port: tcp, weight: 1 },
        { key: 'l4', pool: 't', host: '127.0.0.1', port: tcp, weight: 1 },
      ],
    });
    const h = await currentHealth(db);
    expect(h.get('ok')).toBe('healthy');
    /**
     * ⚠️ **판정 기준이 바뀌었다** (검수 2026-08-22 · B-07).
     *
     * 전에는 "본문이 비어 있지 않으면 산다" 였고 이 줄은 `unhealthy` 였다. 그 규칙이
     * 틀렸다 — **500·502·503 과 함께 온 에러 페이지가 전부 `healthy`** 였고, 죽은
     * 백엔드가 계속 트래픽을 받았다. 그리고 `200` 에 빈 본문을 주는 헬스 경로(204 포함)는
     * 정상인데 죽었다고 판정했다.
     *
     * 이제 상태 코드가 판정한다. 이 테스트의 **의도**(TCP 만 열린 서버는 죽는다)는
     * `http-tcp` 가 그대로 지킨다 — 바뀐 것은 빈 본문 하나이고, 그게 이 수정의 내용이다.
     * 5xx 쪽은 `tests/unit/audit-healthcheck-spec.test.ts` 가 못 박는다.
     */
    expect(h.get('empty')).toBe('healthy');
    expect(h.get('http-tcp')).toBe('unhealthy');
    expect(h.get('l4')).toBe('healthy');
  });
});

describe('표면', () => {
  it('Discovery 는 v0.1 표면에 없다', () => {
    expect(Object.keys(surface).join(' ')).not.toContain('Discovery');
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

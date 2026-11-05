/**
 * 백엔드 디스커버리 출처 — 어댑터 넷 · 레지스트리 (2026-11-05).
 *
 * 가짜 응답(fetch · DNS 주입)으로 잰다: 상태코드의 뜻 · 실패 사유 · 응답 상한 · http 거절 · 토큰 헤더 ·
 * IP 가 아닌 값의 거절 · 레지스트리(모르는 이름 · 반만 설정 거부 · 설정 없으면 DNS 만).
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { consulSource } from '../../src/control/discovery/consul.js';
import { dnsSrvSource, type DnsLookups } from '../../src/control/discovery/dns-srv.js';
import { fileSource } from '../../src/control/discovery/file.js';
import { kubernetesSource } from '../../src/control/discovery/kubernetes.js';
import {
  configuredKinds, discoveryConfigFromEnv, discoverySource,
} from '../../src/control/discovery/registry.js';
import { MAX_DISCOVERY_RESPONSE_BYTES } from '../../src/control/discovery/source.js';
import type { FetchLike } from '../../src/control/sources/fetch.js';

/** 시험의 가짜 토큰 — 실행 중에 만든다(비밀 탐지기가 모양으로 걸지 않게). */
const FAKE_TOKEN = ['fake', 'token', 'for', 'tests'].join('-');

type Seen = { url: string; headers: Record<string, string>; redirect: string | undefined };

function fakeFetch(respond: (url: string) => Response, seen: Seen[] = []): FetchLike {
  return async (url, init) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k] = v; });
    seen.push({ url, headers, redirect: init.redirect });
    return respond(url);
  };
}

const jsonRes = (v: unknown, status = 200): Response =>
  new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json' } });

const err = (code: string): Error => Object.assign(new Error(code), { code });

describe('dns-srv', () => {
  const lookups = (over: Partial<DnsLookups>): DnsLookups => ({
    resolveSrv: async () => [],
    resolve4: async () => [],
    resolve6: async () => [],
    ...over,
  });

  it('가장 낮은 priority 무리만 쓰고 target 을 IP 로 푼다', async () => {
    const s = dnsSrvSource({
      lookups: lookups({
        resolveSrv: async () => [
          { name: 'a.svc.', port: 8080, priority: 10, weight: 5 },
          { name: '10.0.0.9', port: 8081, priority: 10, weight: 1 },
          { name: 'backup.svc', port: 9000, priority: 20, weight: 1 },
        ],
        resolve4: async (n) => (n === 'a.svc' ? ['10.0.0.2', '10.0.0.1'] : []),
        resolve6: async () => Promise.reject(err('ENODATA')),
      }),
    });
    expect(await s.resolve('_http._tcp.api')).toEqual({
      ok: true,
      endpoints: [
        { host: '10.0.0.1', port: 8080 }, { host: '10.0.0.2', port: 8080 }, { host: '10.0.0.9', port: 8081 },
      ],
    });
  });

  it('NXDOMAIN 은 not-found, 서버 실패는 unavailable', async () => {
    const nx = dnsSrvSource({ lookups: lookups({ resolveSrv: async () => Promise.reject(err('ENOTFOUND')) }) });
    expect(await nx.resolve('_x._tcp.none')).toMatchObject({ ok: false, reason: 'not-found' });
    const fail = dnsSrvSource({ lookups: lookups({ resolveSrv: async () => Promise.reject(err('ESERVFAIL')) }) });
    expect(await fail.resolve('_x._tcp.a')).toMatchObject({ ok: false, reason: 'unavailable' });
  });

  it('target 이 「.」 이면 빈 목록이다(RFC 2782 — 서비스 없음)', async () => {
    const s = dnsSrvSource({ lookups: lookups({ resolveSrv: async () => [{ name: '.', port: 0, priority: 0, weight: 0 }] }) });
    expect(await s.resolve('_x._tcp.a')).toEqual({ ok: true, endpoints: [] });
  });

  it('A · AAAA 가 없는 target 이 하나라도 있으면 그 답 전체가 실패다 — 반쪽 목록을 안 낸다', async () => {
    const s = dnsSrvSource({
      lookups: lookups({
        resolveSrv: async () => [{ name: 'a', port: 1, priority: 0, weight: 0 }, { name: 'gone', port: 1, priority: 0, weight: 0 }],
        resolve4: async (n) => (n === 'a' ? ['10.0.0.1'] : Promise.reject(err('ENOTFOUND'))),
        resolve6: async () => Promise.reject(err('ENODATA')),
      }),
    });
    expect(await s.resolve('_x._tcp.a')).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('consul', () => {
  it('통과 인스턴스만 묻고 Service.Address · 없으면 Node.Address 를 쓴다. 토큰은 헤더로', async () => {
    const seen: Seen[] = [];
    const s = consulSource({
      baseUrl: 'https://consul.internal:8501/',
      token: () => `${FAKE_TOKEN}\n`,
      fetch: fakeFetch(() => jsonRes([
        { Node: { Address: '10.0.1.1' }, Service: { Address: '', Port: 7000 } },
        { Node: { Address: '10.0.1.2' }, Service: { Address: '10.0.2.2', Port: 7001 } },
      ]), seen),
    });
    expect(await s.resolve('api')).toEqual({
      ok: true, endpoints: [{ host: '10.0.1.1', port: 7000 }, { host: '10.0.2.2', port: 7001 }],
    });
    expect(seen[0]).toEqual({
      url: 'https://consul.internal:8501/v1/health/service/api?passing=true',
      headers: expect.objectContaining({ 'x-consul-token': FAKE_TOKEN }) as unknown as Record<string, string>,
      redirect: 'error',
    });
  });

  it('상태코드의 뜻 — 403 unauthorized · 404 not-found · 500 unavailable', async () => {
    for (const [status, reason] of [[403, 'unauthorized'], [401, 'unauthorized'], [404, 'not-found'], [500, 'unavailable']] as const) {
      const s = consulSource({ baseUrl: 'https://c', fetch: fakeFetch(() => new Response('x', { status })) });
      expect(await s.resolve('api')).toMatchObject({ ok: false, reason });
    }
  });

  it('http 주소에는 묻지 않는다', async () => {
    const seen: Seen[] = [];
    const s = consulSource({ baseUrl: 'http://127.0.0.1:8500', fetch: fakeFetch(() => jsonRes([]), seen) });
    expect(await s.resolve('api')).toMatchObject({ ok: false, reason: 'insecure' });
    expect(seen).toHaveLength(0);
  });

  it('응답 상한 — 선언이 넘어도, 실제로 넘어도 too-large', async () => {
    const declared = consulSource({
      baseUrl: 'https://c',
      fetch: fakeFetch(() => new Response('[]', { headers: { 'content-length': String(MAX_DISCOVERY_RESPONSE_BYTES + 1) } })),
    });
    expect(await declared.resolve('api')).toMatchObject({ ok: false, reason: 'too-large' });
    const big = consulSource({
      baseUrl: 'https://c',
      fetch: fakeFetch(() => new Response(new ReadableStream({
        start(c) {
          for (let i = 0; i < 5; i += 1) c.enqueue(new Uint8Array(MAX_DISCOVERY_RESPONSE_BYTES / 4));
          c.close();
        },
      }))),
    });
    expect(await big.resolve('api')).toMatchObject({ ok: false, reason: 'too-large' });
  });

  it('닿지 못하면 unavailable, IP 가 아닌 주소는 invalid, 배열이 아니면 invalid', async () => {
    const down = consulSource({ baseUrl: 'https://c', fetch: async () => { throw new Error('ECONNREFUSED'); } });
    expect(await down.resolve('api')).toMatchObject({ ok: false, reason: 'unavailable' });
    const named = consulSource({ baseUrl: 'https://c', fetch: fakeFetch(() => jsonRes([{ Node: { Address: 'node-a' }, Service: { Port: 1 } }])) });
    expect(await named.resolve('api')).toMatchObject({ ok: false, reason: 'invalid' });
    const obj = consulSource({ baseUrl: 'https://c', fetch: fakeFetch(() => jsonRes({})) });
    expect(await obj.resolve('api')).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('kubernetes', () => {
  const slice = (endpoints: unknown[], port = 8080, addressType = 'IPv4'): unknown =>
    ({ addressType, ports: [{ port, name: 'http' }], endpoints });

  it('준비된 주소만, 슬라이스의 포트로. Bearer 토큰 · 라벨 선택자', async () => {
    const seen: Seen[] = [];
    const s = kubernetesSource({
      baseUrl: 'https://kubernetes.default.svc',
      token: () => FAKE_TOKEN,
      fetch: fakeFetch(() => jsonRes({
        items: [
          slice([
            { addresses: ['10.1.0.1'], conditions: { ready: true } },
            { addresses: ['10.1.0.2'], conditions: { ready: false } },
            { addresses: ['10.1.0.3'] },
          ]),
          slice([{ addresses: ['fd00::1'] }], 8080, 'IPv6'),
        ],
      }), seen),
    });
    expect(await s.resolve('prod/api')).toEqual({
      ok: true,
      endpoints: [{ host: '10.1.0.1', port: 8080 }, { host: '10.1.0.3', port: 8080 }, { host: 'fd00::1', port: 8080 }],
    });
    expect(seen[0]!.url).toBe(
      'https://kubernetes.default.svc/apis/discovery.k8s.io/v1/namespaces/prod/endpointslices?labelSelector=kubernetes.io%2Fservice-name%3Dapi');
    expect(seen[0]!.headers['authorization']).toBe(`Bearer ${FAKE_TOKEN}`);
  });

  it('FQDN 슬라이스 · 401 · 토큰 파일 못 읽음', async () => {
    const fqdn = kubernetesSource({ baseUrl: 'https://k', token: () => FAKE_TOKEN, fetch: fakeFetch(() => jsonRes({ items: [slice([{ addresses: ['a.example'] }], 80, 'FQDN')] })) });
    expect(await fqdn.resolve('prod/api')).toMatchObject({ ok: false, reason: 'invalid' });
    const denied = kubernetesSource({ baseUrl: 'https://k', token: () => FAKE_TOKEN, fetch: fakeFetch(() => new Response('', { status: 401 })) });
    expect(await denied.resolve('prod/api')).toMatchObject({ ok: false, reason: 'unauthorized' });
    const noToken = kubernetesSource({ baseUrl: 'https://k', token: () => { throw new Error('ENOENT'); }, fetch: fakeFetch(() => jsonRes({ items: [] })) });
    expect(await noToken.resolve('prod/api')).toMatchObject({ ok: false, reason: 'unconfigured' });
  });
});

describe('file', () => {
  let dir = '';
  afterEach(() => { if (dir !== '') rmSync(dir, { recursive: true, force: true }); });

  it('배열과 {endpoints} 를 받고, 없으면 not-found, 이상하면 invalid', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bary-disc-'));
    writeFileSync(join(dir, 'a.json'), JSON.stringify([{ host: '10.0.0.2', port: 81 }, { host: '10.0.0.1', port: 80 }]));
    writeFileSync(join(dir, 'b.json'), JSON.stringify({ endpoints: [{ host: '10.0.0.3', port: 80 }] }));
    writeFileSync(join(dir, 'bad.json'), '{');
    const s = fileSource({ dir });
    expect(await s.resolve('a.json')).toEqual({ ok: true, endpoints: [{ host: '10.0.0.1', port: 80 }, { host: '10.0.0.2', port: 81 }] });
    expect(await s.resolve('b.json')).toEqual({ ok: true, endpoints: [{ host: '10.0.0.3', port: 80 }] });
    expect(await s.resolve('none.json')).toMatchObject({ ok: false, reason: 'not-found' });
    expect(await s.resolve('bad.json')).toMatchObject({ ok: false, reason: 'invalid' });
    expect(await s.resolve('../a.json')).toMatchObject({ ok: false, reason: 'invalid' });
  });
});

describe('레지스트리', () => {
  const none = (): boolean => false;
  const read = (): string => FAKE_TOKEN;

  it('설정이 없으면 DNS SRV 만 켜진다 — 지금 동작과 같다', () => {
    const c = discoveryConfigFromEnv({}, none, read);
    expect(configuredKinds(c)).toEqual(['dns-srv']);
    expect(c.intervalMs).toBe(30_000);
  });

  it('모르는 이름은 던진다', () => {
    expect(() => discoverySource('eureka', discoveryConfigFromEnv({}, none, read))).toThrow(/모르는 디스커버리 출처/);
  });

  it('반만 설정하면 기동을 거부한다', () => {
    expect(() => discoveryConfigFromEnv({ BARY_DISCOVERY_CONSUL_TOKEN_FILE: '/t' }, none, read)).toThrow(/CONSUL_URL/);
    expect(() => discoveryConfigFromEnv({ BARY_DISCOVERY_K8S_URL: 'https://k' }, none, read)).toThrow(/K8S_TOKEN_FILE/);
    expect(() => discoveryConfigFromEnv({ BARY_DISCOVERY_K8S_CA_FILE: '/ca' }, none, read)).toThrow(/K8S_URL/);
    expect(() => discoveryConfigFromEnv({ BARY_DISCOVERY_CONSUL_URL: 'http://127.0.0.1:8500' }, none, read)).toThrow(/https/);
    expect(() => discoveryConfigFromEnv({ BARY_DISCOVERY_FILE_DIR: '/nope' }, none, read)).toThrow(/없다/);
    expect(() => discoveryConfigFromEnv({ BARY_DISCOVERY_INTERVAL_MS: '10' }, none, read)).toThrow(/INTERVAL_MS/);
    expect(() => discoveryConfigFromEnv({ BARY_DISCOVERY_DNS_SERVERS: 'dns.example' }, none, read)).toThrow(/IP/);
  });

  it('토큰 파일을 못 읽으면 기동을 거부한다', () => {
    expect(() => discoveryConfigFromEnv(
      { BARY_DISCOVERY_CONSUL_URL: 'https://c', BARY_DISCOVERY_CONSUL_TOKEN_FILE: '/t' }, none,
      () => { throw new Error('EACCES'); },
    )).toThrow(/읽지 못했다/);
  });

  it('클러스터 안이면 API 주소 · 토큰 · CA 가 기본 경로다', () => {
    const c = discoveryConfigFromEnv(
      { KUBERNETES_SERVICE_HOST: '10.96.0.1', KUBERNETES_SERVICE_PORT: '443' },
      (p) => p.startsWith('/var/run/secrets/kubernetes.io/serviceaccount/'), read,
    );
    expect(c.kubernetes).toEqual({
      baseUrl: 'https://10.96.0.1:443',
      tokenFile: '/var/run/secrets/kubernetes.io/serviceaccount/token',
      caFile: '/var/run/secrets/kubernetes.io/serviceaccount/ca.crt',
    });
  });
});

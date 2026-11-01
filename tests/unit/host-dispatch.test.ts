/**
 * **한 프로세스, Host 로 전역/지역을 고른다** (docs/adr-host-dispatch.md).
 *
 * 재는 것: Host 이름 읽기 · env 의 짝 맞추기 · 전역 Host 는 전역으로, 나머지(지역 이름 · IP)는 지역으로 ·
 * 실패 제한은 두 화면이 함께 센다 · 전역이 지역의 자기 이름을 목록과 맞춰 본다.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { request, type IncomingMessage, type Server } from 'node:http';
import { createServer as createHttps, type Server as HttpsServer } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { TokenAuth, hashToken } from '../../src/api/auth.js';
import { createApi, requestHost } from '../../src/api/server.js';
import { hostDispatchFromEnv, main } from '../../src/bin/barycenterd.js';
import { RegionRelay } from '../../src/global/relay.js';
import type { ConfigStore } from '../../src/store/config-store.js';
import type { ControlPlane } from '../../src/control/plane.js';
import type { Db } from '../../src/store/pg.js';
import type { LeaderElection } from '../../src/control/leader.js';

const TOKEN = 'known-token';
let dir = '';
let pem: { cert: string; key: string };
let fake: HttpsServer;
let fakeUrl = '';
/** 가짜 지역이 자기 이름이라고 말하는 값. */
let fakeSays: string | undefined = 'alpha';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'bary-host-dispatch-'));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2', '-subj', '/CN=127.0.0.1',
    '-addext', 'subjectAltName=IP:127.0.0.1', '-keyout', join(dir, 'k.pem'), '-out', join(dir, 'c.pem')], { stdio: 'ignore' });
  pem = { cert: readFileSync(join(dir, 'c.pem'), 'utf8'), key: readFileSync(join(dir, 'k.pem'), 'utf8') };
  fake = createHttps({ cert: pem.cert, key: pem.key }, (req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ head: '7', build: null, ...(fakeSays === undefined ? {} : { region: fakeSays }) }));
  });
  await new Promise<void>((r) => fake.listen(0, '127.0.0.1', r));
  fakeUrl = `https://127.0.0.1:${(fake.address() as AddressInfo).port}`;
}, 60_000);

afterAll(() => {
  fake?.closeAllConnections?.();
  fake?.close();
  rmSync(dir, { recursive: true, force: true });
});

function fakeReq(host: string | undefined): IncomingMessage {
  return { headers: host === undefined ? {} : { host } } as unknown as IncomingMessage;
}

describe('requestHost', () => {
  it('소문자로, 포트와 끝 점을 뗀다', () => {
    expect(requestHost(fakeReq('Barycenter.TinyUniver.se:8443'))).toBe('barycenter.tinyuniver.se');
    expect(requestHost(fakeReq('barycenter.tinyuniver.se.'))).toBe('barycenter.tinyuniver.se');
    expect(requestHost(fakeReq('[fd00::1]:8443'))).toBe('[fd00::1]');
    expect(requestHost(fakeReq(undefined))).toBe('');
  });
});

describe('hostDispatchFromEnv', () => {
  it('아무것도 없으면 지금 그대로다', () => {
    expect(hostDispatchFromEnv({})).toEqual({});
  });

  it('BARY_REGION 을 이름 규칙으로 읽는다', () => {
    expect(hostDispatchFromEnv({ BARY_REGION: 'util-icn-vtr' })).toEqual({ region: 'util-icn-vtr' });
    expect(() => hostDispatchFromEnv({ BARY_REGION: 'Util ICN' })).toThrow(/BARY_REGION/);
  });

  it('호스트와 지역 목록은 짝으로만 받는다', () => {
    expect(() => hostDispatchFromEnv({ BARY_GLOBAL_HOST: 'barycenter.tinyuniver.se' })).toThrow(/BARY_GLOBAL_REGIONS/);
    expect(() => hostDispatchFromEnv({ BARY_GLOBAL_REGIONS: '/x.json' })).toThrow(/BARY_GLOBAL_HOST/);
    expect(() => hostDispatchFromEnv({ BARY_GLOBAL_HOST: 'barycenter.tinyuniver.se:9443', BARY_GLOBAL_REGIONS: '/x.json' }))
      .toThrow(/호스트 이름만/);
  });

  it('둘 다 있으면 지역 목록을 읽어 전역 화면을 만든다', () => {
    writeFileSync(join(dir, 'ca.pem'), pem.cert);
    writeFileSync(join(dir, 'a.token'), 'region-token\n');
    const file = join(dir, 'regions.json');
    writeFileSync(file, JSON.stringify([{ name: 'alpha', api: fakeUrl, gui: 'https://alpha.example', ca: join(dir, 'ca.pem'), token: join(dir, 'a.token') }]));
    const d = hostDispatchFromEnv({ BARY_GLOBAL_HOST: 'Barycenter.TinyUniver.se.', BARY_GLOBAL_REGIONS: file });
    expect(d.globalSurface?.host).toBe('barycenter.tinyuniver.se');
    expect(d.globalSurface?.relay.regions.map((r) => r.name)).toEqual(['alpha']);
    d.globalSurface?.relay.close();
  });
});

describe('별도 전역 서비스는 없다 (3 단계)', () => {
  it('**옛 BARY_MODE=global 이면 무엇을 바꿀지 말하고 멈춘다** — 지역으로 오해해 엉뚱한 곳에서 죽지 않는다', async () => {
    const before = process.env['BARY_MODE'];
    process.env['BARY_MODE'] = 'global';
    try {
      await expect(main()).rejects.toThrow(/BARY_MODE=global 는 없어졌다 — .*BARY_GLOBAL_HOST/);
    } finally {
      if (before === undefined) delete process.env['BARY_MODE']; else process.env['BARY_MODE'] = before;
    }
  });
});

describe('한 프로세스의 두 화면', () => {
  let server: Server;
  let port = 0;
  let relay: RegionRelay;

  beforeAll(async () => {
    relay = new RegionRelay([{ name: 'alpha', api: fakeUrl, gui: 'https://alpha.example', ca: pem.cert, token: 'region-token' }]);
    server = createApi({
      db: {} as Db,
      store: { head: async () => ({ revision: '1', etag: 'e1' }) } as unknown as ConfigStore,
      control: { readiness: async () => ({ ok: true }) } as unknown as ControlPlane,
      auth: new TokenAuth([{ name: 'reader', hash: hashToken(TOKEN), scopes: ['read'] }]),
      election: { state: { isLeader: true, token: '1', holder: 'test', since: '' } } as LeaderElection,
      region: 'util-icn-vtr',
      globalSurface: { host: 'barycenter.tinyuniver.se', relay },
      oidcRp: {
        issuer: 'https://idp.example', audience: 'bary', key: 'k'.repeat(32),
        authorizationEndpoint: 'https://idp.example/authorize', tokenEndpoint: 'https://idp.example/token',
        clientId: 'bary', redirectUri: 'https://util-icn-vtr.barycenter.tinyuniver.se:8443/login/callback',
      },
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    relay.close();
    server.closeAllConnections?.();
    await new Promise<void>((r) => server.close(() => r()));
  });

  /** fetch 는 Host 를 못 바꾼다 — http.request 로 보낸다. */
  function call(host: string, path: string, token?: string): Promise<{ status: number; body: Record<string, unknown> }> {
    return new Promise((resolve, reject) => {
      const req = request({
        host: '127.0.0.1', port, path, method: 'GET',
        headers: { host, ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) },
      }, (res) => {
        let text = '';
        res.setEncoding('utf8');
        res.on('data', (c: string) => { text += c; });
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: text === '' ? {} : JSON.parse(text) as Record<string, unknown> }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('전역 호스트로 오면 전역으로 답한다', async () => {
    const r = await call('barycenter.tinyuniver.se:8443', '/readyz');
    expect(r.body).toMatchObject({ mode: 'global', regions: 1 });
  });

  it('지역 이름이나 IP 로 오면 지역으로 답하고 자기 이름을 말한다', async () => {
    expect((await call('util-icn-vtr.barycenter.tinyuniver.se', '/readyz')).body).toEqual({ ok: true, region: 'util-icn-vtr' });
    expect((await call(`127.0.0.1:${port}`, '/readyz')).body).toEqual({ ok: true, region: 'util-icn-vtr' });
  });

  it('지역 목록은 전역 호스트에만 있다', async () => {
    expect((await call('barycenter.tinyuniver.se', '/api/v1/regions', TOKEN)).status).toBe(200);
    expect((await call('util-icn-vtr.barycenter.tinyuniver.se', '/api/v1/regions', TOKEN)).status).toBe(404);
  });

  it('전역이 지역의 자기 이름을 목록과 맞춰 본다', async () => {
    fakeSays = 'alpha';
    let r = await call('barycenter.tinyuniver.se', '/api/v1/regions', TOKEN);
    expect((r.body['regions'] as Record<string, unknown>[])[0]).toMatchObject({ name: 'alpha', reachable: true, status: { region: 'alpha' } });
    fakeSays = 'beta';
    r = await call('barycenter.tinyuniver.se', '/api/v1/regions', TOKEN);
    const row = (r.body['regions'] as Record<string, unknown>[])[0];
    expect(row).toMatchObject({ name: 'alpha', reachable: true });
    expect(row).not.toHaveProperty('status');
    expect(String(row?.['error'])).toMatch(/'beta'/);
    fakeSays = 'alpha';
  });

  it('**SSO 는 들어온 호스트로 돌아온다** — 로그인 쿠키가 호스트에 묶인다', async () => {
    const back = async (host: string): Promise<string | null> => {
      const r = await call(host, '/api/v1/oidc/authorization-request');
      expect(r.status).toBe(200);
      return new URL(String(r.body['url'])).searchParams.get('redirect_uri');
    };
    expect(await back('barycenter.tinyuniver.se')).toBe('https://barycenter.tinyuniver.se/login/callback');
    expect(await back('util-icn-vtr.barycenter.tinyuniver.se')).toBe('https://util-icn-vtr.barycenter.tinyuniver.se:8443/login/callback');
  });

  it('인증 실패는 두 화면이 함께 센다 — 화면을 바꿔 가며 두 배로 시도하지 못한다', async () => {
    const statuses: number[] = [];
    for (let i = 0; i < 4; i += 1) statuses.push((await call('util-icn-vtr.barycenter.tinyuniver.se', '/api/v1/config/head', 'wrong')).status);
    statuses.push((await call('barycenter.tinyuniver.se', '/api/v1/regions', 'wrong')).status);
    expect(statuses).toEqual([401, 401, 401, 401, 429]);
  });
});

/**
 * OIDC ID Token · S3 재시작 부트스트랩 · S4 fail-open · S5/S15 밸런서.
 * 표면(`src/index.ts`)에 새 이름을 안 올린다.
 */
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { can, hashToken, principalFromIdToken, TokenAuth } from '../../src/api/auth.js';
import { apiRouteTable } from '../../src/api/server.js';
import { render } from '../../src/conf/render.js';
import { eligibleCountForPlane, reduceMembership, shouldPushMembership } from '../../src/control/health.js';
import { httpAdminConf, slotsForEligible, streamAdminConf } from '../../src/control/membership.js';
import type { Model } from '../../src/model/provisional.js';
import * as surface from '../../src/index.js';

const SECRET = 'oidc-hs256-secret';
const ISS = 'https://idp.example';
const AUD = 'barycenter';

const b64url = (b: Buffer): string =>
  b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

function idToken(over: Record<string, unknown>, secret = SECRET): string {
  const header = b64url(Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const payload = b64url(Buffer.from(JSON.stringify({
    iss: ISS, aud: AUD, exp: 2_000_000_000, sub: 'alice', role: 'operator', ...over,
  })));
  const sig = b64url(createHmac('sha256', secret).update(`${header}.${payload}`).digest());
  return `${header}.${payload}.${sig}`;
}

const oidc = { issuer: ISS, audience: AUD, key: SECRET, now: () => 1_700_000_000 };

const model = (): Model => ({
  listeners: [
    { key: 'web', protocol: 'http', bind: '0.0.0.0', port: 8080, enabled: true,
      http: { defaultAction: { pool: 'h' } } },
    { key: 'raw', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true, defaultPool: 't' },
  ],
  httpRoutes: [], passthroughRoutes: [], certificates: [], tlsPolicies: [], sniBindings: [],
  pools: [
    { key: 'h', protocolClass: 'http', algorithm: 'round_robin' },
    { key: 't', protocolClass: 'tcp', algorithm: 'source_ip_hash' },
  ],
  backends: [
    { key: 'h1', pool: 'h', host: '10.0.0.1', port: 80, weight: 1 },
    { key: 'h2', pool: 'h', host: '10.0.0.2', port: 80, weight: 1 },
    { key: 't1', pool: 't', host: '10.0.0.3', port: 22, weight: 1 },
  ],
});

describe('OIDC', () => {
  it('서명·iss·aud·exp 가 맞으면 역할로 들어오고 틀리면 401 이다', () => {
    const ok = principalFromIdToken(idToken({ role: 'auditor' }), oidc);
    expect(ok?.name).toBe('alice');
    expect(ok?.role).toBe('auditor');
    expect(can(ok!, 'read')).toBe(true);
    expect(can(ok!, 'admin')).toBe(false);

    const restore = apiRouteTable().find((r) => r.method === 'POST' && r.path === '/api/v1/restore');
    expect(restore?.scope).toBe('admin');
    expect(can(ok!, restore!.scope)).toBe(false);

    expect(principalFromIdToken(idToken({ role: 'auditor' }, 'wrong-secret'), oidc)).toBeUndefined();
    expect(principalFromIdToken(idToken({ iss: 'https://other' }), oidc)).toBeUndefined();
    expect(principalFromIdToken(idToken({ aud: 'other-app' }), oidc)).toBeUndefined();
    expect(principalFromIdToken(idToken({ exp: 1_000 }), oidc)).toBeUndefined();
    expect(principalFromIdToken(idToken({ sub: '' }), oidc)).toBeUndefined();
    expect(principalFromIdToken(idToken({ role: 'nope' }), oidc)).toBeUndefined();

    const hashed = new TokenAuth([
      { name: 'ci', hash: hashToken('api-token'), scopes: ['read', 'write', 'apply'] },
    ], oidc);
    expect(hashed.authenticate('Bearer api-token')?.name).toBe('ci');
    const oidcAuth = hashed.authenticate(`Bearer ${idToken({ role: 'admin' })}`);
    expect(oidcAuth?.role).toBe('admin');
    expect(can(oidcAuth!, 'admin')).toBe(true);
    expect(hashed.authenticate('Bearer not-a-token')).toBeUndefined();
  });
});

describe('S3 · S4 멤버십', () => {
  it('durable unhealthy 는 재시작 부트스트랩으로 되살아나지 않는다', () => {
    const health = new Map<string, 'healthy' | 'unhealthy'>([
      ['h1', 'unhealthy'], ['h2', 'unhealthy'], ['t1', 'healthy'],
    ]);
    const eligible = reduceMembership(model(), health);
    expect(eligible.backends.map((b) => b.key)).toEqual(['t1']);
    expect(eligible.backends.map((b) => b.key)).not.toContain('h1');

    const allDead = reduceMembership(model(), new Map([
      ['h1', 'unhealthy'], ['h2', 'unhealthy'], ['t1', 'unhealthy'],
    ]));
    expect(allDead.backends).toEqual([]);
    expect(shouldPushMembership(allDead.backends.length, 0)).toBe(true);

    expect(shouldPushMembership(2, 0)).toBe(false);
    expect(shouldPushMembership(1, 1)).toBe(true);
  });

  it('멤버십 슬롯 set 에 TTL 이 없고 ACME 만 만료가 있다', () => {
    const http = httpAdminConf('g1', 'e1', '/tmp/bary-admin.sock');
    expect(http).toMatch(/d:set\("slot:" \.\. name \.\. ":" \.\. epoch, peers\)/);
    expect(http).not.toMatch(/d:set\("slot:".*peers,/);
    expect(http).toMatch(/d:set\("tok:" \.\. token, value, \d+\)/);
    const stream = streamAdminConf('e1', '/tmp/bary-stream-admin.sock');
    expect(stream).toMatch(/d:set\("slot:" \.\. name \.\. ":" \.\. epoch, peers\)/);
    expect(stream).not.toMatch(/d:set\("slot:".*peers,/);
  });
});

describe('S5 · S15', () => {
  it('한 평면이 비어도 다른 평면 슬롯을 안 지운다', () => {
    const ON = { streamRealip: false, httpLua: true, streamLua: true };
    const health = new Map<string, 'healthy' | 'unhealthy'>([
      ['h1', 'unhealthy'], ['h2', 'unhealthy'], ['t1', 'healthy'],
    ]);
    const eligible = reduceMembership(model(), health);
    const slots = slotsForEligible(model(), eligible, ON);
    expect(JSON.stringify(slots.http)).not.toContain('10.0.0.1');
    expect(JSON.stringify(slots.stream)).toContain('10.0.0.3:22');
    expect(shouldPushMembership(
      eligibleCountForPlane(eligible, 'http'), Object.keys(slots.http).length,
    )).toBe(true);
    expect(shouldPushMembership(
      eligibleCountForPlane(eligible, 'stream'), Object.keys(slots.stream).length,
    )).toBe(true);
  });

  it('Lua 는 round_robin · source_ip_hash · hash 이고 math.random 이 아니다', () => {
    const ON = { streamRealip: false, httpLua: true, streamLua: true };
    const conf = render(model(), ON).conf;
    expect(conf).toContain('d:incr("rr:pool_h", 1, 0)');
    expect(conf).toContain('ngx.crc32_short(key)');
    expect(conf).not.toContain('math.random');
    expect(conf).not.toContain('least_conn');
  });
});

describe('표면', () => {
  it('OIDC 이름을 v0.1 표면에 안 올린다', () => {
    const names = Object.keys(surface).join(' ');
    expect(names).not.toContain('Oidc');
    expect(names).not.toContain('IdToken');
    expect(names).not.toContain('principalFromIdToken');
  });
});

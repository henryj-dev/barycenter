/**
 * API 가 없어서 못 그리던 셋 — 주문 GET · dns-01 · 드레인 관측.
 * 숫자를 짓지 않고, 시크릿을 안 내보낸다.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { cleanupPlacedChallenges } from '../../src/control/acme-runner.js';
import { leaksSecret, publicChallenge, publicOrder } from '../../src/control/acme-view.js';
import { challengeTypeWanted, dns01TxtName, FileDns01 } from '../../src/control/dns01.js';
import { drainStatusOf } from '../../src/control/drain.js';
import { reduceMembership } from '../../src/control/health.js';
import { backendDrain } from '../../src/cli/backend.js';
import { getPath } from '../../src/cli/get.js';
import type { Http, HttpResult } from '../../src/cli/flow.js';
import type { AcmeOrderRow, ChallengeRow } from '../../src/control/acme-store.js';
import type { Model } from '../../src/model/provisional.js';

const order = (over: Partial<AcmeOrderRow> = {}): AcmeOrderRow => ({
  id: 'o1',
  accountKey: 'le',
  accountId: 'acc',
  certificateKey: 'site',
  certificateId: 'cid',
  domains: ['a.test'],
  state: 'validating',
  orderUrl: 'https://ca.test/order/1',
  finalizeUrl: undefined,
  certificateUrl: undefined,
  issuedRef: 'store://secret@1',
  certKeyRef: 'key://k',
  attempts: 1,
  lastError: undefined,
  ...over,
});

const challenge = (over: Partial<ChallengeRow> = {}): ChallengeRow => ({
  id: 'c1',
  orderId: 'o1',
  domain: 'a.test',
  type: 'http-01',
  token: 'tok-secret',
  value: 'keyauth-secret',
  authzUrl: 'https://ca.test/authz',
  challengeUrl: 'https://ca.test/chall',
  placedAt: '2026-08-19T00:00:00Z',
  cleanedAt: undefined,
  ...over,
});

describe('주문·챌린지 GET', () => {
  it('공개 본문은 원장 상태만 싣고 시크릿은 없다', () => {
    const body = publicOrder(order({ lastError: 'CA 거절' }));
    expect(body).toEqual({
      id: 'o1', certificate: 'site', domains: ['a.test'],
      state: 'validating', attempts: 1, lastError: 'CA 거절',
    });
    expect(leaksSecret(body)).toBe(false);
    expect(JSON.stringify(body)).not.toContain('BEGIN ');
    expect(JSON.stringify(body)).not.toContain('PRIVATE KEY');
    expect(JSON.stringify(body)).not.toContain('store://');
    const ch = publicChallenge(challenge());
    expect(ch).toEqual({
      id: 'c1', order: 'o1', domain: 'a.test', type: 'http-01',
      placed: true, cleaned: false,
    });
    expect(JSON.stringify(ch)).not.toContain('tok-secret');
    expect(JSON.stringify(ch)).not.toContain('keyauth-secret');
    expect(leaksSecret(ch)).toBe(false);
  });

  it('없는 이름은 getPath 가 안 만들고, 주문 GET 은 있는 경로다', () => {
    expect(getPath('acme/orders')).toBe('/api/v1/acme/orders');
    expect(getPath('acme/orders/o1')).toBe('/api/v1/acme/orders/o1');
    expect(getPath('acme/orders/o1/challenges')).toBe('/api/v1/acme/orders/o1/challenges');
    expect(getPath('acme/challenges/c1')).toBe('/api/v1/acme/challenges/c1');
    expect(getPath('acme/orders/')).toBeUndefined();
  });
});

describe('dns-01', () => {
  let dir = '';
  afterEach(() => {
    if (dir !== '') rmSync(dir, { recursive: true, force: true });
    dir = '';
  });

  it('와일드카드는 dns-01 만 고른다', () => {
    expect(challengeTypeWanted({ value: 'example.com', wildcard: true }, true)).toBe('dns-01');
    expect(challengeTypeWanted({ value: '*.example.com' }, true)).toBe('dns-01');
    expect(challengeTypeWanted({ value: 'a.test' }, true)).toBe('http-01');
  });

  it('place 뒤 cleanup 은 성공·실패 둘 다 파일을 지운다', async () => {
    dir = mkdtempSync(join(tmpdir(), 'bary-dns01-'));
    const dns = new FileDns01(dir);
    const name = dns01TxtName('*.example.com');
    await dns.place('*.example.com', 'tok', 'txt-value');
    expect(readFileSync(join(dir, name), 'utf8').trim()).toBe('txt-value');

    const cleaned: string[] = [];
    const row = challenge({
      type: 'dns-01', domain: '*.example.com', token: 'tok',
      placedAt: '2026-08-19T00:00:00Z', cleanedAt: undefined,
    });
    await cleanupPlacedChallenges(
      [row],
      async (r) => { await dns.remove(r.domain, r.token); },
      async (id) => { cleaned.push(id); },
    );
    expect(cleaned).toEqual(['c1']);
    await expect(async () => readFileSync(join(dir, name))).rejects.toThrow();

    await dns.place('*.example.com', 'tok', 'again');
    await cleanupPlacedChallenges(
      [row],
      async (r) => { await dns.remove(r.domain, r.token); },
      async (id) => { cleaned.push(id); },
    );
    await expect(async () => readFileSync(join(dir, name))).rejects.toThrow();
  });
});

describe('드레인', () => {
  const model: Model = {
    listeners: [], httpRoutes: [], passthroughRoutes: [], certificates: [],
    tlsPolicies: [], sniBindings: [],
    pools: [{ key: 'p', protocolClass: 'http', algorithm: 'round_robin' }],
    backends: [
      { key: 'a', pool: 'p', host: '10.0.0.1', port: 1, weight: 1 },
      { key: 'b', pool: 'p', host: '10.0.0.2', port: 2, weight: 1 },
    ],
  };

  it('드레인 중인 백엔드는 멤버십에서 빠진다', () => {
    const out = reduceMembership(model, new Map(), new Set(['a']));
    expect(out.backends.map((b) => b.key)).toEqual(['b']);
  });

  it('관측이 없으면 inflight/sessions 숫자를 안 싣는다', () => {
    const st = drainStatusOf({ backend: 'a', draining: true });
    expect(st).toEqual({ backend: 'a', drain_condition: 'no_new_traffic' });
    expect(st).not.toHaveProperty('inflight');
    expect(st).not.toHaveProperty('active_sessions');
    expect(JSON.stringify(st)).not.toMatch(/inflight":0/);
    expect(drainStatusOf({ backend: 'a', draining: false })).toBeUndefined();
  });

  it('drain 시작은 POST drain 이고 apply 를 안 한다', async () => {
    const calls: [string, string, unknown?][] = [];
    const replies: HttpResult[] = [
      { status: 200, body: { backend: 'a', drain_condition: 'no_new_traffic' } },
    ];
    const http: Http = async (method, path, body) => {
      calls.push(body === undefined ? [method, path] : [method, path, body]);
      const r = replies.shift();
      if (r === undefined) throw new Error('예상 밖 호출');
      return r;
    };
    expect(await backendDrain(http, 'a')).toEqual({
      backend: 'a', drain_condition: 'no_new_traffic',
    });
    expect(calls).toEqual([['POST', '/api/v1/backends/a/drain', {}]]);
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/apply')).toBe(false);
  });
});

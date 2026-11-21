/**
 * CLI 보강 (2026-11-21) — 화면에만 있던 기능을 `bary` 에도 둔다.
 *
 * 요청의 모양(메서드 · 경로 · 몸체)을 본다. 권한은 서버가 정한다 — CLI 는 실패를 **이유와 갈 곳**으로 바꿔 말할 뿐이다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  explainAuth, inviteCreate, roleOf, tokenCreate, userIdOf, userRecoveryLink, userRole, userStatus,
} from '../../src/cli/account.js';
import { CliRequestError, type Http, type HttpResult } from '../../src/cli/flow.js';
import { getPath } from '../../src/cli/get.js';
import {
  accountAudit, acmeAccountCreate, applyRetry, engineSet, pendingResources, resourceHistory, revisions,
} from '../../src/cli/ops.js';
import { acmeDirectoryOf, ACME_DIRECTORIES } from '../../src/web/acme-directories.js';

type Call = { method: string; path: string; body?: unknown };

const script = (replies: HttpResult[]): { http: Http; calls: Call[] } => {
  const calls: Call[] = [];
  let i = 0;
  const http: Http = async (method, path, body) => {
    calls.push({ method, path, ...(body === undefined ? {} : { body }) });
    const r = replies[i];
    i += 1;
    if (r === undefined) throw new Error(`예상 밖 호출 ${method} ${path}`);
    return r;
  };
  return { http, calls };
};

const ok = (body: unknown = {}): HttpResult => ({ status: 200, body });
const USERS = ok([{ id: 'u-1', username: 'alice' }, { id: 'u-2', username: 'bob' }]);

describe('운영 명령', () => {
  it('apply retry · revisions · pending · history 는 있는 창구를 부른다', async () => {
    const { http, calls } = script([ok({ phase: 'activated' }), ok([]), ok({}), ok([])]);
    await applyRetry(http);
    await revisions(http, '5');
    await pendingResources(http);
    await resourceHistory(http, 'http-route', 'web:api');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([
      'POST /api/v1/apply/retry',
      'GET /api/v1/config/revisions?limit=5',
      'GET /api/v1/config/pending-resources',
      'GET /api/v1/config/history?kind=httpRoute&key=web%3Aapi&limit=50',
    ]);
  });

  it('개수와 종류가 틀리면 부르지 않는다', async () => {
    const { http, calls } = script([]);
    await expect(revisions(http, '0')).rejects.toThrow(/1 이상의 정수/);
    await expect(resourceHistory(http, 'routes', 'x')).rejects.toThrow(/종류/);
    expect(calls).toEqual([]);
  });

  it('엔진 설정 — 주지 않은 칸은 head 값을 지키고, --clear 는 기본값으로 돌린다', async () => {
    const calls: Call[] = [];
    const replies: Record<string, unknown> = {
      'GET /api/v1/engine': { settings: { workerShutdownTimeoutS: 30, acmeDictKb: 128 } },
      'GET /api/v1/config/head': { revision: '6' },
      'POST /api/v1/changesets': { id: 'cs-1' },
      'PATCH /api/v1/changesets/cs-1': {},
      'POST /api/v1/changesets/cs-1/plan': { id: 'p-1', impact: {} },
      'GET /api/v1/plans/p-1': { changesetId: 'cs-1' },
      'POST /api/v1/changesets/cs-1/commit': { revision: '7' },
    };
    const http: Http = async (method, path, body) => {
      calls.push({ method, path, ...(body === undefined ? {} : { body }) });
      const r = replies[`${method} ${path}`];
      if (r === undefined) throw new Error(`예상 밖 호출 ${method} ${path}`);
      return ok(r);
    };
    const out = await engineSet(http, { membership: '2048', clear: ['acme'] });
    expect(out).toEqual({ revision: '7', planId: 'p-1' });
    const patch = calls.find((c) => c.method === 'PATCH')?.body as { patch: unknown[] };
    expect(patch.patch).toEqual([{ op: 'put', kind: 'engine', key: 'engine', body: { workerShutdownTimeoutS: 30, membershipDictKb: 2048 } }]);
  });

  it('엔진 설정 — 범위 밖이면 커밋하지 않는다 (GUI 와 같은 검사)', async () => {
    const { http, calls } = script([ok({ settings: {} })]);
    await expect(engineSet(http, { membership: '10', clear: [] })).rejects.toThrow(/membership/);
    expect(calls).toHaveLength(1);
  });

  it('ACME 계정 — CA 이름을 URL 로, 메일에 mailto: 를 붙인다', async () => {
    const { http, calls } = script([{ status: 201, body: { id: 'a-1' } }]);
    await acmeAccountCreate(http, { name: 'le:prod', ca: 'production', contact: ['ops@example.com'] });
    expect(calls[0]).toEqual({
      method: 'POST', path: '/api/v1/acme/accounts',
      body: { key: 'le:prod', directoryUrl: ACME_DIRECTORIES[0].value, contact: ['mailto:ops@example.com'] },
    });
    expect(acmeDirectoryOf('staging')).toContain('staging');
    expect(acmeDirectoryOf('https://ca.example/dir')).toBe('https://ca.example/dir');
    expect(() => acmeDirectoryOf('http://ca.example/dir')).toThrow(/CA 를 모른다/);
    await expect(acmeAccountCreate(http, { name: 'bad name', ca: 'staging', contact: [] })).rejects.toThrow(/규칙/);
  });

  it('get engine · get acme/accounts 가 열린다', () => {
    expect(getPath('engine')).toBe('/api/v1/engine');
    expect(getPath('acme/accounts')).toBe('/api/v1/acme/accounts');
  });

  it('계정 감사는 개수를 싣는다', async () => {
    const { http, calls } = script([ok([])]);
    await accountAudit(http, '10');
    expect(calls[0]?.path).toBe('/api/v1/account-audit?limit=10');
  });
});

describe('계정 명령', () => {
  it('사용자는 이름으로 말하고, API 에는 id 로 보낸다', async () => {
    const { http, calls } = script([USERS, ok(), USERS, ok(), USERS, ok({ token: 't' })]);
    await userRole(http, 'alice', 'operator');
    await userStatus(http, 'bob', 'suspended');
    await userRecoveryLink(http, 'u-1');
    expect(calls.filter((c) => c.path !== '/api/v1/users')).toEqual([
      { method: 'PATCH', path: '/api/v1/users/u-1', body: { role: 'operator' } },
      { method: 'PATCH', path: '/api/v1/users/u-2', body: { status: 'suspended' } },
      { method: 'POST', path: '/api/v1/users/u-1/recovery-link' },
    ]);
  });

  it('없는 사용자 · 모르는 역할은 쓰기 전에 멈춘다', async () => {
    const { http, calls } = script([USERS]);
    await expect(userIdOf(http, 'carol')).rejects.toThrow(/사용자가 없다/);
    expect(() => roleOf('root')).toThrow(/역할을 모른다/);
    expect(calls).toHaveLength(1);
  });

  it('토큰 만들기 · 초대의 몸체', async () => {
    const { http, calls } = script([{ status: 201, body: {} }, ok({}), ok({})]);
    await tokenCreate(http, { name: ' ci ', role: 'auditor', expiresInDays: 30 });
    await inviteCreate(http, 'operator', 'new@example.com');
    await inviteCreate(http, 'auditor');
    expect(calls.map((c) => c.body)).toEqual([
      { name: 'ci', role: 'auditor', expiresInDays: 30 },
      { role: 'operator', email: 'new@example.com' },
      { role: 'auditor' },
    ]);
    await expect(tokenCreate(http, { name: 'x', role: 'admin', expiresInDays: 400 })).rejects.toThrow(/1–365/);
  });

  it('권한 실패는 이유와 갈 곳을 말한다 — 권한을 넓히지 않는다', () => {
    const e = (status: number, code: string): CliRequestError => new CliRequestError('user role', status, { code, message: 'm' });
    expect(explainAuth(e(403, 'token_not_allowed'))).toMatch(/개인 API 토큰으로는 이 작업을 못 한다.*GUI/s);
    expect(explainAuth(e(403, 'mfa_step_up_required'))).toMatch(/인증 앱 확인이 오래됐다/);
    expect(explainAuth(e(403, 'forbidden'))).toMatch(/admin 범위/);
    expect(explainAuth(e(401, 'unauthorized'))).toMatch(/BARY_TOKEN/);
    expect(explainAuth(new Error('x'))).toBe('x');
  });
});

describe('bary 사용법', () => {
  const src = readFileSync(join(import.meta.dirname, '../../src/bin/bary.ts'), 'utf8');
  it.each([
    'bary apply retry', 'bary history <종류>', 'bary revisions', 'bary pending', 'bary engine set',
    'bary acme account create', 'bary me', 'bary token create', 'bary user role', 'bary invite list', 'bary account-audit',
  ])('%s 가 사용법에 있다', (line) => {
    expect(src).toContain(line);
  });
});

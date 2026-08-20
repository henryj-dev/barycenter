/**
 * 열린 제품 자리 — 드레인 관측 · RBAC · 백업 · API/DDL 동결 · Kit 경로.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { can, hashToken, scopesOfRole, TokenAuth } from '../../src/api/auth.js';
import { apiRouteTable } from '../../src/api/server.js';
import { ddlFromMigrations, MIGRATIONS_DIR, openApiOf } from '../../src/api/freeze.js';
import { backupNow, restoreNow, secretRefsIn } from '../../src/cli/backup.js';
import type { Http, HttpResult } from '../../src/cli/flow.js';
import {
  drainStatusOf, observationPeerOf, observePeerFromAdmin, parsePeerObservation,
} from '../../src/control/drain.js';
import { KIT_ROUTES, pageOf } from '../../src/web/page.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('드레인 관측', () => {
  it('엔진 본문을 parsePeerObservation 으로 접고 없으면 숫자를 안 싣는다', async () => {
    const seen = drainStatusOf({
      backend: 'a', draining: true,
      ...parsePeerObservation({ inflight: 2, active_sessions: 1 }),
    });
    expect(seen).toEqual({
      backend: 'a', drain_condition: 'no_new_traffic', inflight: 2, active_sessions: 1,
    });
    const omitted = drainStatusOf({
      backend: 'a', draining: true,
      ...parsePeerObservation({}),
    });
    expect(omitted).toEqual({ backend: 'a', drain_condition: 'no_new_traffic' });
    expect(JSON.stringify(omitted)).not.toMatch(/inflight":0/);

    const hits: string[] = [];
    const raw = await observePeerFromAdmin(async (url) => {
      hits.push(String(url));
      return new Response(JSON.stringify({ inflight: 2, active_sessions: 1 }), {
        status: 200, headers: { 'content-type': 'application/json' },
      });
    }, 19999, '10.0.0.1:80');
    expect(hits[0]).toContain('/membership/inflight?peer=10.0.0.1%3A80');
    expect(parsePeerObservation(raw)).toEqual({ inflight: 2, sessions: 1 });

    const miss = await observePeerFromAdmin(async () => new Response('{}', { status: 200 }), 1, 'x:1');
    expect(parsePeerObservation(miss)).toBeUndefined();
  });

  it('모델 호스트가 이름이면 관측 키는 푼 IP 다', async () => {
    const ipPeer = await observationPeerOf('localhost', 80);
    expect(ipPeer === '127.0.0.1:80' || ipPeer === '[::1]:80').toBe(true);
    const fetchImpl: typeof fetch = async (input) => {
      const url = String(input);
      if (url.includes('localhost')) return new Response('{}', { status: 200 });
      if (url.includes(encodeURIComponent(ipPeer))) {
        return new Response(JSON.stringify({ inflight: 3, active_sessions: 3 }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 200 });
    };
    expect(parsePeerObservation(await observePeerFromAdmin(fetchImpl, 19999, 'localhost:80')))
      .toBeUndefined();
    const raw = await observePeerFromAdmin(fetchImpl, 19999, ipPeer);
    expect(parsePeerObservation(raw)).toEqual({ inflight: 3, sessions: 3 });
    expect(drainStatusOf({
      backend: 'demo', draining: true, ...parsePeerObservation(raw),
    })).toMatchObject({ inflight: 3, active_sessions: 3 });
  });
});

describe('RBAC', () => {
  it('restore 는 admin 이고 auditor 는 그 핸들러를 못 지난다', () => {
    const restore = apiRouteTable().find((r) => r.method === 'POST' && r.path === '/api/v1/restore');
    expect(restore?.scope).toBe('admin');
    const auditor = new TokenAuth([{
      name: 'aud', hash: hashToken('aud-token'), role: 'auditor',
    }]).authenticate('Bearer aud-token');
    expect(auditor).toBeDefined();
    expect(can(auditor!, restore!.scope)).toBe(false);
    const admin = new TokenAuth([{
      name: 'adm', hash: hashToken('adm-token'), role: 'admin',
    }]).authenticate('Bearer adm-token');
    expect(can(admin!, 'admin')).toBe(true);
    expect(scopesOfRole('operator')).toEqual(['read', 'write']);
    expect(scopesOfRole('auditor')).not.toContain('admin');
  });
});

describe('백업·복구', () => {
  it('backup 뒤 restore 는 리비전을 되돌리고 apply 를 안 한다', async () => {
    const calls: [string, string][] = [];
    const http: Http = async (method, path) => {
      calls.push([method, path]);
      const replies: Record<string, HttpResult> = {
        'GET /api/v1/backup': {
          status: 200,
          body: { revision: '7', manifest: { certificates: [{ materialRef: 'store://c@1' }] } },
        },
        'POST /api/v1/restore': { status: 200, body: { revision: '8', unchanged: false } },
      };
      return replies[`${method} ${path}`] ?? { status: 500, body: {} };
    };
    const bundle = await backupNow(http);
    expect(bundle.revision).toBe('7');
    expect(secretRefsIn(bundle.manifest)).toEqual(['store://c@1']);
    expect(await restoreNow(http, bundle)).toEqual({ revision: '8' });
    expect(calls).toEqual([
      ['GET', '/api/v1/backup'],
      ['POST', '/api/v1/restore'],
    ]);
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/apply')).toBe(false);
  });
});

describe('OpenAPI · DDL 동결', () => {
  it('구현된 라우트·마이그레이션과 정본이 같다', () => {
    const table = apiRouteTable();
    expect(table.some((r) => r.path === '/api/v1/backup')).toBe(true);
    expect(table.some((r) => r.path === '/api/v1/restore' && r.scope === 'admin')).toBe(true);
    const generated = `${JSON.stringify(openApiOf(table), null, 2)}\n`;
    expect(generated).toBe(readFileSync(join(root, 'SURFACE-API.json'), 'utf8'));
    expect(ddlFromMigrations(MIGRATIONS_DIR)).toBe(readFileSync(join(root, 'SURFACE-DDL.sql'), 'utf8'));
    const drifted = openApiOf(table.slice(0, -1));
    expect(JSON.stringify(drifted)).not.toBe(JSON.stringify(openApiOf(table)));
  });
});

describe('Kit 경로', () => {
  it('GUI 는 adapter-static Kit 이고 SPA 폴백이 아니다', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'gui/package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies['@sveltejs/kit']).toBeDefined();
    expect(pkg.devDependencies['@sveltejs/adapter-static']).toBeDefined();
    const svelteCfg = readFileSync(join(root, 'gui/svelte.config.js'), 'utf8');
    expect(svelteCfg).toContain('@sveltejs/adapter-static');
    expect(svelteCfg).toMatch(/fallback:\s*undefined/);
    const viteCfg = readFileSync(join(root, 'gui/vite.config.ts'), 'utf8');
    expect(viteCfg).toContain('@sveltejs/kit/vite');
    expect(viteCfg).toContain('sveltekit()');
    expect(viteCfg).not.toMatch(/plugins:\s*\[svelte\(\)\]/);
  });

  it('Kit 자리가 라우트고 pageOf 가 같은 이름을 읽는다', () => {
    expect(KIT_ROUTES.some((r) => r.place === 'login' && r.path === '/login')).toBe(true);
    expect(KIT_ROUTES).toHaveLength(9);
    const routesDir = join(root, 'gui/src/routes');
    for (const r of KIT_ROUTES) {
      expect(pageOf(r.path)).toBe(r.place);
      const file = r.path === '/'
        ? join(routesDir, '+page.svelte')
        : join(routesDir, r.path.slice(1), '+page.svelte');
      expect(readdirSync(dirname(file))).toContain('+page.svelte');
      expect(readFileSync(file, 'utf8')).not.toMatch(/setInterval|setTimeout\(\s*\(\)\s*=>\s*fetch/);
    }
    expect(readFileSync(join(root, 'gui/src/routes/+layout.svelte'), 'utf8'))
      .not.toMatch(/setInterval|setTimeout\(\s*\(\)\s*=>\s*fetch/);
  });
});

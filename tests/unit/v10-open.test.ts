/**
 * 열린 제품 자리 — 드레인 관측 · RBAC · 백업 · API/DDL 동결 · Kit 경로.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
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
import { GUI_DYNAMIC, GUI_SHELL, KIT_ROUTES, pageOf } from '../../src/web/page.js';
import { RESOURCES, resourcePath, type DetailExtra, type TabSlug } from '../../src/web/resources.js';

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
    }, '10.0.0.1:80');
    expect(hits[0]).toContain('/membership/inflight?peer=10.0.0.1%3A80');
    expect(parsePeerObservation(raw)).toEqual({ inflight: 2, sessions: 1 });

    const miss = await observePeerFromAdmin(async () => new Response('{}', { status: 200 }), 'x:1');
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
    expect(parsePeerObservation(await observePeerFromAdmin(fetchImpl, 'localhost:80')))
      .toBeUndefined();
    const raw = await observePeerFromAdmin(fetchImpl, ipPeer);
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
    // 계정 DB 는 따로 고정한다 (공통 회원정책 1차).
    expect(ddlFromMigrations(join(root, 'src/store/account-migrations'))).toBe(readFileSync(join(root, 'SURFACE-DDL-ACCOUNTS.sql'), 'utf8'));
    const drifted = openApiOf(table.slice(0, -1));
    expect(JSON.stringify(drifted)).not.toBe(JSON.stringify(openApiOf(table)));
  });
});

describe('Kit 경로', () => {
  it('GUI 는 adapter-static Kit 이고, 폴백은 key 자리를 위한 셸 하나다', () => {
    const pkg = JSON.parse(readFileSync(join(root, 'gui/package.json'), 'utf8')) as {
      devDependencies: Record<string, string>;
    };
    expect(pkg.devDependencies['@sveltejs/kit']).toBeDefined();
    expect(pkg.devDependencies['@sveltejs/adapter-static']).toBeDefined();
    // Kit 3 은 svelte.config.js 를 읽지 않는다 — 설정은 vite.config.ts 의 sveltekit({...}) 인자다.
    expect(existsSync(join(root, 'gui/svelte.config.js'))).toBe(false);
    const viteCfg = readFileSync(join(root, 'gui/vite.config.ts'), 'utf8');
    expect(viteCfg).toContain('@sveltejs/kit/vite');
    expect(viteCfg).toContain('@sveltejs/adapter-static');
    expect(viteCfg).toMatch(/sveltekit\(\{/);
    // 셸은 서버가 GUI_DYNAMIC 패턴에만 낸다 — 아무 경로나 받지 않는다(plan-view 테스트).
    expect(viteCfg).toMatch(new RegExp(`fallback:\\s*'${GUI_SHELL}'`));
    expect(viteCfg).not.toMatch(/plugins:\s*\[svelte\(\)\]/);
  });

  it('Kit 자리가 라우트고 pageOf 가 같은 이름을 읽는다', () => {
    expect(KIT_ROUTES.some((r) => r.place === 'login' && r.path === '/login')).toBe(true);
    // 경로 분리(#124): 대시보드·적용 대기 2 · 목록 9(라우트는 세그먼트 둘) · 만들기 9 · 리스너 만들기 둘째
    // 단계 5 · 빠른 프록시 1 · 운영 4 · 사람 1 · 계정 화면 6. 표가 정본이다 — 여기선
    // 중복이 없고, 파일이 다 있는지를 본다(아래 반복).
    expect(new Set(KIT_ROUTES.map((r) => r.path)).size).toBe(KIT_ROUTES.length);
    expect(KIT_ROUTES).toHaveLength(38); // + 디자인 시스템 견본(/design)
    const routesDir = join(root, 'gui/src/routes');
    for (const r of KIT_ROUTES) {
      expect(pageOf(r.path)).toBe(r.place);
      const file = r.path === '/'
        ? join(routesDir, '+page.svelte')
        : join(routesDir, r.path.slice(1), '+page.svelte');
      expect(readdirSync(dirname(file))).toContain('+page.svelte');
      expect(readFileSync(file, 'utf8')).not.toMatch(/setInterval|setTimeout\(\s*\(\)\s*=>\s*fetch/);
    }
    // key 자리도 라우트 파일이 있고, 미리 만들지 않는다(셸이 연다). 탭마다 파일이 리소스 표와 같다.
    for (const d of GUI_DYNAMIC) {
      if (d.kind === undefined) {
        // 리소스가 아닌 동적 자리(클러스터 노드) — 라우트 파일이 있고 미리 만들지 않는다.
        const dir = join(routesDir, d.route.slice(1));
        expect(readFileSync(join(dir, '+page.ts'), 'utf8')).toMatch(/prerender\s*=\s*false/);
        expect(pageOf(d.route.replace(/\[\w+\]/, 'web-01'))).toBe(d.place);
        continue;
      }
      const spec = RESOURCES[d.kind];
      const dir = join(routesDir, d.route.slice(1));
      expect(readFileSync(join(dir, '+layout.ts'), 'utf8')).toMatch(/prerender\s*=\s*false/);
      expect(readFileSync(join(dir, '+layout.svelte'), 'utf8')).toContain(`kind="${d.kind}"`);
      const tails: (TabSlug | DetailExtra)[] = [...spec.tabs.map((t) => t.slug), ...spec.extras];
      for (const tail of tails) {
        expect(existsSync(join(dir, tail, '+page.svelte')), `${d.route}/${tail}`).toBe(true);
        const path = resourcePath(d.kind, 'edge-443', tail);
        expect(d.pattern.test(path), path).toBe(true);
        expect(pageOf(path)).toBe(d.place);
      }
      // 표에 없는 탭 디렉터리가 있으면 서버가 셸을 안 내 준다 — 화면이 404 가 된다.
      const onDisk = readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name).sort();
      expect(onDisk).toEqual(tails.filter((t) => t !== '').sort());
      // `new` 는 key 가 아니다 — 만들기 화면이 미리 만들어져 있다.
      expect(d.pattern.test(`${spec.base}/new`)).toBe(false);
      if (spec.creatable) expect(existsSync(join(routesDir, spec.base.slice(1), 'new', '+page.svelte'))).toBe(true);
    }
    expect(readFileSync(join(root, 'gui/src/routes/+layout.svelte'), 'utf8'))
      .not.toMatch(/setInterval|setTimeout\(\s*\(\)\s*=>\s*fetch/);
  });
});

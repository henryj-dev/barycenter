/**
 * 검수 2026-08-22 · S-10 — **응답이 스니핑과 프레임을 막는다**
 *
 * 응답에 `X-Content-Type-Options` 도 `frame-ancestors` 도 하나도 없었다. GUI 는 인증
 * 없이 서빙되므로(토큰은 페이지가 fetch 에 붙인다) **clickjacking 이 열려 있었다** —
 * 남의 페이지가 이 화면을 투명하게 겹쳐 두면 운영자가 자기도 모르게 apply 를 누른다.
 *
 * 그리고 `serveGui` 의 이탈 검사는 `relative()` 기반이라 `..` 은 막지만 **루트 안의
 * 심볼릭 링크는 안 본다.** 링크 하나면 GUI 루트 밖의 파일이 인증 없이 나간다.
 *
 * 실제 HTTP 표면으로 잰다 — `serveGui` 를 직접 부르면 서버가 그것을 정말 그 경로에서
 * 부르는지는 안 재게 된다.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createApi } from '../../src/api/server.js';
import { ConfigStore } from '../../src/store/config-store.js';
import { ControlPlane } from '../../src/control/plane.js';
import { TokenAuth } from '../../src/api/auth.js';
import { LeaderElection } from '../../src/control/leader.js';
import type { DataplaneDriver } from '../../src/dp/driver.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('audit-headers');
const TOKEN = 'audit-headers-token';

let db: Db;
let server: import('node:http').Server;
let base = '';
let sandbox: string;
let guiRoot: string;

const driver: DataplaneDriver = new Proxy({} as DataplaneDriver, {
  get: (_t, prop) => () => {
    throw new Error(`이 테스트는 데이터 플레인을 안 태운다 (호출됨: ${String(prop)})`);
  },
});

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');

  sandbox = mkdtempSync(join(tmpdir(), 'bary-gui-'));
  guiRoot = join(sandbox, 'build');
  mkdirSync(guiRoot, { recursive: true });
  writeFileSync(join(guiRoot, 'index.html'), '<h1>bary</h1>');
  // 루트 **밖**의 비밀. 링크로 끌어낼 수 있으면 안 된다.
  writeFileSync(join(sandbox, 'secret.txt'), 'PRIVATE KEY');
  symlinkSync(join(sandbox, 'secret.txt'), join(guiRoot, 'leak.html'));

  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  const store = new ConfigStore(db, { streamRealip: false });
  const election = new LeaderElection(PG.dsn, 'audit-headers-test');
  if (!(await election.tryAcquire())) throw new Error('리더 획득 실패');
  const control = new ControlPlane(db, store, driver, election,
    { prefix: '/tmp/bary-audit-headers', adminSocket: '/tmp/bary-admin-test.sock' });
  const auth = new TokenAuth([{
    name: 'tester',
    hash: `sha256:${createHash('sha256').update(TOKEN).digest('hex')}`,
    scopes: ['read'],
  }]);

  server = createApi({ db, store, control, auth, election, guiRoot });
  await new Promise<void>((r) => { server.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  await reset(db);
}, 180_000);

afterAll(async () => {
  await new Promise<void>((r) => { server?.close(() => { r(); }); });
  await db?.close();
  stopPg(PG);
  rmSync(sandbox, { recursive: true, force: true });
});

describe('응답 보안 헤더 (검수 S-10)', () => {
  it('정적 응답이 스니핑과 프레임을 막는다', async () => {
    const r = await fetch(`${base}/`);
    expect(r.status).toBe(200);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
    // clickjacking — GUI 는 인증 없이 나가므로 이게 유일한 방어다.
    expect(r.headers.get('content-security-policy') ?? '').toContain("frame-ancestors 'none'");
  });

  it('JSON 응답도 스니핑을 막는다', async () => {
    const r = await fetch(`${base}/api/v1/config/head`, {
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('x-content-type-options')).toBe('nosniff');
  });

  it('GUI 루트 밖을 가리키는 심볼릭 링크는 안 나간다', async () => {
    const r = await fetch(`${base}/leak.html`);
    expect(await r.text()).not.toContain('PRIVATE KEY');
    // `serveGui` 가 거절하면 요청은 인증 검사로 흘러간다 — 토큰이 없으니 401 이다.
    // **200 이 아니라는 것**이 요점이고, 그게 이 자리의 계약이다.
    expect(r.status).not.toBe(200);
    expect(r.status).toBe(401);
  });

  it('멀쩡한 GUI 파일은 그대로 나간다', async () => {
    // 이탈을 막다가 정상 서빙까지 막으면 화면이 안 열린다.
    const r = await fetch(`${base}/index.html`);
    expect(r.status).toBe(200);
    expect(await r.text()).toContain('bary');
  });
});

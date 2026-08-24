/**
 * ACME 계정을 만드는 **제품 경로**가 있다 — 검수 2026-08-24 D21 · High
 *
 * ── 없던 것
 *
 * `acme_accounts` 에 넣는 코드는 `AcmeStore.upsertAccount` 하나였고 **호출자가
 * 테스트뿐이었다.** 계정이 없으면 `AcmeRunner.scan` 이 `acme.no_account` 를 경고로
 * 찍고 건너뛰므로, 새 배포에서 운영자가 인증서에 `acme` 의도를 적어도 **주문이 영영
 * 안 열린다.** 로그 한 줄 말고는 아무 신호가 없다.
 *
 * **ACME 기능 전체가 제품 표면에서 도달 불가였다.** 도달성 게이트를 클래스 메서드까지
 * 넓힌 회차에 켜자마자 짚었다.
 *
 * ── 결정은 DESIGN §8.2.1 에 있다
 *
 * REST 다. CLI 만 두면 §2 의 제품 명제(GUI)가 그 자리에서 깨지고, 환경변수는 계정을
 * 리비전·감사·롤백 밖으로 내보낸다. B 표면이 움직이는 것은 **대가이지 반대 근거가
 * 아니다** — 그 게이트는 표면이 느는 것을 보이게 하려고 있다.
 *
 * ── 이 파일이 재는 것
 *
 * **창구가 생겼는가**가 아니라 **그것으로 만든 계정이 실제로 주문을 열게 하는가**다.
 * 앞엣것만 재면 「필드는 있는데 아무도 안 읽는다」를 새로 만들 뿐이다 — 이 결함 자체가
 * 그 부류였다.
 *
 *   npm run test:store     (도커 필요)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TokenAuth, hashToken } from '../../src/api/auth.js';
import { createApi } from '../../src/api/server.js';
import { AcmeStore } from '../../src/control/acme-store.js';
import { AcmeRunner, type ChallengePlacer } from '../../src/control/acme-runner.js';
import { FsSecretStore } from '../../src/dp/secrets.js';
import type { ControlPlane } from '../../src/control/plane.js';
import type { LeaderElection } from '../../src/control/leader.js';
import { ConfigStore } from '../../src/store/config-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('acme-account-path');
const TOKEN = 'acct-token';

let db: Db;
let store: AcmeStore;
let secrets: FsSecretStore;
let root = '';
let server: Server | undefined;
let base = '';

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new AcmeStore(db);
  root = mkdtempSync(join(tmpdir(), 'bary-acctpath-'));
  secrets = new FsSecretStore(root);

  server = createApi({
    db: db as unknown as never,
    // **실물 `ConfigStore` 다.** 창구가 감사에 남기므로 그 자리가 가짜면 재현물이
    // 「감사에 남는가」를 못 잰다 — 이 회차에 가짜가 실물보다 좁아서 물린 것이 셋이다.
    store: new ConfigStore(db as unknown as never),
    control: {} as ControlPlane,
    auth: new TokenAuth([
      { name: 'w', hash: hashToken(TOKEN), scopes: ['read', 'write'] },
    ]),
    election: { state: { isLeader: true } } as unknown as LeaderElection,
    secrets,
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  server?.closeAllConnections?.();
  await new Promise<void>((r) => (server === undefined ? r() : server.close(() => r())));
  await db?.close();
  stopPg(PG);
  if (root !== '') {
    try { execFileSync('chmod', ['-R', 'u+w', root]); } catch { /* 이미 없으면 그만 */ }
    rmSync(root, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  await reset(db);
  await db.query('TRUNCATE acme_challenges, acme_orders, acme_accounts CASCADE');
});

type Res = { status: number; body: Record<string, unknown> };

async function api(method: string, path: string, body?: unknown): Promise<Res> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const parsed: unknown = await r.json().catch(() => ({}));
  return { status: r.status, body: (parsed ?? {}) as Record<string, unknown> };
}

/** 놓은 것을 기억하는 배치기. */
class Placer implements ChallengePlacer {
  readonly type = 'http-01' as const;
  async place(): Promise<void> { /* 이 테스트는 놓는 것을 안 본다 */ }
  async remove(): Promise<void> { /* 같다 */ }
}

/** 인증서 하나. `acme` 의도만 있고 자료는 없다 — 첫 발급 전 상태다. */
async function certWithAcmeIntent(accountKey: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO certificates (id,key,name,acme_account,acme_domains,created_by,updated_by,revision)
     VALUES (gen_random_uuid(),'web','web',$1,$2,'t','t',1) RETURNING id`,
    [accountKey, ['a.test']],
  );
  return String(r.rows[0]?.['id']);
}

describe('계정을 만드는 제품 경로', () => {
  it('제품 경로로 계정을 만들 수 있다', async () => {
    const r = await api('POST', '/api/v1/acme/accounts', {
      key: 'le', directoryUrl: 'https://ca.test/dir', contact: ['mailto:ops@a.test'],
    });
    expect(r.status, JSON.stringify(r.body)).toBe(201);
    expect(r.body['key']).toBe('le');

    // 원장에 실제로 들어갔다.
    const row = await store.accountByKey('le');
    expect(row?.directoryUrl).toBe('https://ca.test/dir');
  });

  /**
   * **이것이 이 항목의 요점이다.** 창구가 생긴 것만으로는 아무것도 안 고친 것이다 —
   * 그것으로 만든 계정이 **러너를 움직여야** 한다.
   */
  it('그 계정으로 러너가 주문을 연다 — `acme.no_account` 로 안 건너뛴다', async () => {
    await api('POST', '/api/v1/acme/accounts', {
      key: 'le', directoryUrl: 'https://ca.test/dir',
    });
    const certId = await certWithAcmeIntent('le');

    const runner = new AcmeRunner({
      store, secrets, placer: new Placer(),
      clientFor: () => ({}) as never,
    });
    const opened = await runner.scan([
      { key: 'web', id: certId, acme: { account: 'le', domains: ['a.test'] } },
    ]);
    expect(opened, '계정이 있는데도 주문이 안 열렸다').toHaveLength(1);
  });

  /** **계정이 없으면 여전히 안 연다.** 고친 것은 만들 길이지 판정이 아니다. */
  it('계정이 없으면 그대로 건너뛴다 — 판정은 안 바꿨다', async () => {
    const certId = await certWithAcmeIntent('없는계정');
    const runner = new AcmeRunner({
      store, secrets, placer: new Placer(), clientFor: () => ({}) as never,
    });
    expect(await runner.scan([
      { key: 'web', id: certId, acme: { account: '없는계정', domains: ['a.test'] } },
    ])).toHaveLength(0);
  });

  it('만든 계정을 목록으로 확인할 수 있다 — 만들 수만 있으면 절반이다', async () => {
    await api('POST', '/api/v1/acme/accounts', { key: 'le', directoryUrl: 'https://ca.test/dir' });
    const r = await api('GET', '/api/v1/acme/accounts');
    expect(r.status).toBe(200);
    const rows = r.body['accounts'] as { key: string }[];
    expect(rows.map((x) => x.key)).toEqual(['le']);
  });

  /**
   * **개인키가 창구로 안 나간다.** 계정 키는 `key://` 참조로 살고, 그 참조조차 낼
   * 이유가 없다 — 운영자가 그것으로 할 수 있는 일이 없다.
   */
  it('응답에 개인키도 그 참조도 없다', async () => {
    const made = await api('POST', '/api/v1/acme/accounts',
      { key: 'le', directoryUrl: 'https://ca.test/dir' });
    const listed = await api('GET', '/api/v1/acme/accounts');
    for (const body of [made.body, listed.body]) {
      const text = JSON.stringify(body);
      expect(text, text).not.toContain('PRIVATE KEY');
      expect(text, text).not.toContain('key://');
    }
  });

  it('같은 디렉토리로 다시 만들면 갱신이다 — 계정이 둘로 안 갈린다', async () => {
    await api('POST', '/api/v1/acme/accounts', { key: 'le', directoryUrl: 'https://ca.test/dir' });
    const again = await api('POST', '/api/v1/acme/accounts', {
      key: 'le', directoryUrl: 'https://ca.test/dir', contact: ['mailto:new@a.test'],
    });
    expect(again.status).toBeLessThan(300);
    const rows = (await api('GET', '/api/v1/acme/accounts')).body['accounts'] as unknown[];
    expect(rows).toHaveLength(1);
  });

  it('모양이 틀리면 400 이다 — 경계에 해독기가 있다', async () => {
    expect((await api('POST', '/api/v1/acme/accounts', { key: 'le' })).status).toBe(400);
    expect((await api('POST', '/api/v1/acme/accounts',
      { key: 'le', directoryUrl: 'http://ca.test/dir' })).status,
    'https 가 아닌 디렉토리를 받았다').toBe(400);
    expect((await api('POST', '/api/v1/acme/accounts',
      { key: '../탈출', directoryUrl: 'https://ca.test/dir' })).status).toBe(400);
  });
});

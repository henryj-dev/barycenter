/**
 * **ACME 를 사람이 다시 움직인다** (2026-11-20).
 *
 * 러너는 실패한 주문을 백오프로 8 번 다시 하고 포기한다. 그 뒤가 문제였다:
 *
 *   · 포기(`abandoned`)는 살아 있는 상태가 아니어서, 다음 틱에 `openOrder` 가 **새 주문을 열었다** — 포기가 「처음부터 다시」 였다.
 *   · CA 가 `invalid` 로 판정한 주문을 같은 URL 로 다시 물었다 — CA 의 주문은 다시 살지 않으므로 같은 거절만 8 번 받았다.
 *   · 사람이 원인(:80 · DNS)을 고쳐도 백오프(최대 1 시간)를 기다리거나 DB 를 손으로 고쳐야 했다.
 *
 * 이 파일이 재는 것:
 *   · `POST /api/v1/certificates/:id/acme/retry` — 실패한 주문은 백오프를 지우고, 포기한 주문은 새 주문을 연다
 *   · `POST /api/v1/certificates/:id/acme/renew` — 만료가 멀어도 새 주문을 연다. 진행 중이면 409
 *   · 포기한 그대로면 러너가 새 주문을 안 연다. 의도를 바꾸면 연다
 *   · CA 가 거절한 주문은 좌표를 버린다 — 다음 시도가 새 CA 주문을 낸다
 *   · 다시 놓는 챌린지가 고아 스캔에서 안 빠진다
 *
 *   npm run test:store     (도커 필요 — PG · MySQL. SQLite 는 BARY_TEST_DB=sqlite)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { newEcKey } from '../../src/acme/der.js';
import { TokenAuth, hashToken } from '../../src/api/auth.js';
import { createApi } from '../../src/api/server.js';
import { AcmeRunner, type ChallengePlacer } from '../../src/control/acme-runner.js';
import { AcmeStore, MAX_ATTEMPTS } from '../../src/control/acme-store.js';
import type { LeaderElection } from '../../src/control/leader.js';
import type { ControlPlane } from '../../src/control/plane.js';
import { FsSecretStore } from '../../src/dp/secrets.js';
import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { Db, dockerAvailable, IS_MYSQL, pgFor, reset, startPg, stopPg, TEST_DB } from './pg-fixture.js';

const PG = pgFor('acme-manual');
const TOKEN = 'acme-manual-token';
const CAPS = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };

let db: Db;
let config: ConfigStore;
let acme: AcmeStore;
let secrets: FsSecretStore;
let root = '';
let server: Server | undefined;
let base = '';
let certId = '';

const placer: ChallengePlacer = { type: 'http-01', place: async () => undefined, remove: async () => undefined };

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  config = new ConfigStore(db as unknown as never, CAPS);
  acme = new AcmeStore(db);
  root = mkdtempSync(join(tmpdir(), 'bary-acmemanual-'));
  secrets = new FsSecretStore(root);
  server = createApi({
    db: db as unknown as never,
    store: config,
    control: {} as ControlPlane,
    auth: new TokenAuth([{ name: 'w', hash: hashToken(TOKEN), scopes: ['read', 'write'] }]),
    election: { state: { isLeader: true } } as unknown as LeaderElection,
    secrets,
  });
  await new Promise<void>((r) => server?.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 240_000);

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

/** 한 changeset 을 커밋한다. 적용은 안 한다. */
async function commit(patch: PatchOp[]): Promise<void> {
  const head = await config.head();
  const cs = await config.createChangeset(head.revision, 't');
  await config.patchChangeset(cs, patch, 't');
  const plan = await config.plan(cs, 't');
  await config.commit(cs, plan.id, 't');
}

beforeEach(async () => {
  await reset(db);
  // SQLite 의 `reset` 은 acme 표도 비운다. MySQL 은 FK 가 걸린 표를 TRUNCATE 못 한다 — 자식부터 지운다.
  if (TEST_DB === 'postgres') await db.query('TRUNCATE acme_challenges, acme_orders, acme_accounts CASCADE');
  if (IS_MYSQL) {
    for (const t of ['acme_challenges', 'acme_orders', 'acme_accounts']) await db.query(`DELETE FROM ${t}`);
  }
  const ref = await secrets.putKey('acct', newEcKey().export({ type: 'pkcs8', format: 'pem' }).toString());
  await acme.upsertAccount({ key: 'le', directoryUrl: 'https://ca.test/dir', accountKeyRef: ref.ref, by: 't' });
  await commit([{ op: 'put', kind: 'certificate', key: 'site', body: { acme: { account: 'le', domains: ['a.test'] } } }]);
  certId = String((await db.query('SELECT id FROM certificates WHERE key=$1', ['site'])).rows[0]?.['id']);
});

type Res = { status: number; body: Record<string, unknown> };
async function post(path: string): Promise<Res> {
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: '{}',
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
}
const retry = (key = 'site'): Promise<Res> => post(`/api/v1/certificates/${key}/acme/retry`);
const renew = (key = 'site'): Promise<Res> => post(`/api/v1/certificates/${key}/acme/renew`);

/** 주문을 하나 열고 n 번 실패시킨다. */
async function failedOrder(times: number): Promise<string> {
  const account = await acme.accountByKey('le');
  const { id } = await acme.openOrder({ accountId: account!.id, certificateId: certId, domains: ['a.test'] });
  for (let i = 0; i < times; i++) await acme.fail(id, `CA 가 거절했다 ${i + 1}`);
  return id;
}

const scan = (domains = ['a.test']): Promise<string[]> =>
  new AcmeRunner({ store: acme, secrets, placer, clientFor: () => ({}) as never })
    .scan([{ key: 'site', id: certId, acme: { account: 'le', domains } }]);

describe('지금 다시 시도', () => {
  it('실패한 주문의 백오프를 지우고 시도 수를 0 으로 돌린다 — 러너가 바로 집는다', async () => {
    const id = await failedOrder(3);
    expect(await acme.claimDue('t', 30), '백오프 중이라 아직 안 집혀야 한다').toBeUndefined();

    const r = await retry();
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ certificate: 'site', order: id, state: 'failed', created: false });

    const row = await acme.get(id);
    expect(row?.attempts).toBe(0);
    expect(row?.lastError, '사유는 남긴다 — 무엇이 실패했는지 화면이 보인다').toBe('CA 가 거절했다 3');
    expect((await acme.claimDue('t', 30))?.id).toBe(id);
  });

  it('포기한 주문이면 새 주문을 연다', async () => {
    const old = await failedOrder(MAX_ATTEMPTS);
    expect((await acme.get(old))?.state).toBe('abandoned');

    const r = await retry();
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body['created']).toBe(true);
    expect(r.body['order']).not.toBe(old);
    expect((await acme.latest(certId))?.state).toBe('pending');
  });

  it('실패한 주문이 없으면 409 nothing_to_retry · 진행 중이면 409 order_live', async () => {
    expect((await retry()).body['error']).toBe('nothing_to_retry');
    await renew();
    const r = await retry();
    expect(r.status).toBe(409);
    expect(r.body['error']).toBe('order_live');
  });

  it('없는 인증서는 404 다', async () => {
    expect((await retry('none')).status).toBe(404);
  });

  it('감사에 남는다 — 누가 언제 손으로 움직였나', async () => {
    await failedOrder(1);
    await retry();
    const rows = (await db.query(`SELECT principal, action, subject FROM audit WHERE action LIKE 'acme.order.%'`)).rows;
    expect(rows).toEqual([{ principal: 'w', action: 'acme.order.retry', subject: 'site' }]);
  });
});

describe('지금 갱신', () => {
  it('진행 중인 주문이 없으면 새 주문을 연다 · 있으면 409', async () => {
    const r = await renew();
    expect(r.status, JSON.stringify(r.body)).toBe(202);
    expect(r.body).toMatchObject({ state: 'pending', created: true });
    const again = await renew();
    expect(again.status).toBe(409);
    expect(again.body['error']).toBe('order_live');
  });

  it('실패 중이면 409 이고 다시 시도를 쓰라고 한다', async () => {
    await failedOrder(1);
    const r = await renew();
    expect(r.status).toBe(409);
    expect(String(r.body['message'])).toContain('다시 시도');
  });
});

describe('포기는 사람이 움직일 때까지 멈춘다', () => {
  it('포기한 그대로면 러너가 새 주문을 안 연다', async () => {
    await failedOrder(MAX_ATTEMPTS);
    expect(await scan(), '포기한 뒤 다음 틱에 새 주문이 열렸다 — 포기가 「처음부터 다시」 다').toHaveLength(0);
  });

  it('의도(도메인)를 바꾸면 연다', async () => {
    await failedOrder(MAX_ATTEMPTS);
    expect(await scan(['a.test', 'b.test'])).toHaveLength(1);
  });
});

describe('다시 시도가 깨끗이 다시 시작한다', () => {
  it('CA 주문 좌표를 버리면 다음 시도가 새 CA 주문을 낸다', async () => {
    const id = await failedOrder(1);
    await acme.recordOrderUrls(id, { orderUrl: 'https://ca.test/order/1', finalizeUrl: 'https://ca.test/fin/1' });
    await acme.forgetCaOrder(id);
    const row = await acme.get(id);
    expect(row?.orderUrl).toBeUndefined();
    expect(row?.finalizeUrl).toBeUndefined();
  });

  it('치운 챌린지를 다시 놓으면 고아 스캔이 다시 본다', async () => {
    // 포기한 주문의 놓인 자료는 나이와 상관없이 고아다 — 시각에 기대지 않고 잰다.
    const id = await failedOrder(MAX_ATTEMPTS);
    const ch = { orderId: id, domain: 'a.test', type: 'http-01' as const, token: 't1', value: 'v1', authzUrl: 'https://ca.test/a/1', challengeUrl: 'https://ca.test/c/1' };
    const cid = await acme.putChallenge(ch);
    await acme.markPlaced(cid);
    await acme.markCleaned(cid);

    // 새 CA 주문 — 같은 주문 · 도메인 · 종류에 새 토큰을 덮는다.
    const again = await acme.putChallenge({ ...ch, token: 't2', value: 'v2' });
    expect(again).toBe(cid);
    expect((await acme.challenge(cid))?.placedAt, '치운 것은 「안 놓음」 으로 돌아가야 한다').toBeUndefined();
    await acme.markPlaced(cid);
    expect((await acme.orphans(3600)).map((c) => c.id), '새로 놓은 자료가 치운 것으로 보인다').toContain(cid);
  });

  it('놓고 아직 안 치운 챌린지는 그대로 치울 대상이다', async () => {
    const id = await failedOrder(0);
    const ch = { orderId: id, domain: 'a.test', type: 'http-01' as const, token: 't1', value: 'v1', authzUrl: 'https://ca.test/a/1', challengeUrl: 'https://ca.test/c/1' };
    const cid = await acme.putChallenge(ch);
    await acme.markPlaced(cid);
    await acme.putChallenge({ ...ch, token: 't2' });
    expect((await acme.challenge(cid))?.placedAt).toBeDefined();
  });
});

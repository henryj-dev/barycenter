/**
 * **인증서 의도만 바꾼 커밋은 적용 대기에 남기지 않는다** (2026-11-02).
 *
 * 인증서를 만들면 ACME 의도만 리비전에 들어간다. 자료가 없으니 nginx 에 나갈 것이 없고, 발급은 head 를 보고 바로
 * 시작한다. 그런데도 「적용 대기」 에 1건이 남았다. 이제 트래픽에 닿지 않는 커밋은 바로 활성으로 올린다 — reload 없는
 * 멤버십 길로. 다른 변경이 끼어 있으면 그대로 적용 대기에 남는다.
 *
 * 함께 재는 것: **ACME 게시가 남의 적용 대기를 끌고 나가지 않는다.** 전에는 발급된 인증서를 게시하며 head 를 자동
 * 적용했고, 그때 사람이 커밋만 해 둔 변경도 트래픽에 나갔다.
 *
 *   npm run test:store     (도커 필요)
 */
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { ControlPlane, pendingApplies } from '../../src/control/plane.js';
import { LeaderElection } from '../../src/control/leader.js';
import { AcmeStore } from '../../src/control/acme-store.js';
import { publishIssued } from '../../src/control/acme-publish.js';
import { FsSecretStore } from '../../src/dp/secrets.js';
import { newEcKey } from '../../src/acme/der.js';
import type { DataplaneDriver } from '../../src/dp/driver.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('cert-no-pending');
const CAPS = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };

let db: Db;
let store: ConfigStore;
let control: ControlPlane;
let election: LeaderElection;
let secrets: FsSecretStore;
let prefix = '';
let epochOfR1 = '';

/** apply 가 어느 길로 갔는가. 드라이버는 거기서 멈춘다 — 엔진은 없다. */
class Took extends Error { constructor(readonly path: 'config' | 'membership') { super(path); } }
const driver = {
  fence: () => Promise.resolve({ maxToken: '0' }),
  applyConfig: () => Promise.reject(new Took('config')),
  applyMembership: () => Promise.reject(new Took('membership')),
  recoverConfig: () => Promise.reject(new Error('안 쓴다')),
  abortConfig: () => Promise.resolve(),
  pushMembershipDirect: () => Promise.resolve(),
  reconcileConfig: () => Promise.reject(new Error('안 쓴다')),
  status: () => Promise.resolve({
    maxLeaderToken: '0',
    planes: {
      http: { activationEpoch: epochOfR1, membershipRevision: '1', payloadDigest: '' },
      stream: { activationEpoch: epochOfR1, membershipRevision: '1', payloadDigest: '' },
    },
    published: { kind: 'none' }, lastEvidence: undefined, unfinished: undefined,
  }),
} as unknown as DataplaneDriver;

const MODEL: PatchOp[] = [
  { op: 'put', kind: 'pool', key: 'web', body: { protocolClass: 'http', algorithm: 'round_robin' } },
  { op: 'put', kind: 'backend', key: 'w1', body: { pool: 'web', host: '10.0.0.1', port: 80, weight: 1 } },
  { op: 'put', kind: 'listener', key: 'a',
    body: { protocol: 'http', bind: '127.0.0.1', port: 18080, enabled: true, http: { defaultAction: { pool: 'web' } } } },
];
const ACME_CERT: PatchOp = {
  op: 'put', kind: 'certificate', key: 'site', body: { acme: { account: 'le', domains: ['a.test'] } },
};
const MOVE_LISTENER: PatchOp = {
  op: 'put', kind: 'listener', key: 'a',
  body: { protocol: 'http', bind: '127.0.0.1', port: 18081, enabled: true, http: { defaultAction: { pool: 'web' } } },
};

/** 한 changeset 을 커밋한다. 적용은 안 한다. */
async function commit(patch: PatchOp[]): Promise<{ planId: string; revision: string; epoch: string }> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, patch, 't');
  const plan = await store.plan(cs, 't');
  const out = await store.commit(cs, plan.id, 't');
  return { planId: plan.id, revision: String(out.revision), epoch: String(out.activationEpoch) };
}

/** r1 을 커밋하고 활성으로 적는다. */
async function activeR1(): Promise<void> {
  const r1 = await commit(MODEL);
  epochOfR1 = r1.epoch;
  await db.query(
    `INSERT INTO operations (id, plan_id, revision, activation_epoch, generation, phase, detail, created_by)
     VALUES ($1, $2, $3, $4, $5, 'activated', '{"phase":"activated"}', 't')`,
    [randomUUID(), r1.planId, r1.revision, r1.epoch, `r${r1.revision}-e${r1.epoch}`],
  );
  await db.query(`UPDATE plans SET state = 'applied' WHERE id = $1`, [r1.planId]);
}

/** 자동 적용이 어느 길로 갔나 — 안 갔으면 'none'. */
async function neutral(planId: string): Promise<string> {
  try {
    return (await control.applyIfTrafficNeutral(planId, 't')) === undefined ? 'none' : 'applied';
  } catch (e) {
    if (e instanceof Took) return e.path;
    throw e;
  }
}

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new ConfigStore(db, CAPS);
  election = new LeaderElection(PG.dsn, 'cert-no-pending-test');
  if (!(await election.tryAcquire())) throw new Error('리더 획득 실패');
}, 240_000);

afterAll(async () => {
  if (prefix !== '') {
    try { rmSync(prefix, { recursive: true, force: true }); } catch { /* 0500 자료 디렉토리 */ }
  }
  await db?.close();
  stopPg(PG);
});

beforeEach(async () => {
  await reset(db);
  await db.query('TRUNCATE acme_challenges, acme_orders, acme_accounts CASCADE');
  if (prefix !== '') {
    try { rmSync(prefix, { recursive: true, force: true }); } catch { /* 0500 자료 디렉토리 */ }
  }
  prefix = mkdtempSync(join(tmpdir(), 'bary-certnp-'));
  secrets = new FsSecretStore(join(prefix, 'secrets'));
  const ref = await secrets.putKey('acct', newEcKey().export({ type: 'pkcs8', format: 'pem' }).toString());
  await new AcmeStore(db).upsertAccount({ key: 'le', directoryUrl: 'https://ca.test/dir', accountKeyRef: ref.ref, by: 't' });
  control = new ControlPlane(db, store, driver, election, {
    prefix, adminSocket: join(prefix, 'admin.sock'), renderCaps: CAPS, secrets,
  });
});

describe('트래픽에 닿지 않는 커밋', () => {
  it('**ACME 인증서를 만든 커밋은 바로 올라간다** — reload 없는 멤버십 길로', async () => {
    await activeR1();
    const r2 = await commit([ACME_CERT]);
    expect(await neutral(r2.planId)).toBe('membership');
  });

  it('리스너를 바꾼 커밋은 그대로 적용 대기다', async () => {
    await activeR1();
    const r2 = await commit([MOVE_LISTENER]);
    expect(await neutral(r2.planId)).toBe('none');
  });

  it('**앞에 다른 대기 변경이 있으면 인증서 커밋도 적용 대기에 남는다** — 함께 끌고 나가지 않는다', async () => {
    await activeR1();
    await commit([MOVE_LISTENER]);
    const r3 = await commit([ACME_CERT]);
    expect(await neutral(r3.planId)).toBe('none');
  });

  it('멤버십 평면이 없는 엔진이면 하지 않는다 — 거기서는 같은 산출물도 새 세대다', async () => {
    await activeR1();
    const plain = new ControlPlane(db, store, driver, election, {
      prefix, adminSocket: join(prefix, 'admin.sock'), renderCaps: { streamRealip: false }, secrets,
    });
    const r2 = await commit([ACME_CERT]);
    expect(await plain.applyIfTrafficNeutral(r2.planId, 't')).toBeUndefined();
  });

  it('활성화된 적이 없으면 하지 않는다', async () => {
    const r1 = await commit([...MODEL, ACME_CERT]);
    expect(await neutral(r1.planId)).toBe('none');
  });
});

describe('ACME 게시가 남의 적용 대기를 끌고 나가지 않는다', () => {
  /** 발급이 끝난 주문을 하나 만든다. 인증서 `site` 는 이미 리비전에 있다. */
  async function issued(): Promise<void> {
    const acme = new AcmeStore(db);
    const certId = String((await db.query("SELECT id FROM certificates WHERE key='site'")).rows[0]?.['id']);
    const account = await acme.accountByKey('le');
    const base = join(prefix, `mint-${Math.random().toString(36).slice(2)}`);
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '90', '-subj', '/CN=a.test',
      '-addext', 'subjectAltName=DNS:a.test', '-keyout', `${base}.key`, '-out', `${base}.crt`], { stdio: 'ignore' });
    const pem = { crt: readFileSync(`${base}.crt`, 'utf8'), key: readFileSync(`${base}.key`, 'utf8') };
    const material = await secrets.put('acme-site', { fullchain: pem.crt, privkey: pem.key });
    const keyRef = await secrets.putKey('acme-site', pem.key);
    const o = await acme.openOrder({ accountId: account!.id, certificateId: certId, domains: ['a.test'] });
    await acme.setCertKeyRef(o.id, keyRef.ref);
    await acme.markIssued(o.id, material.ref, keyRef.ref);
  }

  const recorder = (): { calls: string[]; control: never } => {
    const calls: string[] = [];
    return { calls, control: { apply: async (planId: string) => { calls.push(planId); return { id: 'op' }; } } as never };
  };

  it('다른 대기가 없으면 지금처럼 자동 적용한다', async () => {
    await activeR1();
    await commit([ACME_CERT]);
    await db.query(`UPDATE plans SET state='applied' WHERE state='committed'`);
    await db.query(
      `INSERT INTO operations (id, plan_id, revision, activation_epoch, generation, phase, detail, created_by)
       SELECT gen_random_uuid(), id, target_revision, activation_epoch, 'g', 'activated', '{}', 't'
         FROM plans WHERE target_revision = (SELECT revision FROM config_head)`,
    );
    await issued();
    const r = recorder();
    const out = await publishIssued({ db, store, control: r.control, acme: new AcmeStore(db), secrets });
    expect(out[0]?.error).toBeUndefined();
    expect(r.calls).toHaveLength(1);
    expect(out[0]?.held).toBeUndefined();
  });

  it('**사람이 커밋만 해 둔 변경이 있으면 커밋까지만 한다** — 적용 대기에 함께 올라간다', async () => {
    await activeR1();
    await commit([ACME_CERT]);
    const waiting = await commit([MOVE_LISTENER]);
    await issued();
    const r = recorder();
    const out = await publishIssued({ db, store, control: r.control, acme: new AcmeStore(db), secrets });
    expect(out[0]?.error).toBeUndefined();
    expect(r.calls, '자동 적용을 부르지 않았다').toHaveLength(0);
    expect(out[0]?.held).toContain(`r${waiting.revision}`);
    // 게시 커밋은 head 이고, 사람의 리스너 변경과 함께 적용 대기에 있다.
    const pending = await pendingApplies(db);
    expect(pending.map((p) => p.revision)).toContain(out[0]?.revision);
    expect((await store.modelAt((await store.head()).revision)).listeners.find((l) => l.key === 'a')?.port).toBe(18081);
  });
});

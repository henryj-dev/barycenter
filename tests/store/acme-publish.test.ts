/**
 * 발급된 인증서를 설정에 반영한다 (DESIGN.md §8.2 · ADR-ACME ⑥)
 *
 * 러너는 인증서를 받아 SecretStore 에 넣고 `issued` 로 끝낸다. **거기까지는 nginx 가
 * 아무것도 모른다** — 주문 상태는 리비전에 안 살기 때문이다(009). 발급이 실제로 트래픽에
 * 닿으려면 정상 경로(changeset → plan → commit)를 지나야 한다.
 *
 * 이 절이 없으면 증상은 **"인증서는 발급됐다는데 옛 것이 계속 제시된다"** 다. 로그에는
 * `acme.order.advanced ... issued` 가 찍혀 있으므로 성공한 것처럼 보인다.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AcmeStore } from '../../src/control/acme-store.js';
import { pendingPublications, publishIssued } from '../../src/control/acme-publish.js';
import { ConfigStore } from '../../src/store/config-store.js';
import { FsSecretStore } from '../../src/dp/secrets.js';
import { newEcKey } from '../../src/acme/der.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('acmepub');
let db: Db;
let store: ConfigStore;
let acme: AcmeStore;
let secrets: FsSecretStore;
let root = '';
let accountId = '';
let certId = '';

/** 활성화는 안 한다 — 여기서 재는 것은 **설정에 닿는가** 이지 데이터 플레인이 아니다. */
const noApply = { apply: async () => { throw new Error('이 테스트는 활성화를 안 태운다'); } };

function mintPair(cn: string): { pem: string; key: string } {
  const base = join(root, `mint-${cn}-${Math.random().toString(36).slice(2)}`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '90',
    '-subj', `/CN=${cn}`, '-addext', `subjectAltName=DNS:${cn}`,
    '-keyout', `${base}.key`, '-out', `${base}.crt`,
  ], { stdio: 'ignore' });
  return { pem: readFileSync(`${base}.crt`, 'utf8'), key: readFileSync(`${base}.key`, 'utf8') };
}

/** 발급이 끝난 주문 하나를 만든다. */
async function issuedOrder(certKey: string, cn: string): Promise<{ orderId: string; ref: string }> {
  const pair = mintPair(cn);
  const material = await secrets.put(`acme-${certKey}`, { fullchain: pair.pem, privkey: pair.key });
  const keyRef = await secrets.putKey(`acme-${certKey}`, pair.key);
  const o = await acme.openOrder({ accountId, certificateId: certId, domains: [cn] });
  await acme.setCertKeyRef(o.id, keyRef.ref);
  await acme.markIssued(o.id, material.ref, keyRef.ref);
  return { orderId: o.id, ref: material.ref };
}

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new ConfigStore(db, { streamRealip: false });
  acme = new AcmeStore(db);
  root = mkdtempSync(join(tmpdir(), 'bary-acmepub-'));
  secrets = new FsSecretStore(root);
}, 180_000);

afterAll(async () => {
  await db?.close();
  stopPg(PG);
  if (root !== '') {
    // 0500 디렉토리라 쓰기 권한을 돌려줘야 지워진다 (§4.8 — 자료를 그렇게 지킨다).
    try { execFileSync('chmod', ['-R', 'u+w', root]); } catch { /* 이미 없으면 그만 */ }
    rmSync(root, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  await reset(db);
  await db.query('TRUNCATE acme_challenges, acme_orders, acme_accounts CASCADE');
  const ref = await secrets.putKey('acct', newEcKey().export({ type: 'pkcs8', format: 'pem' }).toString());
  accountId = await acme.upsertAccount({
    key: 'le', directoryUrl: 'https://ca.test/dir', accountKeyRef: ref.ref, by: 't',
  });
  // **ACME 의도만 있고 자료가 없는 인증서** — 첫 발급을 기다리는 상태다.
  const r = await db.query(
    `INSERT INTO certificates (id,key,name,acme_account,acme_domains,created_by,updated_by,revision)
     VALUES (gen_random_uuid(),'web','web','le',$1,'t','t',1) RETURNING id`,
    [['a.test']],
  );
  certId = String(r.rows[0]?.['id']);
});

describe('무엇이 게시를 기다리는가', () => {
  it('**발급됐는데 설정이 모르는 것**만 나온다', async () => {
    expect(await pendingPublications(db)).toHaveLength(0);
    const { ref } = await issuedOrder('web', 'a.test');
    const pending = await pendingPublications(db);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.certificateKey).toBe('web');
    expect(pending[0]?.issuedRef).toBe(ref);
  });

  it('게시하고 나면 목록에서 빠진다 — **상태를 따로 안 만들고 비교로 판정한다**', async () => {
    await issuedOrder('web', 'a.test');
    await publishIssued({ db, store, control: noApply as never, acme, secrets, applyAutomatically: false });
    expect(await pendingPublications(db)).toHaveLength(0);
  });

  it('아직 발급 안 된 주문은 안 나온다', async () => {
    await acme.openOrder({ accountId, certificateId: certId, domains: ['a.test'] });
    expect(await pendingPublications(db)).toHaveLength(0);
  });
});

describe('게시', () => {
  it('**인증서 자료가 설정에 들어간다** — 여기까지 와야 nginx 가 안다', async () => {
    const { ref } = await issuedOrder('web', 'a.test');
    const before = await store.modelAt((await store.head()).revision);
    expect(before.certificates[0]?.materialRef).toBeUndefined();

    const out = await publishIssued({
      db, store, control: noApply as never, acme, secrets, applyAutomatically: false,
    });
    expect(out[0]?.error, out[0]?.error).toBeUndefined();

    const after = await store.modelAt((await store.head()).revision);
    const cert = after.certificates.find((c) => c.key === 'web');
    expect(cert?.materialRef).toBe(ref);
    // digest 도 함께 들어가야 세대 결박이 선다 (§7.2).
    expect(cert?.chainDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(cert?.keyDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  it('**ACME 의도를 안 지운다** — 지우면 한 번 갱신되고 영영 멈춘다', async () => {
    await issuedOrder('web', 'a.test');
    await publishIssued({ db, store, control: noApply as never, acme, secrets, applyAutomatically: false });
    const after = await store.modelAt((await store.head()).revision);
    // PUT 은 통째로 덮는다. 의도를 안 실으면 다음 스캔이 이 인증서를 자기 것으로 안 본다.
    expect(after.certificates.find((c) => c.key === 'web')?.acme)
      .toEqual({ account: 'le', domains: ['a.test'] });
  });

  it('**정상 경로를 지난다** — 리비전이 늘고 감사에 남는다', async () => {
    const head = await store.head();
    await issuedOrder('web', 'a.test');
    const out = await publishIssued({
      db, store, control: noApply as never, acme, secrets, applyAutomatically: false,
    });
    expect(Number(out[0]?.revision)).toBe(Number(head.revision) + 1);
    const audit = (await db.query(
      `SELECT count(*)::int AS n FROM audit WHERE principal='acme'`)).rows[0];
    expect(Number(audit?.['n'])).toBeGreaterThan(0);
  });

  it('두 번 불러도 리비전이 한 번만 는다 — 멱등하다', async () => {
    await issuedOrder('web', 'a.test');
    await publishIssued({ db, store, control: noApply as never, acme, secrets, applyAutomatically: false });
    const mid = await store.head();
    await publishIssued({ db, store, control: noApply as never, acme, secrets, applyAutomatically: false });
    expect((await store.head()).revision).toBe(mid.revision);
  });

  it('갱신도 같은 경로로 간다 — 새 주문의 자료가 설정을 덮는다', async () => {
    const first = await issuedOrder('web', 'a.test');
    await publishIssued({ db, store, control: noApply as never, acme, secrets, applyAutomatically: false });

    // 두 번째 발급. 살아 있는 주문이 없으므로 새 주문이 열린다.
    const second = await issuedOrder('web', 'a.test');
    expect(second.ref).not.toBe(first.ref);
    await publishIssued({ db, store, control: noApply as never, acme, secrets, applyAutomatically: false });

    const after = await store.modelAt((await store.head()).revision);
    expect(after.certificates.find((c) => c.key === 'web')?.materialRef).toBe(second.ref);
  });

  it('**하나가 실패해도 다음 것을 계속한다**', async () => {
    // **둘이 필요하다.** 하나만 두면 `break` 와 `continue` 가 구분되지 않는다 — 처음에
    // 하나로 짰다가 변이 실험에서 `break` 를 넣어도 통과하는 것을 보고 알았다. 이름이
    // 약속한 것을 안 재고 있었다.
    const other = await db.query(
      `INSERT INTO certificates (id,key,name,acme_account,acme_domains,created_by,updated_by,revision)
       VALUES (gen_random_uuid(),'web2','web2','le',$1,'t','t',1) RETURNING id`,
      [['b.test']],
    );
    const otherId = String(other.rows[0]?.['id']);

    // ① 자료가 사라진 주문 — `describe` 가 던진다. `updated_at` 을 앞당겨 **먼저** 오게 한다.
    const bad = await acme.openOrder({ accountId, certificateId: certId, domains: ['a.test'] });
    await db.query(
      `UPDATE acme_orders SET state='issued', issued_ref=$2, cert_key_ref=$3,
              claimed_by=NULL, claimed_until=NULL, updated_at = now() - interval '1 hour'
        WHERE id=$1`,
      [bad.id, `store://gone@${'a'.repeat(32)}`, `key://gone@${'a'.repeat(32)}`]);

    // ② 멀쩡한 주문.
    const pair = mintPair('b.test');
    const material = await secrets.put('acme-web2', { fullchain: pair.pem, privkey: pair.key });
    const keyRef = await secrets.putKey('acme-web2', pair.key);
    const good = await acme.openOrder({ accountId, certificateId: otherId, domains: ['b.test'] });
    await acme.setCertKeyRef(good.id, keyRef.ref);
    await acme.markIssued(good.id, material.ref, keyRef.ref);

    const out = await publishIssued({
      db, store, control: noApply as never, acme, secrets, applyAutomatically: false,
    });

    // 실패가 자기 자리에 남고, **뒤엣것은 그대로 간다.**
    expect(out).toHaveLength(2);
    expect(out.find((r) => r.certificate === 'web')?.error).toBeDefined();
    expect(out.find((r) => r.certificate === 'web2')?.error).toBeUndefined();

    const after = await store.modelAt((await store.head()).revision);
    expect(after.certificates.find((c) => c.key === 'web2')?.materialRef).toBe(material.ref);
    expect(after.certificates.find((c) => c.key === 'web')?.materialRef).toBeUndefined();
  });
});

/**
 * ACME 주문 원장 (DESIGN.md §8.2 · ADR-ACME · S18)
 *
 * 프로토콜은 S18 이 실물 CA 로 쟀다. 여기서 재는 것은 **언제 무엇을 다시 시도하는가** —
 * S18 이 실측한 대로 그건 CA 가 안 해 준다:
 *
 *   · **버려진 주문을 CA 는 안 치운다** (`pending` 으로 남는다)
 *   · 실패한 챌린지도 CA 쪽에서는 그냥 `invalid` 로 남아 있을 뿐이다
 *
 * 그래서 재시도·백오프·포기·고아 정리가 전부 우리 몫이고, 그게 틀리면 증상은 **"인증서가
 * 가끔 갱신 안 된다"** 다 — 아무 데서도 안 터진다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AcmeStore, LIVE_STATES, MAX_ATTEMPTS, backoffSeconds } from '../../src/control/acme-store.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('acme');
let db: Db;
let store: AcmeStore;
let accountId = '';
let certA = '';
let certB = '';

const REF = (n: string): string => `store://${n}@${'a'.repeat(32)}`;

/** 인증서 행을 직접 넣는다 — 여기서 재는 것은 changeset 경로가 아니다. */
async function makeCert(key: string): Promise<string> {
  const r = await db.query(
    `INSERT INTO certificates (id,key,name,material_ref,chain_digest,key_digest,
                               created_by,updated_by,revision)
     VALUES (gen_random_uuid(),$1,$1,$2,$3,$4,'t','t',1) RETURNING id`,
    [key, REF(key), `sha256:${'0'.repeat(64)}`, `sha256:${'1'.repeat(64)}`],
  );
  return String(r.rows[0]?.['id']);
}

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new AcmeStore(db);
}, 180_000);

afterAll(async () => {
  await db?.close();
  stopPg(PG);
});

beforeEach(async () => {
  await reset(db);
  await db.query('TRUNCATE acme_challenges, acme_orders, acme_accounts CASCADE');
  certA = await makeCert('cert-a');
  certB = await makeCert('cert-b');
  accountId = await store.upsertAccount({
    key: 'le', directoryUrl: 'https://ca.test/dir', accountKeyRef: REF('acct'), by: 't',
  });
});

describe('계정', () => {
  it('디렉토리당 하나다 — 두 번 넣어도 같은 계정', async () => {
    const again = await store.upsertAccount({
      key: 'le2', directoryUrl: 'https://ca.test/dir', accountKeyRef: REF('acct'), by: 't',
    });
    expect(again).toBe(accountId);
  });

  it('**개인키가 아니라 참조를 든다** (§4.8)', async () => {
    const acct = await store.account('https://ca.test/dir');
    expect(acct?.accountKeyRef).toMatch(/^store:\/\/acct@[a-f0-9]{32}$/);
    // 자료를 담을 컬럼 자체가 없다.
    const cols = (await db.query(
      `SELECT column_name FROM information_schema.columns WHERE table_name='acme_accounts'`,
    )).rows.map((r) => String(r['column_name']));
    expect(cols).not.toContain('account_key');
    expect(cols).not.toContain('private_key');
  });

  it('CA 가 준 kid 를 기억한다 — 재시작 뒤 다시 등록하지 않는다', async () => {
    expect((await store.account('https://ca.test/dir'))?.accountUrl).toBeUndefined();
    await store.setAccountUrl(accountId, 'https://ca.test/acct/1');
    expect((await store.account('https://ca.test/dir'))?.accountUrl).toBe('https://ca.test/acct/1');
  });
});

describe('주문은 인증서당 하나만 살아 있다', () => {
  it('두 번 열어도 같은 주문이다 — **매 틱마다 새 주문을 내면 레이트리밋에 걸린다**', async () => {
    const first = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    const second = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it('**DB 가 구조적으로 막는다** — 애플리케이션이 잊어도 안 뚫린다', async () => {
    const o = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    // 부분 유일 인덱스를 우회해서 직접 넣어 본다.
    await expect(db.query(
      `INSERT INTO acme_orders (id,account_id,certificate_id,domains)
       VALUES (gen_random_uuid(),$1,$2,$3)`,
      [accountId, certA, ['a.test']],
    )).rejects.toThrow();
    expect(o.created).toBe(true);
  });

  it('끝난 주문은 새 주문을 막지 않는다 — 그래야 갱신이 돈다', async () => {
    const first = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    await store.setCertKeyRef(first.id, REF('k'));
    await store.markIssued(first.id, REF('issued'), REF('k'));
    const next = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    expect(next.created).toBe(true);
    expect(next.id).not.toBe(first.id);
    // **옛 주문은 기록으로 남는다** — 무엇이 언제 발급됐나.
    expect((await store.get(first.id))?.state).toBe('issued');
  });

  it('인증서가 다르면 주문도 따로다', async () => {
    const a = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    const b = await store.openOrder({ accountId, certificateId: certB, domains: ['b.test'] });
    expect(b.id).not.toBe(a.id);
  });
});

describe('실행권 — 둘이 같은 주문을 몰면 nonce 가 서로를 깨뜨린다', () => {
  it('**한 명만 집는다**', async () => {
    await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    const first = await store.claimDue('leader-1');
    const second = await store.claimDue('leader-2');
    expect(first?.domains).toEqual(['a.test']);
    expect(second).toBeUndefined();
  });

  it('둘이 서로 다른 주문을 집는다 — 서로를 막지 않는다', async () => {
    await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    await store.openOrder({ accountId, certificateId: certB, domains: ['b.test'] });
    const a = await store.claimDue('leader-1');
    const b = await store.claimDue('leader-2');
    expect(a?.id).toBeDefined();
    expect(b?.id).toBeDefined();
    expect(a?.id).not.toBe(b?.id);
  });

  it('**lease 가 만료되면 남이 집는다** — 죽은 리더를 영원히 기다릴 수 없다', async () => {
    const o = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    await store.claimDue('dead-leader', 120);
    expect(await store.claimDue('leader-2')).toBeUndefined();
    // 시각을 손으로 밀어 만료를 만든다. `sleep` 으로 재면 테스트가 느리고 불안정하다.
    await db.query(`UPDATE acme_orders SET claimed_until = now() - interval '1 second' WHERE id=$1`,
      [o.id]);
    expect((await store.claimDue('leader-2'))?.id).toBe(o.id);
  });

  it('놓으면 바로 다시 집힌다', async () => {
    const o = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    await store.claimDue('leader-1');
    await store.release(o.id);
    expect((await store.claimDue('leader-2'))?.id).toBe(o.id);
  });

  it('**종단 상태는 실행권을 못 든다** — 들고 있으면 아무도 못 집는다', async () => {
    const o = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    await store.claimDue('leader-1');
    await store.setCertKeyRef(o.id, REF('k'));
    await store.markIssued(o.id, REF('issued'), REF('k'));
    const row = (await db.query('SELECT claimed_by FROM acme_orders WHERE id=$1', [o.id])).rows[0];
    expect(row?.['claimed_by']).toBeNull();
  });
});

describe('백오프와 포기', () => {
  it('지수로 늘고 **상한이 있다** — 무한히 늘리면 "포기" 와 구분이 안 된다', () => {
    expect(backoffSeconds(1)).toBe(60);
    expect(backoffSeconds(2)).toBe(120);
    expect(backoffSeconds(4)).toBe(480);
    expect(backoffSeconds(99)).toBe(3600);
  });

  it('**실패하면 바로 다시 안 집힌다** — 매 틱 재시도는 레이트리밋을 부른다', async () => {
    const o = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    await store.claimDue('leader-1');
    expect(await store.fail(o.id, '챌린지 실패')).toBe('failed');
    // 실행권은 놓였지만 `next_attempt_at` 이 미래다.
    expect(await store.claimDue('leader-1')).toBeUndefined();
  });

  it('시간이 지나면 다시 집힌다', async () => {
    const o = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    await store.claimDue('leader-1');
    await store.fail(o.id, '일시적');
    await db.query(`UPDATE acme_orders SET next_attempt_at = now() - interval '1 second' WHERE id=$1`,
      [o.id]);
    expect((await store.claimDue('leader-1'))?.id).toBe(o.id);
  });

  it('**상한을 넘으면 포기하고 멈춘다** — 계속 시도하며 아무 말도 안 하는 것보다 낫다', async () => {
    const o = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    let state = '';
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      await db.query('UPDATE acme_orders SET next_attempt_at = now() WHERE id=$1', [o.id]);
      await store.claimDue('leader-1');
      state = await store.fail(o.id, `시도 ${i}`);
    }
    expect(state).toBe('abandoned');
    // 포기한 주문은 스케줄러가 다시 안 집는다 — 사람이 봐야 한다.
    await db.query('UPDATE acme_orders SET next_attempt_at = now() WHERE id=$1', [o.id]);
    expect(await store.claimDue('leader-1')).toBeUndefined();
    expect((await store.get(o.id))?.lastError).toContain('시도');
  });

  it('포기한 주문은 **새 주문을 막지 않는다** — 고친 뒤 다시 시도할 수 있어야 한다', async () => {
    const o = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    await db.query(`UPDATE acme_orders SET state='abandoned', claimed_by=NULL, claimed_until=NULL
                     WHERE id=$1`, [o.id]);
    expect((await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] })).created)
      .toBe(true);
  });
});

describe('챌린지와 고아 정리 (§8.2)', () => {
  it('http-01 과 dns-01 은 **같은 도메인에 공존한다** — 값이 다르다', async () => {
    const o = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    const base = { orderId: o.id, domain: 'a.test', token: 'tok', authzUrl: 'u', challengeUrl: 'c' };
    await store.putChallenge({ ...base, type: 'http-01', value: 'tok.thumb' });
    await store.putChallenge({ ...base, type: 'dns-01', value: 'sha256값' });
    const list = await store.challenges(o.id);
    expect(list.map((c) => c.type).sort()).toEqual(['dns-01', 'http-01']);
  });

  it('**놓은 것만 고아가 된다** — "놓을 예정" 은 치울 것이 없다', async () => {
    const o = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    const id = await store.putChallenge({
      orderId: o.id, domain: 'a.test', type: 'dns-01', token: 't', value: 'v',
      authzUrl: 'u', challengeUrl: 'c',
    });
    // 아직 안 놓았다 → 주문을 포기해도 고아가 아니다.
    await db.query(`UPDATE acme_orders SET state='abandoned', claimed_by=NULL, claimed_until=NULL
                     WHERE id=$1`, [o.id]);
    expect(await store.orphans(3600)).toHaveLength(0);

    await store.markPlaced(id);
    expect((await store.orphans(3600)).map((c) => c.id)).toEqual([id]);
  });

  it('**끝난 주문의 자료는 즉시 고아다** — 시간을 안 기다린다', async () => {
    const o = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    const id = await store.putChallenge({
      orderId: o.id, domain: 'a.test', type: 'dns-01', token: 't', value: 'v',
      authzUrl: 'u', challengeUrl: 'c',
    });
    await store.markPlaced(id);
    await store.setCertKeyRef(o.id, REF('k'));
    await store.markIssued(o.id, REF('issued'), REF('k'));
    // 성공해도 치워야 한다 — §8.2 는 "성공/실패와 무관하게" 라고 적었다.
    expect((await store.orphans(3600)).map((c) => c.id)).toEqual([id]);
  });

  it(
    '**진행 중인 주문의 자료는 오래됐을 때만 고아다** — S18: CA 는 pending 을 안 치운다',
    async () => {
      const o = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
      const id = await store.putChallenge({
        orderId: o.id, domain: 'a.test', type: 'dns-01', token: 't', value: 'v',
        authzUrl: 'u', challengeUrl: 'c',
      });
      await store.markPlaced(id);
      // 주문 상태로 물으면 영영 안 걸린다. **놓은 지 얼마나 됐나**로 묻는다.
      expect(await store.orphans(3600)).toHaveLength(0);
      await db.query(`UPDATE acme_challenges SET placed_at = now() - interval '2 hours' WHERE id=$1`,
        [id]);
      expect((await store.orphans(3600)).map((c) => c.id)).toEqual([id]);
    },
  );

  it('치우면 고아 목록에서 빠진다', async () => {
    const o = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    const id = await store.putChallenge({
      orderId: o.id, domain: 'a.test', type: 'http-01', token: 't', value: 'v',
      authzUrl: 'u', challengeUrl: 'c',
    });
    await store.markPlaced(id);
    await store.setCertKeyRef(o.id, REF('k'));
    await store.markIssued(o.id, REF('issued'), REF('k'));
    await store.markCleaned(id);
    expect(await store.orphans(3600)).toHaveLength(0);
  });

  it('**놓지 않은 것을 치웠다고 적을 수 없다** — DB 가 막는다', async () => {
    const o = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    const id = await store.putChallenge({
      orderId: o.id, domain: 'a.test', type: 'http-01', token: 't', value: 'v',
      authzUrl: 'u', challengeUrl: 'c',
    });
    await expect(db.query('UPDATE acme_challenges SET cleaned_at=now() WHERE id=$1', [id]))
      .rejects.toThrow();
  });

  it('인증서를 지우면 주문과 챌린지가 함께 간다 — 목적 없는 갱신 루프를 막는다', async () => {
    const o = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    await store.putChallenge({
      orderId: o.id, domain: 'a.test', type: 'http-01', token: 't', value: 'v',
      authzUrl: 'u', challengeUrl: 'c',
    });
    await db.query('DELETE FROM certificates WHERE id=$1', [certA]);
    expect(await store.get(o.id)).toBeUndefined();
    const n = (await db.query('SELECT count(*)::int AS n FROM acme_challenges')).rows[0];
    expect(n?.['n']).toBe(0);
  });
});

describe('발급 결과는 설정이 아니다', () => {
  it('**issued 는 참조만 든다** — 게시는 별도 사건이다 (changeset)', async () => {
    const o = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    await store.setCertKeyRef(o.id, REF('newkey'));
    await store.markIssued(o.id, REF('newcert'), REF('newkey'));
    const row = await store.get(o.id);
    expect(row?.issuedRef).toMatch(/^store:\/\/newcert@/);
    // **`certificates.material_ref` 는 아직 안 바뀐다.** 발급과 게시는 다르다.
    const cert = (await db.query('SELECT material_ref FROM certificates WHERE id=$1', [certA]))
      .rows[0];
    expect(String(cert?.['material_ref'])).toContain('cert-a@');
  });

  it('**결과 없이 issued 가 될 수 없다** — DB 가 막는다', async () => {
    const o = await store.openOrder({ accountId, certificateId: certA, domains: ['a.test'] });
    await expect(db.query(`UPDATE acme_orders SET state='issued' WHERE id=$1`, [o.id]))
      .rejects.toThrow();
  });

  it('진행 중 상태 목록이 계약이다 — 종단이 섞이면 스케줄러가 끝난 것을 다시 집는다', () => {
    expect([...LIVE_STATES].sort()).toEqual(['failed', 'pending', 'ready', 'validating']);
  });
});

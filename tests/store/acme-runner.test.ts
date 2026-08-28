/**
 * ACME 갱신 러너 (DESIGN.md §8.2 · ADR-ACME · S18)
 *
 * 프로토콜은 S18 이 실물 CA 로, 원장은 `acme-store.test.ts` 가 실물 PG 로 쟀다. 여기서
 * 재는 것은 **그 둘을 잇는 글루** 다 — 그리고 글루가 틀리면 증상은 언제나 같다:
 * *"인증서가 가끔 갱신 안 된다."*
 *
 * ── CA 를 가짜로 두는 이유 ──────────────────────────────────────────────
 *
 * 여기서 묻는 것은 "CA 가 규격대로 답하는가" 가 아니라 **"CA 가 이렇게 답하면 우리가 뭘
 * 하는가"** 다. `invalid` 를 받으면? 검증이 안 끝났으면? finalize 직전에 죽으면?
 * 실물 CA 로는 그 분기를 **부를 수가 없다** — Pebble 에게 "이번엔 invalid 를 답해라" 를
 * 시킬 방법이 없다.
 *
 * 원장은 실물 PG 다. 상태 전이·실행권·백오프가 거기 살기 때문이다.
 */
import { execFileSync } from 'node:child_process';
import { createPrivateKey } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AcmeStore } from '../../src/control/acme-store.js';
import { AcmeRunner, type ChallengePlacer } from '../../src/control/acme-runner.js';
import { newEcKey } from '../../src/acme/der.js';
import { FsSecretStore } from '../../src/dp/secrets.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('acmerun');
let db: Db;
let store: AcmeStore;
let secrets: FsSecretStore;
let root = '';
let accountId = '';
let certId = '';

/** 놓은 것을 기억하는 배치기. **치우는지**를 재려면 기억해야 한다. */
class FakePlacer implements ChallengePlacer {
  readonly type = 'http-01' as const;
  readonly placed = new Map<string, string>();
  readonly removed: string[] = [];
  failNext = false;

  async place(_domain: string, token: string, value: string): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('배치 실패');
    }
    this.placed.set(token, value);
  }

  async remove(_domain: string, token: string): Promise<void> {
    this.placed.delete(token);
    this.removed.push(token);
  }
}

/**
 * CA 를 흉내 낸다. **시나리오를 대본으로 준다** — 실물로는 부를 수 없는 분기를 부르려고.
 */
type Script = {
  orderStatus: ('pending' | 'ready' | 'valid' | 'invalid')[];
  challengeTypes?: string[];
  finalizeStatus?: 'valid' | 'invalid';
  certPem?: string;
  failOn?: 'newOrder' | 'accept' | 'finalize';
};

function fakeClient(script: Script): any {
  let poll = 0;
  return {
    async register(): Promise<string> { return 'https://ca.test/acct/1'; },
    // **이미 아는 계정은 `newAccount` 없이 이어 쓴다** (검수 D16). 이 가짜에 이 줄이
    // 없던 동안 러너는 틱마다 `register()` 를 불렀고, 그것이 정상으로 보였다 —
    // 가짜가 실물 계약보다 좁으면 그 차이만큼 검증이 비는 자리다.
    resumeAccount(_url: string): void { /* `kid` 를 놓는 것이 전부다 */ },
    async newOrder(domains: readonly string[]): Promise<unknown> {
      if (script.failOn === 'newOrder') throw new Error('CA 가 주문을 거절했다');
      return {
        url: 'https://ca.test/order/1',
        order: {
          status: 'pending',
          finalize: 'https://ca.test/finalize/1',
          authorizations: domains.map((d) => `https://ca.test/authz/${d}`),
          identifiers: domains.map((value) => ({ type: 'dns', value })),
        },
      };
    },
    async fetchAuthorization(url: string): Promise<unknown> {
      const domain = url.split('/').pop() ?? '';
      const types = script.challengeTypes ?? ['http-01', 'dns-01'];
      return {
        status: 'pending',
        identifier: { type: 'dns', value: domain },
        challenges: types.map((type) => ({
          type, url: `https://ca.test/chall/${domain}/${type}`,
          token: `tok-${domain}`, status: 'pending',
        })),
      };
    },
    async acceptChallenge(): Promise<unknown> {
      if (script.failOn === 'accept') throw new Error('챌린지 수락 실패');
      return { status: 'processing' };
    },
    async fetchOrder(): Promise<unknown> {
      const status = script.orderStatus[Math.min(poll, script.orderStatus.length - 1)];
      poll += 1;
      return {
        status, finalize: 'https://ca.test/finalize/1',
        authorizations: ['https://ca.test/authz/a.test'],
        identifiers: [{ type: 'dns', value: 'a.test' }],
        ...(status === 'invalid' ? { error: { type: 'urn:x', detail: '챌린지 실패' } } : {}),
        ...(status === 'valid' ? { certificate: 'https://ca.test/cert/1' } : {}),
      };
    },
    async finalize(): Promise<unknown> {
      if (script.failOn === 'finalize') throw new Error('finalize 실패');
      return {
        status: script.finalizeStatus ?? 'valid',
        certificate: 'https://ca.test/cert/1',
        finalize: 'https://ca.test/finalize/1',
        authorizations: [], identifiers: [],
      };
    },
    async downloadCertificate(): Promise<string> { return script.certPem ?? ''; },
  };
}

/** 실제 인증서 한 벌 — `inspectMaterial` 이 검증하므로 진짜여야 한다. */
function mintPair(): { pem: string; key: string } {
  const base = join(root, `mint-${Math.random().toString(36).slice(2)}`);
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '90',
    '-subj', '/CN=a.test', '-addext', 'subjectAltName=DNS:a.test',
    '-keyout', `${base}.key`, '-out', `${base}.crt`,
  ], { stdio: 'ignore' });
  return { pem: readFileSync(`${base}.crt`, 'utf8'), key: readFileSync(`${base}.key`, 'utf8') };
}

function runnerWith(script: Script, placer: FakePlacer, over: Record<string, unknown> = {}): AcmeRunner {
  return new AcmeRunner({
    store, secrets, placer,
    clientFor: () => fakeClient(script) as never,
    ...over,
  });
}

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new AcmeStore(db);
  root = mkdtempSync(join(tmpdir(), 'bary-acmerun-'));
  secrets = new FsSecretStore(root);
}, 180_000);

afterAll(async () => {
  await db?.close();
  stopPg(PG);
  // **0500 디렉토리는 그냥 못 지운다.** `FsSecretStore` 가 자료를 그렇게 지키기 때문이고
  // (§4.8), 지우려면 쓰기 권한을 먼저 돌려줘야 한다. SecretStore GC 를 짓는 회차가 같은
  // 것을 만난다 — 여기 적어 둔다.
  if (root !== '') {
    try {
      execFileSync('chmod', ['-R', 'u+w', root]);
    } catch { /* 이미 지워졌으면 그만 */ }
    rmSync(root, { recursive: true, force: true });
  }
});

beforeEach(async () => {
  await reset(db);
  await db.query('TRUNCATE acme_challenges, acme_orders, acme_accounts CASCADE');
  const accountKey = newEcKey();
  const ref = await secrets.putKey('acct', accountKey.export({ type: 'pkcs8', format: 'pem' }).toString());
  accountId = await store.upsertAccount({
    key: 'le', directoryUrl: 'https://ca.test/dir', accountKeyRef: ref.ref, by: 't',
  });
  const r = await db.query(
    `INSERT INTO certificates (id,key,name,acme_account,acme_domains,created_by,updated_by,revision)
     VALUES (gen_random_uuid(),'cert-a','cert-a','le',$1,'t','t',1) RETURNING id`,
    [['a.test']],
  );
  certId = String(r.rows[0]?.['id']);
});

describe('scan — 언제 주문을 여는가', () => {
  it('**자료가 없으면 무조건 연다** — 첫 발급이다', async () => {
    const runner = runnerWith({ orderStatus: ['pending'] }, new FakePlacer());
    const opened = await runner.scan([{ key: 'cert-a', id: certId, acme: { account: 'le', domains: ['a.test'] } }]);
    expect(opened).toHaveLength(1);
  });

  it('두 번 스캔해도 주문은 하나다 — **매 틱 새 주문은 레이트리밋을 부른다**', async () => {
    const runner = runnerWith({ orderStatus: ['pending'] }, new FakePlacer());
    const certs = [{ key: 'cert-a', id: certId, acme: { account: 'le', domains: ['a.test'] } }];
    expect(await runner.scan(certs)).toHaveLength(1);
    expect(await runner.scan(certs)).toHaveLength(0);
  });

  it('ACME 의도가 없으면 안 연다 — 손으로 올린 인증서는 건드리지 않는다', async () => {
    const runner = runnerWith({ orderStatus: ['pending'] }, new FakePlacer());
    expect(await runner.scan([{ key: 'cert-a', id: certId }])).toHaveLength(0);
  });

  it('**만료가 멀면 안 연다**', async () => {
    const pair = mintPair();
    const ref = await secrets.put('manual', { fullchain: pair.pem, privkey: pair.key });
    const runner = runnerWith({ orderStatus: ['pending'] }, new FakePlacer(),
      { renewBeforeDays: 30 });
    expect(await runner.scan([{
      key: 'cert-a', id: certId, materialRef: ref.ref,
      acme: { account: 'le', domains: ['a.test'] },
    }])).toHaveLength(0);
  });

  it('만료가 가까우면 연다 — 30 일 창 (§8.2)', async () => {
    const pair = mintPair();
    const ref = await secrets.put('soon', { fullchain: pair.pem, privkey: pair.key });
    // 인증서는 90 일짜리다. 70 일 뒤로 시각을 밀면 20 일 남는다.
    const later = new Date(Date.now() + 70 * 86_400_000);
    const runner = runnerWith({ orderStatus: ['pending'] }, new FakePlacer(),
      { renewBeforeDays: 30, now: () => later });
    expect(await runner.scan([{
      key: 'cert-a', id: certId, materialRef: ref.ref,
      acme: { account: 'le', domains: ['a.test'] },
    }])).toHaveLength(1);
  });

  it('**사실을 모르면 안 연다** — "모른다" 를 "갱신 필요" 로 읽으면 매 틱 주문한다', async () => {
    const runner = runnerWith({ orderStatus: ['pending'] }, new FakePlacer());
    // v0.6 1단계에 올라간 자료에는 `facts.json` 이 없다.
    expect(await runner.scan([{
      // 모양은 맞고 **없는** 참조다. 모양이 틀린 참조는 다른 문제(설정 손상)라
      // `facts` 가 던지는 것이 맞다 — 여기서 재는 것은 "자료를 모른다" 쪽이다.
      key: 'cert-a', id: certId, materialRef: `store://missing@${'a'.repeat(32)}`,
      acme: { account: 'le', domains: ['a.test'] },
    }])).toHaveLength(0);
  });
});

describe('step — 한 틱에 한 걸음', () => {
  const open = async (): Promise<void> => {
    await store.openOrder({ accountId, certificateId: certId, domains: ['a.test'] });
  };

  it('pending → validating: 챌린지를 놓고 수락한다', async () => {
    await open();
    const placer = new FakePlacer();
    const r = await runnerWith({ orderStatus: ['pending'] }, placer).step();
    expect(r?.to).toBe('validating');
    expect([...placer.placed.keys()]).toEqual(['tok-a.test']);
    // **놓았다고 원장에 적혔는가** — 안 적히면 고아 스캔이 못 찾는다.
    const chs = await store.challenges(r!.order!);
    expect(chs[0]?.placedAt).toBeDefined();
  });

  it('**검증이 안 끝났으면 그대로 둔다** — 실패가 아니다', async () => {
    await open();
    await runnerWith({ orderStatus: ['pending'] }, new FakePlacer()).step();
    const r = await runnerWith({ orderStatus: ['pending'] }, new FakePlacer()).step();
    expect(r?.to).toBe('validating');
    expect(r?.error).toBeUndefined();
    // 실행권이 놓여서 다음 틱이 다시 집을 수 있어야 한다.
    expect((await store.get(r!.order!))?.attempts).toBe(0);
  });

  it('validating → ready', async () => {
    await open();
    await runnerWith({ orderStatus: ['pending'] }, new FakePlacer()).step();
    const r = await runnerWith({ orderStatus: ['ready'] }, new FakePlacer()).step();
    expect(r?.to).toBe('ready');
  });

  it('**CA 가 invalid 라고 하면 기다리지 않고 실패로 확정한다** (S18)', async () => {
    await open();
    await runnerWith({ orderStatus: ['pending'] }, new FakePlacer()).step();
    const r = await runnerWith({ orderStatus: ['invalid'] }, new FakePlacer()).step();
    expect(r?.to).toBe('failed');
    expect(r?.error).toContain('챌린지 실패');
  });

  it('ready → issued: 인증서를 받아 SecretStore 에 넣는다', async () => {
    await open();
    const pair = mintPair();
    const placer = new FakePlacer();
    await runnerWith({ orderStatus: ['pending'] }, placer).step();
    await runnerWith({ orderStatus: ['ready'] }, placer).step();
    const r = await runnerWith(
      { orderStatus: ['valid'], certPem: pair.pem, certKeyPem: pair.key } as never,
      placer,
      { newKey: () => createPrivateKey(pair.key) },
    ).step();
    expect(r?.to, r?.error).toBe('issued');

    const row = await store.get(r!.order!);
    expect(row?.issuedRef).toMatch(/^store:\/\/acme-cert-a@/);
    // **키 참조는 인증서 참조와 다르다** — 어느 키로 CSR 을 만들었나를 잃으면 안 된다.
    expect(row?.certKeyRef).toMatch(/^key:\/\/acme-cert-a@/);

    // 자료가 실제로 저장됐고 짝이 맞는다.
    const material = await secrets.get(row!.issuedRef!);
    expect(material.fullchain).toContain('BEGIN CERTIFICATE');

    // **발급하면 챌린지 자료를 치운다** (§8.2 — 성공/실패와 무관하게).
    expect(placer.removed).toEqual(['tok-a.test']);
    expect(placer.placed.size).toBe(0);
  });

  it('**키를 finalize 전에 durable 하게 둔다** — 잃으면 새 주문을 내야 한다', async () => {
    await open();
    const pair = mintPair();
    const placer = new FakePlacer();
    await runnerWith({ orderStatus: ['pending'] }, placer).step();
    await runnerWith({ orderStatus: ['ready'] }, placer).step();
    // finalize 에서 죽는 시나리오.
    const r = await runnerWith({ orderStatus: ['ready'], failOn: 'finalize' }, placer,
      { newKey: () => createPrivateKey(pair.key) }).step();
    expect(r?.to).toBe('failed');
    // 실패했어도 **키는 남아 있다.** 다음 시도가 같은 키로 이어 간다.
    const row = await store.get(r!.order!);
    expect(row?.certKeyRef).toMatch(/^key:\/\//);
    expect(await secrets.getKey(row!.certKeyRef!)).toContain('PRIVATE KEY');
  });

  it('**원하는 챌린지가 없으면 무엇이 있었는지 말한다** — 와일드카드가 그렇다 (S18)', async () => {
    await open();
    const r = await runnerWith(
      { orderStatus: ['pending'], challengeTypes: ['dns-01', 'dns-account-01'] },
      new FakePlacer(),
    ).step();
    expect(r?.to).toBe('failed');
    expect(r?.error).toContain('dns-01');
    expect(r?.error).toContain('http-01');
  });

  it('배치가 실패하면 주문이 실패한다 — 수락은 안 한다', async () => {
    await open();
    const placer = new FakePlacer();
    placer.failNext = true;
    const r = await runnerWith({ orderStatus: ['pending'] }, placer).step();
    expect(r?.to).toBe('failed');
    expect(placer.placed.size).toBe(0);
  });

  it('할 일이 없으면 undefined', async () => {
    expect(await runnerWith({ orderStatus: ['pending'] }, new FakePlacer()).step()).toBeUndefined();
  });
});

describe('고아 정리 (§8.2)', () => {
  it('**하나가 실패해도 나머지를 계속 치운다**', async () => {
    const o = await store.openOrder({ accountId, certificateId: certId, domains: ['a.test'] });
    for (const d of ['a.test', 'b.test', 'c.test']) {
      const id = await store.putChallenge({
        orderId: o.id, domain: d, type: 'http-01', token: `t-${d}`, value: 'v',
        authzUrl: 'u', challengeUrl: 'c',
      });
      await store.markPlaced(id);
    }
    await db.query(`UPDATE acme_orders SET state='abandoned', claimed_by=NULL, claimed_until=NULL
                     WHERE id=$1`, [o.id]);

    const placer = new FakePlacer();
    // 가운데 하나만 실패하게 한다.
    const original = placer.remove.bind(placer);
    let n = 0;
    placer.remove = async (domain: string, token: string): Promise<void> => {
      n += 1;
      if (n === 2) throw new Error('제거 실패');
      await original(domain, token);
    };

    const cleaned = await runnerWith({ orderStatus: ['pending'] }, placer).cleanup();
    // 하나 때문에 멈추면 나머지가 영원히 남고, 그건 고아 스캔이 있는 이유와 반대다.
    expect(cleaned).toBe(2);
    expect((await store.orphans(3600)).length).toBe(1);
  });
});

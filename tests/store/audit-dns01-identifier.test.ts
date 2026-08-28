/**
 * CA 가 준 이름을 대조한다 — 검수 2026-08-24 D19
 *
 * ── 무엇을 안 보고 있었나
 *
 * `#startOrder` 는 CA 가 준 authz 를 그대로 믿는다:
 *
 *   await placer.place(authz.identifier.value, ch.token, value);
 *   await this.#o.store.putChallenge({ domain: authz.identifier.value, ... });
 *
 * `authz.identifier.value` 는 **우리가 주문한 도메인과 같아야** 한다. 같은지 아무도
 * 안 본다. 그리고 그 값은 곧장 파일 경로가 된다:
 *
 *   dns01TxtName(domain) → `_acme-challenge.<도메인>`
 *   FileDns01.place      → writeFileSync(join(this.dir, 그것))
 *
 * `join` 은 `..` 을 정규화하므로 CA 가 `/../../../x` 같은 값을 주면 챌린지 디렉토리
 * **밖에** 파일이 쓰인다. `materializeGeneration` 이 리소스 key 로 물렸던 것과 **같은
 * 모양**이고, 그때 배운 것이 *"값이 아니라 경계에 건다"* 였다.
 *
 * ── "CA 를 못 믿나" 는 잘못된 질문이다
 *
 * 우리가 믿는 것은 **디렉토리 URL 을 적은 운영자**이지 그 URL 뒤에 있는 것이 아니다.
 * ACME 디렉토리는 설정값이고(`acme_accounts.directory_url`), 사설 CA·프록시·오타가
 * 전부 정상 배포다. 그리고 이건 신뢰의 문제가 아니라 **경계의 문제**다 — 주문한 것과
 * 다른 이름이 돌아오면 그건 배신이기 전에 **버그**이고, 버그는 조용히 파일을 쓰면
 * 안 된다.
 *
 * ── 왜 `FileDns01` 이 아니라 부르는 쪽인가
 *
 * http-01 도 **같은 값**을 쓴다(`putChallenge` 의 `domain`, 그리고 `remove(domain,…)`).
 * 배치기마다 고치면 배치기가 늘 때마다 빠뜨릴 자리가 하나 는다 — 이 회차가 이미 두 번
 * 본 모양이다(`build.sh` 의 진입점 목록 N1, `assertDirectiveStrings` 의 필드 목록 N3).
 *
 *   npm run test:store     (도커 필요)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { AcmeStore } from '../../src/control/acme-store.js';
import { AcmeRunner, type ChallengePlacer } from '../../src/control/acme-runner.js';
import { FileDns01 } from '../../src/control/dns01.js';
import { newEcKey } from '../../src/acme/der.js';
import { FsSecretStore } from '../../src/dp/secrets.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('dns01-identifier');

let db: Db;
let store: AcmeStore;
let secrets: FsSecretStore;
let root = '';
let certId = '';

/** 놓인 도메인을 기억한다 — **무엇이 경계를 넘었는지**가 이 테스트의 물음이다. */
class RecordingPlacer implements ChallengePlacer {
  readonly type = 'http-01' as const;
  readonly domains: string[] = [];
  async place(domain: string): Promise<void> { this.domains.push(domain); }
  async remove(): Promise<void> { /* 이 테스트는 치우는 것을 안 본다 */ }
}

/**
 * CA 를 흉내 낸다. **authz 가 무엇을 답할지 대본으로 준다** — 주문한 도메인과 다른
 * 이름을 돌려주는 CA 는 실물로는 부를 수 없는 분기다.
 */
function fakeClient(identifierFor: (domain: string) => string): unknown {
  return {
    async register(): Promise<string> { return 'https://ca.test/acct/1'; },
    async newOrder(domains: readonly string[]): Promise<unknown> {
      return {
        url: 'https://ca.test/order/1',
        order: {
          status: 'pending',
          finalize: 'https://ca.test/finalize/1',
          authorizations: domains.map((d) => `https://ca.test/authz/${encodeURIComponent(d)}`),
          identifiers: domains.map((value) => ({ type: 'dns', value })),
        },
      };
    },
    async fetchAuthorization(url: string): Promise<unknown> {
      const asked = decodeURIComponent(url.split('/').pop() ?? '');
      const value = identifierFor(asked);
      return {
        status: 'pending',
        identifier: { type: 'dns', value },
        challenges: [
          { type: 'http-01', url: 'https://ca.test/chall/http', token: 'tok', status: 'pending' },
          { type: 'dns-01', url: 'https://ca.test/chall/dns', token: 'tok', status: 'pending' },
        ],
      };
    },
    async acceptChallenge(): Promise<unknown> { return { status: 'processing' }; },
  };
}

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new AcmeStore(db);
  root = mkdtempSync(join(tmpdir(), 'bary-d19-'));
  secrets = new FsSecretStore(root);
}, 180_000);

afterAll(async () => {
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
  const ref = await secrets.putKey(
    `acct-${Math.random().toString(36).slice(2)}`,
    newEcKey().export({ type: 'pkcs8', format: 'pem' }).toString(),
  );
  await store.upsertAccount({
    key: 'le', directoryUrl: 'https://ca.test/dir', accountKeyRef: ref.ref, by: 't',
  });
  const r = await db.query(
    `INSERT INTO certificates (id,key,name,acme_account,acme_domains,created_by,updated_by,revision)
     VALUES (gen_random_uuid(),'cert-a','cert-a','le',$1,'t','t',1) RETURNING id`,
    [['a.test', '*.b.test']],
  );
  certId = String(r.rows[0]?.['id']);
});

const DOMAINS = ['a.test', '*.b.test'];

/** 스캔으로 주문을 열고 한 틱 돌린다. 틱이 `#startOrder` 로 들어간다. */
async function tick(
  identifierFor: (domain: string) => string,
  placer: ChallengePlacer,
  dnsPlacer?: ChallengePlacer,
): Promise<{ error?: string; to?: string }> {
  const runner = new AcmeRunner({
    store, secrets, placer,
    ...(dnsPlacer === undefined ? {} : { dnsPlacer }),
    clientFor: () => fakeClient(identifierFor) as never,
  });
  await runner.scan([{ key: 'cert-a', id: certId, acme: { account: 'le', domains: DOMAINS } }]);
  return (await runner.step()) ?? {};
}

describe('주문에 없는 도메인', () => {
  it('주문에 없는 도메인은 챌린지를 안 놓는다', async () => {
    const placer = new RecordingPlacer();
    const dns = new RecordingPlacer();
    const r = await tick(() => 'evil.test', placer, dns);

    // **놓기 전에 막혔다.** 이것이 이 테스트의 전부다.
    expect(placer.domains).toEqual([]);
    expect(dns.domains).toEqual([]);
    // 그리고 **조용히 안 지나간다** — 주문이 진행 상태로 안 넘어간다.
    expect(r.to).not.toBe('validating');
    expect(String(r.error ?? '')).toMatch(/evil\.test/);
  });

  it('경로 조각이 든 이름은 파일시스템에 안 닿는다 — `FileDns01` 이 실물이다', async () => {
    const dir = join(root, 'dns-challenges');
    const dns = new FileDns01(dir);
    const before = readdirSync(dir);

    // **`*.` 로 시작해야 dns-01 로 간다.** `challengeTypeWanted` 가 와일드카드가
    // 아니면 http-01 을 고르고, 그러면 이 케이스가 `FileDns01` 을 안 지난다 —
    // 처음 쓸 때 그래서 초록이었다. 배치기를 안 지나는 검사는 아무것도 안 잰다.
    await tick(() => '*./../../pwned', new RecordingPlacer(), dns);

    // `dns01TxtName` 이 `*.` 를 떼어 `_acme-challenge./../../pwned` 를 만들고
    // `join` 이 `..` 을 정규화한다. 막지 않으면 **챌린지 디렉토리 밖에** 쓰인다:
    //   dir/`_acme-challenge.` → `..` → dir → `..` → root → `pwned`
    expect(readdirSync(dir)).toEqual(before);
    expect(readdirSync(join(dir, '..'))).not.toContain('pwned');
  });

  it('원장에도 안 적힌다 — 안 놓은 것을 놓았다고 적지 않는다', async () => {
    await tick(() => 'evil.test', new RecordingPlacer(), new RecordingPlacer());
    const rows = await db.query('SELECT domain FROM acme_challenges');
    expect(rows.rows).toEqual([]);
  });
});

describe('주문에 있는 도메인', () => {
  /** **되는 것을 못 쓰게 만들지 않는다.** 좁히다 제품을 멈추면 그건 수정이 아니다. */
  it('정확일치는 그대로 지나간다', async () => {
    const placer = new RecordingPlacer();
    const r = await tick((asked) => asked, placer, new RecordingPlacer());
    expect(r.to).toBe('validating');
    expect(placer.domains).toContain('a.test');
  });

  /**
   * **와일드카드는 이름이 다르게 온다.** RFC 8555 §7.1.3 — `*.b.test` 를 주문하면
   * authz 의 identifier 는 `b.test` 이고 `wildcard: true` 가 붙는다. 주문 목록과
   * 문자열로만 대조하면 **정상 와일드카드 발급이 통째로 막힌다.**
   */
  it('와일드카드의 apex 도 지나간다 — `*.b.test` 의 authz 는 `b.test` 다', async () => {
    const dns = new RecordingPlacer();
    const r = await tick(
      (asked) => (asked.startsWith('*.') ? asked.slice(2) : asked),
      new RecordingPlacer(), dns,
    );
    expect(r.to).toBe('validating');
    expect(r.error).toBeUndefined();
  });
});

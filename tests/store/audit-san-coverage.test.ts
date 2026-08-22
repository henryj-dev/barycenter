/**
 * 검수 2026-08-22 · B-05 — **SAN 이 안 덮는 인증서는 바인딩되지 않는다**
 *
 * `certCoversHost` 는 SAN 기준 커버리지를 정확히 구현하고 단위 테스트도 있는데
 * **프로덕션 호출자가 없었다.** 검증기의 `sni_binding_missing` 은 *바인딩 패턴*이 호스트를
 * 덮는지만 본다 — 그 바인딩이 가리키는 **인증서가 실제로 그 호스트를 덮는지**는 아무도
 * 안 봤다.
 *
 * 그래서 `a.test` 를 SAN 이 `b.test` 뿐인 인증서에 묶어도 검증·plan·commit·apply 가 전부
 * 통과하고, handshake 에서 **커버하지 않는 인증서가 제시된다.** 주석이 "S17 합격 기준이
 * 겨눈 실패" 라고 적어 둔 바로 그것이다.
 *
 * ── 왜 `validateModel` 이 아니라 저장소인가 ─────────────────────────────
 *
 * SAN 은 **모델 밖의 사실**이다 — SecretStore 의 바이트에서 온다. `validateModel` 은
 * 순수 함수이고 그 인자 타입(`ValidationCapabilities`)은 공개 표면이다. 거기에 I/O 를
 * 끌어들이면 표면이 움직이고(동결 카운터 리셋) 순수성도 잃는다.
 *
 * 대가: `render()` 만 쓰는 라이브러리 소비자는 이 검사를 못 받는다. 그 사실을
 * `ConfigStore` 주석에 적어 뒀다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, StoreError, type PatchOp } from '../../src/store/config-store.js';
import type { CertFacts } from '../../src/dp/certinfo.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('audit-san');

const REF = (n: string): string => `store://${n}@${'a'.repeat(32)}`;

/** SAN 만 다른 두 인증서. **자료 바이트는 필요 없다** — 저장소는 `facts` 만 읽는다. */
const FACTS: Record<string, CertFacts> = {
  [REF('good')]: {
    subject: 'CN=a.test', issuer: 'CN=Test CA',
    domains: ['a.test', '*.wild.test'],
    notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2030-01-01T00:00:00.000Z',
    chainLength: 2,
  },
  [REF('other')]: {
    subject: 'CN=b.test', issuer: 'CN=Test CA',
    domains: ['b.test'],
    notBefore: '2026-01-01T00:00:00.000Z', notAfter: '2030-01-01T00:00:00.000Z',
    chainLength: 2,
  },
};

const facts = { facts: (ref: string): CertFacts | undefined => FACTS[ref] };

let db: Db;
let store: ConfigStore;

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new ConfigStore(db, { streamRealip: false }, facts);
}, 180_000);

afterAll(async () => {
  await db?.close();
  stopPg(PG);
});

beforeEach(async () => {
  await reset(db);
});

const digests = {
  chainDigest: `sha256:${'a'.repeat(64)}`,
  keyDigest: `sha256:${'b'.repeat(64)}`,
};

/** `hosts` 를 `certKey` 에 묶는 https 리스너 한 벌. */
const bind = (certKey: string, hosts: string[]): PatchOp[] => [
  { op: 'put', kind: 'pool', key: 'app', body: { protocolClass: 'http', algorithm: 'round_robin' } },
  { op: 'put', kind: 'backend', key: 'a1', body: { pool: 'app', host: '10.0.0.1', port: 8080, weight: 1 } },
  { op: 'put', kind: 'certificate', key: 'good', body: { materialRef: REF('good'), ...digests } },
  { op: 'put', kind: 'certificate', key: 'other', body: { materialRef: REF('other'), ...digests } },
  { op: 'put', kind: 'tlsPolicy', key: 'pol', body: { minVersion: '1.2' } },
  {
    op: 'put', kind: 'listener', key: 'secure',
    body: {
      protocol: 'https', bind: '0.0.0.0', port: 443, enabled: true,
      tls: { policy: 'pol', defaultCertificate: 'good' },
      http: { defaultAction: 'reject' },
    },
  },
  { op: 'put', kind: 'sniBinding', key: 'b1', body: { listener: 'secure', hosts, certificate: certKey } },
  ...hosts.map((h, i): PatchOp => ({
    op: 'put', kind: 'httpRoute', key: `r${i}`,
    body: {
      listener: 'secure', hosts: [h], priority: 0,
      action: { kind: 'proxy', pool: 'app', websocket: false },
    },
  })),
];

async function planOf(ops: PatchOp[]): Promise<void> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(cs, ops, 't');
  await store.plan(cs, 't');
}

describe('SAN 커버리지 (검수 B-05)', () => {
  it('SAN 이 안 덮는 인증서는 바인딩되지 않는다', async () => {
    // `a.test` 를 SAN 이 `b.test` 뿐인 인증서에 묶는다. 전에는 전부 통과했다.
    await expect(planOf(bind('other', ['a.test']))).rejects.toThrow(StoreError);
    await expect(planOf(bind('other', ['a.test'])))
      .rejects.toMatchObject({ status: 422, code: 'certificate_does_not_cover' });
  });

  it('덮는 인증서는 그대로 지난다', async () => {
    await planOf(bind('good', ['a.test']));
  });

  it('와일드카드 SAN 이 한 라벨을 덮는다', async () => {
    // X.509 와일드카드는 한 라벨만 보장한다 — `certCoversHost` 가 그렇게 판정한다.
    await planOf(bind('good', ['x.wild.test']));
    await expect(planOf(bind('good', ['deep.x.wild.test'])))
      .rejects.toMatchObject({ code: 'certificate_does_not_cover' });
  });

  it('사실을 모르면 판단하지 않는다', async () => {
    // v0.6 1단계에 올라간 자료는 `facts.json` 이 없다. 모르는 것을 "안 덮는다" 로 읽으면
    // 멀쩡한 설정이 막힌다 — §6.7 의 "관측 못 한 것과 실패한 것은 다르다" 와 같은 규칙이다.
    const blind = new ConfigStore(db, { streamRealip: false }, { facts: () => undefined });
    const head = await store.head();
    const cs = await blind.createChangeset(head.revision, 't');
    await blind.patchChangeset(cs, bind('other', ['a.test']), 't');
    await blind.plan(cs, 't');
  });

  it('저장소가 사실을 못 읽으면 아무것도 안 막는다', async () => {
    // SecretStore 를 안 준 배포(TLS 를 안 쓰는 v0.1~v0.5)에서 이 검사가 걸리면 안 된다.
    const noSecrets = new ConfigStore(db, { streamRealip: false });
    const head = await store.head();
    const cs = await noSecrets.createChangeset(head.revision, 't');
    await noSecrets.patchChangeset(cs, bind('other', ['a.test']), 't');
    await noSecrets.plan(cs, 't');
  });
});

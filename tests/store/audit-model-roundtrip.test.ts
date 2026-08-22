/**
 * 검수 2026-08-22 · 제안#1 — **커밋한 모델을 그대로 되읽는다**
 *
 * 이 저장소가 반복해서 밟는 함정이 있다: *"필드는 있는데 아무도 안 읽는다."*
 * 해독기가 받고 렌더러가 읽는데 **그 사이의 저장소가 없는** 필드들이 그렇다.
 *
 * 검수가 다섯을 찾았다 — `tlsPolicy.hsts` · `cipherPolicy` · `sniHostMismatch`,
 * 리스너 `http2`, 모델 `engine`. 전부 PATCH 200, plan 초록, commit 성공, 그리고
 * **렌더에서 사라진다.** DB 에 컬럼이 없었기 때문이다.
 *
 * 그 부류를 하나씩 잡는 대신 **왕복으로 막는다.** 앞으로 모델 필드를 더하면서 저장을
 * 잊으면 여기서 빨개진다 — 컬럼을 안 넣었는지 매핑을 빠뜨렸는지는 몰라도, *"들어간 것과
 * 나온 것이 다르다"* 는 항상 참이다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ConfigStore, type PatchOp, type ResourceKind } from '../../src/store/config-store.js';
import type { Model } from '../../src/model/provisional.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('audit-roundtrip');

let db: Db;
let store: ConfigStore;

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  // **capability 를 열어 둔다.** 닫아 두면 http2 를 켠 모델이 검증기에 막혀
  // 왕복을 재기도 전에 끝난다.
  store = new ConfigStore(db, {
    streamRealip: true, httpLua: true, streamLua: true, http2: true, sslConfCommand: true,
  });
}, 180_000);

afterAll(async () => {
  await db?.close();
  stopPg(PG);
});

beforeEach(async () => {
  await reset(db);
});

const REF = `store://leaf@${'a'.repeat(32)}`;

/**
 * **선택 필드를 하나도 안 비운 모델.** 왕복이 의미를 가지려면 채워야 한다 —
 * 비어 있으면 "안 저장되는 필드" 가 통과한다.
 */
const rich = (): Model => ({
  engine: { workerShutdownTimeoutS: 45 },
  pools: [
    { key: 'app', protocolClass: 'http', algorithm: 'hash', hashKey: 'header(X-Tenant)' },
    { key: 'l4', protocolClass: 'tcp', algorithm: 'round_robin', sendProxyProtocol: 'v1' },
  ],
  backends: [
    { key: 'a1', pool: 'app', host: '10.0.0.1', port: 8080, weight: 3 },
    { key: 'b1', pool: 'l4', host: '10.0.0.2', port: 9000, weight: 1 },
  ],
  certificates: [{
    key: 'leaf',
    materialRef: REF,
    chainDigest: `sha256:${'a'.repeat(64)}`,
    keyDigest: `sha256:${'b'.repeat(64)}`,
    acme: { account: 'le', domains: ['a.test', '*.a.test'] },
  }],
  tlsPolicies: [{
    key: 'strict',
    minVersion: '1.2',
    maxVersion: '1.3',
    sniHostMismatch: 'reject_421',
    cipherPolicy: 'modern-2026',
    hsts: { maxAgeSeconds: 31_536_000, includeSubdomains: true, preload: true },
  }],
  listeners: [
    {
      key: 'secure', protocol: 'https', bind: '0.0.0.0', port: 443, enabled: true,
      http2: false,
      acceptProxyProtocol: { trustedCidrs: ['10.0.0.0/8'] },
      tls: { policy: 'strict', defaultCertificate: 'leaf' },
      http: { defaultAction: 'reject' },
    },
    {
      key: 'stream', protocol: 'tcp', bind: '127.0.0.1', port: 9443, enabled: false,
      defaultPool: 'l4',
    },
  ],
  httpRoutes: [
    {
      key: 'r-api', listener: 'secure', hosts: ['a.test'], priority: 10,
      pathPrefix: '/api/', action: { kind: 'proxy', pool: 'app', websocket: true },
    },
    {
      key: 'r-old', listener: 'secure', hosts: ['a.test'], priority: 5,
      pathPrefix: '/old/', action: { kind: 'redirect', to: 'https://a.test/new/', status: 308 },
    },
  ],
  passthroughRoutes: [],
  sniBindings: [{
    key: 'bind-a', listener: 'secure', hosts: ['a.test'], certificate: 'leaf',
    override: { minVersion: '1.3' },
  }],
});

/** 모델 하나를 **처음부터 만드는** patch. 참조되는 쪽이 먼저다. */
function opsOf(model: Model): PatchOp[] {
  const put = (kind: ResourceKind, key: string, body: unknown): PatchOp =>
    ({ op: 'put', kind, key, body });
  return [
    ...(model.engine === undefined ? [] : [put('engine', 'engine', model.engine)]),
    ...model.pools.map((p) => put('pool', p.key, p)),
    ...model.backends.map((b) => put('backend', b.key, b)),
    ...model.certificates.map((c) => put('certificate', c.key, c)),
    ...model.tlsPolicies.map((t) => put('tlsPolicy', t.key, t)),
    ...model.listeners.map((l) => put('listener', l.key, l)),
    ...model.httpRoutes.map((r) => put('httpRoute', r.key, r)),
    ...model.passthroughRoutes.map((r) => put('passthroughRoute', r.key, r)),
    ...model.sniBindings.map((b) => put('sniBinding', b.key, b)),
  ];
}

/** `readModel` 은 key 로 정렬해 돌려준다. 비교 전에 같은 축으로 맞춘다. */
function normalize(m: Model): Model {
  const by = <T extends { key: string }>(xs: T[]): T[] =>
    [...xs].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return {
    ...(m.engine === undefined ? {} : { engine: m.engine }),
    listeners: by(m.listeners), httpRoutes: by(m.httpRoutes),
    passthroughRoutes: by(m.passthroughRoutes), pools: by(m.pools),
    backends: by(m.backends), certificates: by(m.certificates),
    tlsPolicies: by(m.tlsPolicies), sniBindings: by(m.sniBindings),
  };
}

async function commitModel(model: Model): Promise<string> {
  const head = await store.head();
  const cs = await store.createChangeset(head.revision, 'roundtrip');
  await store.patchChangeset(cs, opsOf(model), 'roundtrip');
  const plan = await store.plan(cs, 'roundtrip');
  return (await store.commit(cs, plan.id, 'roundtrip')).revision;
}

describe('모델 왕복 (검수 제안#1)', () => {
  it('커밋한 모델을 그대로 되읽는다', async () => {
    const input = rich();
    const revision = await commitModel(input);
    expect(normalize(await store.modelAt(revision))).toEqual(normalize(input));
  });

  it('검수가 찾은 다섯 필드를 각각 짚는다', async () => {
    // 위 단언이 전부를 덮지만, 깨졌을 때 **어느 필드인지** 바로 보이게 나눠 둔다.
    const revision = await commitModel(rich());
    const out = await store.modelAt(revision);

    const policy = out.tlsPolicies[0];
    expect(policy?.hsts).toEqual({
      maxAgeSeconds: 31_536_000, includeSubdomains: true, preload: true,
    });
    expect(policy?.cipherPolicy).toBe('modern-2026');
    expect(policy?.sniHostMismatch).toBe('reject_421');

    const secure = out.listeners.find((l) => l.key === 'secure');
    expect(secure?.protocol === 'https' ? secure.http2 : undefined).toBe(false);

    expect(out.engine).toEqual({ workerShutdownTimeoutS: 45 });
  });

  it('저장한 것이 렌더에도 나온다', async () => {
    // 저장은 됐는데 렌더가 안 읽는 경우도 같은 부류다. 끝까지 따라간다.
    const revision = await commitModel(rich());
    const conf = (await store.renderAt(revision)).conf;

    expect(conf).toContain('add_header Strict-Transport-Security');
    expect(conf).toContain('includeSubDomains');
    expect(conf).toContain('ssl_conf_command Ciphersuites');
    expect(conf).toContain('worker_shutdown_timeout 45s;');
    // `http2: false` 를 명시했으니 나오면 안 된다 — 기본값(켬)이 이기면 안 된다.
    expect(conf).not.toContain('http2 on;');
  });

  it('두 번째 export/import 는 리비전을 안 올린다', async () => {
    const revision = await commitModel(rich());
    const manifest = await store.exportAt(revision);
    const again = await store.importFromManifest(manifest, 'replace', 'roundtrip');
    expect(again.unchanged).toBe(true);
  });
});

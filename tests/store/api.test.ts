/**
 * REST 표면 — **API 레벨 테스트가 하나도 없었다**
 *
 * 라우트 서른 개가 e2e 로만 밟히고 있었다. e2e 는 도커·PG·nginx 를 다 띄우고 행복한
 * 경로를 통과시키는 물건이라, **오류 응답을 거의 안 본다.** "없는 풀을 물으면 404 인가",
 * "커밋된 changeset 을 버리려 하면 409 인가" 같은 것은 거기서 재기에 너무 비싸고, 그래서
 * 안 쟀다.
 *
 * 안 재면 어떻게 되는가 — 이 저장소가 반복해서 배운 대로다. 빈 배열로 답하는 404,
 * 200 을 돌려주는 실패, 조용히 무시되는 오타. 전부 **호출자가 성공으로 읽는** 모양이다.
 *
 * ── 여기서 재는 것 ──────────────────────────────────────────────────────
 *
 *   · §5.2 가 요구한 읽기 엔드포인트가 실제로 있는가
 *   · **없는 것과 비어 있는 것을 구분하는가** — 오타 하나가 빈 목록으로 보이면 안 된다
 *   · `/certificates` 응답에 개인키가 없는가 (§8.1)
 *   · changeset 폐기의 상태 전이 — open/sealed 만, 커밋된 것은 409
 *
 * 컨트롤 플레인은 안 태운다. 여기 있는 라우트들은 `store` 와 `db` 만 만진다 — apply
 * 경로는 e2e 와 conformance 가 진다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';

import { createApi } from '../../src/api/server.js';
import { ConfigStore, type PatchOp } from '../../src/store/config-store.js';
import { ControlPlane } from '../../src/control/plane.js';
import { TokenAuth } from '../../src/api/auth.js';
import { LeaderElection } from '../../src/control/leader.js';
import type { DataplaneDriver } from '../../src/dp/driver.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('api');
const TOKEN = 'api-test-token';
let db: Db;
let store: ConfigStore;
let server: import('node:http').Server;
let base = '';

/**
 * apply 를 안 부르므로 아무것도 안 하는 드라이버로 충분하다.
 *
 * **부르면 터지게 둔다.** 조용한 no-op 으로 두면 나중에 누가 apply 경로를 이 테스트에
 * 넣었을 때 "성공했다" 는 거짓말을 받게 된다.
 */
const driver: DataplaneDriver = new Proxy({} as DataplaneDriver, {
  get: (_t, prop) => () => {
    throw new Error(`이 테스트는 데이터 플레인을 안 태운다 (호출됨: ${String(prop)})`);
  },
});

async function req(method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const r = await fetch(`${base}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await r.text();
  if (text === '') return { status: r.status, body: null };
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
}

/** changeset 한 바퀴 — 커밋까지. */
async function commitAll(patch: PatchOp[]): Promise<string> {
  const head = await store.head();
  const id = await store.createChangeset(head.revision, 't');
  await store.patchChangeset(id, patch, 't');
  const plan = await store.plan(id, 't');
  await store.commit(id, plan.id, 't');
  return id;
}

const PUT = (kind: PatchOp extends { kind: infer K } ? K : never, key: string, body: unknown): PatchOp =>
  ({ op: 'put', kind, key, body } as PatchOp);

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  store = new ConfigStore(db, { streamRealip: false });

  const election = new LeaderElection(PG.dsn, 'api-test');
  // **리더가 돼야 쓰기 스코프가 열린다** — 스탠바이는 비-read 요청에 503 을 준다 (§3.5).
  if (!(await election.tryAcquire())) throw new Error('리더 획득 실패');
  const control = new ControlPlane(db, store, driver, election,
    { prefix: '/tmp/bary-api-test', adminPort: 19999 });
  const hash = (await import('node:crypto')).createHash('sha256').update(TOKEN).digest('hex');
  const auth = new TokenAuth([
    { name: 'tester', hash: `sha256:${hash}`, scopes: ['read', 'write', 'apply'] },
  ]);

  server = createApi({ db, store, control, auth, election });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}, 180_000);

afterAll(async () => {
  await new Promise<void>((r) => server?.close(() => r()));
  await db?.close();
  stopPg(PG);
});

beforeEach(async () => {
  await reset(db);
});

// ── 읽기 표면 ───────────────────────────────────────────────────────────

describe('§5.2 읽기 엔드포인트', () => {
  it('모델이 비어 있으면 **빈 배열이지 404 가 아니다**', async () => {
    for (const path of ['/api/v1/listeners', '/api/v1/pools', '/api/v1/backends',
      '/api/v1/certificates', '/api/v1/tls-policies', '/api/v1/sni-bindings']) {
      const r = await req('GET', path);
      expect(r.status, path).toBe(200);
      expect(r.body, path).toEqual([]);
    }
  });

  it('TLS 리소스가 리소스별로 읽힌다 — 모델을 통째로 안 받아도 된다', async () => {
    await commitAll([
      PUT('certificate', 'cert-a', {
        materialRef: `store://a@${'a'.repeat(32)}`,
        chainDigest: `sha256:${'0'.repeat(64)}`, keyDigest: `sha256:${'1'.repeat(64)}`,
      }),
      PUT('tlsPolicy', 'modern', { minVersion: '1.2', maxVersion: '1.3' }),
    ]);

    const certs = await req('GET', '/api/v1/certificates');
    expect(certs.status).toBe(200);
    expect(certs.body.map((c: { key: string }) => c.key)).toEqual(['cert-a']);

    const policies = await req('GET', '/api/v1/tls-policies');
    expect(policies.body).toEqual([{ key: 'modern', minVersion: '1.2', maxVersion: '1.3' }]);
  });

  /**
   * **§8.1 — GUI 는 개인키를 절대 되돌려주지 않는다.**
   *
   * `Certificate` 타입에 자료를 담을 자리가 없다는 것은 *지금의* 타입이 그렇다는 말이지
   * 앞으로도 그렇다는 보장이 아니다. 응답 **전체 문자열**로 검사한다 — 특정 필드만 보면
   * 나중에 다른 필드로 새는 것을 못 잡는다.
   */
  it('**`/certificates` 응답에 자료가 없다**', async () => {
    await commitAll([PUT('certificate', 'cert-a', {
      materialRef: `store://a@${'a'.repeat(32)}`,
      chainDigest: `sha256:${'0'.repeat(64)}`, keyDigest: `sha256:${'1'.repeat(64)}`,
    })]);
    const raw = JSON.stringify((await req('GET', '/api/v1/certificates')).body);
    expect(raw).not.toContain('PRIVATE KEY');
    expect(raw).not.toContain('BEGIN CERTIFICATE');
    expect(raw).not.toContain('fullchain');
    expect(raw).not.toContain('privkey');
    // 참조는 나간다 — 그게 설정이고, 자료가 아니다.
    expect(raw).toContain('store://a@');
  });
});

/**
 * **픽스처가 새 테이블을 비우는가.**
 *
 * `reset` 의 `TRUNCATE ... CASCADE` 는 *참조하는* 쪽을 데려간다. `certificates` 와
 * `tls_policies` 는 `listeners` 가 참조하는 쪽이라 **안 딸려온다** — 목록에 이름을 적지
 * 않으면 테스트 사이에 그대로 남는다.
 *
 * 픽스처 주석이 이미 같은 사고를 적어 뒀다: `leadership` 을 빠뜨려 리더 선출 테스트 넷이
 * 깨졌는데 증상은 코드처럼 보였다.
 *
 * **읽기 엔드포인트로는 이걸 못 잡는다.** `/certificates` 는 `modelAt` 을 거치고 그건
 * `config_revisions.model` **스냅샷**을 읽는데, 스냅샷 테이블은 truncate 목록에 있다.
 * 그래서 응답은 깨끗한데 테이블에는 남아 있는 상태가 된다 — 처음에 이 테스트를 응답으로
 * 쓰다가, 통과하는 것을 보고 무엇을 재고 있는지 다시 봤다. **테이블에 직접 묻는다.**
 */
describe('픽스처', () => {
  it('**reset 이 TLS 테이블도 비운다** — 앞 테스트가 만든 행이 안 남는다', async () => {
    for (const table of ['certificates', 'tls_policies', 'sni_certificate_bindings']) {
      const n = (await db.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0]?.['n'];
      expect(n, table).toBe(0);
    }
  });
});

describe('없는 것과 비어 있는 것', () => {
  beforeEach(async () => {
    await commitAll([
      PUT('pool', 'app', { protocolClass: 'http', algorithm: 'round_robin' }),
      PUT('backend', 'b1', { pool: 'app', host: '10.0.0.1', port: 80, weight: 1 }),
      PUT('pool', 'empty', { protocolClass: 'tcp', algorithm: 'round_robin' }),
    ]);
  });

  it('풀의 백엔드를 골라 준다', async () => {
    const r = await req('GET', '/api/v1/pools/app/backends');
    expect(r.status).toBe(200);
    expect(r.body.map((b: { key: string }) => b.key)).toEqual(['b1']);
  });

  it('**백엔드가 없는 풀은 빈 배열, 없는 풀은 404** — 오타가 빈 목록으로 보이면 안 된다', async () => {
    expect((await req('GET', '/api/v1/pools/empty/backends')).body).toEqual([]);
    expect((await req('GET', '/api/v1/pools/없는것/backends')).status).toBe(404);
  });

  it('**관측이 없는 백엔드는 `unknown`, 없는 백엔드는 404**', async () => {
    // §6.6 이 "아직 재보지 못한 것과 죽은 것은 다르다" 고 한 것과 같은 구분이다.
    const r = await req('GET', '/api/v1/backends/b1/status');
    expect(r.status).toBe(200);
    expect(r.body.state).toBe('unknown');
    expect(r.body.pool).toBe('app');
    expect((await req('GET', '/api/v1/backends/없는것/status')).status).toBe(404);
  });
});

// ── changeset 폐기 ──────────────────────────────────────────────────────

describe('DELETE /changesets/{id}', () => {
  it('open 인 것을 버린다 — 204', async () => {
    const head = await store.head();
    const id = await store.createChangeset(head.revision, 't');
    expect((await req('DELETE', `/api/v1/changesets/${id}`)).status).toBe(204);
    // 행이 사라지지 않는다. 감사 기록이 가리킬 대상이 남아야 한다.
    const row = (await db.query('SELECT state FROM changesets WHERE id=$1', [id])).rows[0];
    expect(row?.['state']).toBe('discarded');
  });

  it('sealed 인 것도 버린다 — **그리고 매달린 plan 을 죽인다**', async () => {
    const head = await store.head();
    const id = await store.createChangeset(head.revision, 't');
    await store.patchChangeset(id,
      [PUT('pool', 'p', { protocolClass: 'http', algorithm: 'round_robin' })], 't');
    const plan = await store.plan(id, 't');

    expect((await req('DELETE', `/api/v1/changesets/${id}`)).status).toBe(204);

    // **안 죽이면 재생 경로가 남는다** — 버린 changeset 의 plan_id 로 commit 하면
    // 아무도 의도하지 않은 모델이 리비전이 된다. reopen 이 같은 이유로 같은 일을 한다.
    const st = (await db.query('SELECT state FROM plans WHERE id=$1', [plan.id])).rows[0];
    expect(st?.['state']).toBe('expired');
    await expect(store.commit(id, plan.id, 't')).rejects.toThrow();
  });

  it('**커밋된 것은 못 버린다** — 409. 되돌리는 것은 롤백이지 폐기가 아니다', async () => {
    const id = await commitAll([PUT('pool', 'p', { protocolClass: 'http', algorithm: 'round_robin' })]);
    const r = await req('DELETE', `/api/v1/changesets/${id}`);
    expect(r.status).toBe(409);
    expect(r.body.code ?? r.body.error).toBe('not_discardable');
  });

  it('없는 것은 404 — 성공으로 답하지 않는다', async () => {
    const r = await req('DELETE', '/api/v1/changesets/00000000-0000-0000-0000-000000000000');
    expect(r.status).toBe(404);
  });

  it('버린 뒤에는 PATCH 도 막힌다', async () => {
    const head = await store.head();
    const id = await store.createChangeset(head.revision, 't');
    await req('DELETE', `/api/v1/changesets/${id}`);
    const r = await req('PATCH', `/api/v1/changesets/${id}`, {
      patch: [{ op: 'put', kind: 'pool', key: 'p', body: { protocolClass: 'http', algorithm: 'round_robin' } }],
    });
    expect(r.status).toBeGreaterThanOrEqual(400);
  });
});

describe('§5.5 export / import', () => {
  it('export 한 것을 다시 import 하면 리비전이 안 오른다', async () => {
    await commitAll([
      PUT('pool', 'app', { protocolClass: 'http', algorithm: 'round_robin' }),
      PUT('backend', 'a-11', { pool: 'app', host: '10.0.0.1', port: 80, weight: 1 }),
    ]);
    const first = await req('GET', '/api/v1/config/export');
    expect(first.status).toBe(200);
    expect(first.body.schemaVersion).toBe('1');
    expect(first.body.resources.some((r: { kind: string }) => r.kind === 'pool')).toBe(true);

    const before = (await req('GET', '/api/v1/config/head')).body.revision;
    const again = await req('POST', '/api/v1/config/import', first.body);
    expect(again.status).toBe(200);
    expect(again.body.unchanged).toBe(true);
    expect(again.body.revision).toBe(before);
  });
});

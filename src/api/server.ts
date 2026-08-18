/**
 * REST API — `/api/v1` (DESIGN.md §5.1, §5.2)
 *
 * **모든 쓰기는 changeset 을 지난다.** 직접 CRUD 엔드포인트는 없다 (§5.3). 리소스는
 * 읽기만 되고, 바꾸려면 changeset 을 열어 patch → plan → commit → apply 를 지나야 한다.
 *
 * 프레임워크를 안 쓴다. `node:http` 로 충분한 크기이고, v0.1 에서 늘리고 싶지 않은 것은
 * 코드가 아니라 **의존성**이다 (§11.2 가 PG 하나만 쓰기로 한 것과 같은 이유다).
 *
 * ── §5.1 상태 코드 4분할 ─────────────────────────────────────────────────
 *
 * | 상황 | 코드 |
 * |---|---|
 * | `If-Match` 불일치 | **412** |
 * | 상태와 충돌하지만 해소 가능 (head 이동 · sealed 인데 PATCH) | **409** |
 * | 상태와 무관하게 의미적으로 불가능 (UDP + acceptProxyProtocol) | **422** |
 * | 타입·구문 오류 | **400** |
 *
 * **428 은 v0.1 에 쓸 자리가 없다.** 조건부 헤더를 *요구하는* 엔드포인트가 없기
 * 때문이다 — 직접 리소스 편집이 없으니 전제조건은 전부 커밋의 `base_revision`(→409)으로
 * 표현된다. 쓸 데 없는 코드를 미리 배선해 두지 않는다. v0.4 CLI/GUI 가 단일 리소스
 * 편집을 낼 때 함께 들어온다.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';

import type { ControlPlane } from '../control/plane.js';
import { healthRows } from '../control/health.js';
import { render as renderMetrics } from '../obs/metrics.js';
import { NotLeader, type LeaderElection } from '../control/leader.js';
import { ConfigStore, StoreError, type PatchOp } from '../store/config-store.js';
import type { Db } from '../store/pg.js';
import type { SecretStore } from '../dp/secrets.js';
import { CertMaterialError, inspectMaterial } from '../dp/certinfo.js';
import { can, TokenAuth, type Principal, type Scope } from './auth.js';
import { EventHub, openEventStream } from './events.js';

export type ApiOptions = {
  db: Db;
  store: ConfigStore;
  control: ControlPlane;
  auth: TokenAuth;
  election: LeaderElection;
  /** 본문 상한. 없으면 한 요청이 프로세스를 삼킬 수 있다. */
  maxBodyBytes?: number;
  /** 인증서 자료 저장소 (§4.8). 없으면 업로드 엔드포인트가 501 이다. */
  secrets?: SecretStore;
  /** SSE 허브. 없으면 서버가 하나 만든다. */
  events?: EventHub;
  /** 테스트가 하트비트를 기다리도록. 기본 15s. */
  heartbeatMs?: number;
};

const eventsOf = (api: ApiOptions): EventHub => {
  api.events ??= new EventHub();
  return api.events;
};

const DEFAULT_MAX_BODY = 4 * 1024 * 1024;

type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  who: Principal;
  body: unknown;
  params: Record<string, string>;
};

type Route = {
  method: string;
  pattern: RegExp;
  keys: string[];
  scope: Scope;
  handle: (c: Ctx, api: ApiOptions) => Promise<void>;
};

const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void => {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
};

/** `/api/v1/changesets/:id/plan` → 정규식 + 키 이름. */
function route(
  method: string, path: string, scope: Scope,
  handle: (c: Ctx, api: ApiOptions) => Promise<void>,
): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' + path.replace(/:([a-zA-Z]+)/g, (_, k: string) => {
      keys.push(k);
      return '([^/]+)';
    }) + '$',
  );
  return { method, pattern, keys, scope, handle };
}

const asPatchOps = (v: unknown): PatchOp[] => {
  if (!Array.isArray(v)) {
    throw new StoreError(400, 'malformed', 'patch 는 배열이어야 한다');
  }
  return v as PatchOp[];
};

const field = (body: unknown, name: string): string => {
  const v = (body as Record<string, unknown> | null)?.[name];
  if (typeof v !== 'string' || v === '') {
    throw new StoreError(400, 'malformed', `본문에 '${name}' 문자열이 필요하다`);
  }
  return v;
};

/** changeset 의 ETag — 누적된 patch 의 내용으로 만든다. */
const changesetEtag = (patch: unknown, state: string): string =>
  `"${createHash('sha256').update(`${state}:${JSON.stringify(patch)}`).digest('hex').slice(0, 16)}"`;

const ROUTES: Route[] = [
  // ── 읽기 ───────────────────────────────────────────────────────────────
  route('GET', '/api/v1/config/head', 'read', async (c, api) => {
    const head = await api.store.head();
    json(c.res, 200, head, { etag: head.etag });
  }),

  route('GET', '/api/v1/config/model', 'read', async (c, api) => {
    const rev = c.url.searchParams.get('revision') ?? (await api.store.head()).revision;
    json(c.res, 200, { revision: rev, model: await api.store.modelAt(rev) });
  }),

  route('GET', '/api/v1/config/rendered', 'read', async (c, api) => {
    const rev = c.url.searchParams.get('revision') ?? (await api.store.head()).revision;
    // **저장소를 거친다.** 여기서 `render()` 를 직접 부르면 capability 인자를 빼먹고,
    // 그러면 엔진이 할 수 있는 조합을 못 읽는다 — 실제로 그랬다.
    const r = await api.store.renderAt(rev);
    json(c.res, 200, { revision: rev, digest: r.digest, planes: r.planes, conf: r.conf });
  }),

  /**
   * §5.5 export. spec-only. CLI `bary export` 가 이걸 그대로 찍는다.
   */
  route('GET', '/api/v1/config/export', 'read', async (c, api) => {
    const rev = c.url.searchParams.get('revision') ?? (await api.store.head()).revision;
    json(c.res, 200, await api.store.exportAt(rev));
  }),

  /**
   * §5.5 import. 단일 changeset. 차이가 없으면 리비전을 안 올린다.
   * nginx 적용은 `/apply` 의 몫이다 — import 가 적용까지 하면 그 경로만 덜 검증된다.
   */
  route('POST', '/api/v1/config/import', 'write', async (c, api) => {
    const body = c.body;
    const wrapped = body !== null && typeof body === 'object' && !Array.isArray(body)
      && 'manifest' in (body as object);
    const mode = wrapped && (body as { mode?: unknown }).mode === 'replace' ? 'replace' : 'merge';
    const input = wrapped ? (body as { manifest: unknown }).manifest : body;
    const out = await api.store.importFromManifest(input, mode, c.who.name);
    eventsOf(api).publish('revision', { revision: out.revision, unchanged: out.unchanged });
    json(c.res, 200, out);
  }),

  route('GET', '/api/v1/listeners', 'read', async (c, api) => {
    json(c.res, 200, (await api.store.modelAt((await api.store.head()).revision)).listeners);
  }),
  route('GET', '/api/v1/pools', 'read', async (c, api) => {
    json(c.res, 200, (await api.store.modelAt((await api.store.head()).revision)).pools);
  }),
  route('GET', '/api/v1/backends', 'read', async (c, api) => {
    json(c.res, 200, (await api.store.modelAt((await api.store.head()).revision)).backends);
  }),
  route('GET', '/api/v1/routes', 'read', async (c, api) => {
    const m = await api.store.modelAt((await api.store.head()).revision);
    json(c.res, 200, { http: m.httpRoutes, passthrough: m.passthroughRoutes });
  }),

  /**
   * 한 풀의 백엔드만 (§5.2 `GET /pools/{id}/backends`).
   *
   * 없는 풀은 **404 다.** 빈 배열로 답하면 "백엔드가 없는 풀" 과 "없는 풀" 이 같은
   * 응답이 되고, 오타 하나가 조용히 빈 목록으로 보인다.
   */
  route('GET', '/api/v1/pools/:id/backends', 'read', async (c, api) => {
    const m = await api.store.modelAt((await api.store.head()).revision);
    const key = c.params['id'] ?? '';
    if (!m.pools.some((p) => p.key === key)) {
      json(c.res, 404, { error: 'not_found', message: `풀 '${key}' 가 없다` });
      return;
    }
    json(c.res, 200, m.backends.filter((b) => b.pool === key));
  }),

  /**
   * 백엔드 하나의 헬스 (§5.2 `GET /backends/{id}/status`).
   *
   * **아직 재보지 못한 것과 없는 것을 구분한다.** 모델에 있으면 200 이고, 관측이 없으면
   * `unknown` 이다 — §6.6 이 그 둘을 다르게 다루는 것과 같은 이유다. 모르는 키만 404 다.
   */
  route('GET', '/api/v1/backends/:id/status', 'read', async (c, api) => {
    const m = await api.store.modelAt((await api.store.head()).revision);
    const key = c.params['id'] ?? '';
    const backend = m.backends.find((b) => b.key === key);
    if (backend === undefined) {
      json(c.res, 404, { error: 'not_found', message: `백엔드 '${key}' 가 없다` });
      return;
    }
    const row = (await healthRows(api.db)).find((h) => h.backendKey === key);
    json(c.res, 200, {
      backend: key, pool: backend.pool, host: backend.host, port: backend.port,
      ...(row === undefined
        ? { state: 'unknown', observedAt: null, detail: '아직 관측이 없다' }
        : { state: row.state, observedAt: row.observedAt, ...(row.detail === undefined ? {} : { detail: row.detail }) }),
    });
  }),

  /**
   * TLS 리소스 읽기 (§5.2).
   *
   * **`certificates` 에 자료가 없다는 것이 여기서 계약이 된다** (§8.1). `Certificate` 는
   * 메타데이터 타입이라 개인키를 담을 자리가 애초에 없지만, 그건 지금의 타입이 그렇다는
   * 말이지 앞으로도 그렇다는 보장이 아니다 — 그래서 적합성 테스트가 이 응답에
   * `PRIVATE KEY` 가 없다는 것을 **응답 전체 문자열로** 검사한다.
   */
  route('GET', '/api/v1/certificates', 'read', async (c, api) => {
    const certs = (await api.store.modelAt((await api.store.head()).revision)).certificates;
    const secrets = api.secrets;
    const now = Date.now();
    json(c.res, 200, certs.map((cert) => {
      // **사실은 참조에서 온다.** 설정에 적힌 값을 믿으면 클라이언트가 만료일을
      // 거짓말할 수 있고, 그러면 만료 알람이 안 울린다 (§4.6 · §7.2).
      // 자료가 없으면(ACME 발급 전) 사실도 없다. **목록에서 빼지 않는다** — 발급을
      // 기다리는 인증서가 안 보이면 "왜 안 나오지" 를 묻게 된다.
      const f = cert.materialRef === undefined ? undefined : secrets?.facts(cert.materialRef);
      if (f === undefined) return { ...cert, facts: null };
      return {
        ...cert,
        domains: f.domains,
        subject: f.subject,
        issuer: f.issuer,
        notBefore: f.notBefore,
        notAfter: f.notAfter,
        // 운영자가 제일 먼저 보는 값이다. 음수면 이미 만료다.
        expiresInDays: Math.floor((new Date(f.notAfter).getTime() - now) / 86_400_000),
      };
    }));
  }),
  route('GET', '/api/v1/tls-policies', 'read', async (c, api) => {
    json(c.res, 200, (await api.store.modelAt((await api.store.head()).revision)).tlsPolicies);
  }),
  route('GET', '/api/v1/sni-bindings', 'read', async (c, api) => {
    json(c.res, 200, (await api.store.modelAt((await api.store.head()).revision)).sniBindings);
  }),

  // ── changeset (유일한 쓰기 경로) ───────────────────────────────────────
  route('POST', '/api/v1/changesets', 'write', async (c, api) => {
    const base = (c.body as { base_revision?: unknown } | null)?.base_revision;
    const baseRevision = base === undefined ? (await api.store.head()).revision : String(base);
    const id = await api.store.createChangeset(baseRevision, c.who.name);
    json(c.res, 201, { id, base_revision: baseRevision, state: 'open' },
      { location: `/api/v1/changesets/${id}` });
  }),

  route('GET', '/api/v1/changesets/:id', 'read', async (c, api) => {
    const r = (await api.db.query(
      `SELECT id, base_revision, state, patch, created_by, committed_revision
         FROM changesets WHERE id=$1`, [c.params['id']],
    )).rows[0];
    if (r === undefined) throw new StoreError(404, 'unknown_changeset', 'changeset 이 없다');
    const etag = changesetEtag(r['patch'], String(r['state']));
    json(c.res, 200, {
      id: r['id'], base_revision: String(r['base_revision']), state: r['state'],
      patch: r['patch'], created_by: r['created_by'],
      committed_revision: r['committed_revision'] === null ? null : String(r['committed_revision']),
    }, { etag });
  }),

  route('PATCH', '/api/v1/changesets/:id', 'write', async (c, api) => {
    const id = c.params['id'] ?? '';
    // §5.1 — `If-Match` 는 **대상 표현**의 전제조건이다. 두 사람이 같은 changeset 을
    // 동시에 고칠 때 뒤엣것이 앞엣것을 모르고 덮는 것을 막는다. 주지 않으면 검사하지
    // 않는다 (요구하지 않으므로 428 이 아니다).
    const ifMatch = c.req.headers['if-match'];
    if (typeof ifMatch === 'string') {
      const cur = (await api.db.query('SELECT patch, state FROM changesets WHERE id=$1', [id])).rows[0];
      if (cur === undefined) throw new StoreError(404, 'unknown_changeset', 'changeset 이 없다');
      const etag = changesetEtag(cur['patch'], String(cur['state']));
      if (ifMatch !== etag && ifMatch !== '*') {
        throw new StoreError(412, 'precondition_failed',
          `If-Match 가 현재 표현과 다르다 (현재 ${etag}) — 다시 읽고 다시 보내라`);
      }
    }
    await api.store.patchChangeset(id, asPatchOps((c.body as { patch?: unknown } | null)?.patch), c.who.name);
    json(c.res, 200, { id, ok: true });
  }),

  route('POST', '/api/v1/changesets/:id/plan', 'write', async (c, api) => {
    json(c.res, 200, await api.store.plan(c.params['id'] ?? '', c.who.name));
  }),

  route('DELETE', '/api/v1/changesets/:id', 'write', async (c, api) => {
    await api.store.discardChangeset(c.params['id'] ?? '', c.who.name);
    // 본문 없이 204. 버린 것에 대해 돌려줄 내용이 없다.
    c.res.writeHead(204);
    c.res.end();
  }),

  route('POST', '/api/v1/changesets/:id/reopen', 'write', async (c, api) => {
    await api.store.reopen(c.params['id'] ?? '', c.who.name);
    json(c.res, 200, { id: c.params['id'], state: 'open' });
  }),

  route('POST', '/api/v1/changesets/:id/commit', 'write', async (c, api) => {
    const planId = field(c.body, 'plan_id');
    const out = await api.store.commit(c.params['id'] ?? '', planId, c.who.name);
    eventsOf(api).publish('revision', { revision: out.revision });
    json(c.res, 200, out);
  }),

  route('GET', '/api/v1/plans/:id', 'read', async (c, api) => {
    json(c.res, 200, await api.store.getPlan(c.params['id'] ?? ''));
  }),

  /**
   * 롤백 (§5.3).
   *
   * **과거 리비전을 `/apply` 로 되돌리는 경로는 없다** — 일반 apply 는 언제나 head 만
   * 적용한다. 되돌리려면 여기를 지나야 하고, 여기는 head 를 뒤로 옮기는 대신 그 시점의
   * 내용으로 **새 리비전**을 만든다.
   *
   * 스코프는 `apply` 다. 되돌리는 것은 고치는 것보다 무거운 권한이지 가벼운 권한이
   * 아니다 — 트래픽이 즉시 바뀐다.
   */
  route('POST', '/api/v1/rollback', 'apply', async (c, api) => {
    const to = field(c.body, 'to_revision');
    const note = (c.body as { note?: unknown } | null)?.note;
    const rolled = await api.store.rollbackTo(to, c.who.name,
      typeof note === 'string' ? note : undefined);
    eventsOf(api).publish('revision', { revision: rolled.revision, rollbackOf: rolled.rollbackOf });
    // 만들기만 하고 적용은 `/apply` 가 한다. 롤백만의 적용 경로를 따로 두면 그 경로만
    // 덜 검증된다 — 정작 급할 때 쓰는 경로가 가장 안 밟힌 경로가 된다.
    json(c.res, 200, rolled);
  }),

  // ── 적용·관찰 ──────────────────────────────────────────────────────────
  route('POST', '/api/v1/apply', 'apply', async (c, api) => {
    const planId = field(c.body, 'plan_id');
    const out = await api.control.apply(planId, c.who.name);
    eventsOf(api).publish('apply', { planId, phase: out.phase });
    json(c.res, 200, out);
  }),

  route('GET', '/api/v1/operations/:id', 'read', async (c, api) => {
    json(c.res, 200, await api.control.operation(c.params['id'] ?? ''));
  }),

  route('POST', '/api/v1/operations/:id/cancel', 'apply', async (c, api) => {
    json(c.res, 200, await api.control.cancel(c.params['id'] ?? '', c.who.name));
  }),

  route('POST', '/api/v1/recover', 'apply', async (c, api) => {
    json(c.res, 200, await api.control.recover(c.who.name));
  }),

  route('GET', '/api/v1/status', 'read', async (c, api) => {
    json(c.res, 200, await api.control.status());
  }),

  /**
   * §5.2 · §10 SSE. 스냅샷 + 델타 + 하트비트. GUI 는 폴링하지 않는다.
   * 핸들러가 연결이 끊길 때까지 await 한다.
   */
  route('GET', '/api/v1/events', 'read', async (c, api) => {
    await openEventStream({
      req: c.req,
      res: c.res,
      hub: eventsOf(api),
      snapshot: () => api.control.status(),
      ...(api.heartbeatMs === undefined ? {} : { heartbeatMs: api.heartbeatMs }),
    });
  }),

  /**
   * §5.2 `GET /health/backends`.
   *
   * **`unknown` 을 숨기지 않는다.** 아직 재보지 못한 것과 산 것은 다르고, 그 구분이
   * 없으면 프로버가 죽었는지 백엔드가 다 산 것인지 알 수 없다 (§6.7 프로버 장애).
   */
  route('GET', '/api/v1/health/backends', 'read', async (c, api) => {
    json(c.res, 200, await healthRows(api.db));
  }),

  /**
   * Prometheus 노출.
   *
   * **인증을 요구한다.** 스크레이퍼가 토큰을 들고 다니는 불편보다, 풀 이름과 리비전이
   * 인증 없이 나가는 편이 나쁘다 — `/healthz` 와 다르다. 그쪽은 "살아 있나" 하나뿐이고
   * 이쪽은 배포 구조를 말한다.
   */
  route('GET', '/metrics', 'read', async (c, api) => {
    c.res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    c.res.end(renderMetrics(
      await api.control.gauges(), await api.control.certificateExpiry()));
  }),

  /**
   * 인증서 **자료 업로드** (§4.8 · §8.1).
   *
   * ── 왜 changeset 을 안 거치는가 ─────────────────────────────────────
   *
   * 자료는 설정이 아니다. changeset → plan → commit → apply 는 **모델**을 옮기는 길이고,
   * 개인키가 그 길을 지나가면 `config_revisions.model` 스냅샷에 평문으로 남는다 —
   * §4.8 이 정확히 금지하는 것이다. 그래서 자료는 여기로 들어가 SecretStore 에 앉고,
   * 설정에는 **불변 버전 참조**만 들어간다.
   *
   * 응답은 참조와 digest 뿐이다. **개인키는 어떤 경로로도 안 나간다** (§8.1: *"GUI 는
   * 개인키를 절대 되돌려주지 않는다"*). 그래서 이 자원에는 GET 이 없다 — 읽을 수 있는
   * 것을 만들어 두면 언젠가 읽힌다.
   */
  route('POST', '/api/v1/certificates/material', 'write', async (c, api) => {
    const store = api.secrets;
    if (store === undefined) {
      json(c.res, 501, { error: 'no_secret_store', message: 'SecretStore 가 설정되지 않았다' });
      return;
    }
    const b = (c.body ?? {}) as Record<string, unknown>;
    const name = b['name'];
    const fullchain = b['fullchain'];
    const privkey = b['privkey'];
    if (typeof name !== 'string' || typeof fullchain !== 'string' || typeof privkey !== 'string') {
      json(c.res, 400, {
        error: 'invalid_body',
        message: 'name·fullchain·privkey 가 모두 문자열이어야 한다',
      });
      return;
    }
    /**
     * **§7.2 의 검증을 여기서 한다** — *"직후 인증서-키 일치·SAN·not_after 검증."*
     *
     * 안 하면 실패가 사라지는 게 아니라 **옮겨간다.** 무관한 한 쌍은 저장되고, apply 의
     * `nginx -t` 에서 며칠 뒤 터진다 — 그때 보이는 것은 "설정이 이상하다" 이지 "올린
     * 키가 그 인증서 것이 아니다" 가 아니다. 만료는 더 나쁘다: 아무 데서도 안 터지고
     * **handshake 만 조용히 깨진다.**
     */
    let facts;
    try {
      facts = inspectMaterial(fullchain, privkey);
    } catch (e) {
      const err = e as CertMaterialError;
      json(c.res, 400, {
        error: 'invalid_certificate',
        kind: err.kind ?? 'unparsable',
        message: err.message,
      });
      return;
    }

    try {
      const ref = store.put(name, { fullchain, privkey });
      // **자료를 안 돌려준다.** 참조·digest 와 **바이트에서 뽑은 사실**만 나간다.
      //
      // 이 사실들을 changeset 으로 받지 않는 이유가 있다 — 클라이언트가 만료일을
      // 거짓말할 수 있고, 그러면 만료 알람이 안 울린다. 내용 주소 참조에 매달아 두면
      // 사실도 내용의 함수가 된다.
      json(c.res, 201, {
        ref: ref.ref, name: ref.name, version: ref.version,
        chainDigest: ref.chainDigest, keyDigest: ref.keyDigest,
        subject: facts.subject, issuer: facts.issuer, domains: facts.domains,
        notBefore: facts.notBefore, notAfter: facts.notAfter,
        chainLength: facts.chainLength,
      });
    } catch (e) {
      json(c.res, 400, { error: 'invalid_body', message: (e as Error).message });
    }
  }),

  route('GET', '/api/v1/audit', 'read', async (c, api) => {
    const limit = Math.min(Number(c.url.searchParams.get('limit') ?? '100') || 100, 1000);
    const rows = (await api.db.query(
      `SELECT id, at, principal, action, subject, revision FROM audit
        ORDER BY id DESC LIMIT $1`, [limit],
    )).rows;
    json(c.res, 200, rows.map((r) => ({
      id: String(r['id']), at: r['at'], principal: r['principal'],
      action: r['action'], subject: r['subject'],
      revision: r['revision'] === null ? null : String(r['revision']),
    })));
  }),
];

async function readBody(req: IncomingMessage, max: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const b = chunk as Buffer;
    size += b.length;
    // **상한을 넘으면 즉시 끊는다.** 다 읽고 나서 재면 이미 메모리를 다 쓴 뒤다.
    if (size > max) throw new StoreError(413, 'body_too_large', `본문이 ${max} 바이트를 넘는다`);
    chunks.push(b);
  }
  if (size === 0) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new StoreError(400, 'malformed', 'JSON 이 아니다');
  }
}

export function createApi(api: ApiOptions): Server {
  const max = api.maxBodyBytes ?? DEFAULT_MAX_BODY;
  return createServer((req, res) => {
    void handle(req, res, api, max).catch((e) => {
      // 여기까지 온 것은 핸들러 밖의 실패다. 조용히 끊지 않는다.
      if (!res.headersSent) json(res, 500, { code: 'internal', message: String(e) });
      else res.end();
    });
  });
}

async function handle(
  req: IncomingMessage, res: ServerResponse, api: ApiOptions, max: number,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // 인증 없이 답하는 유일한 자리. 살아 있는지 묻는 데 토큰을 요구하면 오케스트레이터가
  // 토큰을 들고 다녀야 하고, 그 토큰이 곧 새는 경로가 된다.
  if (url.pathname === '/healthz') {
    json(res, 200, { ok: true });
    return;
  }

  const who = api.auth.authenticate(req.headers.authorization);
  if (who === undefined) {
    json(res, 401, { code: 'unauthenticated', message: 'Bearer 토큰이 필요하다' },
      { 'www-authenticate': 'Bearer' });
    return;
  }

  const matched = ROUTES.map((r) => ({ r, m: r.pattern.exec(url.pathname) }))
    .filter((x) => x.m !== null);
  if (matched.length === 0) {
    json(res, 404, { code: 'no_route', message: `${url.pathname} 은 없다` });
    return;
  }
  const hit = matched.find((x) => x.r.method === req.method);
  if (hit === undefined) {
    // **경로는 있는데 메서드가 다른 것과 없는 것은 다르다.** 405 로 구분해 주지 않으면
    // 클라이언트가 오타와 권한 문제를 구별할 수 없다.
    json(res, 405, {
      code: 'method_not_allowed',
      message: `${url.pathname} 은 ${matched.map((x) => x.r.method).join(', ')} 만 받는다`,
    }, { allow: matched.map((x) => x.r.method).join(', ') });
    return;
  }

  if (!can(who, hit.r.scope)) {
    json(res, 403, {
      code: 'forbidden',
      message: `'${hit.r.scope}' 스코프가 필요하다 (가진 것: ${[...who.scopes].join(',') || '없음'})`,
    });
    return;
  }

  // **스탠바이는 읽기만 답한다** (§3.5 · §11.4).
  //
  // `apply` 만 막고 `write` 는 열어 둘까 고민했는데, 그러면 스탠바이에 커밋해 놓고
  // 적용이 안 되는 상태를 사람이 만들 수 있다. head 는 PG 가 직렬화하니 안전하긴 하지만
  // **안전한 것과 이해할 수 있는 것은 다르다.** 리더 하나만 쓴다.
  //
  // **503 이지 403 이 아니다.** 권한이 없는 것이 아니라 *여기서는* 못 하는 것이고,
  // 다른 인스턴스에서는 되고 이 인스턴스도 승격되면 된다.
  if (hit.r.scope !== 'read' && !api.election.state.isLeader) {
    const s = api.election.state;
    json(res, 503, {
      code: 'not_leader',
      message: `이 인스턴스는 리더가 아니다 — ${s.reason ?? '리더가 아니다'}`,
      holder: s.holder,
    }, { 'retry-after': '5' });
    return;
  }

  const params: Record<string, string> = {};
  hit.r.keys.forEach((k, i) => {
    params[k] = decodeURIComponent(hit.m?.[i + 1] ?? '');
  });

  try {
    const body = req.method === 'GET' || req.method === 'DELETE'
      ? null : await readBody(req, max);
    await hit.r.handle({ req, res, url, who, body, params }, api);
  } catch (e) {
    if (e instanceof StoreError) {
      json(res, e.status, {
        code: e.code, message: e.message,
        ...(e.detail === undefined ? {} : { detail: e.detail }),
      });
      return;
    }
    // 라우팅 시점에 리더였는데 부작용 직전에 아니게 된 경우다. 창이 있다는 사실
    // 자체는 못 없앤다 — 닫는 것은 DP Agent 의 토큰 비교다 (§3.5).
    if (e instanceof NotLeader) {
      json(res, e.status, { code: e.code, message: e.message }, { 'retry-after': '5' });
      return;
    }
    throw e;
  }
}

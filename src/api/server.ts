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

import { render } from '../conf/render.js';
import type { ControlPlane } from '../control/plane.js';
import { ConfigStore, StoreError, type PatchOp } from '../store/config-store.js';
import type { Db } from '../store/pg.js';
import { can, TokenAuth, type Principal, type Scope } from './auth.js';

export type ApiOptions = {
  db: Db;
  store: ConfigStore;
  control: ControlPlane;
  auth: TokenAuth;
  /** 본문 상한. 없으면 한 요청이 프로세스를 삼킬 수 있다. */
  maxBodyBytes?: number;
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
    const model = await api.store.modelAt(rev);
    const r = render(model);
    json(c.res, 200, { revision: rev, digest: r.digest, planes: r.planes, conf: r.conf });
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

  route('POST', '/api/v1/changesets/:id/reopen', 'write', async (c, api) => {
    await api.store.reopen(c.params['id'] ?? '', c.who.name);
    json(c.res, 200, { id: c.params['id'], state: 'open' });
  }),

  route('POST', '/api/v1/changesets/:id/commit', 'write', async (c, api) => {
    const planId = field(c.body, 'plan_id');
    json(c.res, 200, await api.store.commit(c.params['id'] ?? '', planId, c.who.name));
  }),

  route('GET', '/api/v1/plans/:id', 'read', async (c, api) => {
    json(c.res, 200, await api.store.getPlan(c.params['id'] ?? ''));
  }),

  // ── 적용·관찰 ──────────────────────────────────────────────────────────
  route('POST', '/api/v1/apply', 'apply', async (c, api) => {
    json(c.res, 200, await api.control.apply(field(c.body, 'plan_id'), c.who.name));
  }),

  route('GET', '/api/v1/operations/:id', 'read', async (c, api) => {
    json(c.res, 200, await api.control.operation(c.params['id'] ?? ''));
  }),

  route('POST', '/api/v1/recover', 'apply', async (c, api) => {
    json(c.res, 200, await api.control.recover(c.who.name));
  }),

  route('GET', '/api/v1/status', 'read', async (c, api) => {
    json(c.res, 200, await api.control.status());
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
    throw e;
  }
}

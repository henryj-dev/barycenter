/**
 * 정본 저장소 — changeset → plan → commit (DESIGN.md §5.2, §5.3, §4.0)
 *
 * **모든 쓰기는 changeset 을 지난다.** 직접 CRUD 는 없다 (§5.3). 단일 리소스 편집도
 * 서버가 암묵 changeset 을 만들어 처리한다. 그래야 감사와 리비전이 한 군데서 생긴다.
 *
 * 세 층이 각각 다른 것을 막는다.
 *
 *   1. **해독** (`decodeModel`)  — 모양. PATCH 시점에 400 으로 튕긴다
 *   2. **DB 제약**               — 단일 행 조합 · 복합 FK. 애플리케이션이 잊어도 안 뚫린다
 *   3. **트랜잭션 검증기**       — 소켓 겹침 · 참조 그래프. plan/commit 트랜잭션 안에서
 *
 * 3 이 `render()` 다 — 렌더러가 `decodeModel` + `validateModel` 을 자기 안에서 다시 돌린다
 * (fail closed, 4차 검수 Critical). 그래서 "렌더가 나왔다" 는 것 자체가 검증 통과의 증거다.
 */
import { randomUUID } from 'node:crypto';

import { render, type RenderedConfig } from '../conf/render.js';
import { decodeModel } from '../model/decode.js';
import { ModelValidationError } from '../validate/model.js';
import type {
  Backend,
  HttpRoute,
  Listener,
  Model,
  PassthroughRoute,
  Pool,
  SniOutcome,
} from '../model/provisional.js';
import type { Db, Queryable, Row } from './pg.js';

/** 렌더 결과를 리비전에 결박하기 위한 표식 (§5.3 `renderer_version_changed`). */
export const RENDERER_VERSION = 'v0.1';

export type ResourceKind = 'pool' | 'backend' | 'listener' | 'httpRoute' | 'passthroughRoute';

export type PatchOp =
  | { op: 'put'; kind: ResourceKind; key: string; body: unknown }
  | { op: 'delete'; kind: ResourceKind; key: string };

/**
 * §5.1 의 상태 코드 4분할을 값으로 든다.
 *
 * | 상황 | 코드 |
 * |---|---|
 * | 전제조건 불일치 (`base_revision ≠ head`) | 409 |
 * | 상태와 충돌하지만 해소 가능 (소켓 점유, sealed 인데 PATCH) | 409 |
 * | 상태와 무관하게 의미적으로 불가능 (UDP + upstream_tls) | 422 |
 * | 타입·구문 오류 | 400 |
 */
export class StoreError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'StoreError';
  }
}

export type Head = { revision: string; etag: string };

export type PlanRecord = {
  id: string;
  changesetId: string;
  state: string;
  baseRevision: string;
  model: Model;
  impact: Impact;
  renderDigest: string;
  rendererVersion: string;
  expiresAt: string;
  targetRevision: string | undefined;
  activationEpoch: string | undefined;
};

/** §5.4 — plan 이 보여주는 것. v0.1 은 이 부분집합만 낸다. */
export type Impact = {
  requiresReload: boolean;
  affectedListeners: { key: string; protocol: string; bind: string; port: number }[];
  socketChanges: { added: string[]; removed: string[] };
  planes: ('http' | 'stream')[];
  confDiff: { before: number; after: number };
};

const PLAN_TTL_MS = 24 * 60 * 60 * 1000;

const text = (r: Row, k: string): string => String(r[k]);
const maybeText = (r: Row, k: string): string | undefined =>
  r[k] === null || r[k] === undefined ? undefined : String(r[k]);
const num = (r: Row, k: string): number => Number(r[k]);
const bool = (r: Row, k: string): boolean => r[k] === true;

/** DB 가 준 배열 컬럼. pg 는 `text[]` 를 JS 배열로 준다. */
const list = (r: Row, k: string): string[] => (Array.isArray(r[k]) ? (r[k] as string[]) : []);

// ── 모델 읽기 ────────────────────────────────────────────────────────────

async function readModel(c: Queryable): Promise<Model> {
  const pools = (await c.query(
    `SELECT key, protocol_class, algorithm, hash_key, send_proxy_protocol
       FROM pools ORDER BY key`,
  )).rows.map((r): Pool => ({
    key: text(r, 'key'),
    protocolClass: text(r, 'protocol_class') as Pool['protocolClass'],
    algorithm: text(r, 'algorithm') as Pool['algorithm'],
    ...(maybeText(r, 'hash_key') !== undefined ? { hashKey: text(r, 'hash_key') } : {}),
    ...(maybeText(r, 'send_proxy_protocol') !== undefined
      ? { sendProxyProtocol: 'v1' as const }
      : {}),
  }));

  const backends = (await c.query(
    `SELECT b.key, p.key AS pool, b.host, b.port, b.weight
       FROM backends b JOIN pools p ON p.id = b.pool_id
      WHERE b.enabled ORDER BY b.key`,
  )).rows.map((r): Backend => ({
    key: text(r, 'key'),
    pool: text(r, 'pool'),
    host: text(r, 'host'),
    port: num(r, 'port'),
    weight: num(r, 'weight'),
  }));

  const listeners = (await c.query(
    `SELECT l.key, l.protocol, l.bind, l.port, l.enabled, l.accept_proxy_protocol,
            l.udp_preset, l.preread_timeout_s, l.http_default_reject, l.on_unmatched_sni_reject,
            dp.key AS default_pool, hp.key AS http_default_pool, sp.key AS sni_pool
       FROM listeners l
       LEFT JOIN pools dp ON dp.id = l.default_pool_id
       LEFT JOIN pools hp ON hp.id = l.http_default_pool_id
       LEFT JOIN pools sp ON sp.id = l.on_unmatched_sni_pool
      ORDER BY l.key`,
  )).rows.map((r): Listener => {
    const base = {
      key: text(r, 'key'),
      bind: text(r, 'bind'),
      port: num(r, 'port'),
      enabled: bool(r, 'enabled'),
    };
    const app = r['accept_proxy_protocol'];
    const pp = app === null || app === undefined ? {} : { acceptProxyProtocol: app === true };
    const protocol = text(r, 'protocol');
    if (protocol === 'http') {
      const hp = maybeText(r, 'http_default_pool');
      const reject = bool(r, 'http_default_reject');
      const action = hp !== undefined ? { pool: hp } : reject ? ('reject' as const) : undefined;
      return {
        ...base, protocol: 'http', ...pp,
        ...(action !== undefined ? { http: { defaultAction: action } } : {}),
      };
    }
    if (protocol === 'tls_passthrough') {
      const sp = maybeText(r, 'sni_pool');
      const reject = bool(r, 'on_unmatched_sni_reject');
      const outcome: SniOutcome | undefined =
        sp !== undefined ? { pool: sp } : reject ? 'reject' : undefined;
      const t = maybeText(r, 'preread_timeout_s');
      return {
        ...base, protocol: 'tls_passthrough', ...pp,
        ...(outcome !== undefined ? { onUnmatchedSni: outcome } : {}),
        ...(t !== undefined ? { prereadTimeoutS: Number(t) } : {}),
      };
    }
    if (protocol === 'udp') {
      return {
        ...base, protocol: 'udp',
        defaultPool: text(r, 'default_pool'),
        udp: { preset: text(r, 'udp_preset') as 'dns' },
      };
    }
    return { ...base, protocol: 'tcp', defaultPool: text(r, 'default_pool'), ...pp };
  });

  const httpRoutes = (await c.query(
    `SELECT r.key, l.key AS listener, r.hosts, r.priority, r.path_prefix,
            r.action_kind, p.key AS pool, r.websocket, r.redirect_to, r.status
       FROM http_routes r
       JOIN listeners l ON l.id = r.listener_id
       LEFT JOIN pools p ON p.id = r.pool_id
      ORDER BY r.key`,
  )).rows.map((r): HttpRoute => ({
    key: text(r, 'key'),
    listener: text(r, 'listener'),
    hosts: list(r, 'hosts'),
    priority: num(r, 'priority'),
    ...(maybeText(r, 'path_prefix') !== undefined ? { pathPrefix: text(r, 'path_prefix') } : {}),
    action:
      text(r, 'action_kind') === 'proxy'
        ? { kind: 'proxy', pool: text(r, 'pool'), websocket: bool(r, 'websocket') }
        : text(r, 'action_kind') === 'redirect'
          ? { kind: 'redirect', to: text(r, 'redirect_to'), status: num(r, 'status') as 301 }
          : { kind: 'reject', status: num(r, 'status') as 403 },
  }));

  const passthroughRoutes = (await c.query(
    `SELECT r.key, l.key AS listener, r.snis, r.priority, r.action_kind, p.key AS pool
       FROM passthrough_routes r
       JOIN listeners l ON l.id = r.listener_id
       LEFT JOIN pools p ON p.id = r.pool_id
      ORDER BY r.key`,
  )).rows.map((r): PassthroughRoute => ({
    key: text(r, 'key'),
    listener: text(r, 'listener'),
    snis: list(r, 'snis'),
    priority: num(r, 'priority'),
    action:
      text(r, 'action_kind') === 'proxy'
        ? { kind: 'proxy', pool: text(r, 'pool') }
        : { kind: 'reject' },
  }));

  return { listeners, httpRoutes, passthroughRoutes, pools, backends };
}

// ── 패치 적용 ────────────────────────────────────────────────────────────

/** 풀 키 → `(id, protocol_class)`. 복합 FK 를 걸려면 둘 다 필요하다. */
async function poolRef(c: Queryable, key: string, subject: string): Promise<[string, string]> {
  const r = (await c.query('SELECT id, protocol_class FROM pools WHERE key = $1', [key])).rows[0];
  if (r === undefined) {
    throw new StoreError(422, 'unknown_pool', `'${subject}' 가 존재하지 않는 풀 '${key}' 를 참조한다`);
  }
  return [text(r, 'id'), text(r, 'protocol_class')];
}

async function listenerRef(c: Queryable, key: string, subject: string): Promise<[string, string]> {
  const r = (await c.query('SELECT id, protocol FROM listeners WHERE key = $1', [key])).rows[0];
  if (r === undefined) {
    throw new StoreError(422, 'unknown_listener', `'${subject}' 가 존재하지 않는 리스너 '${key}' 를 참조한다`);
  }
  return [text(r, 'id'), text(r, 'protocol')];
}

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

async function applyOp(c: Queryable, op: PatchOp, revision: string, by: string): Promise<void> {
  if (op.op === 'delete') {
    const table = {
      pool: 'pools', backend: 'backends', listener: 'listeners',
      httpRoute: 'http_routes', passthroughRoute: 'passthrough_routes',
    }[op.kind];
    const r = await c.query(`DELETE FROM ${table} WHERE key = $1`, [op.key]);
    if (r.rowCount === 0) {
      throw new StoreError(409, 'not_found', `${op.kind} '${op.key}' 가 없다`);
    }
    return;
  }

  const b = obj(op.body);
  switch (op.kind) {
    case 'pool':
      await c.query(
        `INSERT INTO pools (id,key,name,protocol_class,algorithm,hash_key,send_proxy_protocol,
                            created_by,updated_by,revision)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$7,$8)
         ON CONFLICT (key) DO UPDATE SET
           name=EXCLUDED.name, protocol_class=EXCLUDED.protocol_class,
           algorithm=EXCLUDED.algorithm, hash_key=EXCLUDED.hash_key,
           send_proxy_protocol=EXCLUDED.send_proxy_protocol,
           version=pools.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by,
           revision=EXCLUDED.revision`,
        [op.key, b['name'] ?? op.key, b['protocolClass'], b['algorithm'],
          b['hashKey'] ?? null, b['sendProxyProtocol'] ?? null, by, revision],
      );
      return;

    case 'backend': {
      const [poolId] = await poolRef(c, String(b['pool']), `backend '${op.key}'`);
      await c.query(
        `INSERT INTO backends (id,key,pool_id,host,port,weight,created_by,updated_by,revision)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$6,$7)
         ON CONFLICT (key) DO UPDATE SET
           pool_id=EXCLUDED.pool_id, host=EXCLUDED.host, port=EXCLUDED.port,
           weight=EXCLUDED.weight, version=backends.version+1, updated_at=now(),
           updated_by=EXCLUDED.updated_by, revision=EXCLUDED.revision`,
        [op.key, poolId, b['host'], b['port'], b['weight'] ?? 1, by, revision],
      );
      return;
    }

    case 'listener': {
      const protocol = String(b['protocol']);
      const http = obj(b['http']);
      const da = http['defaultAction'];
      const sni = b['onUnmatchedSni'];
      // 판별 유니온을 컬럼으로 편다. **프로토콜에 없는 필드는 NULL 로 못 박는다** —
      // 값을 남겨 두면 나중에 프로토콜이 바뀔 때 아무도 의도하지 않은 설정이 되살아난다.
      const dpool = protocol === 'tcp' || protocol === 'udp'
        ? await poolRef(c, String(b['defaultPool']), `listener '${op.key}'`) : undefined;
      const hpool = protocol === 'http' && obj(da)['pool'] !== undefined
        ? await poolRef(c, String(obj(da)['pool']), `listener '${op.key}'`) : undefined;
      const spool = protocol === 'tls_passthrough' && obj(sni)['pool'] !== undefined
        ? await poolRef(c, String(obj(sni)['pool']), `listener '${op.key}'`) : undefined;
      await c.query(
        `INSERT INTO listeners (id,key,name,protocol,bind,port,enabled,accept_proxy_protocol,
                                udp_preset,http_default_pool_id,http_default_pool_cls,
                                http_default_reject,on_unmatched_sni_pool,on_unmatched_sni_cls,
                                on_unmatched_sni_reject,preread_timeout_s,
                                default_pool_id,default_pool_cls,created_by,updated_by,revision)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$18,$19)
         ON CONFLICT (key) DO UPDATE SET
           name=EXCLUDED.name, protocol=EXCLUDED.protocol, bind=EXCLUDED.bind,
           port=EXCLUDED.port, enabled=EXCLUDED.enabled,
           accept_proxy_protocol=EXCLUDED.accept_proxy_protocol,
           udp_preset=EXCLUDED.udp_preset,
           http_default_pool_id=EXCLUDED.http_default_pool_id,
           http_default_pool_cls=EXCLUDED.http_default_pool_cls,
           http_default_reject=EXCLUDED.http_default_reject,
           on_unmatched_sni_pool=EXCLUDED.on_unmatched_sni_pool,
           on_unmatched_sni_cls=EXCLUDED.on_unmatched_sni_cls,
           on_unmatched_sni_reject=EXCLUDED.on_unmatched_sni_reject,
           preread_timeout_s=EXCLUDED.preread_timeout_s,
           default_pool_id=EXCLUDED.default_pool_id, default_pool_cls=EXCLUDED.default_pool_cls,
           version=listeners.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by,
           revision=EXCLUDED.revision`,
        [op.key, b['name'] ?? op.key, protocol, b['bind'], b['port'], b['enabled'] ?? true,
          b['acceptProxyProtocol'] ?? null,
          protocol === 'udp' ? obj(b['udp'])['preset'] : null,
          hpool?.[0] ?? null, hpool?.[1] ?? null, da === 'reject' ? true : null,
          spool?.[0] ?? null, spool?.[1] ?? null, sni === 'reject' ? true : null,
          protocol === 'tls_passthrough' ? b['prereadTimeoutS'] ?? null : null,
          dpool?.[0] ?? null, dpool?.[1] ?? null, by, revision],
      );
      return;
    }

    case 'httpRoute': {
      const [lid, lproto] = await listenerRef(c, String(b['listener']), `route '${op.key}'`);
      const action = obj(b['action']);
      const kind = String(action['kind']);
      const pool = kind === 'proxy'
        ? await poolRef(c, String(action['pool']), `route '${op.key}'`) : undefined;
      await c.query(
        `INSERT INTO http_routes (id,key,listener_id,listener_protocol,hosts,priority,path_prefix,
                                  action_kind,pool_id,pool_cls,websocket,redirect_to,status,
                                  created_by,updated_by,revision)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13,$14)
         ON CONFLICT (key) DO UPDATE SET
           listener_id=EXCLUDED.listener_id, listener_protocol=EXCLUDED.listener_protocol,
           hosts=EXCLUDED.hosts, priority=EXCLUDED.priority, path_prefix=EXCLUDED.path_prefix,
           action_kind=EXCLUDED.action_kind, pool_id=EXCLUDED.pool_id, pool_cls=EXCLUDED.pool_cls,
           websocket=EXCLUDED.websocket, redirect_to=EXCLUDED.redirect_to, status=EXCLUDED.status,
           version=http_routes.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by,
           revision=EXCLUDED.revision`,
        [op.key, lid, lproto, b['hosts'] ?? [], b['priority'] ?? 0, b['pathPrefix'] ?? null,
          kind, pool?.[0] ?? null, pool?.[1] ?? null,
          kind === 'proxy' ? action['websocket'] ?? false : null,
          kind === 'redirect' ? action['to'] ?? null : null,
          kind === 'proxy' ? null : action['status'] ?? null,
          by, revision],
      );
      return;
    }

    case 'passthroughRoute': {
      const [lid, lproto] = await listenerRef(c, String(b['listener']), `route '${op.key}'`);
      const action = obj(b['action']);
      const kind = String(action['kind']);
      const pool = kind === 'proxy'
        ? await poolRef(c, String(action['pool']), `route '${op.key}'`) : undefined;
      await c.query(
        `INSERT INTO passthrough_routes (id,key,listener_id,listener_protocol,snis,priority,
                                         action_kind,pool_id,pool_cls,created_by,updated_by,revision)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$9,$10)
         ON CONFLICT (key) DO UPDATE SET
           listener_id=EXCLUDED.listener_id, listener_protocol=EXCLUDED.listener_protocol,
           snis=EXCLUDED.snis, priority=EXCLUDED.priority, action_kind=EXCLUDED.action_kind,
           pool_id=EXCLUDED.pool_id, pool_cls=EXCLUDED.pool_cls,
           version=passthrough_routes.version+1, updated_at=now(),
           updated_by=EXCLUDED.updated_by, revision=EXCLUDED.revision`,
        [op.key, lid, lproto, b['snis'] ?? [], b['priority'] ?? 0, kind,
          pool?.[0] ?? null, pool?.[1] ?? null, by, revision],
      );
      return;
    }
  }
}

/**
 * DB 가 던진 제약 위반을 §5.1 의 코드로 옮긴다.
 *
 * **`23514`(CHECK) 는 422 다** — 상태와 무관하게 의미적으로 불가능한 조합이라는 뜻이다.
 * `23503`(FK) 는 참조 대상이 있느냐에 달렸으므로 422, `23505`(unique) 는 사용자가 키를
 * 바꿔 해소할 수 있으므로 409.
 */
function translate(e: unknown): never {
  const err = e as { code?: string; constraint?: string; message?: string; detail?: string };
  const where = err.constraint !== undefined ? ` (${err.constraint})` : '';
  if (err.code === '23514') {
    throw new StoreError(422, 'constraint_violation',
      `DB 제약을 위반한다${where} — 그 프로토콜에 없는 필드 조합이다`, err.detail);
  }
  if (err.code === '23503') {
    throw new StoreError(422, 'reference_violation',
      `참조가 성립하지 않는다${where} — 대상이 없거나 프로토콜 계열이 어긋난다`, err.detail);
  }
  if (err.code === '23505') {
    throw new StoreError(409, 'duplicate_key', `이미 있는 키다${where}`, err.detail);
  }
  throw e;
}

// ── 저장소 ───────────────────────────────────────────────────────────────

export class ConfigStore {
  constructor(private readonly db: Db) {}

  async head(): Promise<Head> {
    const r = (await this.db.query('SELECT revision FROM config_head')).rows[0];
    if (r === undefined) throw new StoreError(500, 'no_head', 'config_head 가 비어 있다');
    const revision = text(r, 'revision');
    return { revision, etag: `"r${revision}"` };
  }

  async modelAt(revision: string): Promise<Model> {
    const r = (await this.db.query(
      'SELECT model FROM config_revisions WHERE revision = $1', [revision],
    )).rows[0];
    if (r === undefined) throw new StoreError(404, 'unknown_revision', `리비전 ${revision} 이 없다`);
    return r['model'] as Model;
  }

  async createChangeset(baseRevision: string, by: string): Promise<string> {
    const id = randomUUID();
    try {
      await this.db.query(
        'INSERT INTO changesets (id, base_revision, created_by) VALUES ($1,$2,$3)',
        [id, baseRevision, by],
      );
    } catch (e) {
      const err = e as { code?: string };
      if (err.code === '23503') {
        throw new StoreError(422, 'unknown_revision', `base_revision ${baseRevision} 이 없다`);
      }
      throw e;
    }
    await this.audit(by, 'changeset.create', id, undefined, { baseRevision });
    return id;
  }

  /** 변경 누적. **`open` 일 때만**. sealed 이후의 PATCH 는 409 (§5.2). */
  async patchChangeset(id: string, ops: PatchOp[], by: string): Promise<void> {
    for (const op of ops) shapeCheck(op);
    const r = await this.db.query(
      `UPDATE changesets SET patch = patch || $2::jsonb
        WHERE id = $1 AND state = 'open' RETURNING id`,
      [id, JSON.stringify(ops)],
    );
    if (r.rowCount === 0) {
      const cur = (await this.db.query('SELECT state FROM changesets WHERE id=$1', [id])).rows[0];
      if (cur === undefined) throw new StoreError(404, 'unknown_changeset', `changeset ${id} 이 없다`);
      throw new StoreError(409, 'changeset_not_open',
        `changeset 이 '${text(cur, 'state')}' 다 — 열려 있을 때만 고칠 수 있다. reopen 하라`);
    }
    await this.audit(by, 'changeset.patch', id, undefined, ops);
  }

  /**
   * seal 하고 plan 을 만든다 (§5.3 `planned`).
   *
   * **패치를 실제로 적용해 보고 되돌린다.** 손으로 만든 그림자 상태에 대고 검증하면 DB 가
   * 거는 제약이 빠지고, 그러면 plan 이 초록인데 commit 이 빨간 상황이 생긴다 — plan 의
   * 존재 이유가 없어진다.
   */
  async plan(changesetId: string, by: string): Promise<PlanRecord> {
    const cs = (await this.db.query(
      'SELECT state, base_revision, patch FROM changesets WHERE id=$1', [changesetId],
    )).rows[0];
    if (cs === undefined) throw new StoreError(404, 'unknown_changeset', `changeset ${changesetId} 이 없다`);
    const state = text(cs, 'state');
    if (state !== 'open' && state !== 'sealed') {
      throw new StoreError(409, 'changeset_closed', `changeset 이 '${state}' 다`);
    }
    const baseRevision = text(cs, 'base_revision');
    const ops = cs['patch'] as PatchOp[];

    const { model, rendered, before } = await this.db.dryRun(async (c) => {
      const prior = await readModel(c);
      const beforeConf = safeRender(prior);
      for (const op of ops) await applyOp(c, op, baseRevision, by).catch(translate);
      const next = await readModel(c);
      return { model: next, rendered: renderOrThrow(next), before: beforeConf };
    });

    const impact = impactOf(before?.conf ?? '', rendered, model);
    const id = randomUUID();
    await this.db.tx(async (c) => {
      await c.query(
        `UPDATE changesets SET state='sealed', sealed_at=now() WHERE id=$1 AND state IN ('open','sealed')`,
        [changesetId],
      );
      await c.query(
        `INSERT INTO plans (id,changeset_id,base_revision,model,impact,render_digest,
                            renderer_version,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,now() + ($8 || ' milliseconds')::interval)`,
        [id, changesetId, baseRevision, JSON.stringify(model), JSON.stringify(impact),
          rendered.digest, RENDERER_VERSION, String(PLAN_TTL_MS)],
      );
    });
    await this.audit(by, 'changeset.plan', changesetId, undefined, { planId: id });
    return {
      id, changesetId, state: 'planned', baseRevision, model, impact,
      renderDigest: rendered.digest, rendererVersion: RENDERER_VERSION,
      expiresAt: new Date(Date.now() + PLAN_TTL_MS).toISOString(),
      targetRevision: undefined, activationEpoch: undefined,
    };
  }

  /** sealed → open. plan 을 무효화한다 (§5.2 reopen). */
  async reopen(changesetId: string, by: string): Promise<void> {
    await this.db.tx(async (c) => {
      const r = await c.query(
        `UPDATE changesets SET state='open', sealed_at=NULL WHERE id=$1 AND state='sealed' RETURNING id`,
        [changesetId],
      );
      if (r.rowCount === 0) {
        throw new StoreError(409, 'not_sealed', 'sealed 인 changeset 만 reopen 할 수 있다');
      }
      // **여기서 plan 을 죽이지 않으면 재생 경로가 남는다** — reopen 뒤에 옛 plan_id 로
      // commit 하면 이미 바뀐 changeset 과 무관한 모델이 커밋된다.
      await c.query(`UPDATE plans SET state='expired' WHERE changeset_id=$1 AND state='planned'`,
        [changesetId]);
    });
    await this.audit(by, 'changeset.reopen', changesetId, undefined, undefined);
  }

  /**
   * `plan_id` 를 **단회 소비**한다 (§5.3).
   *
   * 이 순간 `target_revision` 과 `activation_epoch` 를 예약해 artifact 에 결박한다.
   * plan 시점에는 둘의 할당 규칙이 없다 — 그때 매기면 두 plan 이 같은 epoch 를 받는다.
   */
  async commit(changesetId: string, planId: string, by: string): Promise<{
    revision: string; activationEpoch: string;
  }> {
    const out = await this.db.tx(async (c) => {
      // **head 행을 잠근다.** 동시 커밋 둘 중 하나는 반드시 진다.
      const headRow = (await c.query('SELECT revision FROM config_head FOR UPDATE')).rows[0];
      const head = text(headRow ?? {}, 'revision');

      const plan = (await c.query(
        `SELECT p.state, p.base_revision, p.model, p.changeset_id, p.expires_at
           FROM plans p WHERE p.id = $1 FOR UPDATE`, [planId],
      )).rows[0];
      if (plan === undefined) throw new StoreError(404, 'unknown_plan', `plan ${planId} 이 없다`);
      if (text(plan, 'changeset_id') !== changesetId) {
        throw new StoreError(409, 'plan_mismatch', 'plan 이 이 changeset 의 것이 아니다');
      }
      const pstate = text(plan, 'state');
      if (pstate !== 'planned') {
        throw new StoreError(409, 'PLAN_STALE',
          pstate === 'expired' ? 'plan 이 무효다 (expired) — replan 하라'
            : `plan 이 이미 '${pstate}' 다 — plan_id 는 단회 소비다`);
      }
      if (new Date(String(plan['expires_at'])).getTime() < Date.now()) {
        await c.query(`UPDATE plans SET state='expired' WHERE id=$1`, [planId]);
        throw new StoreError(409, 'PLAN_STALE', 'plan 이 만료됐다 (expired) — replan 하라');
      }
      const base = text(plan, 'base_revision');
      if (base !== head) {
        throw new StoreError(409, 'PLAN_STALE',
          `head 가 움직였다 (head_moved): base=${base} head=${head} — rebase 후 replan 하라`);
      }

      const ops = (await c.query('SELECT patch FROM changesets WHERE id=$1', [changesetId]))
        .rows[0]?.['patch'] as PatchOp[];

      const revision = text(
        (await c.query(`SELECT nextval('config_revision_seq') AS v`)).rows[0] ?? {}, 'v');

      for (const op of ops) await applyOp(c, op, revision, by).catch(translate);

      // **커밋 트랜잭션 안에서 다시 검증한다** (§4.0 트랜잭션 검증기).
      // plan 이 통과했다고 지금도 통과하는 것은 아니다 — 그 사이 다른 커밋이 있었으면
      // head 검사가 막지만, 같은 트랜잭션 안의 순서 때문에 달라지는 것이 남는다.
      const model = await readModel(c);
      const rendered = renderOrThrow(model);

      const epoch = text(
        (await c.query(`SELECT nextval('activation_epoch_seq') AS v`)).rows[0] ?? {}, 'v');

      await c.query(
        `INSERT INTO config_revisions (revision,parent,model,created_by,note)
         VALUES ($1,$2,$3,$4,$5)`,
        [revision, head, JSON.stringify(model), by, `changeset ${changesetId}`],
      );
      await c.query('UPDATE config_head SET revision = $1', [revision]);
      await c.query(
        `UPDATE plans SET state='committed', target_revision=$2, activation_epoch=$3,
                          render_digest=$4 WHERE id=$1`,
        [planId, revision, epoch, rendered.digest],
      );
      await c.query(
        `UPDATE changesets SET state='committed', committed_revision=$2 WHERE id=$1`,
        [changesetId, revision],
      );
      // 같은 changeset 의 다른 plan 은 전부 무효다 (§5.3 superseded).
      await c.query(
        `UPDATE plans SET state='superseded' WHERE changeset_id=$1 AND id<>$2 AND state='planned'`,
        [changesetId, planId],
      );
      return { revision, activationEpoch: epoch };
    });
    await this.audit(by, 'changeset.commit', changesetId, undefined, out, out.revision);
    return out;
  }

  async getPlan(planId: string): Promise<PlanRecord> {
    const r = (await this.db.query(
      `SELECT id, changeset_id, state, base_revision, model, impact, render_digest,
              renderer_version, expires_at, target_revision, activation_epoch
         FROM plans WHERE id=$1`, [planId],
    )).rows[0];
    if (r === undefined) throw new StoreError(404, 'unknown_plan', `plan ${planId} 이 없다`);
    return {
      id: text(r, 'id'), changesetId: text(r, 'changeset_id'), state: text(r, 'state'),
      baseRevision: text(r, 'base_revision'), model: r['model'] as Model,
      impact: r['impact'] as Impact, renderDigest: text(r, 'render_digest'),
      rendererVersion: text(r, 'renderer_version'),
      expiresAt: new Date(String(r['expires_at'])).toISOString(),
      targetRevision: maybeText(r, 'target_revision'),
      activationEpoch: maybeText(r, 'activation_epoch'),
    };
  }

  async audit(
    principal: string, action: string, subject: string,
    before?: unknown, after?: unknown, revision?: string,
  ): Promise<void> {
    await this.db.query(
      `INSERT INTO audit (principal,action,subject,before,after,revision)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [principal, action, subject,
        before === undefined ? null : JSON.stringify(before),
        after === undefined ? null : JSON.stringify(after),
        revision ?? null],
    );
  }
}

// ── 보조 ─────────────────────────────────────────────────────────────────

/** PATCH 시점의 모양 검사. 여기서 걸리는 것은 **400** 이다 (타입·구문). */
function shapeCheck(op: PatchOp): void {
  if (op.op === 'delete') return;
  const empty: Model = {
    listeners: [], httpRoutes: [], passthroughRoutes: [], pools: [], backends: [],
  };
  const key = {
    pool: 'pools', backend: 'backends', listener: 'listeners',
    httpRoute: 'httpRoutes', passthroughRoute: 'passthroughRoutes',
  }[op.kind] as keyof Model;
  const body = { ...obj(op.body), key: op.key };
  const probe = { ...empty, [key]: [body] };
  const decoded = decodeModel(probe);
  if (!decoded.ok) {
    throw new StoreError(400, 'malformed',
      `${op.kind} '${op.key}' 의 모양이 잘못됐다`, decoded.issues);
  }
}

function renderOrThrow(model: Model): RenderedConfig {
  try {
    return render(model);
  } catch (e) {
    if (e instanceof ModelValidationError) {
      throw new StoreError(422, 'invalid_model', e.message, e.issues);
    }
    throw e;
  }
}

/** 이전 모델이 렌더 안 되는 상태일 수도 있다 (빈 모델 등). 그건 impact 계산의 실패가 아니다. */
function safeRender(model: Model): RenderedConfig | undefined {
  try {
    return render(model);
  } catch {
    return undefined;
  }
}

const socketOf = (l: { bind: string; port: number; protocol: string }): string =>
  `${l.protocol === 'udp' ? 'udp' : 'tcp'}://${l.bind}:${l.port}`;

function impactOf(beforeConf: string, rendered: RenderedConfig, model: Model): Impact {
  const sockets = new Set(model.listeners.filter((l) => l.enabled).map(socketOf));
  const beforeSockets = new Set(
    [...beforeConf.matchAll(/listen\s+([^\s;]+)(\s+udp)?/g)].map((m) =>
      `${m[2] !== undefined ? 'udp' : 'tcp'}://${m[1] ?? ''}`),
  );
  return {
    // v0.1 에서 백엔드 반영은 **세대 전환**이다 — 멤버십 평면은 v0.3 이다 (§9.1.1).
    // 그러니 어떤 변경이든 reload 를 요구한다. "멤버십만 바뀌면 아니오" 는 아직 거짓말이다.
    requiresReload: true,
    affectedListeners: model.listeners.map((l) => ({
      key: l.key, protocol: l.protocol, bind: l.bind, port: l.port,
    })),
    socketChanges: {
      added: [...sockets].filter((s) => !beforeSockets.has(s)).sort(),
      removed: [...beforeSockets].filter((s) => !sockets.has(s)).sort(),
    },
    planes: rendered.planes,
    confDiff: { before: beforeConf.length, after: rendered.conf.length },
  };
}

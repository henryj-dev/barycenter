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

import { render, type RenderCapabilities, type RenderedConfig } from '../conf/render.js';
import { decodeModel } from '../model/decode.js';
import { ModelValidationError } from '../validate/model.js';
import type {
  Backend,
  HttpRoute,
  Listener,
  Model,
  PassthroughRoute,
  Pool,
  Certificate,
  SniCertificateBinding,
  TlsPolicy,
  SniOutcome,
} from '../model/provisional.js';
import type { Db, Queryable, Row } from './pg.js';

/** 렌더 결과를 리비전에 결박하기 위한 표식 (§5.3 `renderer_version_changed`). */
export const RENDERER_VERSION = 'v0.1';

export type ResourceKind =
  | 'pool' | 'backend' | 'listener' | 'httpRoute' | 'passthroughRoute'
  | 'certificate' | 'tlsPolicy' | 'sniBinding';

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
  changesetId: string | null;
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
    `SELECT l.key, l.protocol, l.bind, l.port, l.enabled, l.accept_proxy_cidrs,
            l.udp_preset, l.preread_timeout_s, l.http_default_reject, l.on_unmatched_sni_reject,
            dp.key AS default_pool, hp.key AS http_default_pool, sp.key AS sni_pool,
            tp.key AS tls_policy, tc.key AS tls_default_certificate
       FROM listeners l
       LEFT JOIN pools dp ON dp.id = l.default_pool_id
       LEFT JOIN pools hp ON hp.id = l.http_default_pool_id
       LEFT JOIN pools sp ON sp.id = l.on_unmatched_sni_pool
       LEFT JOIN tls_policies tp ON tp.id = l.tls_policy_id
       LEFT JOIN certificates tc ON tc.id = l.tls_default_cert_id
      ORDER BY l.key`,
  )).rows.map((r): Listener => {
    const base = {
      key: text(r, 'key'),
      bind: text(r, 'bind'),
      port: num(r, 'port'),
      enabled: bool(r, 'enabled'),
    };
    const cidrs = r['accept_proxy_cidrs'];
    const pp = Array.isArray(cidrs) && cidrs.length > 0
      ? { acceptProxyProtocol: { trustedCidrs: cidrs as string[] } }
      : {};
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
    if (protocol === 'https') {
      const hp = maybeText(r, 'http_default_pool');
      const reject = bool(r, 'http_default_reject');
      const action = hp !== undefined ? { pool: hp } : reject ? ('reject' as const) : undefined;
      return {
        ...base, protocol: 'https', ...pp,
        tls: {
          policy: text(r, 'tls_policy'),
          defaultCertificate: text(r, 'tls_default_certificate'),
        },
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

  const certificates = (await c.query(
    `SELECT key, material_ref, chain_digest, key_digest FROM certificates ORDER BY key`,
  )).rows.map((r): Certificate => ({
    key: text(r, 'key'),
    materialRef: text(r, 'material_ref'),
    chainDigest: text(r, 'chain_digest'),
    keyDigest: text(r, 'key_digest'),
  }));

  const tlsPolicies = (await c.query(
    `SELECT key, min_version, max_version FROM tls_policies ORDER BY key`,
  )).rows.map((r): TlsPolicy => ({
    key: text(r, 'key'),
    minVersion: text(r, 'min_version') as TlsPolicy['minVersion'],
    ...(maybeText(r, 'max_version') !== undefined
      ? { maxVersion: text(r, 'max_version') as TlsPolicy['minVersion'] }
      : {}),
  }));

  const sniBindings = (await c.query(
    `SELECT b.key, l.key AS listener, c.key AS certificate, b.hosts,
            b.ovr_min_version, b.ovr_max_version
       FROM sni_certificate_bindings b
       JOIN listeners l ON l.id = b.listener_id
       JOIN certificates c ON c.id = b.certificate_id
      ORDER BY b.key`,
  )).rows.map((r): SniCertificateBinding => {
    const min = maybeText(r, 'ovr_min_version');
    const max = maybeText(r, 'ovr_max_version');
    const override = {
      ...(min !== undefined ? { minVersion: min as TlsPolicy['minVersion'] } : {}),
      ...(max !== undefined ? { maxVersion: max as TlsPolicy['minVersion'] } : {}),
    };
    return {
      key: text(r, 'key'),
      listener: text(r, 'listener'),
      certificate: text(r, 'certificate'),
      hosts: list(r, 'hosts'),
      ...(Object.keys(override).length > 0 ? { override } : {}),
    };
  });

  return {
    listeners, httpRoutes, passthroughRoutes, pools, backends,
    certificates, tlsPolicies, sniBindings,
  };
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

/**
 * 키로 id 를 찾는다. 참조 무결성을 **여기서** 422 로 돌려주기 위해서다 — FK 위반을 그대로
 * 올리면 PG 에러가 500 이 되고, 사용자는 자기 입력의 어디가 틀렸는지 못 본다.
 */
async function idOf(c: Queryable, table: string, key: string, subject: string): Promise<string> {
  const r = (await c.query(`SELECT id FROM ${table} WHERE key = $1`, [key])).rows[0];
  if (r === undefined) {
    throw new StoreError(422, 'unknown_reference', `'${subject}' 가 존재하지 않는 '${key}' 를 참조한다`);
  }
  return text(r, 'id');
}

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

async function applyOp(c: Queryable, op: PatchOp, revision: string, by: string): Promise<void> {
  if (op.op === 'delete') {
    const table = {
      pool: 'pools', backend: 'backends', listener: 'listeners',
      httpRoute: 'http_routes', passthroughRoute: 'passthrough_routes',
      certificate: 'certificates', tlsPolicy: 'tls_policies',
      sniBinding: 'sni_certificate_bindings',
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
      const hpool = (protocol === 'http' || protocol === 'https') && obj(da)['pool'] !== undefined
        ? await poolRef(c, String(obj(da)['pool']), `listener '${op.key}'`) : undefined;
      const spool = protocol === 'tls_passthrough' && obj(sni)['pool'] !== undefined
        ? await poolRef(c, String(obj(sni)['pool']), `listener '${op.key}'`) : undefined;
      // §4.6 — TLS 결박은 https 에만. 다른 프로토콜에서는 NULL 로 못 박는다 (DB 도
      // `listener_tls_only_https` 로 같은 규칙을 건다).
      const tls = protocol === 'https'
        ? {
            policy: await idOf(c, 'tls_policies', String(obj(b['tls'])['policy']),
              `listener '${op.key}' 의 tls.policy`),
            cert: await idOf(c, 'certificates', String(obj(b['tls'])['defaultCertificate']),
              `listener '${op.key}' 의 tls.defaultCertificate`),
          }
        : undefined;
      await c.query(
        `INSERT INTO listeners (id,key,name,protocol,bind,port,enabled,accept_proxy_cidrs,
                                udp_preset,http_default_pool_id,http_default_pool_cls,
                                http_default_reject,on_unmatched_sni_pool,on_unmatched_sni_cls,
                                on_unmatched_sni_reject,preread_timeout_s,
                                default_pool_id,default_pool_cls,
                                tls_policy_id,tls_default_cert_id,created_by,updated_by,revision)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                 $18,$19,$20,$20,$21)
         ON CONFLICT (key) DO UPDATE SET
           name=EXCLUDED.name, protocol=EXCLUDED.protocol, bind=EXCLUDED.bind,
           port=EXCLUDED.port, enabled=EXCLUDED.enabled,
           accept_proxy_cidrs=EXCLUDED.accept_proxy_cidrs,
           udp_preset=EXCLUDED.udp_preset,
           http_default_pool_id=EXCLUDED.http_default_pool_id,
           http_default_pool_cls=EXCLUDED.http_default_pool_cls,
           http_default_reject=EXCLUDED.http_default_reject,
           on_unmatched_sni_pool=EXCLUDED.on_unmatched_sni_pool,
           on_unmatched_sni_cls=EXCLUDED.on_unmatched_sni_cls,
           on_unmatched_sni_reject=EXCLUDED.on_unmatched_sni_reject,
           preread_timeout_s=EXCLUDED.preread_timeout_s,
           default_pool_id=EXCLUDED.default_pool_id, default_pool_cls=EXCLUDED.default_pool_cls,
           tls_policy_id=EXCLUDED.tls_policy_id,
           tls_default_cert_id=EXCLUDED.tls_default_cert_id,
           version=listeners.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by,
           revision=EXCLUDED.revision`,
        [op.key, b['name'] ?? op.key, protocol, b['bind'], b['port'], b['enabled'] ?? true,
          // §4.7 — 신뢰 경계 없이는 켤 수 없다. 해독기가 모양을 이미 봤다.
          obj(b['acceptProxyProtocol'])['trustedCidrs'] ?? null,
          protocol === 'udp' ? obj(b['udp'])['preset'] : null,
          hpool?.[0] ?? null, hpool?.[1] ?? null, da === 'reject' ? true : null,
          spool?.[0] ?? null, spool?.[1] ?? null, sni === 'reject' ? true : null,
          protocol === 'tls_passthrough' ? b['prereadTimeoutS'] ?? null : null,
          dpool?.[0] ?? null, dpool?.[1] ?? null,
          tls?.policy ?? null, tls?.cert ?? null, by, revision],
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
    case 'certificate':
      // **자료가 아니라 참조가 들어온다.** `materialRef` 는 SecretStore 가 이미 자료를
      // 받아 두고 돌려준 불변 버전이다 (§4.8). 개인키는 이 경로를 지나지 않는다.
      await c.query(
        `INSERT INTO certificates (id,key,name,material_ref,chain_digest,key_digest,
                                   created_by,updated_by,revision)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$6,$7)
         ON CONFLICT (key) DO UPDATE SET
           name=EXCLUDED.name, material_ref=EXCLUDED.material_ref,
           chain_digest=EXCLUDED.chain_digest, key_digest=EXCLUDED.key_digest,
           version=certificates.version+1, updated_at=now(),
           updated_by=EXCLUDED.updated_by, revision=EXCLUDED.revision`,
        [op.key, b['name'] ?? op.key, b['materialRef'], b['chainDigest'], b['keyDigest'],
          by, revision],
      );
      return;

    case 'tlsPolicy':
      await c.query(
        `INSERT INTO tls_policies (id,key,name,min_version,max_version,
                                   created_by,updated_by,revision)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$5,$6)
         ON CONFLICT (key) DO UPDATE SET
           name=EXCLUDED.name, min_version=EXCLUDED.min_version,
           max_version=EXCLUDED.max_version,
           version=tls_policies.version+1, updated_at=now(),
           updated_by=EXCLUDED.updated_by, revision=EXCLUDED.revision`,
        [op.key, b['name'] ?? op.key, b['minVersion'], b['maxVersion'] ?? null, by, revision],
      );
      return;

    case 'sniBinding': {
      const [lid, lproto] = await listenerRef(c, String(b['listener']), `sniBinding '${op.key}'`);
      const cert = await idOf(c, 'certificates', String(b['certificate']),
        `sniBinding '${op.key}' 의 certificate`);
      const ovr = obj(b['override']);
      // `listener_proto` 를 함께 넣는 이유는 복합 FK 다 — DB 가 "https 리스너에만"
      // 을 스스로 보장한다 (008 의 `sni_binding_is_https`).
      await c.query(
        `INSERT INTO sni_certificate_bindings (id,key,listener_id,listener_proto,certificate_id,
                                               hosts,ovr_min_version,ovr_max_version,
                                               created_by,updated_by,revision)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$8,$9)
         ON CONFLICT (key) DO UPDATE SET
           listener_id=EXCLUDED.listener_id, listener_proto=EXCLUDED.listener_proto,
           certificate_id=EXCLUDED.certificate_id, hosts=EXCLUDED.hosts,
           ovr_min_version=EXCLUDED.ovr_min_version, ovr_max_version=EXCLUDED.ovr_max_version,
           version=sni_certificate_bindings.version+1, updated_at=now(),
           updated_by=EXCLUDED.updated_by, revision=EXCLUDED.revision`,
        [op.key, lid, lproto, cert, b['hosts'], ovr['minVersion'] ?? null,
          ovr['maxVersion'] ?? null, by, revision],
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
  /**
   * **엔진 capability 를 받는다.**
   *
   * 전에는 `render(model)` 을 기본값으로 불렀고, 기본값은 보수적(`streamRealip: false`)
   * 이다. 그 자체는 옳지만 **아무도 진짜 값을 넣어 주지 않아서** 엔진이 할 수 있는 것도
   * plan 단계에서 막혔다. capability 로 좁힌다고 해 놓고 capability 를 안 물어본 셈이다.
   */
  constructor(
    private readonly db: Db,
    private readonly caps: RenderCapabilities = { streamRealip: false },
  ) {}

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
    // **캐스팅하지 않고 해독한다.**
    //
    // 전에는 `r['model'] as Model` 이었다. 그건 *지금의* `Model` 모양을 옛 스냅샷이
    // 갖고 있다고 가정하는 것이고, 스키마가 자라는 순간 거짓이 된다 — v0.6 이 컬렉션
    // 셋(`certificates`·`tlsPolicies`·`sniBindings`)을 더하자 **v0.6 이전 리비전으로
    // 롤백하면 `undefined.map` 으로 500** 이 났다. 캐스팅은 그 순간까지 아무 말도 안 한다.
    //
    // 해독기는 없는 컬렉션을 빈 배열로 채우고(그게 옛 리비전의 정확한 의미다) 모양이
    // 정말 틀렸으면 **여기서** 말한다. 어차피 렌더는 해독을 다시 하므로, 실패를 읽는
    // 시점으로 당기는 것뿐이다.
    const decoded = decodeModel(r['model']);
    if (!decoded.ok) {
      throw new StoreError(500, 'corrupt_revision',
        `리비전 ${revision} 의 스냅샷을 해독할 수 없다`, decoded.issues);
    }
    return decoded.model;
  }

  /**
   * 리비전 하나를 렌더한다.
   *
   * **API 가 `render()` 를 직접 부르지 않게 하려고 있다.** 직접 부르면 capability 인자를
   * 빼먹기 쉽고, 실제로 `/config/rendered` 가 보수적 기본값으로 렌더해서 엔진이 할 수
   * 있는 조합을 500 으로 답했다 — 저장은 됐는데 읽을 수가 없는 상태였다.
   * **렌더는 capability 를 아는 쪽에서만 한다.**
   */
  async renderAt(revision: string): Promise<RenderedConfig> {
    return renderOrThrow(await this.modelAt(revision), this.caps);
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
      const beforeConf = safeRender(prior, this.caps);
      for (const op of ops) await applyOp(c, op, baseRevision, by).catch(translate);
      const next = await readModel(c);
      return { model: next, rendered: renderOrThrow(next, this.caps), before: beforeConf };
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
   * changeset 을 버린다 (§5.2 `DELETE /changesets/{id}`).
   *
   * **행을 지우지 않고 `discarded` 로 옮긴다.** 감사 기록이 가리킬 대상이 사라지면
   * "누가 무엇을 하려다 접었나" 를 나중에 물을 수 없다 — 그리고 `changesets` 는 §5.3 의
   * 단회 lifecycle 을 지키는 상태기계라, 상태 하나를 삭제로 대신하면 그 기계에 구멍이
   * 생긴다.
   *
   * **커밋된 것은 못 버린다.** 이미 리비전이 됐으므로 되돌리는 것은 롤백이지 폐기가
   * 아니다. 여기서 허용하면 "버렸는데 트래픽은 그대로" 인 상태가 표현된다.
   *
   * `reopen` 과 같은 이유로 매달린 plan 도 함께 죽인다 — 안 그러면 버린 changeset 의
   * plan_id 로 commit 하는 경로가 남는다.
   */
  async discardChangeset(changesetId: string, by: string): Promise<void> {
    await this.db.tx(async (c) => {
      const r = await c.query(
        `UPDATE changesets SET state='discarded'
          WHERE id=$1 AND state IN ('open','sealed') RETURNING id`,
        [changesetId],
      );
      if (r.rowCount === 0) {
        const exists = (await c.query('SELECT state FROM changesets WHERE id=$1', [changesetId]))
          .rows[0];
        if (exists === undefined) {
          throw new StoreError(404, 'not_found', `changeset '${changesetId}' 가 없다`);
        }
        throw new StoreError(409, 'not_discardable',
          `changeset '${changesetId}' 는 ${String(exists['state'])} 다 — open/sealed 만 버릴 수 있다`);
      }
      await c.query(`UPDATE plans SET state='expired' WHERE changeset_id=$1 AND state='planned'`,
        [changesetId]);
    });
    await this.audit(by, 'changeset.discard', changesetId, undefined, undefined);
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
      const rendered = renderOrThrow(model, this.caps);

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

  /**
   * 롤백 — **head 를 뒤로 옮기지 않는다** (§5.3).
   *
   * *"`R1` 의 내용으로 새 `ConfigRevision R3` 을 만들고 `rollback_of: R1` 을 붙인다.
   * head 는 앞으로만 간다."*
   *
   * 왜 head 를 되돌리면 안 되는가. desired 가 `R2` 인데 runtime 만 `R1` 로 되돌리면
   * reconciler 가 다시 `R2` 를 적용해 버리고, 반대로 head 를 `R1` 로 되돌리면 리비전
   * 단조 계약이 깨진다. 새 리비전을 만드는 것이 둘 다 피하는 유일한 길이다.
   *
   * **리소스 테이블도 그 시점으로 되돌린다.** 스냅샷만 새로 적고 테이블을 그대로 두면
   * 다음 changeset 이 *되돌리지 않은* 상태 위에 앉는다 — head 는 R1 내용인데 다음
   * 커밋은 R2 내용에서 출발하는, 아무도 이해할 수 없는 상태가 된다.
   *
   * S8(인증서 세대 결박)과 S19(clone + 새 epoch)가 증명한 경로가 여기서 시작된다.
   * epoch 는 `commit` 과 같은 규칙으로 **새로** 뽑는다 — 옛 값을 재사용하지 않는다.
   */
  async rollbackTo(revision: string, by: string, note?: string): Promise<{
    revision: string; activationEpoch: string; rollbackOf: string; planId: string;
  }> {
    const out = await this.db.tx(async (c) => {
      const headRow = (await c.query('SELECT revision FROM config_head FOR UPDATE')).rows[0];
      const head = text(headRow ?? {}, 'revision');

      const src = (await c.query(
        'SELECT model FROM config_revisions WHERE revision = $1', [revision],
      )).rows[0];
      if (src === undefined) {
        throw new StoreError(404, 'unknown_revision', `리비전 ${revision} 이 없다`);
      }
      if (BigInt(revision) >= BigInt(head)) {
        throw new StoreError(409, 'not_past',
          `r${revision} 은 과거가 아니다 (head=r${head}) — 롤백은 뒤로만 간다`);
      }
      const model = src['model'] as Model;

      // **테이블을 그 시점 모델로 되돌린다.** 지우고 다시 넣는다 — 부분 갱신으로는
      // "그 시점에 없던 리소스" 를 없앨 수 없다.
      const target = text(
        (await c.query(`SELECT nextval('config_revision_seq') AS v`)).rows[0] ?? {}, 'v');
      // 참조하는 쪽부터 지운다. 라우트 → 리스너 → 풀 순서다.
      //
      // **`backends` 는 명시적으로 안 지운다** — `pools` 삭제가 CASCADE 로 데려간다
      // (§4.0: Pool → Backend 는 CASCADE). 처음엔 넣어 뒀는데, 변이 검사에서 그 줄을
      // 지워도 **아무 테스트도 안 깨졌다.** 도달 불가한 방어는 방어가 아니라 죽은
      // 코드이고, "여기서 다 지운다" 는 말을 반쯤 거짓으로 만든다(24차에 배운 것).
      // 대신 그 CASCADE 의존을 테스트로 못 박았다.
      //
      // **인증서·정책은 리스너 뒤에 지운다.** 리스너가 `ON DELETE RESTRICT` 로 둘을
      // 참조하므로 순서를 뒤집으면 롤백이 FK 위반으로 죽는다. `sni_certificate_bindings`
      // 는 리스너 CASCADE 가 데려간다 (008 의 복합 FK).
      await c.query(`DELETE FROM http_routes`);
      await c.query(`DELETE FROM passthrough_routes`);
      await c.query(`DELETE FROM listeners`);
      await c.query(`DELETE FROM pools`);
      await c.query(`DELETE FROM certificates`);
      await c.query(`DELETE FROM tls_policies`);
      for (const op of opsOf(model)) await applyOp(c, op, target, by).catch(translate);

      // 되돌린 결과가 지금도 유효한지 **다시 본다.** 엔진 capability 나 검증 규칙이
      // 그 사이 바뀌었을 수 있다 — 옛 리비전이라고 무조건 통과시키지 않는다.
      const restored = await readModel(c);
      renderOrThrow(restored, this.caps);

      const epoch = text(
        (await c.query(`SELECT nextval('activation_epoch_seq') AS v`)).rows[0] ?? {}, 'v');
      await c.query(
        `INSERT INTO config_revisions (revision,parent,rollback_of,model,created_by,note)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [target, head, revision, JSON.stringify(restored), by,
          note ?? `r${revision} 로 롤백`],
      );
      await c.query('UPDATE config_head SET revision = $1', [target]);

      // 적용은 별도다 — plan 을 하나 만들어 **`/apply` 가 그대로 소비**하게 한다.
      // 롤백만의 적용 경로를 따로 두면 그 경로만 덜 검증된다.
      const planId = randomUUID();
      await c.query(
        `INSERT INTO plans (id,changeset_id,base_revision,model,impact,render_digest,
                            renderer_version,expires_at,state,target_revision,activation_epoch)
         VALUES ($1,NULL,$2,$3,$4,$5,$6,now() + interval '24 hours','committed',$7,$8)`,
        [planId, head, JSON.stringify(restored),
          JSON.stringify({ rollbackOf: revision }), renderOrThrow(restored, this.caps).digest,
          RENDERER_VERSION, target, epoch],
      );
      return { revision: target, activationEpoch: epoch, rollbackOf: revision, planId };
    });
    await this.audit(by, 'rollback', out.rollbackOf, undefined, out, out.revision);
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
      id: text(r, 'id'),
      // 롤백 plan 에는 changeset 이 없다 (003 마이그레이션).
      changesetId: maybeText(r, 'changeset_id') ?? null,
      state: text(r, 'state'),
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

/**
 * 모델 하나를 **처음부터 만드는** patch 로 편다.
 *
 * 순서가 중요하다 — 풀이 백엔드보다, 리스너가 라우트보다 먼저다. 복합 FK 가 참조
 * 대상을 요구하므로 순서가 틀리면 DB 가 막는다(그건 좋은 일이다. 조용히 통과하는
 * 것보다 낫다).
 */
function opsOf(model: Model): PatchOp[] {
  const put = (kind: ResourceKind, key: string, body: unknown): PatchOp =>
    ({ op: 'put', kind, key, body });
  // **순서가 계약이다.** 리스너의 `tls` 가 인증서·정책을 참조하고 SNI 바인딩이 리스너를
  // 참조하므로, 참조되는 쪽이 먼저 와야 한다. 뒤집히면 롤백 재적용이
  // `unknown_reference` 로 죽는다 — 원래 모델은 멀쩡한데 되돌리기만 실패한다.
  return [
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

/** PATCH 시점의 모양 검사. 여기서 걸리는 것은 **400** 이다 (타입·구문). */
function shapeCheck(op: PatchOp): void {
  if (op.op === 'delete') return;
  const empty: Model = {
    listeners: [], httpRoutes: [], passthroughRoutes: [], pools: [], backends: [],
    certificates: [], tlsPolicies: [], sniBindings: [],
  };
  const key = {
    pool: 'pools', backend: 'backends', listener: 'listeners',
    httpRoute: 'httpRoutes', passthroughRoute: 'passthroughRoutes',
    certificate: 'certificates', tlsPolicy: 'tlsPolicies', sniBinding: 'sniBindings',
  }[op.kind] as keyof Model;
  const body = { ...obj(op.body), key: op.key };
  const probe = { ...empty, [key]: [body] };
  const decoded = decodeModel(probe);
  if (!decoded.ok) {
    throw new StoreError(400, 'malformed',
      `${op.kind} '${op.key}' 의 모양이 잘못됐다`, decoded.issues);
  }
}

function renderOrThrow(model: Model, caps: RenderCapabilities): RenderedConfig {
  try {
    return render(model, caps);
  } catch (e) {
    if (e instanceof ModelValidationError) {
      throw new StoreError(422, 'invalid_model', e.message, e.issues);
    }
    throw e;
  }
}

/** 이전 모델이 렌더 안 되는 상태일 수도 있다 (빈 모델 등). 그건 impact 계산의 실패가 아니다. */
function safeRender(model: Model, caps: RenderCapabilities): RenderedConfig | undefined {
  try {
    return render(model, caps);
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
    /**
     * **산출물이 바뀌면 reload 가 필요하다** (§5.4).
     *
     * 멤버십 평면이 켜지면 백엔드는 conf 에 없다 — dict 에 산다. 그러니 백엔드만 바뀐
     * 변경은 렌더 산출물이 **바이트 단위로 같고**, 그때는 세대 전환도 HUP 도 없다.
     * 판정을 산출물 비교로 두는 이유: "백엔드만 바뀌었나" 같은 다른 근거로 재면 렌더에
     * 영향을 주는 필드가 하나 늘 때마다 조용히 틀려진다.
     *
     * ⚠️ **plan 은 base 리비전과 비교하고, apply 는 지금 서빙 중인 세대와 비교한다.**
     * 보통 같지만 커밋만 되고 적용은 안 된 리비전이 사이에 있으면 갈릴 수 있다 —
     * 그때는 plan 이 "reload 없음" 이라고 했는데 apply 가 세대를 만든다. 예측이
     * 보수적으로 틀리는 쪽이라 두지만, 사실이므로 적어 둔다.
     */
    requiresReload: beforeConf !== rendered.conf,
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

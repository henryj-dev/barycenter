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
import { compileHostRoutes, type CompileWarning, type RouteInput } from '../route/compile.js';
import { decodeModel } from '../model/decode.js';
import { certCoversHost } from '../dp/certinfo.js';
import {
  validateBackendHost, validateHeaderValue, validatePathPrefix,
} from '../validate/strings.js';
import type { SecretStore } from '../dp/secrets.js';
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
  HeaderRules,
  HttpProfile,
  ProxyLimits,
  RateLimit,
} from '../model/provisional.js';
import type { Db, Queryable, Row } from './pg.js';
import {
  exportManifest, importPatch, parseManifest, type ImportMode, type Manifest,
} from './manifest.js';

/** 렌더 결과를 리비전에 결박하기 위한 표식 (§5.3 `renderer_version_changed`). */
export const RENDERER_VERSION = 'v0.1';

export type ResourceKind =
  | 'pool' | 'backend' | 'listener' | 'httpRoute' | 'passthroughRoute'
  | 'certificate' | 'tlsPolicy' | 'sniBinding'
  /**
   * 전역 엔진 설정. **리소스가 아니다** — key 가 없고 하나뿐이다 (검수 B-01).
   *
   * 그래도 같은 patch 통로로 넣는다. 별도 엔드포인트를 만들면 그 경로만 changeset ·
   * plan · 감사 · 롤백 밖에 살게 되고, §5.3 이 "모든 쓰기는 changeset 을 지난다" 고
   * 한 이유가 그것이다. key 는 `'engine'` 하나로 고정한다.
   */
  | 'engine';

/** `engine` 은 하나뿐이라 key 가 고정이다. */
export const ENGINE_KEY = 'engine';

/**
 * 리소스 `key` 의 문법 (검수 S-01).
 *
 * 왜 이렇게 좁은가 — **key 가 파일 경로가 되기 때문이다.** 인증서는
 * `certs/<key>/<version>/privkey.pem` 으로 세대에 들어가고(`certPaths`),
 * ACME 는 `acme-<key>` 를 SecretStore 이름으로 쓴다. 그래서 `FsSecretStore` 가 이름에
 * 이미 쓰는 규칙(`^[A-Za-z0-9._-]+$`)과 **같은 문자 집합**으로 맞춘다 — 안 맞추면
 * "모델에는 저장되는데 ACME 가 그 인증서만 발급 못 하는" 조합이 생긴다.
 *
 * 선두를 영숫자로 제한하는 것은 `.`·`..`·`-flag` 를 한 번에 막기 위해서다.
 * 63 자는 DNS 라벨과 같은 한도다 — 이름이 그보다 길면 읽는 사람이 없다.
 */
const KEY_SYNTAX = /^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$/;

/**
 * **쓰기 경계에서만** 문법을 본다.
 *
 * ⚠️ `decodeModel` 에 넣으면 안 된다. `modelAt` 이 `config_revisions.model` 스냅샷을
 * 그 해독기로 읽으므로, 문법을 좁히면 규칙을 벗어난 key 가 든 **옛 리비전이 해독
 * 불가**가 되고 그 리비전으로 **롤백할 수 없다.** v0.6 이 컬렉션을 더했을 때 옛 리비전
 * 롤백이 `undefined.map` 으로 죽었고 그래서 `modelAt` 이 캐스팅 대신 해독으로 바뀌었다 —
 * 해독기를 좁히는 것은 그 수정의 정반대 방향이다.
 *
 * 이미 저장된 나쁜 key 는 `materializeGeneration` 이 파일시스템 층에서 막는다.
 */
function assertKeySyntax(kind: ResourceKind, key: string): void {
  if (KEY_SYNTAX.test(key)) return;
  throw new StoreError(400, 'malformed',
    `${kind} 의 key 가 문법에 안 맞는다: ${JSON.stringify(key)} — `
    + '영숫자로 시작하고 영숫자·점·밑줄·하이픈만, 63 자까지다 '
    + '(key 는 인증서 파일 경로가 된다)');
}

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

/**
 * 리스너가 **어떻게** 영향을 받았는가.
 *
 * `removed` 는 지금 모델에 없는 것이므로 이전 리비전에서 읽는다 — 그게 빠지면
 * "리스너를 지웠는데 아무 리스너도 영향받지 않았다" 는 답이 나온다.
 */
export type ListenerChange = 'added' | 'removed' | 'changed';

/**
 * 기존 세션이 어떻게 되는가 (§5.4 `session_impact`).
 *
 * | | 뜻 |
 * |---|---|
 * | `none` | 이 프로토콜은 안 건드린다 |
 * | `new_only` | 기존 것은 그대로 가고, 새 연결·새 요청부터 바뀐다 |
 * | `may_reset` | 기존 것이 끊길 수 있다 |
 *
 * **`none` 은 "모른다" 가 아니다.** 영향받은 리스너가 그 프로토콜에 하나도 없을
 * 때만 낸다 — §6.3 이 관측 못 한 것과 나쁜 것을 가른 것과 같은 규칙이다.
 */
export type SessionEffect = 'none' | 'new_only' | 'may_reset';

/**
 * 인증서가 어떻게 바뀌는가. 리스너와 달리 `replaced` 가 있다 — 같은 이름의 자료가
 * **다른 바이트**로 바뀌는 것이 갱신이고, 그게 이 표에서 제일 자주 일어나는 일이다.
 */
export type MaterialChange = 'added' | 'removed' | 'replaced';

/** §5.4 — plan 이 보여주는 것. */
export type Impact = {
  requiresReload: boolean;
  /**
   * 이 전환이 **새 `activation_epoch` 를 쓰는가** (§3.3 · §6.1 분류기).
   *
   * `requiresReload` 와 같은 값이 아니다. 멤버십 평면이 **없는** 엔진에서는 백엔드가
   * conf 에 렌더되므로 백엔드 하나만 옮겨도 세대가 새로 서고, 세대에는 epoch 이
   * 구워진다(§6.5-1). 같은 변경이 엔진에 따라 좌표를 옮기기도 하고 안 옮기기도 한다 —
   * 그게 §7.3 이 말한 "열등한 것이 아니라 다른 계약" 이다.
   *
   * epoch 이 움직이면 멤버십을 **전면 재전송**하고 옛 슬롯을 서빙이 끝날 때까지
   * 들고 있어야 한다 (§6.5-5). plan 이 그걸 미리 말해 주지 않으면 운영자는
   * "백엔드만 바꿨는데 왜 세대가 늘었나" 를 사후에 묻게 된다.
   */
  topologyEpochChange: boolean;
  affectedListeners: {
    key: string; protocol: string; bind: string; port: number; change: ListenerChange;
  }[];
  sessionImpact: { protocol: string; effect: SessionEffect; why: string }[];
  /**
   * 교체되는 인증서와 **그 자료의 만료일** (§5.4 · §8.1).
   *
   * `notAfter` 는 설정이 아니라 **자료**에서 온다. 설정에 적은 날짜를 믿으면 알람이
   * 거짓이 되고, 그 거짓은 handshake 가 깨지는 날에만 드러난다. 자료를 모르면
   * 비워 둔다 — 지어내지 않고, 항목을 감추지도 않는다.
   */
  certificateChanges: { key: string; change: MaterialChange; notAfter?: string }[];
  /**
   * 엔진이 라우트를 고르는 **순서**가 어떻게 바뀌는가 (§5.4 · §7.5).
   *
   * 사용자 `priority` 가 아니라 컴파일된 순서다 — 매치 클래스가 priority 를 이기고
   * (E20.1), 같은 호스트 안에서는 longest-prefix 가 이긴다(E31). 그래서 "우선순위를
   * 20 으로 올렸는데 왜 저게 먼저 잡히나" 가 생기고, §7.5-3 이 그것을 *"저장은
   * 허용하되 plan 이 경고한다"* 로 정했다.
   *
   * `warnings` 는 컴파일러가 이미 만들던 값이다. **아무도 안 읽고 있었다** —
   * `validateModel` 은 `errors` 만 본다. 여기가 그 독자다.
   */
  routeOrderChanges: {
    moved: { listener: string; key: string; from: number | null; to: number | null }[];
    warnings: { kind: string; listener: string; routes: string[]; message: string }[];
  };
  /**
   * 대상 엔진이 **못 하는 것** (§5.4 `capability_warnings` · §7.6).
   *
   * 여기 오는 것은 "막히는 조합" 이 아니다 — 그건 검증기가 422 로 튕긴다. 여기 오는 것은
   * **조용히 덜 되는 것**이다. §4.9 가 h2 기본값에 대해 *"기본값이 못 걸리는 것은 조용히
   * 넘어가지만 그건 status 의 capability 로 보인다"* 고 적어 뒀는데, 그 API 는 없다.
   * plan 이 그 자리다 — 어차피 여기가 "이 변경이 이 엔진에서 어떻게 되는가" 를 답하는 곳이다.
   */
  capabilityWarnings: { kind: string; message: string }[];
  socketChanges: { added: string[]; removed: string[] };
  planes: ('http' | 'stream')[];
  confDiff: { before: number; after: number };
};

const PLAN_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * changeset 하나가 담을 수 있는 patch op 수 (검수 B-13).
 *
 * 상한이 없으면 반복 PATCH 로 무한히 자라고, `commit` 이 그 전부를 `config_head` 를
 * 잠근 채 적용한다 — 다른 모든 커밋이 뒤에 선다.
 *
 * 1000 은 **한 번에 옮기기에 이미 큰 변경**이라는 뜻이다. 리소스 여덟 종류를 합쳐
 * 그만큼을 한 changeset 에 담아야 한다면, 그건 나눠서 커밋할 일이다 — plan 의 impact
 * 도 그 크기에서는 사람이 못 읽는다.
 */
export const MAX_CHANGESET_OPS = 1000;

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
    `SELECT key, protocol_class, algorithm, hash_key, send_proxy_protocol, health_check
       FROM pools ORDER BY key`,
  )).rows.map((r): Pool => ({
    key: text(r, 'key'),
    protocolClass: text(r, 'protocol_class') as Pool['protocolClass'],
    algorithm: text(r, 'algorithm') as Pool['algorithm'],
    ...(maybeText(r, 'hash_key') !== undefined ? { hashKey: text(r, 'hash_key') } : {}),
    ...(maybeText(r, 'send_proxy_protocol') !== undefined
      ? { sendProxyProtocol: 'v1' as const }
      : {}),
    // 014 (검수 B-07). 없으면 기본 판정 — `GET /` 에 2xx.
    ...(r['health_check'] === null || r['health_check'] === undefined
      ? {}
      : { healthCheck: r['health_check'] as NonNullable<Pool['healthCheck']> }),
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
    `SELECT l.key, l.protocol, l.bind, l.port, l.enabled, l.accept_proxy_cidrs, l.http2,
            l.proxy_limits, l.header_rules, l.rate_limit, l.http_strict_priority,
            l.udp_preset, l.preread_timeout_s, l.http_default_reject, l.on_unmatched_sni_reject,
            l.on_no_sni_reject,
            dp.key AS default_pool, hp.key AS http_default_pool, sp.key AS sni_pool,
            np.key AS no_sni_pool,
            tp.key AS tls_policy, tc.key AS tls_default_certificate
       FROM listeners l
       LEFT JOIN pools dp ON dp.id = l.default_pool_id
       LEFT JOIN pools hp ON hp.id = l.http_default_pool_id
       LEFT JOIN pools sp ON sp.id = l.on_unmatched_sni_pool
       LEFT JOIN pools np ON np.id = l.on_no_sni_pool
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
    /**
     * http 프로필을 한 자리에서 만든다 (제안 #8).
     *
     * 전에는 http 와 https 가 같은 세 줄을 각자 들고 있었다. `limits` 를 더하면서 그
     * 중복이 **한쪽만 고칠 자리**가 되므로 먼저 모은다 — 이 저장소가 반복해서 잡는
     * "자리가 둘이면 언젠가 갈린다" 다.
     */
    const httpProfile = (): { http: HttpProfile } | Record<string, never> => {
      const hp = maybeText(r, 'http_default_pool');
      const reject = bool(r, 'http_default_reject');
      const action = hp !== undefined ? { pool: hp } : reject ? ('reject' as const) : undefined;
      const raw = r['proxy_limits'];
      const limits = raw === null || raw === undefined ? undefined : raw as ProxyLimits;
      const rawH = r['header_rules'];
      const headers = rawH === null || rawH === undefined ? undefined : rawH as HeaderRules;
      const rawR = r['rate_limit'];
      const rateLimit = rawR === null || rawR === undefined ? undefined : rawR as RateLimit;
      // S10. NULL 은 **안 정함**이고 동작은 끔과 같다 — DB 가 false 를 못 넣게 막는다.
      const strictPriority = r['http_strict_priority'] === true ? true : undefined;
      if (action === undefined && limits === undefined && headers === undefined
        && rateLimit === undefined && strictPriority === undefined) return {};
      return {
        http: {
          ...(action === undefined ? {} : { defaultAction: action }),
          ...(limits === undefined ? {} : { limits }),
          ...(headers === undefined ? {} : { headers }),
          ...(rateLimit === undefined ? {} : { rateLimit }),
          ...(strictPriority === undefined ? {} : { strictPriority }),
        },
      };
    };
    if (protocol === 'http') {
      return { ...base, protocol: 'http', ...pp, ...httpProfile() };
    }
    if (protocol === 'https') {
      return {
        ...base, protocol: 'https', ...pp, ...httpProfile(),
        tls: {
          policy: text(r, 'tls_policy'),
          defaultCertificate: text(r, 'tls_default_certificate'),
        },
        // 011 이 더했다. `undefined` 와 `false` 는 다르다 — 전자는 "안 정했다"(기본값
        // 켬), 후자는 "끄라고 했다" 다. 전에는 둘을 구분할 자리가 아예 없었다 (B-01).
        ...(r['http2'] === null || r['http2'] === undefined ? {} : { http2: bool(r, 'http2') }),
      };
    }
    if (protocol === 'tls_passthrough') {
      const sp = maybeText(r, 'sni_pool');
      const reject = bool(r, 'on_unmatched_sni_reject');
      const outcome: SniOutcome | undefined =
        sp !== undefined ? { pool: sp } : reject ? 'reject' : undefined;
      // S9 로 열린 분기. 셋 다 NULL 이면 **필드가 없다** — 'reject' 로 적어 두면
      // "안 정했다" 와 "reject 를 골랐다" 가 같아지고, 그 둘은 다음에 기본값을 바꿀 때
      // 갈려야 한다.
      const np = maybeText(r, 'no_sni_pool');
      const nreject = bool(r, 'on_no_sni_reject');
      const noSni: SniOutcome | undefined =
        np !== undefined ? { pool: np } : nreject ? 'reject' : undefined;
      const t = maybeText(r, 'preread_timeout_s');
      return {
        ...base, protocol: 'tls_passthrough', ...pp,
        ...(outcome !== undefined ? { onUnmatchedSni: outcome } : {}),
        ...(noSni !== undefined ? { onNoSni: noSni } : {}),
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
    `SELECT key, material_ref, chain_digest, key_digest, acme_account, acme_domains
       FROM certificates ORDER BY key`,
  )).rows.map((r): Certificate => {
    const ref = maybeText(r, 'material_ref');
    const account = maybeText(r, 'acme_account');
    return {
      key: text(r, 'key'),
      // 자료는 셋이 함께 온다 (DB CHECK `certificate_material_together`).
      ...(ref === undefined ? {} : {
        materialRef: ref,
        chainDigest: text(r, 'chain_digest'),
        keyDigest: text(r, 'key_digest'),
      }),
      ...(account === undefined ? {} : {
        acme: { account, domains: (r['acme_domains'] as string[] | null) ?? [] },
      }),
    };
  });

  const tlsPolicies = (await c.query(
    `SELECT key, min_version, max_version, sni_host_mismatch, cipher_policy, hsts
       FROM tls_policies ORDER BY key`,
  )).rows.map((r): TlsPolicy => ({
    key: text(r, 'key'),
    minVersion: text(r, 'min_version') as TlsPolicy['minVersion'],
    ...(maybeText(r, 'max_version') !== undefined
      ? { maxVersion: text(r, 'max_version') as TlsPolicy['minVersion'] }
      : {}),
    // 011 이 더한 셋. **전에는 해독기가 받고 렌더러가 읽는데 그 사이가 없었다** (B-01).
    ...(maybeText(r, 'sni_host_mismatch') !== undefined
      ? { sniHostMismatch: text(r, 'sni_host_mismatch') as NonNullable<TlsPolicy['sniHostMismatch']> }
      : {}),
    ...(maybeText(r, 'cipher_policy') !== undefined
      ? { cipherPolicy: text(r, 'cipher_policy') as NonNullable<TlsPolicy['cipherPolicy']> }
      : {}),
    ...(r['hsts'] === null || r['hsts'] === undefined
      ? {}
      : { hsts: r['hsts'] as NonNullable<TlsPolicy['hsts']> }),
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

  /**
   * 전역 엔진 설정 (011). **행이 없으면 키 자체가 없다** — `{}` 로 채우면 "안 정했다" 와
   * "빈 객체로 정했다" 가 같아지고, 그 구분이 §4.10 의 시간 보호를 켜고 끈다.
   */
  const engineRow = (await c.query(
    `SELECT worker_shutdown_timeout_s, membership_dict_kb, acme_dict_kb
       FROM engine_settings WHERE only_one`,
  )).rows[0];
  const engineNum = (col: string): number | undefined => {
    const raw = engineRow === undefined ? undefined : maybeText(engineRow, col);
    return raw === undefined ? undefined : Number(raw);
  };
  const shutdown = engineNum('worker_shutdown_timeout_s');
  const membershipKb = engineNum('membership_dict_kb');
  const acmeKb = engineNum('acme_dict_kb');
  const engine = engineRow === undefined
    ? undefined
    : {
        ...(shutdown === undefined ? {} : { workerShutdownTimeoutS: shutdown }),
        ...(membershipKb === undefined ? {} : { membershipDictKb: membershipKb }),
        ...(acmeKb === undefined ? {} : { acmeDictKb: acmeKb }),
      };

  return {
    ...(engine === undefined ? {} : { engine }),
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
    // `engine` 은 key 로 안 지운다 — 컬럼이 없다. 단일 행을 통째로 비운다.
    if (op.kind === 'engine') {
      const r = await c.query('DELETE FROM engine_settings WHERE only_one');
      if (r.rowCount === 0) {
        throw new StoreError(409, 'not_found', '엔진 설정이 없다');
      }
      return;
    }
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
                            health_check,created_by,updated_by,revision)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$9,$7,$7,$8)
         ON CONFLICT (key) DO UPDATE SET
           name=EXCLUDED.name, protocol_class=EXCLUDED.protocol_class,
           algorithm=EXCLUDED.algorithm, hash_key=EXCLUDED.hash_key,
           send_proxy_protocol=EXCLUDED.send_proxy_protocol,
           health_check=EXCLUDED.health_check,
           version=pools.version+1, updated_at=now(), updated_by=EXCLUDED.updated_by,
           revision=EXCLUDED.revision`,
        [op.key, b['name'] ?? op.key, b['protocolClass'], b['algorithm'],
          b['hashKey'] ?? null, b['sendProxyProtocol'] ?? null, by, revision,
          b['healthCheck'] === undefined ? null : JSON.stringify(b['healthCheck'])],
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
      const noSni = b['onNoSni'];
      // 판별 유니온을 컬럼으로 편다. **프로토콜에 없는 필드는 NULL 로 못 박는다** —
      // 값을 남겨 두면 나중에 프로토콜이 바뀔 때 아무도 의도하지 않은 설정이 되살아난다.
      const dpool = protocol === 'tcp' || protocol === 'udp'
        ? await poolRef(c, String(b['defaultPool']), `listener '${op.key}'`) : undefined;
      const hpool = (protocol === 'http' || protocol === 'https') && obj(da)['pool'] !== undefined
        ? await poolRef(c, String(obj(da)['pool']), `listener '${op.key}'`) : undefined;
      const spool = protocol === 'tls_passthrough' && obj(sni)['pool'] !== undefined
        ? await poolRef(c, String(obj(sni)['pool']), `listener '${op.key}'`) : undefined;
      const nspool = protocol === 'tls_passthrough' && obj(noSni)['pool'] !== undefined
        ? await poolRef(c, String(obj(noSni)['pool']), `listener '${op.key}'`) : undefined;
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
                                tls_policy_id,tls_default_cert_id,http2,proxy_limits,header_rules,
                                rate_limit,on_no_sni_pool,on_no_sni_cls,on_no_sni_reject,
                                http_strict_priority,
                                created_by,updated_by,revision)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,
                 $18,$19,$22,$23,$24,$25,$26,$27,$28,$29,$20,$20,$21)
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
           http2=EXCLUDED.http2,
           proxy_limits=EXCLUDED.proxy_limits,
           header_rules=EXCLUDED.header_rules,
           rate_limit=EXCLUDED.rate_limit,
           on_no_sni_pool=EXCLUDED.on_no_sni_pool,
           on_no_sni_cls=EXCLUDED.on_no_sni_cls,
           on_no_sni_reject=EXCLUDED.on_no_sni_reject,
           http_strict_priority=EXCLUDED.http_strict_priority,
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
          tls?.policy ?? null, tls?.cert ?? null, by, revision,
          // $22 — **https 에만.** 다른 프로토콜에서는 NULL 로 못 박는다(DB 도 같은
          // CHECK 을 건다). 안 정한 것과 끄라고 한 것을 구분하려면 boolean|null 이어야 한다.
          protocol === 'https' ? b['http2'] ?? null : null,
          // $23 — **http 계열에만** (제안 #8). DB 도 같은 CHECK 을 건다. tcp·udp·패스스루에
          // 적힌 값은 아무도 안 읽고, 안 읽는 값이 저장되면 다음 사람은 그게 동작한다고 믿는다.
          protocol === 'http' || protocol === 'https'
            ? (obj(b['http'])['limits'] ?? null) : null,
          // $24 — 같은 규칙 (제안 #7). stream 에는 `add_header` 도 `proxy_set_header` 도 없다.
          protocol === 'http' || protocol === 'https'
            ? (obj(b['http'])['headers'] ?? null) : null,
          // $25 — 같은 규칙 (제안 #6). stream 에는 `limit_req` 가 없다.
          protocol === 'http' || protocol === 'https'
            ? (obj(b['http'])['rateLimit'] ?? null) : null,
          // $26~$28 — S9 로 열린 "SNI 없음" 분기. **패스스루에만** (DB 도 같은 CHECK).
          nspool?.[0] ?? null, nspool?.[1] ?? null, noSni === 'reject' ? true : null,
          // $29 — S10. **http 계열에만.** stream 에는 server_name 이 없다.
          // `false` 는 안 적는다 — "안 정함" 과 구분할 필요가 없고 DB 도 그렇게 막는다.
          (protocol === 'http' || protocol === 'https')
            && obj(b['http'])['strictPriority'] === true ? true : null],
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
                                   acme_account,acme_domains,
                                   created_by,updated_by,revision)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$8,$9)
         ON CONFLICT (key) DO UPDATE SET
           name=EXCLUDED.name, material_ref=EXCLUDED.material_ref,
           chain_digest=EXCLUDED.chain_digest, key_digest=EXCLUDED.key_digest,
           acme_account=EXCLUDED.acme_account, acme_domains=EXCLUDED.acme_domains,
           version=certificates.version+1, updated_at=now(),
           updated_by=EXCLUDED.updated_by, revision=EXCLUDED.revision`,
        [op.key, b['name'] ?? op.key,
          b['materialRef'] ?? null, b['chainDigest'] ?? null, b['keyDigest'] ?? null,
          obj(b['acme'])['account'] ?? null, obj(b['acme'])['domains'] ?? null,
          by, revision],
      );
      return;

    case 'tlsPolicy':
      await c.query(
        `INSERT INTO tls_policies (id,key,name,min_version,max_version,
                                   sni_host_mismatch,cipher_policy,hsts,
                                   created_by,updated_by,revision)
         VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7,$8,$8,$9)
         ON CONFLICT (key) DO UPDATE SET
           name=EXCLUDED.name, min_version=EXCLUDED.min_version,
           max_version=EXCLUDED.max_version,
           sni_host_mismatch=EXCLUDED.sni_host_mismatch,
           cipher_policy=EXCLUDED.cipher_policy, hsts=EXCLUDED.hsts,
           version=tls_policies.version+1, updated_at=now(),
           updated_by=EXCLUDED.updated_by, revision=EXCLUDED.revision`,
        [op.key, b['name'] ?? op.key, b['minVersion'], b['maxVersion'] ?? null,
          b['sniHostMismatch'] ?? null, b['cipherPolicy'] ?? null,
          b['hsts'] === undefined ? null : JSON.stringify(b['hsts']),
          by, revision],
      );
      return;

    case 'engine':
      // **키가 하나뿐이다.** 해독기가 이미 모양을 봤다(`decodeEngineSettings`).
      await c.query(
        `INSERT INTO engine_settings (only_one, worker_shutdown_timeout_s,
                                      membership_dict_kb, acme_dict_kb, updated_by, revision)
         VALUES (true,$1,$4,$5,$2,$3)
         ON CONFLICT (only_one) DO UPDATE SET
           worker_shutdown_timeout_s=EXCLUDED.worker_shutdown_timeout_s,
           membership_dict_kb=EXCLUDED.membership_dict_kb,
           acme_dict_kb=EXCLUDED.acme_dict_kb,
           updated_at=now(), updated_by=EXCLUDED.updated_by, revision=EXCLUDED.revision`,
        [b['workerShutdownTimeoutS'] ?? null, by, revision,
          b['membershipDictKb'] ?? null, b['acmeDictKb'] ?? null],
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
    /**
     * 인증서 **사실**을 읽는 창구 (검수 B-05). 없으면 SAN 커버리지를 안 본다.
     *
     * `SecretStore` 전체가 아니라 `facts` 하나만 받는다 — 저장소는 자료 바이트를 읽을
     * 이유가 없고, 좁게 받으면 테스트가 개인키 없이 이 경로를 잴 수 있다.
     */
    private readonly certFacts?: Pick<SecretStore, 'facts'>,
  ) {}

  /**
   * **바인딩된 인증서가 그 호스트를 정말 덮는가** (검수 B-05 · S17).
   *
   * 검증기의 `sni_binding_missing` 은 *바인딩 패턴*이 호스트를 덮는지만 본다. 그
   * 바인딩이 가리키는 인증서의 **실제 SAN** 은 아무도 안 봤고, 그래서 `a.test` 를 SAN 이
   * `b.test` 뿐인 인증서에 묶어도 전부 통과했다 — handshake 에서 커버하지 않는 인증서가
   * 제시된다.
   *
   * ── 왜 `validateModel` 이 아닌가 ──────────────────────────────────
   *
   * SAN 은 **모델 밖의 사실**이다(SecretStore 의 바이트에서 온다). `validateModel` 은
   * 순수 함수이고 그 인자 타입은 공개 표면이라, 거기에 I/O 를 끌어들이면 표면이
   * 움직이고 순수성도 잃는다.
   *
   * ⚠️ **대가**: `render()` 만 쓰는 라이브러리 소비자는 이 검사를 못 받는다. 저장소를
   * 지나는 모든 경로(plan · commit · rollback · import)는 받는다.
   *
   * **모르는 것은 안 막는다.** 자료가 없는 인증서(ACME 발급 전)는 검증기가 따로 막고,
   * 사실이 없는 자료(v0.6 1단계)는 판단하지 않는다 — §6.7 의 "관측 못 한 것과 실패한
   * 것은 다르다" 와 같은 규칙이다.
   */
  private assertCertificatesCover(model: Model): void {
    const facts = this.certFacts;
    if (facts === undefined) return;
    const certs = new Map(model.certificates.map((c) => [c.key, c]));
    const problems: string[] = [];

    const check = (certKey: string, hosts: readonly string[], subject: string): void => {
      const ref = certs.get(certKey)?.materialRef;
      if (ref === undefined) return;                 // 발급 전 — 검증기의 몫
      const f = facts.facts(ref);
      if (f === undefined) return;                   // 사실을 모른다
      for (const host of hosts) {
        if (certCoversHost(f, host)) continue;
        problems.push(
          `${subject}: 인증서 '${certKey}' 의 SAN 이 '${host}' 를 안 덮는다 `
          + `(SAN: ${f.domains.join(', ') || '없음'})`,
        );
      }
    };

    for (const b of model.sniBindings) check(b.certificate, b.hosts, `SNI 바인딩 '${b.key}'`);

    if (problems.length > 0) {
      throw new StoreError(422, 'certificate_does_not_cover',
        `바인딩된 인증서가 그 호스트를 안 덮는다 — handshake 에서 클라이언트가 거절한다:\n`
        + problems.map((p) => `  · ${p}`).join('\n'), problems);
    }
  }

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

  /** 현재 head 를 spec-only 매니페스트로. */
  async exportAt(revision: string): Promise<Manifest> {
    return exportManifest(await this.modelAt(revision));
  }

  /**
   * 매니페스트 한 장을 단일 changeset 으로 커밋한다 (§5.5).
   *
   * 차이가 없으면 changeset 을 만들지 않는다. 두 번째 import 가 리비전을
   * 올리지 않는 것이 "결과가 같다" 의 강한 쪽이다.
   */
  async importFromManifest(
    input: unknown, mode: ImportMode, by: string,
  ): Promise<
    | { unchanged: true; revision: string }
    | { unchanged: false; revision: string; planId: string; changesetId: string }
  > {
    const manifest = parseManifest(input);
    const head = await this.head();
    const ops = importPatch(await this.modelAt(head.revision), manifest, mode);
    if (ops.length === 0) return { unchanged: true, revision: head.revision };
    const changesetId = await this.createChangeset(head.revision, by);
    await this.patchChangeset(changesetId, ops, by);
    const plan = await this.plan(changesetId, by);
    const committed = await this.commit(changesetId, plan.id, by);
    return { unchanged: false, revision: committed.revision, planId: plan.id, changesetId };
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
    /**
     * **누적에 상한을 건다** (검수 B-13).
     *
     * 한 요청은 `maxBodyBytes` 로 막히지만 **같은 changeset 에 반복 PATCH 하는 총량**
     * 에는 상한이 없었다. 그리고 `commit` 이 그 전부를 `config_head` 를 `FOR UPDATE` 로
     * 잠근 채 순차로 적용한다 — 누적된 changeset 하나가 다른 모든 커밋을 뒤에 세운다.
     *
     * 검사를 **같은 UPDATE 안에서** 한다. 읽고 나서 쓰면 그 사이에 다른 PATCH 가
     * 끼어들어 상한을 넘길 수 있다.
     */
    const r = await this.db.query(
      `UPDATE changesets SET patch = patch || $2::jsonb
        WHERE id = $1 AND state = 'open'
          AND jsonb_array_length(patch) + $3 <= $4
        RETURNING id`,
      [id, JSON.stringify(ops), ops.length, MAX_CHANGESET_OPS],
    );
    if (r.rowCount === 0) {
      const cur = (await this.db.query(
        'SELECT state, jsonb_array_length(patch) AS n FROM changesets WHERE id=$1', [id],
      )).rows[0];
      if (cur === undefined) throw new StoreError(404, 'unknown_changeset', `changeset ${id} 이 없다`);
      const state = text(cur, 'state');
      if (state !== 'open') {
        throw new StoreError(409, 'changeset_not_open',
          `changeset 이 '${state}' 다 — 열려 있을 때만 고칠 수 있다. reopen 하라`);
      }
      // 열려 있는데 못 넣었다면 상한이다. **부분 적용은 없다** — 받거나 안 받거나다.
      throw new StoreError(409, 'changeset_too_large',
        `changeset 하나에 담을 수 있는 것은 ${MAX_CHANGESET_OPS} 개다 `
        + `(지금 ${num(cur, 'n')} 개 + 보낸 ${ops.length} 개). 나눠서 커밋하라`);
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

    const { model, rendered, before, priorModel } = await this.db.dryRun(async (c) => {
      const prior = await readModel(c);
      const beforeConf = safeRender(prior, this.caps);
      for (const op of ops) await applyOp(c, op, baseRevision, by).catch(translate);
      const next = await readModel(c);
      // **모델 밖의 사실도 여기서 본다** (검수 B-05). 렌더는 SAN 을 모른다.
      this.assertCertificatesCover(next);
      return {
        model: next, rendered: renderOrThrow(next, this.caps),
        before: beforeConf, priorModel: prior,
      };
    });

    // **이전 conf 뿐 아니라 이전 모델도 넘긴다.** 산출물 비교는 "reload 가 필요한가"
    // 까지만 답한다 — *누가* 영향받는가는 모델을 봐야 나온다 (§5.4).
    const impact = impactOf(
      { model: priorModel, conf: before?.conf ?? '' }, { model, rendered },
      this.caps, this.certFacts);
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
      this.assertCertificatesCover(model);
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
    // **모양을 먼저 본다** (검수 B-11). 숫자가 아닌 값을 bigint 컬럼에 그대로 물면
    // PG 가 `invalid input syntax` 로 거절해 500 이 되고, 아래 `BigInt()` 도 던진다.
    // 리비전은 10 진 정수다 — 그게 아니면 **없는 것이 아니라 틀린 것**이므로 400 이다.
    if (!/^\d+$/.test(revision)) {
      throw new StoreError(400, 'malformed',
        `리비전은 10진 정수여야 한다: ${JSON.stringify(revision)}`);
    }
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
      // **엔진 설정도 되돌린다** (011). 안 지우면 engine 이 없던 리비전으로 롤백해도
      // 옛 값이 그대로 남는다 — 그건 롤백이 아니다.
      await c.query(`DELETE FROM engine_settings`);
      for (const op of opsOf(model)) await applyOp(c, op, target, by).catch(translate);

      // 되돌린 결과가 지금도 유효한지 **다시 본다.** 엔진 capability 나 검증 규칙이
      // 그 사이 바뀌었을 수 있다 — 옛 리비전이라고 무조건 통과시키지 않는다.
      const restored = await readModel(c);
      this.assertCertificatesCover(restored);
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
    // 엔진 설정은 아무것도 참조하지 않는다 — 순서는 자유지만 맨 앞에 둔다(만들 때
    // 먼저, 지울 때 마지막). 없으면 op 자체가 없다.
    ...(model.engine === undefined ? [] : [put('engine', ENGINE_KEY, model.engine)]),
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
  // **삭제도 본다.** 문법 밖의 key 로는 애초에 만들 수 없으니 지울 것도 없다 —
  // 그런데 여기를 열어 두면 `DELETE FROM ... WHERE key = '../x'` 가 그대로 나간다.
  if (op.kind !== 'engine') assertKeySyntax(op.kind, op.key);
  if (op.op === 'delete') return;
  const empty: Model = {
    listeners: [], httpRoutes: [], passthroughRoutes: [], pools: [], backends: [],
    certificates: [], tlsPolicies: [], sniBindings: [],
  };
  // `engine` 은 배열이 아니라 단일 객체다 — 나머지와 감싸는 모양이 다르다.
  if (op.kind === 'engine') {
    if (op.key !== ENGINE_KEY) {
      throw new StoreError(400, 'malformed',
        `engine 의 key 는 '${ENGINE_KEY}' 하나다 (받은 것: '${op.key}')`);
    }
    const decoded = decodeModel({ ...empty, engine: obj(op.body) });
    if (!decoded.ok) {
      throw new StoreError(400, 'malformed', 'engine 설정의 모양이 잘못됐다', decoded.issues);
    }
    return;
  }
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
  assertDirectiveStrings(op, body);
}

/**
 * **디렉티브로 가는 문자열을 검증한다** (검수 S-11).
 *
 * `src/validate/strings.ts` 의 첫 줄이 *"어떤 사용자 문자열도 raw nginx 디렉티브로
 * 흘러들지 않는다"* 인데, 실제로 검증기를 안 지나는 값이 셋 있었다:
 *
 *   · `redirect.to`  — `return 301 "<to>"`. nginx 는 **인용 안에서도 변수를 보간한다.**
 *   · `pathPrefix`   — `location <prefix>`. `^~` 면 nginx 가 수식어로 읽는다.
 *   · `backend.host` — `server <host>:<port>`.
 *
 * 그리고 이미 있던 `validateHeaderValue`(변수 화이트리스트까지 구현돼 있다)를 **아무도
 * 안 불렀다.** 여기가 그 호출자다.
 *
 * ⚠️ **해독기가 아니라 여기다.** key 문법(S-01b)과 같은 이유다 — `modelAt` 이 옛 리비전
 * 스냅샷을 `decodeModel` 로 읽으므로 좁히면 그런 값이 든 리비전이 해독 불가가 되고
 * **롤백할 수 없다.** `validateModel` 도 안 된다: `render()` 가 그것을 부르므로 옛
 * 리비전이 렌더 불가가 되고, 롤백은 렌더를 지난다.
 */
function assertDirectiveStrings(op: PatchOp & { op: 'put' }, body: Record<string, unknown>): void {
  const fail = (what: string, message: string): never => {
    throw new StoreError(400, 'malformed', `${op.kind} '${op.key}' 의 ${what}: ${message}`);
  };

  if (op.kind === 'backend' && typeof body['host'] === 'string') {
    const r = validateBackendHost(body['host']);
    if (!r.ok) fail('host', r.message);
  }

  if (op.kind === 'httpRoute') {
    const prefix = body['pathPrefix'];
    if (typeof prefix === 'string') {
      const r = validatePathPrefix(prefix);
      if (!r.ok) fail('pathPrefix', r.message);
    }
    const action = obj(body['action']);
    if (action['kind'] === 'redirect' && typeof action['to'] === 'string') {
      // 리다이렉트 목적지는 헤더 값과 같은 규칙이다 — 제어문자 금지 + 변수 화이트리스트.
      // `$host`·`$request_uri` 는 실제로 쓸모가 있어서 화이트리스트에 있다.
      const r = validateHeaderValue(action['to']);
      if (!r.ok) fail('action.to', r.message);
    }
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

/**
 * 키 순서에 안 흔들리는 직렬화.
 *
 * 두 리비전의 같은 행이 **같은 값인데 키 순서만 다르면** 그냥 `JSON.stringify` 는
 * 다르다고 답한다. 모델은 DB 를 지나 오므로 그 순서를 우리가 정하지 않는다 —
 * "영향받았다" 가 조용히 거짓이 되는 자리라 정규형으로 만든다.
 */
function canon(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canon);
  if (v === null || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o).sort()) out[k] = canon(o[k]);
  return out;
}

const byKey = <T extends { key: string }>(a: T, b: T): number =>
  (a.key < b.key ? -1 : a.key > b.key ? 1 : 0);

/**
 * 리스너 하나가 **무엇에 의존하는가** (§5.4 `affected_listeners`).
 *
 * 전에는 이 자리가 `model.listeners.map(...)` 이었다 — 즉 **전부**를 실었다. 이름이
 * `affectedListeners` 인데 영향과 무관하게 목록을 내면, 백엔드 하나를 옮긴 plan 이
 * "리스너 열두 개가 영향받는다" 고 말한다. 그러면 사람이 그 줄을 안 읽게 되고,
 * 정말로 열두 개가 걸리는 날에도 안 읽는다. §2.2-1 이 해자라고 부른 것이 *영향*이지
 * 목록이 아니다.
 *
 * 폐포는 트래픽이 실제로 지나는 길이다: 리스너 → 그 위의 라우트 → 풀 → 백엔드,
 * https 면 정책·인증서·SNI 바인딩까지. **엔진 전역 설정은 모든 리스너에 걸리므로**
 * 폐포마다 넣는다 — `worker_shutdown_timeout` 이 바뀌면 전부가 영향이다.
 */
function listenerClosure(model: Model, l: Listener): string {
  const pools = new Set<string>();
  const certs = new Set<string>();
  const policies = new Set<string>();
  const parts: unknown[] = [l];

  const addPool = (p: string | undefined): void => { if (p !== undefined) pools.add(p); };

  if (l.protocol === 'http' || l.protocol === 'https') {
    const da = l.http?.defaultAction;
    if (typeof da === 'object') addPool(da.pool);
    const routes = model.httpRoutes.filter((r) => r.listener === l.key).sort(byKey);
    parts.push(routes);
    for (const r of routes) if (r.action.kind === 'proxy') addPool(r.action.pool);
  }
  if (l.protocol === 'https') {
    policies.add(l.tls.policy);
    certs.add(l.tls.defaultCertificate);
    const bindings = model.sniBindings.filter((b) => b.listener === l.key).sort(byKey);
    parts.push(bindings);
    for (const b of bindings) certs.add(b.certificate);
  }
  if (l.protocol === 'tls_passthrough') {
    const routes = model.passthroughRoutes.filter((r) => r.listener === l.key).sort(byKey);
    parts.push(routes);
    for (const r of routes) if (r.action.kind === 'proxy') addPool(r.action.pool);
    if (typeof l.onUnmatchedSni === 'object') addPool(l.onUnmatchedSni.pool);
  }
  if (l.protocol === 'tcp' || l.protocol === 'udp') addPool(l.defaultPool);

  parts.push([...pools].sort().map((k) => model.pools.find((p) => p.key === k) ?? null));
  parts.push(model.backends.filter((b) => pools.has(b.pool)).sort(byKey));
  parts.push([...policies].sort().map((k) => model.tlsPolicies.find((p) => p.key === k) ?? null));
  parts.push([...certs].sort().map((k) => model.certificates.find((c) => c.key === k) ?? null));
  parts.push(model.engine ?? null);
  return JSON.stringify(canon(parts));
}

/** 이전·이후 두 모델에서 **달라진 리스너**만 고른다. */
function affectedListeners(before: Model, after: Model): Impact['affectedListeners'] {
  const b = new Map(before.listeners.map((l) => [l.key, l]));
  const a = new Map(after.listeners.map((l) => [l.key, l]));
  const out: Impact['affectedListeners'] = [];

  for (const key of [...new Set([...b.keys(), ...a.keys()])].sort()) {
    const prev = b.get(key);
    const next = a.get(key);
    const change: ListenerChange | undefined =
      prev === undefined ? 'added'
        : next === undefined ? 'removed'
          : listenerClosure(before, prev) === listenerClosure(after, next) ? undefined : 'changed';
    if (change === undefined) continue;
    const l = next ?? prev!;
    out.push({ key, protocol: l.protocol, bind: l.bind, port: l.port, change });
  }
  return out;
}

/**
 * 프로토콜별 기존 세션 영향 (§5.4 `session_impact`).
 *
 * **재 본 사실 위에만 세운다.** 셋을 쓴다:
 *
 *   · 소켓이 사라지면 그 위의 연결·세션은 끊긴다. bind 가 없어지므로 다른 답이 없다.
 *   · `worker_shutdown_timeout` 이 걸려 있으면 HUP 뒤 in-flight 가 **응답 없이**
 *     죽는다 — §4.10 실측(`curl exit=52`, 본문 0 바이트). 502 도 부분 응답도 아니라
 *     클라이언트는 네트워크 장애와 구분하지 못한다.
 *   · 그 외의 reload 는 기존 것을 기다려 준다. 옛 워커가 in-flight 를 끝내고(P8),
 *     유휴 keepalive 만 닫힌다. 즉 **새 트래픽부터**다.
 *
 * 안 건드린 프로토콜은 `none` 이다. 전부에 같은 값을 실으면 그 줄을 안 읽게 된다 —
 * `affectedListeners` 가 전부를 싣던 것과 같은 실수다.
 */
function sessionImpactOf(
  before: Model, after: Model,
  affected: Impact['affectedListeners'],
  removedSockets: readonly string[],
  requiresReload: boolean,
): Impact['sessionImpact'] {
  const protocols = [...new Set(
    [...before.listeners, ...after.listeners].map((l) => l.protocol),
  )].sort();
  const byKey = new Map([...before.listeners, ...after.listeners].map((l) => [l.key, l]));
  /**
   * **옛 자리로 판정한다.** 닫히는 소켓은 이전 모델의 것이다 — 포트를 옮기면 새 소켓은
   * `added` 에 있고 옛 소켓이 `removed` 에 있다. 지금 자리만 보면 *"지운 것"* 만 잡고
   * *"옮긴 것"* 을 놓치는데, 그 위에 있던 연결 입장에서 둘은 같은 일이다.
   */
  const wasAt = new Map(before.listeners.map((l) => [l.key, socketOf(l)]));
  const removed = new Set(removedSockets);
  // 상한은 **적용될 모델**의 것이다. 지금 걸려 있어도 이 전환에서 풀면 안 잘린다.
  const cutoff = after.engine?.workerShutdownTimeoutS;

  return protocols.map((protocol) => {
    const mine = affected.filter((a) => byKey.get(a.key)?.protocol === protocol);
    if (mine.length === 0) {
      return { protocol, effect: 'none' as const, why: '이 프로토콜의 리스너는 안 바뀐다' };
    }
    const dropped = mine.filter((a) => {
      const was = wasAt.get(a.key);
      return was !== undefined && removed.has(was);
    });
    if (dropped.length > 0) {
      return {
        protocol,
        effect: 'may_reset' as const,
        why: `소켓이 사라진다 (${dropped.map((d) => d.key).join(', ')}) — 그 위의 연결·세션은 끊긴다`,
      };
    }
    if (requiresReload && cutoff !== undefined) {
      return {
        protocol,
        effect: 'may_reset' as const,
        why: `reload 가 난다. worker_shutdown_timeout=${cutoff}s 가 걸려 있어 `
          + '진행 중 요청이 응답 없이 잘릴 수 있다 (§4.10)',
      };
    }
    return {
      protocol,
      effect: 'new_only' as const,
      why: requiresReload
        ? 'reload 가 나지만 진행 중인 것은 옛 워커가 끝낸다 — 유휴 keepalive 만 닫힌다'
        : '산출물이 같다 — 멤버십만 바뀌므로 새 연결·새 요청부터다',
    };
  });
}

/**
 * 교체되는 인증서 (§5.4 `certificate_changes`).
 *
 * 판정 기준은 **`materialRef`** 다. 갱신은 새 버전 참조를 만들 뿐 옛 것을 안 덮으므로
 * (§8.3), 참조가 달라졌다는 것이 곧 "제시되는 바이트가 달라진다" 는 뜻이다. 그리고
 * 그때가 §7.2 가 경고한 자리다 — 경로에 버전이 안 들어가면 갱신이 세대를 안 만들고
 * 조용히 지나간다.
 */
function certificateChanges(
  before: Model, after: Model, facts?: Pick<SecretStore, 'facts'>,
): Impact['certificateChanges'] {
  const b = new Map(before.certificates.map((c) => [c.key, c]));
  const a = new Map(after.certificates.map((c) => [c.key, c]));
  const out: Impact['certificateChanges'] = [];

  for (const key of [...new Set([...b.keys(), ...a.keys()])].sort()) {
    const prev = b.get(key);
    const next = a.get(key);
    const change: MaterialChange | undefined =
      prev === undefined ? 'added'
        : next === undefined ? 'removed'
          : prev.materialRef === next.materialRef ? undefined : 'replaced';
    if (change === undefined) continue;
    // 만료는 **앞으로 제시될** 자료의 것이다. 지워지는 인증서에는 그 자료가 없다.
    const ref = next?.materialRef;
    const notAfter = ref === undefined ? undefined : facts?.facts(ref)?.notAfter;
    out.push({ key, change, ...(notAfter === undefined ? {} : { notAfter }) });
  }
  return out;
}

/**
 * 리스너 하나 위의 HTTP 라우트를 **엔진이 고르는 순서**로 편다 (§7.5).
 *
 * 리스너 단위로 컴파일한다 — nginx 의 `server_name` 선택은 그 소켓 안에서 일어난다.
 * 렌더러는 호스트별로 나눠 컴파일하지만(그 안에서 location 순서만 정하면 되므로),
 * 클래스 간 역전은 호스트를 가로질러야 보인다.
 */
function routeOrderOf(model: Model): Map<string, { order: string[]; warnings: CompileWarning[] }> {
  const out = new Map<string, { order: string[]; warnings: CompileWarning[] }>();
  for (const l of model.listeners) {
    if (l.protocol !== 'http' && l.protocol !== 'https') continue;
    const inputs: RouteInput[] = model.httpRoutes
      .filter((r) => r.listener === l.key)
      .flatMap((r) => r.hosts.map((host) => ({
        key: r.key, host, priority: r.priority,
        ...(r.pathPrefix === undefined ? {} : { pathPrefix: r.pathPrefix }),
      })));
    if (inputs.length === 0) continue;
    const compiled = compileHostRoutes(inputs);
    // 오류가 있으면 컴파일러가 순서를 안 낸다 — 반쯤 컴파일된 순서는 거짓말이다.
    // 그 오류는 `validateModel` 이 이미 막으므로 plan 이 여기까지 오지도 않는다.
    out.set(l.key, { order: compiled.order.map((c) => c.key), warnings: compiled.warnings });
  }
  return out;
}

/** 두 모델의 컴파일된 순서를 견준다. **자리가 바뀐 것만** 싣는다. */
function routeOrderChanges(before: Model, after: Model): Impact['routeOrderChanges'] {
  const b = routeOrderOf(before);
  const a = routeOrderOf(after);
  const moved: Impact['routeOrderChanges']['moved'] = [];
  const warnings: Impact['routeOrderChanges']['warnings'] = [];

  for (const listener of [...new Set([...b.keys(), ...a.keys()])].sort()) {
    const from = b.get(listener)?.order ?? [];
    const to = a.get(listener)?.order ?? [];
    for (const key of [...new Set([...from, ...to])].sort()) {
      const i = from.indexOf(key);
      const j = to.indexOf(key);
      if (i === j) continue;
      moved.push({ listener, key, from: i < 0 ? null : i, to: j < 0 ? null : j });
    }
    for (const w of a.get(listener)?.warnings ?? []) {
      warnings.push({ kind: w.kind, listener, routes: [...w.routes], message: w.message });
    }
  }
  return { moved, warnings };
}

/**
 * 이 엔진에서 **조용히 덜 되는 것** (§5.4 · §7.6).
 *
 * 막히는 조합은 여기 안 온다 — 검증기가 422 로 튕긴다. 모델은 표현할 수 있고 엔진이
 * 못 해서 렌더가 그냥 안 내는 것들만 모은다. 그런 것은 **켰다는 사실만 남고 아무 일도
 * 안 일어나기** 때문에, 이 저장소가 반복해서 잡아온 모양이다.
 */
function capabilityWarningsOf(model: Model, caps: RenderCapabilities): Impact['capabilityWarnings'] {
  const out: Impact['capabilityWarnings'] = [];

  if (caps.httpLua !== true && caps.streamLua !== true && model.pools.length > 0) {
    out.push({
      kind: 'no_membership_plane',
      message: '이 엔진에는 lua 가 없다 — 백엔드가 conf 에 렌더되므로 백엔드 하나를 '
        + '옮겨도 세대 전환과 reload 가 난다 (§7.3). 드레인·헬스 반영도 같은 대가를 진다',
    });
  }

  if (caps.http2 !== true) {
    const https = model.listeners.filter((l) => l.protocol === 'https' && l.enabled);
    // **기본값이 켜짐이라 여기가 조용하다.** 명시적으로 켠 것은 검증기가 이미 막는다.
    const implicit = https.filter((l) => l.protocol === 'https' && l.http2 === undefined);
    if (implicit.length > 0) {
      out.push({
        kind: 'no_http2',
        message: `${implicit.map((l) => l.key).join(', ')} 는 h2 가 기본인데 이 엔진은 `
          + '`http2 on;` 을 못 낸다 (§4.9 — 모듈 또는 core 1.25.1+ 없음). '
          + 'ALPN 이 http/1.1 로 떨어진다',
      });
    }
  }

  if (caps.sslConfCommand !== true && model.tlsPolicies.some((p) => p.cipherPolicy !== undefined)) {
    out.push({
      kind: 'no_ssl_conf_command',
      message: '`ssl_conf_command` 가 없다 — TLS1.3 ciphersuite 를 정할 길이 그것뿐이라 '
        + '(§4.6) 1.3 쪽은 엔진 기본값으로 협상된다. `ssl_ciphers` 는 1.3 에 안 걸린다',
    });
  }

  return out;
}

function impactOf(
  before: { model: Model; conf: string },
  after: { model: Model; rendered: RenderedConfig },
  caps: RenderCapabilities,
  facts?: Pick<SecretStore, 'facts'>,
): Impact {
  const { conf: beforeConf } = before;
  const { model, rendered } = after;
  const sockets = new Set(model.listeners.filter((l) => l.enabled).map(socketOf));
  const requiresReload = beforeConf !== rendered.conf;
  /**
   * **멤버십 평면이 있어야 멤버십 전용 전환이 가능하다** (`control/plane.ts`).
   *
   * apply 는 `caps.httpLua || caps.streamLua` 일 때만 산출물 digest 를 비교해 세대를
   * 건너뛴다. lua 가 없으면 그 지름길 자체가 없으므로 산출물이 같아도 새 세대다.
   * 판정을 여기서 다시 짓지 않고 **같은 근거를 쓴다** — 두 자리가 갈리면 plan 이
   * 거짓말한다.
   */
  const membershipPlane = caps.httpLua === true || caps.streamLua === true;
  /**
   * **이전 소켓도 모델에서 뽑는다.**
   *
   * 전에는 이전 `conf` 를 정규식으로 훑었다. 두 쪽이 다른 자였다 — 와일드카드 bind 는
   * `listen 999;` 로 렌더되므로(§7.1) conf 쪽은 `tcp://999`, 모델 쪽은
   * `tcp://0.0.0.0:999` 가 나온다. **절대 안 만난다.** 그래서 리스너를 안 건드린
   * plan 도 "소켓 둘이 닫히고 둘이 열린다" 고 답했다.
   *
   * §5.4 는 이 줄을 *"HUP 실패 위험이 드러나는 자리"* 라고 부른다. 매번 전부가
   * 열리고 닫히는 것처럼 보이면 그건 신호가 아니라 잡음이고, 정말로 포트가 바뀌는
   * 날에도 똑같이 보인다. 자를 하나로 맞춘다 — 덤으로 conf 파서가 사라진다.
   */
  const beforeSockets = new Set(
    before.model.listeners.filter((l) => l.enabled).map(socketOf),
  );
  const affected = affectedListeners(before.model, model);
  const socketsRemoved = [...beforeSockets].filter((s) => !sockets.has(s)).sort();
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
    requiresReload,
    topologyEpochChange: requiresReload || !membershipPlane,
    affectedListeners: affected,
    sessionImpact: sessionImpactOf(before.model, model, affected, socketsRemoved, requiresReload),
    certificateChanges: certificateChanges(before.model, model, facts),
    routeOrderChanges: routeOrderChanges(before.model, model),
    capabilityWarnings: capabilityWarningsOf(model, caps),
    socketChanges: {
      added: [...sockets].filter((s) => !beforeSockets.has(s)).sort(),
      removed: socketsRemoved,
    },
    planes: rendered.planes,
    confDiff: { before: beforeConf.length, after: rendered.conf.length },
  };
}

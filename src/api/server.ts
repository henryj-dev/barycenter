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
import {
  createServer, type IncomingMessage, type RequestListener, type Server,
  type ServerResponse,
} from 'node:http';
import { readFileSync } from 'node:fs';
import { createSecureContext, type SecureContextOptions } from 'node:tls';
import { createHash, randomBytes, randomUUID, X509Certificate } from 'node:crypto';

import { currentLeader, listClusterNodes, nodeHistory } from '../control/cluster.js';
import type { ControlPlane } from '../control/plane.js';
import { AcmeStore } from '../control/acme-store.js';
import { leaksSecret, publicChallenge, publicOrder } from '../control/acme-view.js';
import {
  deadlineExceededKeys, drainStatusOf, endDrain, isDraining, parsePeerObservation, startDrain,
} from '../control/drain.js';
import { healthRows } from '../control/health.js';
import { count, render as renderMetrics, type LabeledGauge } from '../obs/metrics.js';
import { log } from '../obs/log.js';
import { NotLeader, type LeaderElection } from '../control/leader.js';
import { ConfigStore, isHistoryKind, StoreError, type PatchOp } from '../store/config-store.js';
import { AccountError, AccountStoreUnavailable, STEP_UP_MAX_AGE_MS, type AccountService, type Meta as AccountMeta } from '../accounts/service.js';
import type { Db } from '../store/pg.js';
import type { SecretStore } from '../dp/secrets.js';
import { CertMaterialError, inspectMaterial } from '../dp/certinfo.js';
import { socketRows } from '../web/sockets-view.js';
import { serveGui } from '../web/serve-gui.js';
import {
  can, principalFromClientCert, TokenAuth,
  type PeerCertificate, type Principal, type Scope,
} from './auth.js';
import { newEcKey } from '../acme/der.js';
import { PATH_SEGMENT_RULE, PATH_SEGMENT_SYNTAX } from '../validate/syntax.js';
import { SECURITY_HEADERS } from './headers.js';
import { EventHub, openEventStream } from './events.js';
import { AuthFailureLimiter } from './auth-rate-limit.js';
import { clientAddress, type TrustedProxies } from './client-address.js';
import { RELAY_PATHS, type RegionRelay } from '../global/relay.js';
import type { HostAddressFacts } from '../engine/host-addresses.js';
import {
  BrowserSessions, LOGIN_COOKIE, SESSION_COOKIE, cookieValue, expiredCookie, sessionCookie,
} from './browser-session.js';
import {
  authorizationRequest, exchangeAuthorizationCode, exchangeForClaims, pkceChallenge, pkceVerifier,
  type OidcRpSettings,
} from './oidc-code.js';

export type ApiOptions = {
  /** 믿을 프록시 (`BARY_TRUSTED_PROXIES`). 접속 주소가 이 안이면 `X-Forwarded-For` 로 보낸 사람을 찾는다. */
  trustedProxies?: TrustedProxies;
  /**
   * 클러스터 모드 (ADR-CLUSTER, #118). 없으면 이 인스턴스는 클러스터가 아니다.
   * `node` 는 이 노드의 이름, `staleAfterMs` 를 넘긴 신호는 「연락 없음」이다.
   */
  cluster?: { node: string; staleAfterMs: number };
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
  /**
   * 정적 GUI 루트. 없으면 HTML 을 안 낸다.
   * API 와 같은 출처에서 내보낸다 — 브라우저 CORS 를 열지 않기 위해.
   */
  guiRoot?: string;
  /**
   * Authorization Code RP. 없으면 로그인 시작·교환이 404 다.
   * ID Token Bearer 검증은 TokenAuth 가 따로 든다. 스코프 표에 안 올린다 —
   * 토큰이 없는 사람이 여기를 지난다.
   */
  oidcRp?: OidcRpSettings;
  /** 테스트가 Token Endpoint 응답을 주입할 때. 없으면 전역 fetch. */
  oidcFetch?: typeof fetch;
  /** 외부 주소에 TLS 없이 바인딩된 상태. 인증된 metrics 에만 노출한다. */
  plaintextExposed?: boolean;
  /** GUI 로그인 세션. 없으면 API 인스턴스마다 하나를 만든다. */
  sessions?: BrowserSessions;
  /** HTTPS 서버에서만 Secure 쿠키를 붙인다. */
  sessionSecure?: boolean;
  /**
   * 사람 계정 (공통 회원정책 1차 · 계획 A). 공용 계정 PG 에 산다. 없으면 계정 경로는 404
   * `accounts_disabled` 이고 사람 로그인은 지금처럼 OIDC 메모리 세션뿐이다.
   */
  accounts?: AccountService;
  /**
   * 설치된 판 (`$PREFIX/version`, 설치 스크립트가 쓴다). `/status` 의 `build` 로 나간다.
   *
   * 전역 모드가 지역 응답을 **해석하지 않고** 넘기므로(docs/design-global-mode.md §2.3),
   * 판이 갈리면 화면이 어긋날 수 있다. 그 어긋남을 드러내려면 지역이 자기 판을 말해야 한다.
   * 없으면 `null` — 모른다는 것이지 판이 없다는 것이 아니다.
   */
  build?: BuildInfo | null;
  /**
   * 이 서버에 할당된 IP (2026-10-31). GUI 의 바인드 선택이 읽는다. 없으면 `available: false` 를 낸다 —
   * 그러면 GUI 는 바인드를 손으로 받는다.
   */
  hostAddresses?: () => HostAddressFacts;
};

export type BuildInfo = { commit?: string; describe?: string; installedAt?: string };

/** `key=value` 줄들. 모르는 키는 버린다 — 이 파일은 설치 스크립트가 쓰는 메모다. */
export function parseBuildInfo(text: string): BuildInfo | null {
  const out: BuildInfo = {};
  for (const line of text.split('\n')) {
    const at = line.indexOf('=');
    if (at <= 0) continue;
    const k = line.slice(0, at).trim();
    const v = line.slice(at + 1).trim();
    if (v === '') continue;
    if (k === 'commit') out.commit = v;
    else if (k === 'describe') out.describe = v;
    else if (k === 'installed_at') out.installedAt = v;
  }
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * **전역 모드의 API** (docs/design-global-mode.md).
 *
 * 설정 PG·데이터 플레인·리더가 없다 — 그 자리(`db`·`store`·`control`·`election`)를 타입에서 아예 뺀다. 가짜
 * 객체로 채우면 지역 라우트가 실수로 닿았을 때 조용히 이상한 값을 낸다. 인증·세션·OIDC·GUI·**사람 계정**은
 * 지역과 같은 코드를 지난다(계정은 공용 계정 PG 에 산다 — 사용자 결정).
 */
export type GlobalApiOptions = {
  /** 믿을 프록시 (`BARY_TRUSTED_PROXIES`). 접속 주소가 이 안이면 `X-Forwarded-For` 로 보낸 사람을 찾는다. */
  trustedProxies?: TrustedProxies;
  global: RegionRelay;
  auth: TokenAuth;
  maxBodyBytes?: number;
  guiRoot?: string;
  oidcRp?: OidcRpSettings;
  oidcFetch?: typeof fetch;
  plaintextExposed?: boolean;
  sessions?: BrowserSessions;
  sessionSecure?: boolean;
  accounts?: AccountService;
  build?: BuildInfo | null;
};

type AnyApi = ApiOptions | GlobalApiOptions;
const isGlobal = (api: AnyApi): api is GlobalApiOptions => 'global' in api;

export function plaintextExposureMetric(exposed: boolean): LabeledGauge {
  return {
    name: 'bary_api_plaintext_exposed',
    help: '제어 API가 외부 주소에 TLS 없이 바인딩되었는가 (1/0)',
    samples: [{ labels: {}, value: exposed ? 1 : 0 }],
  };
}

/**
 * TLS 소켓의 peer 인증서. 평문 소켓이면 `undefined` 다.
 *
 * **`authorized` 를 함께 낸다** — TLS 층이 체인을 검증했는지가 이 값의 뜻을 정한다.
 * `apiTlsOptions` 는 `clientCa` 가 있을 때 `requestCert` 와 `rejectUnauthorized` 를
 * 함께 켜므로, 검증 안 된 인증서로는 handshake 자체가 안 끝난다. 그래도 여기서 다시
 * 보는 이유는 **그 배선이 바뀌어도 이 판정이 혼자 서야** 하기 때문이다.
 */
function peerCertOf(req: IncomingMessage): PeerCertificate | undefined {
  const sock = req.socket as { getPeerCertificate?: () => unknown; authorized?: boolean };
  if (typeof sock.getPeerCertificate !== 'function') return undefined;
  const cert = sock.getPeerCertificate() as { subject?: Record<string, string> } | undefined;
  if (cert === undefined || cert.subject === undefined) return undefined;
  return { subject: cert.subject, authorized: sock.authorized === true };
}

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

type Route<A = ApiOptions> = {
  method: string;
  path: string;
  pattern: RegExp;
  keys: string[];
  scope: Scope;
  handle: (c: Ctx, api: A) => Promise<void>;
  /**
   * 리더가 아니어도 받는다. 계정 쓰기는 **계정 PG** 에 가고 지역 리더십과 무관하다 — 스탠바이에서
   * 비밀번호를 못 바꾸면 사람이 그 이유를 알 길이 없다.
   */
  leaderFree?: boolean;
  /**
   * **민감 작업** (공통 회원정책 1차). 사람 세션이면 최근 MFA(`STEP_UP_MAX_AGE_MS`)를 요구하고, 없으면
   * 403 `mfa_step_up_required` — 화면이 코드를 받아 `/session/step-up` 하고 다시 보낸다. 기계 토큰엔 없다.
   */
  sensitive?: boolean;
};

const json = (res: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void => {
  const body = JSON.stringify(value, null, 2);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    // **한 자리에서 붙인다** (검수 S-10). 라우트마다 적으면 새 라우트가 하나 늘 때마다
    // 빠질 자리가 하나 는다.
    ...SECURITY_HEADERS,
    ...headers,
  });
  res.end(body);
};

/** `/api/v1/changesets/:id/plan` → 정규식 + 키 이름. */
function route<A = ApiOptions>(
  method: string, path: string, scope: Scope,
  handle: (c: Ctx, api: A) => Promise<void>,
  opts: { leaderFree?: boolean; sensitive?: boolean } = {},
): Route<A> {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' + path.replace(/:([a-zA-Z]+)/g, (_, k: string) => {
      keys.push(k);
      return '([^/]+)';
    }) + '$',
  );
  return {
    method, path, pattern, keys, scope, handle,
    ...(opts.leaderFree === true ? { leaderFree: true } : {}),
    ...(opts.sensitive === true ? { sensitive: true } : {}),
  };
}

/** 구현된 REST 표면. OpenAPI 동결이 이 표를 본다. */
export function apiRouteTable(): { method: string; path: string; scope: Scope }[] {
  // 전역 경로도 구현된 표면이다 — 같은 데몬이 `BARY_MODE` 로 고를 뿐이다.
  return [...ROUTES, ...ACCOUNT_ROUTES, ...GLOBAL_ROUTES].map((r) => ({ method: r.method, path: r.path, scope: r.scope }));
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

  /**
   * 리비전 목록 — 새 것부터 (GUI `/change/history`, 2026-10-30). 롤백 대상을 고르는 자리다.
   * `limit` 은 1–500 으로 묶는다(검수 B-11 — 음수가 PG 까지 가면 500 이다).
   */
  route('GET', '/api/v1/config/revisions', 'read', async (c, api) => {
    const asked = Number(c.url.searchParams.get('limit') ?? '50') || 50;
    json(c.res, 200, await api.store.revisions(asked));
  }),

  /**
   * **이 리소스를 바꾼 리비전** (GUI 상세의 「기록」 탭, 2026-10-30).
   * `kind` 는 patch 의 kind 와 같은 이름이다(`listener`·`httpRoute`·`pool` …). 모르는 kind 는 400 이다 —
   * 빈 목록으로 답하면 오타가 「바뀐 적 없다」 로 보인다.
   */
  route('GET', '/api/v1/config/history', 'read', async (c, api) => {
    const kind = c.url.searchParams.get('kind') ?? '';
    const key = c.url.searchParams.get('key') ?? '';
    if (!isHistoryKind(kind)) {
      json(c.res, 400, { error: 'bad_kind', message: `kind '${kind}' 를 모른다` });
      return;
    }
    if (key === '') {
      json(c.res, 400, { error: 'bad_key', message: 'key 가 비어 있다' });
      return;
    }
    const asked = Number(c.url.searchParams.get('limit') ?? '50') || 50;
    json(c.res, 200, await api.store.resourceHistory(kind, key, { limit: asked }));
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

  /**
   * 백업 묶음. spec-only export + head 리비전. 시크릿 바이트는 안 실는다.
   */
  route('GET', '/api/v1/backup', 'read', async (c, api) => {
    const head = await api.store.head();
    const manifest = await api.store.exportAt(head.revision);
    json(c.res, 200, { revision: head.revision, manifest });
  }),

  /**
   * 백업 복구. `admin` 스코프. 적용은 `/apply` 의 몫이다.
   */
  route('POST', '/api/v1/restore', 'admin', async (c, api) => {
    const body = c.body;
    const wrapped = body !== null && typeof body === 'object' && !Array.isArray(body);
    const manifest = wrapped && 'manifest' in (body as object)
      ? (body as { manifest: unknown }).manifest
      : body;
    const out = await api.store.importFromManifest(manifest, 'replace', c.who.name);
    eventsOf(api).publish('revision', { revision: out.revision, restored: true });
    json(c.res, 200, out);
  }, { sensitive: true }),

  route('GET', '/api/v1/listeners', 'read', async (c, api) => {
    json(c.res, 200, (await api.store.modelAt((await api.store.head()).revision)).listeners);
  }),
  /**
   * 이 설정이 **점유하는 소켓 전부** (§4.5 · §11.3).
   *
   * §11.3 이 어느 배포를 고르든(hostNetwork·hostPort·LoadBalancer) 운영자에게 같은 것
   * 하나가 필요하다 — "이 설정이 어느 (전송, 주소, 포트) 를 잡는가". 리스너 목록만
   * 주면 프로토콜→전송 변환을 밖에서 다시 구현해야 하고, 그러면 §4.5 의 규칙이 두 벌이
   * 된다. 리스너 하나가 소켓 **여럿**일 수 있다(S20 — quic 은 UDP 도 잡는다).
   */
  route('GET', '/api/v1/sockets', 'read', async (c, api) => {
    json(c.res, 200, socketRows(await api.store.modelAt((await api.store.head()).revision)));
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
  /**
   * **왜 이 백엔드가 트래픽을 안 받나** — 한 번에 (제안 #9).
   *
   * 헬스(`/backends/{id}/status`)·드레인(`/backends/{id}/drain-status`)·슬롯 소속을
   * 따로 물어 머리로 합치던 것을 모은다. 셋째는 지금까지 물을 창구조차 없었다.
   *
   * `/backends/{id}/status` 는 남긴다 — 한 줄만 보려는 소비자(CLI `get`)가 있고,
   * 이 목록은 백엔드가 많은 배포에서 응답이 커진다.
   */
  route('GET', '/api/v1/backends/status', 'read', async (c, api) => {
    json(c.res, 200, await api.control.backendStatus());
  }),

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

  route('POST', '/api/v1/backends/:id/drain', 'write', async (c, api) => {
    const key = c.params['id'] ?? '';
    const m = await api.store.modelAt((await api.store.head()).revision);
    if (!m.backends.some((b) => b.key === key)) {
      json(c.res, 404, { error: 'not_found', message: `백엔드 '${key}' 가 없다` });
      return;
    }
    const raw = (c.body as { deadline_s?: unknown } | null)?.deadline_s;
    const deadline = typeof raw === 'number' && Number.isInteger(raw) && raw > 0 ? raw : undefined;
    await startDrain(api.db, key, c.who.name, deadline);
    await api.control.projectHealth();
    json(c.res, 200, drainStatusOf({ backend: key, draining: true }));
  }),

  /**
   * 드레인 해제 (검수 B-04).
   *
   * **이 경로가 아예 없었다.** 시작만 되고 푸는 길이 없어서, 운영 중에 백엔드를 잠깐
   * 빼는 것이 DB 를 손으로 고치기 전까지 되돌릴 수 없는 조작이었다.
   *
   * `write` 다 — 시작과 같은 권한이다. 빼는 것보다 넣는 것이 더 위험하지도, 덜 위험하지도
   * 않다(둘 다 트래픽을 옮긴다). 그리고 `apply` 를 요구하면 뺀 사람이 못 되돌린다.
   */
  route('DELETE', '/api/v1/backends/:id/drain', 'write', async (c, api) => {
    const key = c.params['id'] ?? '';
    const m = await api.store.modelAt((await api.store.head()).revision);
    if (!m.backends.some((b) => b.key === key)) {
      json(c.res, 404, { error: 'not_found', message: `백엔드 '${key}' 가 없다` });
      return;
    }
    // **없던 것을 푼 것과 푼 것은 다르다.** 빈 성공으로 답하면 둘이 같아진다.
    if (!(await endDrain(api.db, key))) {
      json(c.res, 404, { error: 'not_draining', message: `백엔드 '${key}' 는 드레인 중이 아니다` });
      return;
    }
    await api.control.projectHealth();
    await api.store.audit(c.who.name, 'backend.undrain', key, undefined, undefined);
    json(c.res, 200, { backend: key, draining: false });
  }),

  route('GET', '/api/v1/backends/:id/drain-status', 'read', async (c, api) => {
    const key = c.params['id'] ?? '';
    const m = await api.store.modelAt((await api.store.head()).revision);
    if (!m.backends.some((b) => b.key === key)) {
      json(c.res, 404, { error: 'not_found', message: `백엔드 '${key}' 가 없다` });
      return;
    }
    const be = m.backends.find((b) => b.key === key);
    /**
     * **어느 평면에 물을지는 풀이 정한다** (S2, 2026-08-23).
     *
     * `in:` 카운터는 평면마다 자기 dict 에 있고 두 zone 은 서로 안 보인다(E14 · E25).
     * 전에는 무조건 http admin 에 물었으므로 TCP·UDP 백엔드는 숫자가 세어지고 있는데도
     * 늘 "관측 없음" 이었고, 그래서 `quiesced` 가 영영 안 나왔다.
     */
    const cls = be === undefined
      ? undefined
      : m.pools.find((p) => p.key === be.pool)?.protocolClass;
    const raw = be === undefined
      ? undefined
      : await api.control.observePeer(be.host, be.port, cls === 'http' ? 'http' : 'stream');
    const obs = parsePeerObservation(raw);
    const status = drainStatusOf({
      backend: key,
      draining: await isDraining(api.db, key),
      // **기한은 관측이다** (§4.4). 넘겨도 드레인은 유지되고 조건만 그것을 말한다 —
      // 안 읽으면 `deadline_at` 이 다시 「저장만 하고 아무도 안 보는」 열이 된다.
      deadlineExceeded: (await deadlineExceededKeys(api.db)).has(key),
      ...(obs === undefined ? {} : { inflight: obs.inflight, sessions: obs.sessions }),
    });
    if (status === undefined) {
      json(c.res, 404, { error: 'not_draining', message: `백엔드 '${key}' 는 드레인 중이 아니다` });
      return;
    }
    json(c.res, 200, status);
  }),

  /**
   * **ACME 계정을 만든다** (검수 D21 · DESIGN §8.2.1).
   *
   * 전에는 `acme_accounts` 에 넣는 코드의 호출자가 **테스트뿐**이었다. 계정이 없으면
   * 러너가 `acme.no_account` 를 경고로 찍고 건너뛰므로, 새 배포에서 인증서에 `acme`
   * 의도를 적어도 **주문이 영영 안 열렸다** — ACME 기능 전체가 도달 불가였다.
   *
   * **CA 등록은 여기서 안 한다.** 원장에 적고 계정 키를 만들 뿐이고, `newAccount` 는
   * 러너가 첫 주문 때 부른다(`#drive` 가 `accountUrl` 이 없으면). 창구가 CA 를 기다리면
   * CA 가 느린 날 계정을 못 만들고, 그건 **관측 못 한 것을 실패로 접는 것**이다.
   */
  route('POST', '/api/v1/acme/accounts', 'write', async (c, api) => {
    const secrets = api.secrets;
    if (secrets === undefined) {
      json(c.res, 501, {
        code: 'no_secret_store',
        message: '시크릿 저장소가 없다 — 계정 키를 둘 곳이 없다',
      });
      return;
    }
    const body = (c.body ?? {}) as Record<string, unknown>;
    const key = field(body, 'key');
    const directoryUrl = field(body, 'directoryUrl');
    // **경계에 해독기를 둔다.** `key` 는 시크릿 이름(`acme-<key>`)이 되어 경로 조각이
    // 되고, 디렉토리 URL 은 우리가 개인키로 서명해 말을 거는 상대다.
    if (!PATH_SEGMENT_SYNTAX.test(key)) {
      throw new StoreError(400, 'malformed',
        `계정 key 가 문법에 안 맞는다: ${JSON.stringify(key)} — ${PATH_SEGMENT_RULE}`);
    }
    if (!directoryUrl.startsWith('https://')) {
      throw new StoreError(400, 'malformed',
        'ACME 디렉토리는 https 여야 한다 — 평문으로 계정 키 서명을 보내지 않는다');
    }
    const contact = Array.isArray(body['contact'])
      ? (body['contact'] as unknown[]).map((x) => {
        if (typeof x !== 'string') {
          throw new StoreError(400, 'malformed', 'contact 는 문자열 배열이어야 한다');
        }
        return x;
      })
      : [];

    // 계정 키는 **인증서가 없는 키**라 `key://` 참조로 산다 (§4.8).
    const ref = await secrets.putKey(`acme-${key}`,
      newEcKey().export({ type: 'pkcs8', format: 'pem' }).toString());
    const id = await new AcmeStore(api.db).upsertAccount({
      key, directoryUrl, accountKeyRef: ref.ref, contact, by: c.who.name,
    });
    await api.store.audit(c.who.name, 'acme.account.created', 'acme', id,
      { key, directoryUrl, contact });
    // **참조도 안 낸다.** 운영자가 그것으로 할 수 있는 일이 없다.
    json(c.res, 201, { id, key, directoryUrl, contact, registered: false });
  }),

  /**
   * 계정 목록 (검수 D21).
   *
   * 만들 수만 있고 확인할 수 없으면 「제품 경로가 있다」가 절반만 참이다 — 운영자도
   * GUI 도 「계정이 있는가」를 물을 자리가 필요하다.
   */
  route('GET', '/api/v1/acme/accounts', 'read', async (c, api) => {
    const accounts = await new AcmeStore(api.db).accounts();
    if (leaksSecret(accounts)) {
      json(c.res, 500, { error: 'secret_leak', message: '계정 목록에 시크릿이 실렸다' });
      return;
    }
    json(c.res, 200, { accounts });
  }),

  route('GET', '/api/v1/acme/orders', 'read', async (c, api) => {
    const body = (await new AcmeStore(api.db).list()).map(publicOrder);
    if (leaksSecret(body)) {
      json(c.res, 500, { error: 'secret_leak', message: '주문 목록에 시크릿이 실렸다' });
      return;
    }
    json(c.res, 200, body);
  }),

  route('GET', '/api/v1/acme/orders/:id/challenges', 'read', async (c, api) => {
    const store = new AcmeStore(api.db);
    const order = await store.get(c.params['id'] ?? '');
    if (order === undefined) {
      json(c.res, 404, { error: 'not_found', message: `주문 '${c.params['id']}' 가 없다` });
      return;
    }
    const body = (await store.challenges(order.id)).map(publicChallenge);
    if (leaksSecret(body)) {
      json(c.res, 500, { error: 'secret_leak', message: '챌린지에 시크릿이 실렸다' });
      return;
    }
    json(c.res, 200, body);
  }),

  route('GET', '/api/v1/acme/orders/:id', 'read', async (c, api) => {
    const order = await new AcmeStore(api.db).get(c.params['id'] ?? '');
    if (order === undefined) {
      json(c.res, 404, { error: 'not_found', message: `주문 '${c.params['id']}' 가 없다` });
      return;
    }
    const body = publicOrder(order);
    if (leaksSecret(body)) {
      json(c.res, 500, { error: 'secret_leak', message: '주문에 시크릿이 실렸다' });
      return;
    }
    json(c.res, 200, body);
  }),

  route('GET', '/api/v1/acme/challenges/:id', 'read', async (c, api) => {
    const ch = await new AcmeStore(api.db).challenge(c.params['id'] ?? '');
    if (ch === undefined) {
      json(c.res, 404, { error: 'not_found', message: `챌린지 '${c.params['id']}' 가 없다` });
      return;
    }
    const body = publicChallenge(ch);
    if (leaksSecret(body)) {
      json(c.res, 500, { error: 'secret_leak', message: '챌린지에 시크릿이 실렸다' });
      return;
    }
    json(c.res, 200, body);
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
  // 주소 집합 (#114). 없으면 빈 배열이다 — 집합이 없는 모델에는 필드가 없다.
  route('GET', '/api/v1/address-sets', 'read', async (c, api) => {
    json(c.res, 200, (await api.store.modelAt((await api.store.head()).revision)).addressSets ?? []);
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

  // **실패한 head 를 다시 적용한다** (2026-11-01). 같은 리비전의 새 plan 을 만들어 바로 적용한다 — 실패한 plan 은
  // 멱등이라 다시 부르면 그 실패를 그대로 돌려준다. 다시 시도할 것이 없으면 409 다.
  route('POST', '/api/v1/apply/retry', 'apply', async (c, api) => {
    const { planId } = await api.store.replanHead(c.who.name);
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

  // 클러스터 노드 (ADR-CLUSTER, #118). 꺼져 있으면 `enabled: false` 와 빈 목록이다.
  /**
   * **바인드할 수 있는 주소** (2026-10-31). 바인드는 수신할 소켓의 주소라, 이 서버에 할당된 것과
   * 와일드카드만 연다. `nonlocalBind` 가 켜진 계열은 VIP 처럼 아직 안 붙은 주소도 연다.
   */
  route('GET', '/api/v1/system/addresses', 'read', async (c, api) => {
    const read = 'hostAddresses' in api ? api.hostAddresses : undefined;
    if (read === undefined) {
      json(c.res, 200, { available: false, addresses: [], nonlocalBind: { v4: false, v6: false } });
      return;
    }
    json(c.res, 200, { available: true, ...read() });
  }),
  route('GET', '/api/v1/cluster/nodes', 'read', async (c, api) => {
    const cl = 'cluster' in api ? api.cluster : undefined;
    if (cl === undefined || !('db' in api)) {
      json(c.res, 200, { enabled: false, nodes: [] });
      return;
    }
    const leader = await currentLeader(api.db);
    json(c.res, 200, {
      enabled: true, self: cl.node,
      ...(leader === undefined ? {} : { leader }),
      nodes: await listClusterNodes(api.db, cl.staleAfterMs),
    });
  }),
  // 노드 하나의 최근 적용 기록 (#120). 클러스터가 꺼져 있으면 빈 목록이다.
  route('GET', '/api/v1/cluster/nodes/:name/history', 'read', async (c, api) => {
    const cl = 'cluster' in api ? api.cluster : undefined;
    if (cl === undefined || !('db' in api)) { json(c.res, 200, []); return; }
    json(c.res, 200, await nodeHistory(api.db, c.params['name'] ?? ''));
  }),
  route('GET', '/api/v1/status', 'read', async (c, api) => {
    json(c.res, 200, { ...await api.control.status(), build: api.build ?? null });
  }),

  /**
   * §5.2 · §10 SSE. 스냅샷 + 델타 + 하트비트. GUI 는 폴링하지 않는다.
   * 스냅샷에 지금 헬스를 실는다. 판정 변경은 `health` 델타 — `/status` 는 그대로다.
   * 핸들러가 연결이 끊길 때까지 await 한다.
   */
  route('GET', '/api/v1/events', 'read', async (c, api) => {
    await openEventStream({
      req: c.req,
      res: c.res,
      hub: eventsOf(api),
      snapshot: async () => {
        const [status, health] = await Promise.all([
          api.control.status(),
          healthRows(api.db),
        ]);
        return { ...status, health };
      },
      ...(api.heartbeatMs === undefined ? {} : { heartbeatMs: api.heartbeatMs }),
      // 사람 세션이면 하트비트마다 살아 있는지 묻는다 — 로그아웃·정지 뒤 열린 스트림을 닫는다.
      ...(c.who.account !== undefined && api.accounts !== undefined
        ? { alive: ((acc, h) => () => acc.sessionAlive(h))(api.accounts, c.who.account.sessionHash) }
        : {}),
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
    // **계열을 나란히 낸다.** `renderMetrics` 는 표본 없는 계열을 통째로 빼므로,
    // 못 물은 것이 0 으로 새지 않는다 (검수 D4 의 슬롯 키 게이지가 그 규칙을 쓴다).
    const [certs, slots] = await Promise.all([
      api.control.certificateExpiry(),
      api.control.membershipSlotKeys(),
    ]);
    c.res.end(renderMetrics(await api.control.gauges(), [
      ...certs,
      ...slots,
      plaintextExposureMetric(api.plaintextExposed === true),
    ]));
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
      const ref = await store.put(name, { fullchain, privkey });
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
  }, { sensitive: true }),

  route('GET', '/api/v1/audit', 'read', async (c, api) => {
    // **하한이 필요하다** (검수 B-11). `Math.min` 만 걸면 음수가 그대로 내려가고
    // PG 가 `LIMIT must not be negative` 로 거절해 500 이 된다.
    const asked = Number(c.url.searchParams.get('limit') ?? '100') || 100;
    const limit = Math.min(Math.max(Math.floor(asked), 1), 1000);
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

/**
 * 사람 계정 경로가 쓰는 것만. 지역(`ApiOptions`)과 전역(`GlobalApiOptions`)이 **같은 표**를 쓴다 —
 * 전역에서도 로그인·내 계정·사람 관리를 한다(계정은 공용 계정 PG 에 산다).
 */
type AccountApi = { accounts?: AccountService; oidcRp?: OidcRpSettings; sessionSecure?: boolean };

const ACCOUNT_ROUTES: Route<AccountApi>[] = [
  // ── 사람 계정 (공통 회원정책 1차 · 계획 A) ─────────────────────────────
  //
  // 「나」 경로는 사람 세션에만 뜻이 있다(`personOf`). 관리 경로는 `admin` 스코프 — 사람 admin 은
  // MFA 를 지난 세션이고(`AccountService.authenticate`), 기계 토큰의 admin 은 비상 경로다.
  // 전부 `leaderFree` 다: 계정 PG 는 지역 리더십과 무관하다.

  route<AccountApi>('GET', '/api/v1/me', 'read', async (c, api) => {
    json(c.res, 200, await accountsOf(api).me(personOf(c.who).userId));
  }, { leaderFree: true }),

  route<AccountApi>('POST', '/api/v1/session/logout-all', 'read', async (c, api) => {
    const n = await accountsOf(api).logoutAll(personOf(c.who).userId, c.who.name, metaOf(c.req));
    c.res.setHeader('set-cookie', expiredCookie(accountCookie(api), api.sessionSecure === true));
    json(c.res, 200, { revoked: n });
  }, { leaderFree: true }),

  route<AccountApi>('POST', '/api/v1/me/password', 'read', async (c, api) => {
    const p = personOf(c.who);
    await accountsOf(api).changePassword(p.userId, bodyStr(c.body, 'current'), bodyStr(c.body, 'next'), p.sessionHash, metaOf(c.req));
    json(c.res, 200, { changed: true });
  }, { leaderFree: true }),

  route<AccountApi>('POST', '/api/v1/me/mfa/totp', 'read', async (c, api) => {
    json(c.res, 200, await accountsOf(api).beginTotp(personOf(c.who).userId, c.who.name.replace(/^user:/, '')));
  }, { leaderFree: true }),

  route<AccountApi>('POST', '/api/v1/me/mfa/totp/confirm', 'read', async (c, api) => {
    json(c.res, 200, { recoveryCodes: await accountsOf(api).confirmTotp(personOf(c.who).userId, bodyStr(c.body, 'code'), metaOf(c.req)) });
  }, { leaderFree: true }),

  route<AccountApi>('POST', '/api/v1/me/mfa/totp/remove', 'read', async (c, api) => {
    await accountsOf(api).removeTotp(personOf(c.who).userId, bodyStr(c.body, 'password'), metaOf(c.req));
    json(c.res, 200, { removed: true });
  }, { leaderFree: true }),

  route<AccountApi>('POST', '/api/v1/me/mfa/recovery-codes', 'read', async (c, api) => {
    json(c.res, 200, { recoveryCodes: await accountsOf(api).regenerateRecoveryCodes(personOf(c.who).userId, bodyStr(c.body, 'password'), metaOf(c.req)) });
  }, { leaderFree: true }),

  /** 민감 작업 앞의 재확인. 세션을 새로 만들지 않고 MFA 시각만 찍는다. */
  route<AccountApi>('POST', '/api/v1/session/step-up', 'read', async (c, api) => {
    const p = personOf(c.who);
    await accountsOf(api).stepUp(p.sessionHash, p.userId, bodyStr(c.body, 'code'), metaOf(c.req));
    json(c.res, 200, { stepUp: true });
  }, { leaderFree: true }),

  /** 새 주소로 확인 메일 — 확인 전까지 주소는 그대로다. 비밀번호를 다시 묻는다. */
  route<AccountApi>('POST', '/api/v1/me/email', 'read', async (c, api) => {
    await accountsOf(api).requestEmailChange(personOf(c.who).userId, bodyStr(c.body, 'email'), bodyStr(c.body, 'password'), metaOf(c.req));
    json(c.res, 202, { sent: true });
  }, { leaderFree: true }),

  /**
   * SSO 연결 시작 — **비밀번호를 다시 넣어야** 연다(공통 정책). 돌아온 콜백(`/oidc/token`)이 그 사람에게 잇는다.
   */
  route<AccountApi>('POST', '/api/v1/me/identities/link', 'read', async (c, api) => {
    const rp = api.oidcRp;
    if (rp === undefined) throw new StoreError(404, 'oidc_not_configured', 'SSO 공급자가 설정되지 않았다');
    const state = randomBytes(16).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    const codeVerifier = pkceVerifier();
    const flowId = await accountsOf(api).beginSso('link', state, nonce, codeVerifier,
      { userId: personOf(c.who).userId, password: bodyStr(c.body, 'password') });
    c.res.setHeader('set-cookie', ssoCookie(flowId, api.sessionSecure === true, 600));
    json(c.res, 200, {
      url: authorizationRequest(rp, { state, nonce, codeChallenge: pkceChallenge(codeVerifier) }).toString(),
      state,
    });
  }, { leaderFree: true }),

  route<AccountApi>('POST', '/api/v1/me/identities/unlink', 'read', async (c, api) => {
    await accountsOf(api).unlinkIdentity(personOf(c.who).userId, bodyStr(c.body, 'issuer'), bodyStr(c.body, 'subject'),
      bodyStr(c.body, 'password'), metaOf(c.req));
    json(c.res, 200, { unlinked: true });
  }, { leaderFree: true }),

  route<AccountApi>('GET', '/api/v1/sso-providers', 'admin', async (c, api) => {
    json(c.res, 200, {
      configured: api.oidcRp?.issuer ?? null,
      providers: await accountsOf(api).providers(),
    });
  }, { leaderFree: true }),

  /**
   * 공급자 설정 — JIT(관리자가 명시해서 켠다, 켜도 auditor 만)와 역할 클레임·매핑(IdP 권한 정본 계정용, B3).
   * 둘 중 준 것만 바꾼다.
   */
  route<AccountApi>('POST', '/api/v1/sso-providers', 'admin', async (c, api) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    const issuer = bodyStr(c.body, 'issuer');
    const hasJit = typeof b['jitEnabled'] === 'boolean';
    const hasRoles = 'roleClaim' in b || 'roleMap' in b;
    if (!hasJit && !hasRoles) throw new StoreError(400, 'malformed', "본문에 'jitEnabled' 또는 'roleClaim'·'roleMap' 이 필요하다");
    if (hasJit) await accountsOf(api).setProviderJit(issuer, b['jitEnabled'] as boolean, c.who.name, metaOf(c.req));
    if (hasRoles) {
      const claim = b['roleClaim'];
      const map = b['roleMap'];
      if (claim !== null && typeof claim !== 'string') throw new StoreError(400, 'malformed', "'roleClaim' 은 문자열 또는 null 이다");
      if (map === null || typeof map !== 'object' || Array.isArray(map)) throw new StoreError(400, 'malformed', "'roleMap' 은 객체다");
      await accountsOf(api).setProviderRoles(issuer, claim as string | null, map as Record<string, unknown>, c.who.name, metaOf(c.req));
    }
    json(c.res, 200, { updated: true });
  }, { leaderFree: true, sensitive: true }),

  route<AccountApi>('GET', '/api/v1/users', 'admin', async (c, api) => {
    json(c.res, 200, await accountsOf(api).listUsers());
  }, { leaderFree: true }),

  route<AccountApi>('PATCH', '/api/v1/users/:id', 'admin', async (c, api) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    await accountsOf(api).updateUser(c.params['id'] ?? '', {
      ...(typeof b['role'] === 'string' ? { role: b['role'] } : {}),
      ...(typeof b['status'] === 'string' ? { status: b['status'] } : {}),
      ...(typeof b['roleAuthority'] === 'string' ? { roleAuthority: b['roleAuthority'] } : {}),
    }, c.who.name, metaOf(c.req));
    json(c.res, 200, { updated: true });
  }, { leaderFree: true, sensitive: true }),

  route<AccountApi>('DELETE', '/api/v1/users/:id', 'admin', async (c, api) => {
    await accountsOf(api).deleteUser(c.params['id'] ?? '', c.who.name, metaOf(c.req));
    json(c.res, 200, { deleted: true });
  }, { leaderFree: true, sensitive: true }),

  route<AccountApi>('POST', '/api/v1/users/:id/revoke-sessions', 'admin', async (c, api) => {
    json(c.res, 200, { revoked: await accountsOf(api).logoutAll(c.params['id'] ?? '', c.who.name, metaOf(c.req)) });
  }, { leaderFree: true, sensitive: true }),

  /** 관리자 MFA 초기화·복구 — 링크는 이 응답에만 한 번 나온다. 대상 세션은 즉시 끊긴다. */
  route<AccountApi>('POST', '/api/v1/users/:id/recovery-link', 'admin', async (c, api) => {
    json(c.res, 200, { token: await accountsOf(api).recoveryLink(c.params['id'] ?? '', c.who.name, metaOf(c.req)) });
  }, { leaderFree: true, sensitive: true }),

  route<AccountApi>('GET', '/api/v1/invitations', 'admin', async (c, api) => {
    json(c.res, 200, await accountsOf(api).listInvitations());
  }, { leaderFree: true }),

  /** 초대 링크는 이 응답에만 한 번 나온다(메일 발송은 B 단계). 공개 가입은 없다. */
  route<AccountApi>('POST', '/api/v1/invitations', 'admin', async (c, api) => {
    const b = (c.body ?? {}) as Record<string, unknown>;
    json(c.res, 200, await accountsOf(api).invite({
      role: typeof b['role'] === 'string' ? b['role'] : '',
      ...(typeof b['email'] === 'string' && b['email'] !== '' ? { email: b['email'] } : {}),
    }, c.who.name, metaOf(c.req)));
  }, { leaderFree: true, sensitive: true }),

  route<AccountApi>('DELETE', '/api/v1/invitations/:id', 'admin', async (c, api) => {
    await accountsOf(api).revokeInvitation(c.params['id'] ?? '', c.who.name, metaOf(c.req));
    json(c.res, 200, { revoked: true });
  }, { leaderFree: true, sensitive: true }),

  route<AccountApi>('GET', '/api/v1/account-audit', 'admin', async (c, api) => {
    json(c.res, 200, await accountsOf(api).accountAudit(Number(c.url.searchParams.get('limit') ?? '100') || 100));
  }, { leaderFree: true }),
];

/**
 * 지역의 같은 경로로 넘긴다. **허용 목록은 `RELAY_PATHS` 하나다** — 표에 없는 경로로 중계를 만들면 모듈을
 * 읽는 순간 던진다. 표와 라우트가 갈리는 날을 만들지 않는다.
 */
/**
 * **전역 조회를 남긴다** (공통 정책 1차 4번). 누가·어느 지역·어느 화면·언제를 공용 감사 저장소(계정 PG 의
 * account_audit)에. **남기지 못하면 그 조회를 거부한다**(503) — 남지 않은 조회를 허용하면 감사에 구멍이 난다.
 * 전역에 사람 계정이 꺼져 있으면 공용 저장소가 없으므로 프로세스 로그로만 남는다(docs/runbook-global.md).
 */
async function auditGlobalView(api: GlobalApiOptions, c: Ctx, region: string | null, path: string, stream = false): Promise<boolean> {
  const view = { region, path, ...(stream ? { stream: true } : {}) };
  if (api.accounts === undefined) {
    log.info('global.view', { actor: c.who.name, ...view, ip: ipOf(c.req) });
    return true;
  }
  try {
    await api.accounts.recordGlobalView(c.who.name, view, c.who.account?.userId ?? null, metaOf(c.req));
    return true;
  } catch (e) {
    if (e instanceof AccountStoreUnavailable) {
      json(c.res, 503, {
        code: 'audit_unavailable',
        message: '전역 조회 기록을 남길 수 없어 조회를 거부한다 — 계정 저장소에 닿지 않는다',
      }, { 'retry-after': '5' });
      return false;
    }
    throw e;
  }
}

const relayTo = (path: string) => {
  if (!RELAY_PATHS.includes(path)) throw new Error(`중계 허용 목록에 없는 경로다: ${path}`);
  return async (c: Ctx, api: GlobalApiOptions): Promise<void> => {
  const name = c.params['name'] ?? '';
  if (!api.global.has(name)) {
    json(c.res, 404, { code: 'no_region', message: `지역 '${name}' 은 목록에 없다` });
    return;
  }
  if (!await auditGlobalView(api, c, name, path, path === 'events')) return;
  if (path !== 'events') {
    await api.global.relay(name, path, c.url.search, c.res);
    return;
  }
  api.global.relayEvents(name, c.req, c.res);
  /**
   * **보는 사람의 세션도 따른다** (공통 회원정책 1차). 상류는 지역 하나를 여럿이 나눠 쓰므로 상류를 끊을 수는
   * 없다 — 이 사람의 스트림만 닫는다. 15초마다(지역 하트비트와 같은 간격) 묻는다.
   */
  const acc = api.accounts;
  const hash = c.who.account?.sessionHash;
  const timer = acc !== undefined && hash !== undefined
    ? setInterval(() => {
      acc.sessionAlive(hash).then((ok) => { if (!ok) c.res.end(); }, () => c.res.end());
    }, 15_000)
    : undefined;
  timer?.unref?.();
  await new Promise<void>((resolve) => c.res.on('close', () => resolve()));
  if (timer !== undefined) clearInterval(timer);
  };
};

/**
 * 전역 라우트. **GET 만 있다** — 설정 쓰기는 지역 GUI 로 넘긴다(설계 §1).
 *
 * 경로를 하나씩 적는다. 패턴 하나(`:name/*`)로 접으면 허용 목록이 이 표에서 안 보이고, B 동결 게이트
 * (`SURFACE-API.json`)도 무엇이 열렸는지 못 센다.
 */
const GLOBAL_ROUTES: Route<GlobalApiOptions>[] = [
  route('GET', '/api/v1/regions', 'read', async (c, api: GlobalApiOptions) => {
    if (!await auditGlobalView(api, c, null, 'regions')) return;
    json(c.res, 200, { mode: 'global', build: api.build ?? null, regions: await api.global.summary() });
  }),
  route('GET', '/api/v1/regions/:name/status', 'read', relayTo('status')),
  route('GET', '/api/v1/regions/:name/listeners', 'read', relayTo('listeners')),
  route('GET', '/api/v1/regions/:name/pools', 'read', relayTo('pools')),
  route('GET', '/api/v1/regions/:name/backends', 'read', relayTo('backends')),
  route('GET', '/api/v1/regions/:name/backends/status', 'read', relayTo('backends/status')),
  route('GET', '/api/v1/regions/:name/routes', 'read', relayTo('routes')),
  route('GET', '/api/v1/regions/:name/certificates', 'read', relayTo('certificates')),
  route('GET', '/api/v1/regions/:name/tls-policies', 'read', relayTo('tls-policies')),
  route('GET', '/api/v1/regions/:name/sni-bindings', 'read', relayTo('sni-bindings')),
  route('GET', '/api/v1/regions/:name/acme/orders', 'read', relayTo('acme/orders')),
  route('GET', '/api/v1/regions/:name/audit', 'read', relayTo('audit')),
  route('GET', '/api/v1/regions/:name/config/rendered', 'read', relayTo('config/rendered')),
  route('GET', '/api/v1/regions/:name/events', 'read', relayTo('events')),
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

/**
 * 요청 리스너. **서버와 떼어 놓는다** (검수 S-05b).
 *
 * 전에는 `createApi` 가 `http.Server` 를 만들어 돌려주기만 해서 https 로 세울 자리가
 * 없었다. 그러면 TLS 를 켜려고 라우팅을 한 벌 더 쓰게 되고, 두 벌은 갈라진다 —
 * `renderCapsOf` 를 한 자리로 모은 이유(B-02)와 같은 종류의 사고다.
 */
/** 요청마다 한 번 정한 보낸 사람 주소 (`client-address.ts`). 시도 제한 · 감사 IP 가 모두 이것을 쓴다. */
const CLIENT_IP = new WeakMap<IncomingMessage, string>();
const ipOf = (req: IncomingMessage): string | undefined => CLIENT_IP.get(req) ?? req.socket.remoteAddress;

export function apiHandler(api: AnyApi): RequestListener {
  const max = api.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const authFailures = new AuthFailureLimiter();
  api.sessions ??= new BrowserSessions();
  return (req, res) => {
    const ip = clientAddress(req, api.trustedProxies);
    if (ip !== undefined) CLIENT_IP.set(req, ip);
    void handle(req, res, api, max, authFailures).catch((e) => {
      /**
       * 여기까지 온 것은 핸들러 밖의 실패다. 조용히 끊지 않는다.
       *
       * **문장을 그대로 내보내지 않는다** (검수 2026-08-24 SCAN-2). 여기 오는 것은
       * *예상 못 한* 오류라 무엇이 들었는지 우리가 모른다 — PG 오류는 쿼리문을, 파일
       * 오류는 절대경로를 담는다. 그리고 이 그물은 **인증 앞에도 있다**: `/readyz` 나
       * 본문 읽기에서 터지면 토큰 없이도 닿는다.
       *
       * ⚠️ **진단을 버리는 것이 아니다.** 문장만 지우면 운영자가 "500 이 났다" 만
       * 들고 서버 로그를 뒤지게 되는데, 그건 이 저장소가 W3-4 에서 없앤 바로 그
       * 모양이다. `ref` 로 잇는다 — 호출자는 `ref` 를, 운영자는 같은 `ref` 가 붙은
       * 로그 한 줄을 본다. 버리는 것이 아니라 **읽을 사람을 가른다.**
       */
      const ref = randomUUID();
      log.error('api.internal', {
        ref,
        method: req.method,
        path: req.url,
        error: e instanceof Error ? e.message : String(e),
        ...(e instanceof Error && e.stack !== undefined ? { stack: e.stack } : {}),
      });
      if (!res.headersSent) {
        json(res, 500, { code: 'internal', message: '내부 오류다 — ref 로 서버 로그를 찾는다', ref });
      } else res.end();
    });
  };
}

export type ApiTlsInput = {
  cert: string;
  key: string;
  /**
   * 주면 클라이언트 인증서를 **요구하고 검증한다.**
   *
   * ⚠️ 이것은 **망 관문**이지 신원이 아니다. 누구인지는 여전히 Bearer 토큰이 답한다.
   * 인증서를 역할에 매핑하는 것은 별개의 결정이고, 섞으면 권한의 진실이 둘이 된다.
   */
  clientCa?: string;
};

export type ApiTlsOptions = SecureContextOptions & {
  requestCert?: boolean;
  rejectUnauthorized?: boolean;
};

/**
 * 제어 API 의 TLS 옵션을 조립한다 (검수 S-05b).
 *
 * 이 API 는 인증서 **개인키를 본문으로 받고** Bearer 토큰을 헤더로 받는데 평문으로
 * 흘렀다. W0-a 가 기본 바인드를 루프백으로 내려 급성 노출은 닫았지만, 그건 "밖에서 못
 * 붙는다" 이지 "안에서 안 샌다" 가 아니다 — 사이드카와 호스트 네트워크를 공유하는
 * 이웃은 여전히 평문을 본다.
 *
 * 켜는 것은 선택이다(끄면 지금과 같다). 다만 **반만 켜지지는 않는다.**
 */
export function apiTlsOptions(input: ApiTlsInput): ApiTlsOptions {
  // 환경변수를 하나만 넣은 배포가 조용히 평문으로 뜨면 안 된다. 그 침묵이
  // "TLS 켰다" 는 믿음과 평문 소켓을 동시에 만든다.
  if (input.cert === '') throw new Error('TLS 를 켜려면 cert 가 있어야 한다');
  if (input.key === '') throw new Error('TLS 를 켜려면 key 가 있어야 한다');
  return {
    cert: input.cert,
    key: input.key,
    // 렌더러 쪽 TLS 정책(W0-4)과 같은 기준이다. 제어 평면이 데이터 평면보다 느슨할
    // 이유가 없다.
    minVersion: 'TLSv1.2',
    // **기본으로 요구하지 않는다.** 서버 TLS 와 mTLS 는 다른 결정이고, 하나를 켠다고
    // 다른 하나가 따라오면 켜는 순간 모든 클라이언트가 막힌다.
    //
    // 요구할 때는 검증까지 한다. `requestCert` 만 켜고 `rejectUnauthorized` 를
    // 빠뜨리면 아무 인증서나 통과한다 — 켰다는 착각만 주고 아무것도 안 막는다.
    ...(input.clientCa === undefined
      ? {}
      : { ca: input.clientCa, requestCert: true, rejectUnauthorized: true }),
  };
}

/**
 * **인증서 파일을 다시 읽어 지금 리스너에 건다** (2026-10-19). 인증서가 갱신돼 파일이 바뀌어도 재시작하지 않는다 —
 * 지역은 데몬과 엔진이 한 유닛이라 재시작이 데이터 플레인을 끊는다. 이미 열린 연결은 옛 인증서로 끝나고, 새 연결부터
 * 새 인증서다. **읽기·해석이 실패하면 던지고 옛 인증서가 그대로 산다**(반쯤 바뀐 상태가 없다).
 * 바뀐 인증서의 만료 시각을 돌려준다 — 갱신이 실제로 들어갔는지 로그로 확인하게.
 */
export function reloadApiTls(server: { setSecureContext(o: SecureContextOptions): void }, files: { cert: string; key: string; clientCa?: string }): string {
  const cert = readFileSync(files.cert, 'utf8');
  const opts = apiTlsOptions({
    cert,
    key: readFileSync(files.key, 'utf8'),
    ...(files.clientCa === undefined ? {} : { clientCa: readFileSync(files.clientCa, 'utf8') }),
  });
  // 키와 인증서가 짝이 맞는지 먼저 본다 — 틀린 짝을 걸면 다음 연결부터 TLS 가 전부 실패한다.
  createSecureContext(opts);
  server.setSecureContext(opts);
  return new X509Certificate(cert).validTo;
}

/**
 * **쿠키로 들어온 쓰기는 같은 출처에서만 받는다** (CSRF, 2026-10-18).
 *
 * 브라우저 세션 쿠키는 `SameSite=Lax` 다. Lax 는 **다른 사이트**의 POST 에 쿠키를 안
 * 싣지만, 사이트는 등록 가능 도메인 단위다 — `a.example.com` 과 `b.example.com` 은
 * **같은 사이트**라서 형제 서브도메인의 페이지가 폼 POST 로 쿠키를 실어 보낼 수 있다.
 * 본문 파서는 Content-Type 을 안 보므로 `text/plain` 폼이 JSON 본문을 만들 수 있다.
 * 그 쿠키가 write·apply 까지 인증하므로, 지역 대시보드를 공개 도메인 아래 열면
 * 옆 서브도메인 하나가 곧 설정 변경 권한이 된다.
 *
 * 그래서 GET·HEAD 가 아니면:
 *   · `Origin` 이 있으면 그 host 가 요청의 `Host` 와 같아야 한다
 *   · 없으면 `Sec-Fetch-Site: same-origin` 이어야 한다 — 둘 다 없으면 거절한다.
 *     쿠키를 싣는 것은 브라우저뿐이고, 요즘 브라우저는 POST 에 `Origin` 을 늘 붙인다
 *
 * **스킴은 안 본다.** 앞단이 TLS 를 풀면(`BARY_ALLOW_PLAINTEXT_EXPOSED`) 브라우저의
 * 출처는 https 인데 데몬은 http 로 받는다. 막으려는 것은 다른 host 이고, 같은 host 의
 * 다른 스킴은 이 데몬 자신이다.
 *
 * Bearer·클라이언트 인증서 요청에는 걸지 않는다 — 브라우저가 저절로 싣는 자격증명이
 * 아니라 CSRF 의 대상이 아니다.
 */
export function sameOriginWrite(req: IncomingMessage): boolean {
  const m = req.method ?? 'GET';
  if (m === 'GET' || m === 'HEAD') return true;
  const host = req.headers.host;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '') {
    if (origin === 'null' || host === undefined) return false;
    try {
      return new URL(origin).host === host.toLowerCase();
    } catch {
      return false;
    }
  }
  return req.headers['sec-fetch-site'] === 'same-origin';
}

function crossSite(res: ServerResponse): void {
  json(res, 403, {
    code: 'cross_site',
    message: '브라우저 세션으로 들어온 쓰기는 같은 출처에서만 받는다 (Origin 이 이 호스트가 아니다)',
  });
}

// ── 사람 계정 도우미 ──────────────────────────────────────────────────────

/**
 * 계정 세션 쿠키 이름. TLS 면 `__Host-` 접두 — 브라우저가 Secure·Path=/·Domain 없음을 강제해서,
 * 형제 서브도메인이 같은 이름의 쿠키를 심어 덮는 길(쿠키 토싱)이 막힌다.
 */
const accountCookie = (api: { sessionSecure?: boolean }): string =>
  api.sessionSecure === true ? '__Host-bary_sid' : 'bary_sid';
/** MFA 대기 표 — MFA 단계에만 실린다. */
const MFA_COOKIE = 'bary_mfa';
/**
 * 로그인·가입·재설정 요청 본문 상한 (회원 공통 수치 1차 — 64 KiB). 비밀번호에는 최대 길이가 없으므로
 * 해시 부담 공격은 여기서 막는다.
 */
const PASSWORD_BODY_MAX = 64 * 1024;
/** 시도 제한 키(공용 계정 PG 의 `auth_throttle`). 재설정 요청 수는 로그인 실패와 나눠 센다. */
const throttleKey = (use: 'login' | 'reset', req: IncomingMessage): string => `${use}:${ipOf(req) ?? 'unknown'}`;
const MFA_PATH = '/api/v1/session/mfa';

function accountsOf(api: { accounts?: AccountService }): AccountService {
  if (api.accounts === undefined) {
    throw new StoreError(404, 'accounts_disabled', '이 배포에는 사람 계정이 켜져 있지 않다 (BARY_ACCOUNTS_DSN)');
  }
  return api.accounts;
}

function personOf(who: Principal): { userId: string; sessionHash: string } {
  if (who.account === undefined) {
    throw new StoreError(404, 'not_a_person', '사람 계정으로 로그인한 세션에서만 쓴다 (토큰·인증서는 사람이 아니다)');
  }
  return who.account;
}

function metaOf(req: IncomingMessage): AccountMeta {
  const ua = req.headers['user-agent'];
  return {
    ...(ipOf(req) === undefined ? {} : { ip: ipOf(req) as string }),
    ...(typeof ua === 'string' ? { userAgent: ua.slice(0, 200) } : {}),
  };
}

function bodyStr(body: unknown, key: string): string {
  const v = body !== null && typeof body === 'object' ? (body as Record<string, unknown>)[key] : undefined;
  if (typeof v !== 'string') throw new StoreError(400, 'malformed', `본문에 '${key}' 문자열이 필요하다`);
  return v;
}

/** 계정 PG 를 못 물었다 — **거부한다**(공통 정책: 확인 불가 시 거부). 캐시로 넘기지 않는다. */
function accountStoreDown(res: ServerResponse): void {
  json(res, 503, {
    code: 'account_store_unavailable',
    message: '계정 저장소에 닿지 못해 세션을 확인할 수 없다 — 사람 로그인은 잠시 막힌다 (API 토큰은 그대로다)',
  }, { 'retry-after': '5' });
}

/** OIDC 흐름 id — 콜백 교환에만 실린다. 상태는 계정 PG 에 있다. */
const SSO_COOKIE = 'bary_sso';
function ssoCookie(value: string, secure: boolean, maxAge: number): string {
  return `${SSO_COOKIE}=${value}; Max-Age=${maxAge}; Path=/api/v1/oidc; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

/**
 * 사람 계정의 SSO 콜백 (계획 B2 — **로컬 권한 정본**). IdP 에게는 누구인지(iss, sub)만 묻고 역할 클레임은 안 읽는다.
 * IdP 의 MFA 도 인정하지 않는다 — 관리자·인증 앱 등록자는 이어서 로컬 TOTP 단계다(공급자 계약 미해결).
 */
async function finishAccountSso(
  req: IncomingMessage, res: ServerResponse, api: { oidcFetch?: typeof fetch; sessionSecure?: boolean }, accounts: AccountService,
  rp: OidcRpSettings, code: string, state: string,
): Promise<void> {
  const secure = api.sessionSecure === true;
  const clearFlow = ssoCookie('', secure, 0);
  const flow = await accounts.takeSsoFlow(cookieValue(req.headers.cookie, SSO_COOKIE), state);
  if (flow === undefined) {
    res.setHeader('set-cookie', clearFlow);
    json(res, 401, { code: 'unauthenticated', message: '로그인 흐름이 없거나 만료됐다' });
    return;
  }
  const claims = await exchangeForClaims(rp, code, api.oidcFetch ?? fetch, { codeVerifier: flow.codeVerifier, nonce: flow.nonce });
  if (claims === undefined || typeof claims['iss'] !== 'string' || typeof claims['sub'] !== 'string') {
    res.setHeader('set-cookie', clearFlow);
    json(res, 401, { code: 'unauthenticated', message: 'ID Token 이 거절됐다' });
    return;
  }
  const pref = claims['preferred_username'];
  const out = await accounts.completeSso(flow.intent, flow.userId, {
    iss: claims['iss'], sub: claims['sub'], raw: claims, ...(typeof pref === 'string' ? { preferredUsername: pref } : {}),
  }, metaOf(req));
  switch (out.kind) {
    case 'session':
      res.setHeader('set-cookie', [clearFlow, sessionCookie(accountCookie(api), out.sessionId, secure, out.maxAgeS)]);
      json(res, 200, { status: 'ok', authenticated: true });
      return;
    case 'mfa':
      res.setHeader('set-cookie', [clearFlow, mfaCookie(out.sessionId, secure, out.maxAgeS)]);
      json(res, 200, { status: 'mfa_required' });
      return;
    case 'linked':
      res.setHeader('set-cookie', clearFlow);
      json(res, 200, { status: 'linked' });
      return;
    case 'not_linked':
      res.setHeader('set-cookie', clearFlow);
      json(res, 403, {
        code: 'sso_not_linked',
        message: '이 SSO 계정에 연결된 barycenter 계정이 없다 — 관리자 초대를 받거나, 로그인해서 내 계정에서 SSO 를 연결한다',
      });
      return;
    default:
      res.setHeader('set-cookie', clearFlow);
      json(res, 401, { code: 'login_failed', message: '로그인할 수 없는 계정이다' });
  }
}

function mfaCookie(value: string, secure: boolean, maxAge: number): string {
  return `${MFA_COOKIE}=${value}; Max-Age=${maxAge}; Path=${MFA_PATH}; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
}

export function createApi(api: ApiOptions | GlobalApiOptions): Server {
  return createServer(apiHandler(api));
}

/**
 * 인증 **뒤**의 한 갈래 — 매칭 → 스코프 → 민감 작업 MFA → 리더 → 실행 → 오류 번역.
 *
 * 지역과 전역이 **같은 함수**를 지난다. 둘로 나누면 스코프·MFA 게이트가 한쪽만 고쳐지는 날이 온다.
 */
async function dispatch<A>(
  req: IncomingMessage, res: ServerResponse, url: URL, who: Principal, api: A,
  routes: Route<A>[], max: number, opts: { leader?: LeaderElection; notFound?: string },
): Promise<void> {
  const matched = routes.map((r) => ({ r, m: r.pattern.exec(url.pathname) }))
    .filter((x) => x.m !== null);
  if (matched.length === 0) {
    json(res, 404, opts.notFound === undefined
      ? { code: 'no_route', message: `${url.pathname} 은 없다` }
      : { code: 'global_mode', message: opts.notFound });
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

  // **민감 작업은 최근 MFA** (공통 회원정책 1차). 사람 세션만 — 기계 토큰은 MFA 가 없다.
  if (hit.r.sensitive === true && who.account !== undefined) {
    const at = who.account.mfaAt;
    if (at === undefined || Date.now() - at > STEP_UP_MAX_AGE_MS) {
      json(res, 403, {
        code: 'mfa_step_up_required',
        message: `이 작업은 최근 ${STEP_UP_MAX_AGE_MS / 60_000}분 안에 인증 앱 확인이 필요하다`,
      });
      return;
    }
  }

  // **스탠바이는 읽기만 답한다** (§3.5 · §11.4).
  //
  // `apply` 만 막고 `write` 는 열어 둘까 고민했는데, 그러면 스탠바이에 커밋해 놓고
  // 적용이 안 되는 상태를 사람이 만들 수 있다. head 는 PG 가 직렬화하니 안전하긴 하지만
  // **안전한 것과 이해할 수 있는 것은 다르다.** 리더 하나만 쓴다.
  //
  // **503 이지 403 이 아니다.** 권한이 없는 것이 아니라 *여기서는* 못 하는 것이고,
  // 다른 인스턴스에서는 되고 이 인스턴스도 승격되면 된다.
  // 전역에는 리더가 없다(`opts.leader` 없음) — 전역 라우트는 GET 뿐이고 계정 경로는 leaderFree 다.
  if (opts.leader !== undefined && hit.r.scope !== 'read' && hit.r.leaderFree !== true && !opts.leader.state.isLeader) {
    const s = opts.leader.state;
    json(res, 503, {
      code: 'not_leader',
      message: `이 인스턴스는 리더가 아니다 — ${s.reason ?? '리더가 아니다'}`,
      holder: s.holder,
    }, { 'retry-after': '5' });
    return;
  }

  const params: Record<string, string> = {};
  try {
    // **해독을 `try` 안으로 넣는다** (검수 B-11). 밖에 있으면 `%` 하나가
    // `URIError` 로 올라가 **500** 이 된다 — 우리 잘못이 아닌데 우리 잘못이라고 답한다.
    hit.r.keys.forEach((k, i) => {
      params[k] = decodeURIComponent(hit.m?.[i + 1] ?? '');
    });
  } catch {
    json(res, 400, {
      code: 'malformed',
      message: `경로에 잘못된 퍼센트 인코딩이 있다: ${url.pathname}`,
    });
    return;
  }

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
    if (e instanceof AccountError) {
      json(res, e.status, { code: e.code, message: e.message });
      return;
    }
    if (e instanceof AccountStoreUnavailable) {
      accountStoreDown(res);
      return;
    }
    // 라우팅 시점에 리더였는데 부작용 직전에 아니게 된 경우다. 창이 있다는 사실
    // 자체는 못 없앤다 — 닫는 것은 DP Agent 의 토큰 비교다 (§3.5).
    if (e instanceof NotLeader) {
      json(res, e.status, { code: e.code, message: e.message }, { 'retry-after': '5' });
      return;
    }
    /**
     * PG `22P02` (invalid_text_representation) — **값이 컬럼 타입이 아니다.**
     *
     * `/plans/:id` 같은 자리는 `uuid` 컬럼에 그대로 물으므로, uuid 가 아닌 문자열이
     * 오면 PG 가 거절한다. 그건 우리 잘못이 아니라 **입력의 구문 오류**다
     * (§5.1 의 4분할에서 400). 500 으로 답하면 호출자는 재시도하고 운영자는
     * 서버 로그를 뒤진다 — 정작 고칠 것은 요청에 있는데 (검수 B-11).
     */
    if ((e as { code?: string }).code === '22P02') {
      json(res, 400, {
        code: 'malformed',
        message: '경로나 본문의 값이 그 자리의 타입이 아니다',
      });
      return;
    }
    throw e;
  }
}

async function handle(
  req: IncomingMessage, res: ServerResponse, api: AnyApi, max: number,
  authFailures: AuthFailureLimiter,
): Promise<void> {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

  // 인증 없이 답하는 유일한 자리. 살아 있는지 묻는 데 토큰을 요구하면 오케스트레이터가
  // 토큰을 들고 다녀야 하고, 그 토큰이 곧 새는 경로가 된다.
  /**
   * **liveness.** 이 프로세스가 HTTP 에 답하는가 — 그것뿐이다.
   *
   * 오케스트레이터는 이걸 보고 **프로세스를 죽인다.** 그래서 여기에 엔진이나 DB 상태를
   * 넣으면 안 된다: 의존성 장애가 곧 재시작이 되고, 재시작해도 의존성은 그대로라
   * **재시작 루프**가 된다. 준비 상태는 `/readyz` 다 (검수 D12).
   */
  if (url.pathname === '/healthz') {
    json(res, 200, { ok: true });
    return;
  }

  /**
   * **readiness.** 이 인스턴스가 보는 데이터 플레인이 준비됐는가 (검수 D12).
   *
   * 안 되면 **503** 이다 — 오케스트레이터가 트래픽만 빼고 프로세스는 안 죽인다.
   * `/healthz` 와 뜻이 다르므로 창구도 다르다.
   *
   * **인증이 없다.** `/metrics` 는 풀 이름과 리비전을 말하므로 토큰을 요구하지만,
   * 여기서 나가는 것은 불리언 둘이다 — 배포 구조를 말하지 않는다. 그리고 프로브는
   * 대개 자격증명을 못 들고 다닌다.
   */
  if (url.pathname === '/readyz') {
    /**
     * **전역은 지역 상태를 안 본다** (설계 §5). 여러 전역을 DNS 로 묶으므로, 지역 하나가 죽었다고 전역 전부가
     * 빠지면 그 지역을 볼 화면까지 사라진다. 전역이 준비됐다는 것은 「지역 목록을 들고 답한다」 뿐이다.
     */
    if (isGlobal(api)) {
      json(res, 200, { ok: true, mode: 'global', regions: api.global.regions.length });
      return;
    }
    const r = await api.control.readiness();
    json(res, r.ok ? 200 : 503, r);
    return;
  }

  // 로그아웃은 인증이 없어도 쿠키를 지워야 한다. 응답 본문에 신원을 싣지 않는다.
  if (req.method === 'POST' && url.pathname === '/api/v1/session/logout') {
    // 남이 로그아웃시키는 것도 막는다 — 피해는 작지만 쿠키가 걸린 POST 의 규칙은 하나다.
    if (!sameOriginWrite(req)) { crossSite(res); return; }
    const clear = [
      expiredCookie(SESSION_COOKIE, api.sessionSecure === true),
      expiredCookie(LOGIN_COOKIE, api.sessionSecure === true),
      expiredCookie(accountCookie(api), api.sessionSecure === true),
    ];
    /**
     * **쿠키를 지운 것으로 로그아웃을 끝내지 않는다**(공통 정책). 사람 계정이면 서버에서 그 세션을
     * 철회하고, 철회를 확인하지 못하면 그렇다고 말한다 — 쿠키는 지우되 503 이다. 「로그아웃됐다」고
     * 답했는데 훔친 쿠키가 계속 통하는 상태를 만들지 않는다.
     */
    if (api.accounts !== undefined) {
      try {
        await api.accounts.logout(cookieValue(req.headers.cookie, accountCookie(api)), metaOf(req));
      } catch (e) {
        if (!(e instanceof AccountStoreUnavailable)) throw e;
        res.setHeader('set-cookie', clear);
        accountStoreDown(res);
        return;
      }
    }
    res.setHeader('set-cookie', clear);
    res.writeHead(204);
    res.end();
    return;
  }

  // 화면이 「비밀번호를 잊었다」를 그릴지 고른다. 비밀이 아니다.
  if (req.method === 'GET' && url.pathname === '/api/v1/account/features') {
    json(res, 200, {
      ...(api.accounts === undefined ? { accounts: false, mail: false } : { accounts: true, ...api.accounts.features() }),
      sso: api.oidcRp !== undefined,
    });
    return;
  }

  /**
   * **메일 링크** (계획 B1) — 비밀번호 재설정 요청·확인, 이메일 변경 확인. 인증 앞이다.
   * 재설정 요청은 **늘 202** 다(열거 방지). IP 단위로 요청 수를 제한한다 — 로그인 실패 카운터와는 따로.
   */
  if (req.method === 'POST' && (url.pathname === '/api/v1/account/password-reset'
    || url.pathname === '/api/v1/account/password-reset/confirm' || url.pathname === '/api/v1/account/email/confirm')) {
    if (!sameOriginWrite(req)) { crossSite(res); return; }
    const accounts = api.accounts;
    if (accounts === undefined) {
      json(res, 404, { code: 'accounts_disabled', message: '이 배포에는 사람 계정이 켜져 있지 않다' });
      return;
    }
    try {
      const body = await readBody(req, Math.min(max, PASSWORD_BODY_MAX));
      if (url.pathname === '/api/v1/account/password-reset') {
        // 실패가 아니라 요청 수를 센다 — 성공으로 지우지 않는다. 인스턴스를 가리지 않는다(공용 PG).
        const retryAfter = await accounts.throttleWait(throttleKey('reset', req)) ?? await accounts.throttleFail(throttleKey('reset', req));
        if (retryAfter !== undefined) {
          json(res, 429, { code: 'rate_limited', message: '요청이 너무 많다 — 잠시 뒤 다시 한다' }, { 'retry-after': String(retryAfter) });
          return;
        }
        await accounts.requestPasswordReset(bodyStr(body, 'email'), metaOf(req));
        json(res, 202, { accepted: true });
      } else if (url.pathname === '/api/v1/account/password-reset/confirm') {
        await accounts.confirmPasswordReset(bodyStr(body, 'token'), bodyStr(body, 'password'), metaOf(req));
        json(res, 200, { reset: true });
      } else {
        await accounts.confirmEmailChange(bodyStr(body, 'token'), metaOf(req));
        json(res, 200, { changed: true });
      }
    } catch (e) {
      if (e instanceof AccountStoreUnavailable) { accountStoreDown(res); return; }
      if (e instanceof AccountError || e instanceof StoreError) { json(res, e.status, { code: e.code, message: e.message }); return; }
      throw e;
    }
    return;
  }

  /**
   * **사람 계정 로그인** (공통 회원정책 1차 · 계획 A). 인증 앞이라 여기서 받는다.
   *
   * 셋 다 쿠키를 만드는 POST 라 같은 출처 검사를 지난다(로그인 CSRF). 실패는 IP 단위 제한과 계정 단위
   * 잠금에 걸리고, **둘 다 공용 계정 PG 에서 센다**(회원 공통 수치 1차 — 인스턴스마다 따로 세지 않는다).
   * IP 가 막혀 있으면 **비밀번호를 보기 전에** 429 다. 응답은 계정 유무와 무관하게 같다.
   */
  if (req.method === 'POST' && (url.pathname === '/api/v1/session/login' || url.pathname === MFA_PATH
    || url.pathname === '/api/v1/invitations/preview' || url.pathname === '/api/v1/invitations/accept')) {
    if (!sameOriginWrite(req)) { crossSite(res); return; }
    const accounts = api.accounts;
    if (accounts === undefined) {
      json(res, 404, { code: 'accounts_disabled', message: '이 배포에는 사람 계정이 켜져 있지 않다' });
      return;
    }
    const ipKey = throttleKey('login', req);
    try {
      const body = await readBody(req, Math.min(max, PASSWORD_BODY_MAX));
      const secure = api.sessionSecure === true;
      if (url.pathname === '/api/v1/invitations/preview') {
        json(res, 200, await accounts.previewLink(bodyStr(body, 'token')));
        return;
      }
      if (url.pathname === '/api/v1/invitations/accept') {
        const b = (body ?? {}) as Record<string, unknown>;
        const totp = b['totp'] as { secret?: unknown; code?: unknown } | undefined;
        json(res, 200, await accounts.acceptLink({
          token: bodyStr(body, 'token'),
          password: bodyStr(body, 'password'),
          ...(typeof b['username'] === 'string' ? { username: b['username'] } : {}),
          ...(typeof b['displayName'] === 'string' ? { displayName: b['displayName'] } : {}),
          ...(totp !== undefined && typeof totp.secret === 'string' && typeof totp.code === 'string'
            ? { totp: { secret: totp.secret, code: totp.code } } : {}),
        }, metaOf(req)));
        return;
      }
      const wait = await accounts.throttleWait(ipKey);
      if (wait !== undefined) {
        json(res, 429, { code: 'rate_limited', message: '실패가 너무 많다 — 잠시 뒤 다시 시도하라' }, { 'retry-after': String(wait) });
        return;
      }
      const out = url.pathname === MFA_PATH
        ? await accounts.completeMfa(cookieValue(req.headers.cookie, MFA_COOKIE), bodyStr(body, 'code'), metaOf(req))
        : await accounts.login(bodyStr(body, 'username'), bodyStr(body, 'password'), metaOf(req));
      if (out.kind === 'denied') {
        count('bary_auth_failures_total');
        const retryAfter = await accounts.throttleFail(ipKey);
        if (retryAfter !== undefined) {
          json(res, 429, { code: 'rate_limited', message: '실패가 너무 많다 — 잠시 뒤 다시 시도하라' }, { 'retry-after': String(retryAfter) });
        } else {
          json(res, 401, { code: 'login_failed', message: '아이디·비밀번호 또는 인증 코드가 맞지 않는다' });
        }
        return;
      }
      if (out.kind === 'mfa') {
        res.setHeader('set-cookie', mfaCookie(out.sessionId, secure, out.maxAgeS));
        json(res, 200, { status: 'mfa_required' });
        return;
      }
      res.setHeader('set-cookie', [
        sessionCookie(accountCookie(api), out.sessionId, secure, out.maxAgeS),
        mfaCookie('', secure, 0),
      ]);
      json(res, 200, { status: 'ok' });
    } catch (e) {
      if (e instanceof AccountStoreUnavailable) { accountStoreDown(res); return; }
      if (e instanceof AccountError || e instanceof StoreError) {
        json(res, e.status, { code: e.code, message: e.message });
        return;
      }
      throw e;
    }
    return;
  }

  // Authorization Code 시작·교환. 아직 Bearer 가 없다. 스코프 표에 안 올린다.
  if (req.method === 'GET' && url.pathname === '/api/v1/oidc/authorization-request') {
    const rp = api.oidcRp;
    if (rp === undefined) {
      json(res, 404, { code: 'oidc_not_configured', message: 'Authorization Code 가 설정되지 않았다' });
      return;
    }
    /**
     * **PKCE 와 nonce 를 여기서 만든다** (검수 S-06 나머지).
     *
     * PKCE verifier·nonce는 API의 짧은 수명 로그인 세션에 보관한다. 브라우저에는
     * state와 opaque 로그인 쿠키만 내보내므로 토큰·검증자를 저장소에 남기지 않는다.
     */
    const state = randomBytes(16).toString('hex');
    const nonce = randomBytes(16).toString('hex');
    const codeVerifier = pkceVerifier();
    if (api.accounts !== undefined) {
      // 사람 계정이 켜졌으면 로그인 중 상태를 **계정 PG** 에 둔다 — 시작과 콜백이 다른 인스턴스로 가도 된다.
      try {
        const flowId = await api.accounts.beginSso('login', state, nonce, codeVerifier);
        res.setHeader('set-cookie', ssoCookie(flowId, api.sessionSecure === true, 600));
      } catch (e) {
        if (e instanceof AccountStoreUnavailable) { accountStoreDown(res); return; }
        throw e;
      }
    } else {
      const loginId = api.sessions!.beginLogin({ state, nonce, codeVerifier });
      res.setHeader('set-cookie', sessionCookie(LOGIN_COOKIE, loginId, api.sessionSecure === true, 600));
    }
    json(res, 200, {
      url: authorizationRequest(rp, {
        state, nonce, codeChallenge: pkceChallenge(codeVerifier),
      }).toString(),
      state,
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/oidc/token') {
    // 로그인 CSRF — 남의 code 로 피해자를 공격자 계정에 앉히는 것 — 도 같은 문으로 막는다.
    if (!sameOriginWrite(req)) { crossSite(res); return; }
    const rp = api.oidcRp;
    if (rp === undefined) {
      json(res, 404, { code: 'oidc_not_configured', message: 'Authorization Code 가 설정되지 않았다' });
      return;
    }
    let raw: unknown;
    try {
      raw = await readBody(req, max);
    } catch (e) {
      if (e instanceof StoreError) {
        json(res, e.status, { code: e.code, message: e.message });
        return;
      }
      throw e;
    }
    const obj = raw !== null && typeof raw === 'object'
      ? (raw as Record<string, unknown>)
      : {};
    const code = obj['code'];
    if (typeof code !== 'string' || code === '') {
      json(res, 400, { code: 'malformed', message: 'code 가 필요하다' });
      return;
    }
    /**
     * **검증자를 요구한다.** 선택으로 두면 가로챈 자가 그냥 빼고 내면 되므로 PKCE 가
     * 아무것도 안 막는다 — 다운그레이드가 공격자의 선택이 된다. 시작 응답이 항상
     * 검증자를 주므로, 못 보내는 클라이언트는 시작 흐름을 안 지난 클라이언트다.
     */
    const state = obj['state'];
    if (typeof state !== 'string' || state === '') {
      json(res, 400, {
        code: 'malformed',
        message: 'state 가 필요하다 — authorization-request 가 준 값을 되보낸다',
      });
      return;
    }
    if (api.accounts !== undefined) {
      try {
        await finishAccountSso(req, res, api, api.accounts, rp, code, state);
      } catch (e) {
        if (e instanceof AccountStoreUnavailable) { accountStoreDown(res); return; }
        if (e instanceof AccountError) { json(res, e.status, { code: e.code, message: e.message }); return; }
        throw e;
      }
      return;
    }
    // state와 로그인 쿠키가 모두 있어야 서버가 보관한 PKCE verifier·nonce를 꺼낸다.
    const login = api.sessions!.takeLogin(cookieValue(req.headers.cookie, LOGIN_COOKIE), state);
    if (login === undefined) {
      json(res, 401, { code: 'unauthenticated', message: '로그인 흐름이 없거나 만료됐다' });
      return;
    }
    const exchanged = await exchangeAuthorizationCode(rp, code, api.oidcFetch ?? fetch, {
      codeVerifier: login.codeVerifier,
      nonce: login.nonce,
    });
    if (exchanged === undefined) {
      json(res, 401, { code: 'unauthenticated', message: 'ID Token 이 거절됐다' });
      return;
    }
    const sessionId = api.sessions!.create(exchanged.principal);
    res.setHeader('set-cookie', [
      sessionCookie(SESSION_COOKIE, sessionId, api.sessionSecure === true, 8 * 60 * 60),
      expiredCookie(LOGIN_COOKIE, api.sessionSecure === true),
    ]);
    json(res, 200, { authenticated: true });
    return;
  }

  // GUI 페이지와 자산은 토큰 없이 나간다. 토큰은 페이지가 events/status/apply 에
  // 붙인다. 문서 탐색에 Authorization 을 요구하면 화면 자체가 안 열린다.
  if (req.method === 'GET' && api.guiRoot !== undefined && !url.pathname.startsWith('/api/')) {
    if (serveGui(res, url.pathname, api.guiRoot)) return;
  }

  /**
   * **Bearer 가 먼저다** (S-05b). 토큰을 들고 왔으면 그것이 신원이고, 없을 때만
   * 클라이언트 인증서를 본다.
   *
   * 순서를 반대로 하면 mTLS 를 켠 배포에서 **토큰이 조용히 무시된다** — 같은 사람이
   * 두 신원을 갖게 되고, 어느 쪽으로 들어왔는지에 따라 권한이 달라진다.
   *
   * 인증서는 이름만 말하고 역할은 토큰 표에서 온다. `principalFromClientCert` 가
   * 그 규칙을 진다.
   */
  const bearer = api.auth.authenticate(req.headers.authorization);
  /**
   * 사람 계정 세션은 **요청마다 계정 PG 로 확인**한다 — 로그아웃·정지·역할 하향이 다음 요청부터
   * 반영되는 자리다. 못 물으면 거부한다(503). OIDC 메모리 세션(현행)은 그 뒤에 본다.
   */
  let session: Principal | undefined;
  if (bearer === undefined && api.accounts !== undefined) {
    // 쿠키 유무로 가르지 않는다 — `authenticate` 가 빈 값을 스스로 거른다(DB 에 묻지 않고 undefined).
    try {
      session = await api.accounts.authenticate(cookieValue(req.headers.cookie, accountCookie(api)));
    } catch (e) {
      if (e instanceof AccountStoreUnavailable) { accountStoreDown(res); return; }
      throw e;
    }
  }
  session ??= bearer === undefined
    ? api.sessions!.get(cookieValue(req.headers.cookie, SESSION_COOKIE))
    : undefined;
  // 쿠키가 신원이 된 요청만 출처를 본다 (위 `sameOriginWrite`).
  if (session !== undefined && !sameOriginWrite(req)) {
    crossSite(res);
    return;
  }
  const who = bearer ?? session ?? principalFromClientCert(peerCertOf(req), api.auth);
  if (who === undefined) {
    /**
     * **자격을 아예 안 보낸 요청은 실패로 세지 않는다** (2026-11-01, web-01). 로그인 화면은 로그아웃 상태에서
     * `/api/v1/me` 를 부른다. 그것까지 세면 새로고침 몇 번에 그 출처가 429 로 잠겼다. 맞혀 볼 값이 없는 요청은
     * 무차별 대입이 아니다. 틀린 토큰 · 낡은 세션 쿠키 · 매핑 없는 인증서는 전처럼 센다.
     */
    const sid = cookieValue(req.headers.cookie, accountCookie(api));
    const oidc = cookieValue(req.headers.cookie, SESSION_COOKIE);
    const presented = (req.headers.authorization ?? '') !== '' || (sid ?? '') !== '' || (oidc ?? '') !== ''
      || peerCertOf(req) !== undefined;
    if (!presented) {
      json(res, 401, { code: 'unauthenticated', message: 'Bearer 토큰이나 클라이언트 인증서가 필요하다' },
        { 'www-authenticate': 'Bearer' });
      return;
    }
    // 낡은 세션 쿠키는 지운다. 남겨 두면 로그인 화면이 새로고침마다 그것을 다시 보내 실패로 세어진다.
    const stale = [
      ...((sid ?? '') !== '' ? [expiredCookie(accountCookie(api), api.sessionSecure === true)] : []),
      ...((oidc ?? '') !== '' ? [expiredCookie(SESSION_COOKIE, api.sessionSecure === true)] : []),
    ];
    if (stale.length > 0) res.setHeader('set-cookie', stale);
    const key = ipOf(req) ?? 'unknown';
    count('bary_auth_failures_total');
    const retryAfter = authFailures.record(key);
    if (retryAfter !== undefined) {
      json(res, 429, {
        code: 'rate_limited', message: '인증 실패가 너무 많다 — 잠시 뒤 다시 시도하라',
      }, { 'retry-after': String(retryAfter) });
    } else {
      json(res, 401, { code: 'unauthenticated', message: 'Bearer 토큰이나 클라이언트 인증서가 필요하다' },
        { 'www-authenticate': 'Bearer' });
    }
    return;
  }
  authFailures.clear(ipOf(req) ?? 'unknown');

  if (isGlobal(api)) {
    await dispatch(req, res, url, who, api, [...GLOBAL_ROUTES, ...ACCOUNT_ROUTES as Route<GlobalApiOptions>[]], max, {
      notFound: `전역 모드에는 ${url.pathname} 이 없다 — /api/v1/regions 와 /api/v1/regions/<지역>/… 를 쓴다`,
    });
    return;
  }
  await dispatch(req, res, url, who, api, [...ROUTES, ...ACCOUNT_ROUTES as Route<ApiOptions>[]], max, {
    leader: api.election,
  });
}

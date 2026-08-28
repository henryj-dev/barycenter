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
import type { SecureContextOptions } from 'node:tls';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

import type { ControlPlane } from '../control/plane.js';
import { AcmeStore } from '../control/acme-store.js';
import { leaksSecret, publicChallenge, publicOrder } from '../control/acme-view.js';
import {
  drainStatusOf, endDrain, isDraining, parsePeerObservation, startDrain,
} from '../control/drain.js';
import { healthRows } from '../control/health.js';
import { count, render as renderMetrics, type LabeledGauge } from '../obs/metrics.js';
import { log } from '../obs/log.js';
import { NotLeader, type LeaderElection } from '../control/leader.js';
import { ConfigStore, StoreError, type PatchOp } from '../store/config-store.js';
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
import {
  BrowserSessions, LOGIN_COOKIE, SESSION_COOKIE, cookieValue, expiredCookie, sessionCookie,
} from './browser-session.js';
import {
  authorizationRequest, exchangeAuthorizationCode, pkceChallenge, pkceVerifier,
  type OidcRpSettings,
} from './oidc-code.js';

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
};

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

type Route = {
  method: string;
  path: string;
  pattern: RegExp;
  keys: string[];
  scope: Scope;
  handle: (c: Ctx, api: ApiOptions) => Promise<void>;
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
  return { method, path, pattern, keys, scope, handle };
}

/** 구현된 REST 표면. OpenAPI 동결이 이 표를 본다. */
export function apiRouteTable(): { method: string; path: string; scope: Scope }[] {
  return ROUTES.map((r) => ({ method: r.method, path: r.path, scope: r.scope }));
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
  }),

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
  }),

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
export function apiHandler(api: ApiOptions): RequestListener {
  const max = api.maxBodyBytes ?? DEFAULT_MAX_BODY;
  const authFailures = new AuthFailureLimiter();
  api.sessions ??= new BrowserSessions();
  return (req, res) => {
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

export function createApi(api: ApiOptions): Server {
  return createServer(apiHandler(api));
}

async function handle(
  req: IncomingMessage, res: ServerResponse, api: ApiOptions, max: number,
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
    const r = await api.control.readiness();
    json(res, r.ok ? 200 : 503, r);
    return;
  }

  // 로그아웃은 인증이 없어도 쿠키를 지워야 한다. 응답 본문에 신원을 싣지 않는다.
  if (req.method === 'POST' && url.pathname === '/api/v1/session/logout') {
    res.setHeader('set-cookie', [
      expiredCookie(SESSION_COOKIE, api.sessionSecure === true),
      expiredCookie(LOGIN_COOKIE, api.sessionSecure === true),
    ]);
    res.writeHead(204);
    res.end();
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
    const loginId = api.sessions!.beginLogin({ state, nonce, codeVerifier });
    res.setHeader('set-cookie', sessionCookie(LOGIN_COOKIE, loginId, api.sessionSecure === true, 600));
    json(res, 200, {
      url: authorizationRequest(rp, {
        state, nonce, codeChallenge: pkceChallenge(codeVerifier),
      }).toString(),
      state,
    });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/api/v1/oidc/token') {
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
  const who = api.auth.authenticate(req.headers.authorization)
    ?? api.sessions!.get(cookieValue(req.headers.cookie, SESSION_COOKIE))
    ?? principalFromClientCert(peerCertOf(req), api.auth);
  if (who === undefined) {
    const key = req.socket.remoteAddress ?? 'unknown';
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
  authFailures.clear(req.socket.remoteAddress ?? 'unknown');

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

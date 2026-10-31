/**
 * 운영 책상. SSE 를 구독하고, 폴링하지 않는다.
 * 운영 화면이 같은 스트림을 본다 — 연결을 둘로 열지 않는다.
 * 헬스는 스냅샷과 health 델타다. `/health/backends` 를 치지 않는다.
 */
import { pickPending, viewOfImpact, type Impact, type ImpactView, type PendingApply } from '@web/impact-view';
import {
  viewOfListeners, type ListenerFact, type ListenersView,
} from '@web/listeners-view';
import {
  applyHealthFlip, upsertHealth, viewOfPools,
  type BackendFact, type HealthFact, type PoolFact, type PoolsView,
} from '@web/pools-view';
import {
  viewOfRoutes, type HttpRouteFact, type PassthroughFact, type RoutesView,
} from '@web/routes-view';
import { viewOfCertificates, type CertificateFact, type CertsView, type OrderFact } from '@web/certs-view';
import { viewOfStatus, type StatusView } from '@web/status-view';
import { viewOfRendered, type RenderedView } from '@web/rendered-view';
import { viewOfAudit, type AuditView } from '@web/audit-view';
import { backoffMs } from '@web/reconnect';
import { deletePatch, putBackendPatch, putCertificatePatch, putHashPoolWithBackendPatch, putHttpListenerPatch, putHttpsListenerPatch, putHttpRedirectPatch, putHttpRejectPatch, putHttpRoutePatch, putPassthroughListenerPatch, putPassthroughRejectPatch, putPassthroughRoutePatch, putPoolWithBackendPatch, putSniBindingPatch, putSourceIpHashPoolWithBackendPatch, putTcpListenerPatch, putTlsPolicyPatch, putUdpListenerPatch, editListenerPatch, proxyFromUrlPatch, type ProxyFromUrlInput, type ListenerEdit, type EditKind, type KeylessAlgorithm, type ProtocolClass, type RedirectStatus, type RejectStatus, type TlsVersion, type UdpPreset, parseListenerOptions, parseSourceAllow, parseHeaderLines, type ListenerOptionFlags } from '@web/edit';
import { pullSse } from '@web/sse-parse';
import type { ModelLike, ResourceKind } from '@web/resources';
import { needsStepUp, stepUp } from '#lib/account/step-up.svelte';

export type StatusSnap = {
  head?: string;
  pendingApply?: PendingApply[];
  health?: HealthFact[];
  engine?: unknown;
  driver?: unknown;
  leader?: unknown;
  published?: unknown;
  unfinished?: unknown;
};

/**
 * @param scope 전역 모드면 읽기 경로를 고른 지역의 중계 경로로 바꾼다(`lib/global/scope`). 지역 인스턴스면 그대로다.
 */
/** 바인드할 수 있는 주소 — `GET /api/v1/system/addresses`. */
export type HostAddressFacts = {
  addresses: { address: string; family: 'v4' | 'v6'; interface: string; internal: boolean }[];
  nonlocalBind: { v4: boolean; v6: boolean };
};

/** ACME 계정 한 줄 — `GET /api/v1/acme/accounts`. */
export type AcmeAccountRow = { id: string; key: string; directoryUrl: string; contact: string[]; registered: boolean };

export function createDesk(scope?: { api(path: string): string }) {
  const api = (path: string): string => scope?.api(path) ?? path;
  // OIDC 로그인은 HttpOnly 세션 쿠키를 쓴다. 수동 Bearer 입력은 새로고침하면 사라지는
  // 메모리 값으로만 남긴다 — 브라우저 저장소에 API 자격증명을 보관하지 않는다.
  let token = $state('');
  let live = $state(false);
  let error = $state<string | undefined>();
  let head = $state<string | undefined>();
  let view = $state<ImpactView | undefined>();
  let listeners = $state<ListenersView>({ rows: [] });
  /** head 모델의 리스너 그대로 — 상세가 보여 주고, 수정이 바탕으로 쓴다(`editListenerPatch`). */
  let listenerModels = $state<Record<string, unknown>[]>([]);
  /**
   * **head 모델 묶음** — 컬렉션마다 API 가 준 그대로 (상세 화면, 2026-10-30).
   * `/config/model` 을 따로 묻지 않는다: 전역 모드의 지역 중계에 그 경로가 없고, 같은 값을
   * 이미 목록마다 받는다. 받을 때마다 그 컬렉션만 바꾼다.
   */
  let model = $state<ModelLike>({});
  const setModel = (collection: string, rows: unknown): void => {
    model = { ...model, [collection]: Array.isArray(rows) ? rows as Record<string, unknown>[] : [] };
  };
  let health = $state<HealthFact[]>([]);
  let pools = $state<PoolsView>({ rows: [] });
  let routes = $state<RoutesView>({ order: [], warnings: [], errors: [], passthrough: [] });
  let certs = $state<CertsView>({ rows: [] });
  let policies = $state<string[]>([]);
  let bindings = $state<{ key: string; listener: string; hosts: string[]; certificate: string }[]>([]);
  let status = $state<StatusView>(viewOfStatus({}));
  let rendered = $state<RenderedView>(viewOfRendered({}));
  let audit = $state<AuditView>(viewOfAudit([]));
  let applying = $state(false);
  /** 커밋했지만 적용하지 않은 plan 수 — 상단 바의 「적용 대기 N」 과 배너. */
  let pendingCount = $state(0);
  let recovering = $state(false);
  let editing = $state(false);
  let stop: (() => void) | undefined;

  const auth = (): Record<string, string> =>
    token === '' ? {} : { authorization: `Bearer ${token}` };

  const refreshImpact = async (pending: PendingApply | undefined): Promise<void> => {
    if (pending === undefined) {
      view = undefined;
      return;
    }
    const r = await fetch(api(`/api/v1/plans/${pending.planId}`), { headers: auth() });
    if (!r.ok) {
      error = `plan ${pending.planId} 을 못 읽었다 (${r.status})`;
      view = undefined;
      return;
    }
    const body = (await r.json()) as { impact: Impact };
    view = viewOfImpact(pending, body.impact);
  };

  const refreshListeners = async (impact: ImpactView | undefined): Promise<void> => {
    const r = await fetch(api('/api/v1/listeners'), { headers: auth() });
    if (!r.ok) {
      error = `listeners ${r.status}`;
      listeners = { rows: [] };
      listenerModels = [];
      return;
    }
    const body = (await r.json()) as unknown;
    const facts = Array.isArray(body) ? body as ListenerFact[] : [];
    listenerModels = Array.isArray(body) ? body as Record<string, unknown>[] : [];
    setModel('listeners', body);
    listeners = viewOfListeners(
      facts,
      impact === undefined ? undefined : { added: impact.socketsAdded, removed: impact.socketsRemoved },
    );
  };

  const asList = <T>(v: unknown): T[] => (Array.isArray(v) ? v as T[] : []);

  /**
   * 백엔드가 왜 트래픽을 안 받나 (제안 #9). **없으면 아무 말도 안 한다.**
   *
   * 이 API 가 안 오는 것과 "이유가 없다(= 받는 중)" 는 다르다 — 못 읽은 것을 초록으로
   * 보이게 하면 안 되므로 실패는 빈 맵이 아니라 **표시를 안 만드는 것**으로 흐른다.
   */
  let acmeOrders = $state<Record<string, unknown>[]>([]);
  let traffic = $state<Map<string, { receivingTraffic: boolean; reasons: string[] }>>(new Map());

  const refreshPools = async (): Promise<void> => {
    const [pr, br, sr] = await Promise.all([
      fetch(api('/api/v1/pools'), { headers: auth() }),
      fetch(api('/api/v1/backends'), { headers: auth() }),
      fetch(api('/api/v1/backends/status'), { headers: auth() }),
    ]);
    // 상태 API 는 **선택**이다. 못 읽어도 풀 화면은 서야 한다 — 헬스와 드레인은
    // 다른 경로로 오고, 이 줄 하나 때문에 화면 전체가 비면 그게 더 나쁘다.
    traffic = sr.ok
      ? new Map((await sr.json() as { key: string; receivingTraffic: boolean; reasons: string[] }[])
        .map((r) => [r.key, { receivingTraffic: r.receivingTraffic, reasons: r.reasons }]))
      : new Map();
    if (!pr.ok || !br.ok) {
      error = `pools ${pr.status}/${br.status}`;
      pools = { rows: [] };
      return;
    }
    const poolRows = await pr.json() as unknown;
    const backendRows = await br.json() as unknown;
    setModel('pools', poolRows);
    setModel('backends', backendRows);
    pools = viewOfPools(asList<PoolFact>(poolRows), asList<BackendFact>(backendRows), health);
  };

  const onStatus = async (snap: StatusSnap): Promise<void> => {
    head = snap.head;
    pendingCount = snap.pendingApply?.length ?? 0;
    status = viewOfStatus(snap);
    if (snap.health !== undefined) health = snap.health;
    await refreshImpact(pickPending(snap.pendingApply ?? []));
    await refreshListeners(view);
    await refreshPools();
    await refreshRoutes();
    await refreshCerts();
    await refreshPolicies();
    await refreshBindings();
    await refreshAddressSets();
    await refreshRendered();
    await refreshAudit();
  };

  const refreshAudit = async (): Promise<void> => {
    const r = await fetch(api('/api/v1/audit'), { headers: auth() });
    if (!r.ok) {
      error = `audit ${r.status}`;
      audit = viewOfAudit([]);
      return;
    }
    audit = viewOfAudit(await r.json());
  };

  const refreshRendered = async (): Promise<void> => {
    const r = await fetch(api('/api/v1/config/rendered'), { headers: auth() });
    if (!r.ok) {
      error = `rendered ${r.status}`;
      rendered = viewOfRendered({});
      return;
    }
    rendered = viewOfRendered(await r.json());
  };

  /** 주소 집합. 전역 중계에는 이 경로가 없다 — 못 읽으면 빈 목록이고, 오류로 말하지 않는다. */
  const refreshAddressSets = async (): Promise<void> => {
    const r = await fetch(api('/api/v1/address-sets'), { headers: auth() });
    setModel('addressSets', r.ok ? await r.json() : []);
  };

  const refreshBindings = async (): Promise<void> => {
    const r = await fetch(api('/api/v1/sni-bindings'), { headers: auth() });
    if (!r.ok) {
      error = `sni-bindings ${r.status}`;
      bindings = [];
      setModel('sniBindings', []);
      return;
    }
    const bindingRows = await r.json() as unknown;
    setModel('sniBindings', bindingRows);
    bindings = asList<{ key?: unknown; listener?: unknown; hosts?: unknown; certificate?: unknown }>(bindingRows)
      .flatMap((b) => {
        if (typeof b.key !== 'string' || typeof b.listener !== 'string' || typeof b.certificate !== 'string') {
          return [];
        }
        const hosts = Array.isArray(b.hosts) ? b.hosts.filter((h): h is string => typeof h === 'string') : [];
        return [{ key: b.key, listener: b.listener, hosts, certificate: b.certificate }];
      });
  };

  const refreshPolicies = async (): Promise<void> => {
    const r = await fetch(api('/api/v1/tls-policies'), { headers: auth() });
    if (!r.ok) {
      error = `tls-policies ${r.status}`;
      policies = [];
      return;
    }
    const policyRows = await r.json() as unknown;
    setModel('tlsPolicies', policyRows);
    policies = asList<{ key?: unknown }>(policyRows)
      .map((p) => p.key)
      .filter((k): k is string => typeof k === 'string' && k !== '');
  };

  const refreshCerts = async (): Promise<void> => {
    const [cr, or] = await Promise.all([
      fetch(api('/api/v1/certificates'), { headers: auth() }),
      fetch(api('/api/v1/acme/orders'), { headers: auth() }),
    ]);
    if (!cr.ok) {
      error = `certificates ${cr.status}`;
      certs = { rows: [] };
      return;
    }
    const orders = or.ok ? asList<OrderFact>(await or.json()) : [];
    const certRows = await cr.json() as unknown;
    setModel('certificates', certRows);
    acmeOrders = orders as unknown as Record<string, unknown>[];
    certs = viewOfCertificates(asList<CertificateFact>(certRows), orders);
  };

  const refreshRoutes = async (): Promise<void> => {
    const r = await fetch(api('/api/v1/routes'), { headers: auth() });
    if (!r.ok) {
      error = `routes ${r.status}`;
      routes = { order: [], warnings: [], errors: [], passthrough: [] };
      return;
    }
    const body = (await r.json()) as { http?: unknown; passthrough?: unknown };
    setModel('httpRoutes', body.http);
    setModel('passthroughRoutes', body.passthrough);
    routes = viewOfRoutes(asList<HttpRouteFact>(body.http), asList<PassthroughFact>(body.passthrough));
  };

  const onHealth = (data: unknown): void => {
    const flip = data as { backendKey?: unknown; state?: unknown };
    if (typeof flip.backendKey !== 'string' || typeof flip.state !== 'string') return;
    const row = { backendKey: flip.backendKey, state: flip.state };
    health = upsertHealth(health, row);
    pools = applyHealthFlip(pools, row);
  };

  /**
   * 스트림 한 번. **재연결은 `connect` 가 한다** (검수 G1).
   *
   * 셋을 갈라 돌려준다. `live` 로는 못 가른다 — `finally` 가 그것을 내리므로 돌아온
   * 시점에는 언제나 `false` 다.
   *
   *   `served`   붙어서 흘리다 끊겼다 — 다음 재시도는 **처음부터**다
   *   `refused`  못 붙었다 — 대기를 늘린다
   *   `stop`     우리가 끊었거나 토큰이 거절됐다 — **다시 안 붙는다**
   */
  const streamOnce = async (ac: AbortController): Promise<'served' | 'refused' | 'stop'> => {
    const r = await fetch(api('/api/v1/events'), { headers: auth(), signal: ac.signal });
    if (!r.ok || r.body === null) {
      error = r.status === 401 ? '토큰이 거절됐다' : `events ${r.status}`;
      live = false;
      // 401 은 다시 붙어 봐야 같다. 그건 사람이 고칠 것이다.
      return r.status === 401 ? 'stop' : 'refused';
    }
    live = true;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        const pulled = pullSse(buf);
        buf = pulled.rest;
        for (const frame of pulled.frames) {
          if (frame.kind !== 'event') continue;
          if (frame.event === 'snapshot') {
            await onStatus(frame.data as StatusSnap);
          } else if (frame.event === 'health') {
            onHealth(frame.data);
          } else if (frame.event === 'acme') {
            // 주문이 한 걸음 갔다(대기 → 검증 중 → 발급됨 · 실패). 인증서와 주문만 다시 읽는다.
            await refreshCerts();
          } else if (frame.event === 'revision' || frame.event === 'apply') {
            const st = await fetch(api('/api/v1/status'), { headers: auth() });
            if (st.ok) await onStatus((await st.json()) as StatusSnap);
          }
        }
      }
    } catch (e) {
      if ((e as { name?: string }).name === 'AbortError') {
        // 우리가 끊었다. 다시 붙지 않는다.
        live = false;
        return 'stop';
      }
      error = e instanceof Error ? e.message : String(e);
    } finally {
      live = false;
    }
    // 여기 왔다는 것은 **붙어서 흘렸다**는 뜻이다 — 위에서 이미 돌아갔을 것이므로.
    return 'served';
  };

  /**
   * **끊기면 다시 붙는다** (검수 G1).
   *
   * 전에는 스트림이 끝나면 `live = false` 만 하고 끝났다 — 망이 잠깐 끊기거나 데몬이
   * 재기동하면 **화면이 그 자리에서 멈추고 다시는 안 살아났다.** 운영자는 그것이
   * 「아무 일도 안 일어나는 중」인지 「연결이 죽은 것」인지 알 수 없다. 그리고 이 화면은
   * 트래픽을 바꾸는 데 쓰인다.
   *
   * **`Last-Event-ID` 를 안 쓴다.** 스트림이 열릴 때 언제나 전체 스냅샷을 주므로
   * 재연결 = 새 스냅샷 = 일관된 상태이고, 이건 **구성상 옳다** — 빠뜨릴 이벤트라는
   * 개념이 없다. 근거는 `src/web/reconnect.ts` 머리말에 있다.
   */
  const connect = async (): Promise<void> => {
    stop?.();
    error = undefined;
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    stop = () => {
      if (timer !== undefined) clearTimeout(timer);
      ac.abort();
    };

    let attempt = 0;
    while (!ac.signal.aborted) {
      const outcome = await streamOnce(ac);
      if (outcome === 'stop' || ac.signal.aborted) return;
      // **붙었다 끊긴 것과 못 붙은 것을 가른다.** 붙었었다면 다음 재시도는 처음부터다 —
      // 안 그러면 잠깐씩 자주 끊기는 망에서 대기가 끝없이 길어진다.
      if (outcome === 'served') attempt = 0;
      const wait = backoffMs(attempt);
      if (outcome === 'refused') attempt += 1;
      await new Promise<void>((r) => { timer = setTimeout(r, wait); });
    }
  };

  const call = async (method: string, path: string, body?: unknown, retried = false): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> => {
    const r = await fetch(path, {
      method,
      headers: {
        ...auth(),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (r.status === 204) return { ok: r.ok, status: r.status, body: {} };
    const parsed: unknown = await r.json().catch(() => ({}));
    const rec = parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    // 민감 작업(인증서 개인키 등) — 사람 세션이면 코드를 한 번 받고 한 번만 다시 보낸다.
    if (!retried && needsStepUp(r.status, rec['code']) && await stepUp.request()) return call(method, path, body, true);
    return { ok: r.ok, status: r.status, body: rec };
  };

  /**
   * changeset 에 patch 를 얹고 commit 까지. apply 는 안 한다.
   * 트래픽은 Impact 화면의 「트래픽에 건다」가 바꾼다.
   */
  const commitPatch = async (patch: unknown[]): Promise<boolean> => {
    let csId: string | undefined;
    try {
      const headRes = await call('GET', '/api/v1/config/head');
      if (!headRes.ok || typeof headRes.body['revision'] !== 'string') {
        error = (headRes.body['message'] as string | undefined) ?? `head ${headRes.status}`;
        return false;
      }
      const opened = await call('POST', '/api/v1/changesets', { base_revision: headRes.body['revision'] });
      if (!opened.ok || typeof opened.body['id'] !== 'string') {
        error = (opened.body['message'] as string | undefined) ?? `changeset ${opened.status}`;
        return false;
      }
      csId = opened.body['id'];
      const patched = await call('PATCH', `/api/v1/changesets/${csId}`, { patch });
      if (!patched.ok) {
        error = (patched.body['message'] as string | undefined) ?? `patch ${patched.status}`;
        return false;
      }
      const planned = await call('POST', `/api/v1/changesets/${csId}/plan`);
      if (!planned.ok || typeof planned.body['id'] !== 'string') {
        error = (planned.body['message'] as string | undefined) ?? `plan ${planned.status}`;
        return false;
      }
      const committed = await call('POST', `/api/v1/changesets/${csId}/commit`, { plan_id: planned.body['id'] });
      if (!committed.ok) {
        error = (committed.body['message'] as string | undefined) ?? `commit ${committed.status}`;
        return false;
      }
      return true;
    } finally {
      if (csId !== undefined && error !== undefined) {
        await call('DELETE', `/api/v1/changesets/${csId}`).catch(() => undefined);
      }
    }
  };

  const withdraw = async (kind: EditKind, key: string): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      return await commitPatch(deletePatch(kind, key));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  const insertBackend = async (
    key: string,
    body: { pool: string; host: string; port: number; weight?: number },
  ): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      return await commitPatch(putBackendPatch(key, body));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  const insertPool = async (input: {
    pool: string;
    protocolClass: ProtocolClass;
    backend: string;
    host: string;
    port: number;
    /** S6. 없으면 `round_robin` — 빌더가 기본을 준다. */
    algorithm?: KeylessAlgorithm;
  }): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      return await commitPatch(putPoolWithBackendPatch(input));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  const insertHashPool = async (input: {
    pool: string;
    protocolClass: ProtocolClass;
    hashKey: string;
    backend: string;
    host: string;
    port: number;
  }): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      return await commitPatch(putHashPoolWithBackendPatch(input));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  const insertSourceIpHashPool = async (input: {
    pool: string;
    protocolClass: ProtocolClass;
    backend: string;
    host: string;
    port: number;
  }): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      return await commitPatch(putSourceIpHashPoolWithBackendPatch(input));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  /**
   * 출발지 제한 칸의 문자열 → patch 조각. 끊기·검사는 `parseSourceAllow` 한 자리다(CLI 와 같다).
   * **try 안에서 부른다** — 잘못된 대역은 폼 위의 오류 한 줄로 끝난다.
   */
  const allowOf = (allow: string | undefined): { sourceAllow?: string[] } => {
    const list = parseSourceAllow(allow);
    return list === undefined ? {} : { sourceAllow: list };
  };

  const insertHttpListener = async (
    key: string,
    body: { bind: string; port: number; pool: string; hosts?: string[] },
    opts?: ListenerOptionFlags,
    allow?: string,
  ): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      // 단위 해석은 `parseListenerOptions` 한 자리다 — CLI 와 같은 것을 쓴다.
      return await commitPatch(putHttpListenerPatch(key, { ...body, ...parseListenerOptions(opts ?? {}), ...allowOf(allow) }));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  const insertTcpListener = async (
    key: string,
    body: { bind: string; port: number; pool: string },
    allow?: string,
  ): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      return await commitPatch(putTcpListenerPatch(key, { ...body, ...allowOf(allow) }));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  const insertPassthroughListener = async (
    key: string,
    body: { bind: string; port: number; pool?: string; noSniPool?: string },
    allow?: string,
  ): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      return await commitPatch(putPassthroughListenerPatch(key, { ...body, ...allowOf(allow) }));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  /**
   * **아무 리소스나 통째로 바꾼다** — 상세의 JSON 수정·만들기 (2026-10-30). body 는 key 를 뺀
   * 모델 모양 그대로다. 모양 검사는 저장소(해독기·검증기)가 한다 — 여기서 다시 하지 않는다.
   */
  const putResource = async (kind: ResourceKind, key: string, body: Record<string, unknown>): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      if (key.trim() === '') throw new Error('키가 비어 있다');
      return await commitPatch([{ op: 'put', kind, key: key.trim(), body }]);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  /**
   * ACME 계정 (DESIGN §8.2.1). 계정 키는 서버가 만들어 시크릿에 둔다 — 화면은 키를 보지 않는다.
   * CA 등록은 첫 주문 때 러너가 한다(`registered`). 못 읽으면 undefined.
   */
  const acmeAccounts = async (): Promise<AcmeAccountRow[] | undefined> => {
    const r = await fetch(api('/api/v1/acme/accounts'), { headers: auth() });
    if (!r.ok) return undefined;
    const body = (await r.json()) as { accounts?: AcmeAccountRow[] };
    return body.accounts ?? [];
  };
  /**
   * 이 서버에 할당된 IP — 바인드 선택이 읽는다(2026-10-31). 못 읽거나 서버가 모르면 undefined —
   * 그러면 바인드를 손으로 받는다.
   */
  const hostAddresses = async (): Promise<HostAddressFacts | undefined> => {
    const r = await fetch(api('/api/v1/system/addresses'), { headers: auth() });
    if (!r.ok) return undefined;
    const body = (await r.json()) as HostAddressFacts & { available?: boolean };
    return body.available === true ? { addresses: body.addresses, nonlocalBind: body.nonlocalBind } : undefined;
  };
  const createAcmeAccount = async (input: { key: string; directoryUrl: string; contact: string[] }): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      const r = await call('POST', '/api/v1/acme/accounts', input);
      if (!r.ok) error = (r.body['message'] as string | undefined) ?? `acme account ${r.status}`;
      return r.ok;
    } finally {
      editing = false;
    }
  };

  /** 상세의 「기록」 탭. 못 읽으면(전역 중계에 없다) undefined — 「바뀐 적 없다」 와 다르다. */
  const historyOf = async (kind: ResourceKind, key: string): Promise<unknown[] | undefined> => {
    const q = new URLSearchParams({ kind, key });
    const r = await fetch(api(`/api/v1/config/history?${q.toString()}`), { headers: auth() });
    return r.ok ? asList<unknown>(await r.json()) : undefined;
  };

  /** 적용 대기 화면의 롤백 구획 — 리비전 목록. */
  const revisions = async (): Promise<unknown[] | undefined> => {
    const r = await fetch(api('/api/v1/config/revisions?limit=100'), { headers: auth() });
    return r.ok ? asList<unknown>(await r.json()) : undefined;
  };

  /** 롤백 — 옛 내용으로 새 리비전을 만든다. 적용은 적용 대기 화면이 한다. */
  const rollback = async (toRevision: string): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      const r = await call('POST', '/api/v1/rollback', { to_revision: toRevision });
      if (!r.ok) error = (r.body['message'] as string | undefined) ?? `rollback ${r.status}`;
      return r.ok;
    } finally {
      editing = false;
    }
  };

  /**
   * 빠른 프록시 · URL로 다시 만들기 — URL 하나를 풀·백엔드·리스너(또는 라우트)로 편다.
   * 펴는 규칙은 `proxyFromUrlPatch` 한 자리다(CLI `bary proxy create` 와 같다).
   */
  const proxyFromUrl = async (input: ProxyFromUrlInput): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      return await commitPatch(proxyFromUrlPatch(input));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  /** `/ops/cluster/<노드>` — 그 노드가 최근에 따라간 기록. */
  const clusterHistory = async (name: string): Promise<unknown[] | undefined> => {
    const r = await fetch(api(`/api/v1/cluster/nodes/${encodeURIComponent(name)}/history`), { headers: auth() });
    return r.ok ? asList<unknown>(await r.json()) : undefined;
  };

  /** `/ops/cluster` — 노드 상태. */
  const clusterNodes = async (): Promise<Record<string, unknown> | undefined> => {
    const r = await fetch(api('/api/v1/cluster/nodes'), { headers: auth() });
    return r.ok ? await r.json() as Record<string, unknown> : undefined;
  };

  /** 상세의 수정 화면. head 의 그 리스너를 바탕으로 고친 칸만 덮는다. */
  const updateListener = async (key: string, edit: ListenerEdit): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      const current = listenerModels.find((l) => l['key'] === key);
      if (current === undefined) throw new Error(`리스너 '${key}' 가 head 에 없다`);
      return await commitPatch(editListenerPatch(current, edit));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  const insertTlsPolicy = async (key: string, minVersion?: TlsVersion): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      return await commitPatch(putTlsPolicyPatch(key, minVersion === undefined ? {} : { minVersion }));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  const insertCertificate = async (
    key: string,
    material: { fullchain: string; privkey: string },
  ): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      const uploaded = await call('POST', '/api/v1/certificates/material', {
        name: key,
        fullchain: material.fullchain,
        privkey: material.privkey,
      });
      if (!uploaded.ok) {
        error = (uploaded.body['message'] as string | undefined) ?? `material ${uploaded.status}`;
        return false;
      }
      const materialRef = uploaded.body['ref'];
      const chainDigest = uploaded.body['chainDigest'];
      const keyDigest = uploaded.body['keyDigest'];
      if (typeof materialRef !== 'string' || typeof chainDigest !== 'string' || typeof keyDigest !== 'string') {
        error = '자료 응답에 참조가 없다';
        return false;
      }
      return await commitPatch(putCertificatePatch(key, { materialRef, chainDigest, keyDigest }));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  const insertSniBinding = async (input: {
    key: string; listener: string; hosts: string[]; certificate: string;
  }): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      return await commitPatch(putSniBindingPatch(input));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  const insertHttpsListener = async (
    key: string,
    body: { bind: string; port: number; pool: string; policy: string; certificate: string; hosts?: string[]; httpRedirect?: { port: number } },
    opts?: ListenerOptionFlags,
    allow?: string,
  ): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      return await commitPatch(putHttpsListenerPatch(key, { ...body, ...parseListenerOptions(opts ?? {}), ...allowOf(allow) }));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  const insertUdpListener = async (
    key: string,
    body: { bind: string; port: number; pool: string; preset: UdpPreset },
    allow?: string,
  ): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      return await commitPatch(putUdpListenerPatch(key, { ...body, ...allowOf(allow) }));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  const insertHttpRoute = async (input: {
    key: string;
    listener: string;
    hosts: string[];
    pool: string;
    pathPrefix?: string;
    websocket?: boolean;
    rewritePrefix?: string;
    /** `이름: 값` 줄들. 끊기는 `parseHeaderLines` 한 자리다 (#109). */
    requestHeaders?: string;
  }): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      const { requestHeaders, ...rest } = input;
      const parsed = parseHeaderLines(requestHeaders);
      return await commitPatch(putHttpRoutePatch({ ...rest, ...(parsed === undefined ? {} : { requestHeaders: parsed }) }));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  const insertHttpRedirect = async (input: {
    key: string;
    listener: string;
    hosts: string[];
    to: string;
    status: RedirectStatus;
    pathPrefix?: string;
  }): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      return await commitPatch(putHttpRedirectPatch(input));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  const insertHttpReject = async (input: {
    key: string;
    listener: string;
    hosts: string[];
    status: RejectStatus;
    pathPrefix?: string;
  }): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      return await commitPatch(putHttpRejectPatch(input));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  const insertPassthroughRoute = async (input: {
    key: string;
    listener: string;
    snis: string[];
    pool: string;
  }): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      return await commitPatch(putPassthroughRoutePatch(input));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  const insertPassthroughReject = async (input: {
    key: string;
    listener: string;
    snis: string[];
  }): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      return await commitPatch(putPassthroughRejectPatch(input));
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  const apply = async (): Promise<void> => {
    if (view === undefined) return;
    applying = true;
    error = undefined;
    try {
      const r = await fetch(api('/api/v1/apply'), {
        method: 'POST',
        headers: { ...auth(), 'content-type': 'application/json' },
        body: JSON.stringify({ plan_id: view.planId }),
      });
      const body = (await r.json()) as { phase?: string; message?: string };
      if (!r.ok) error = body.message ?? `apply ${r.status}`;
      else if (body.phase !== 'activated') error = `활성화되지 않았다: ${body.phase ?? '?'}`;
    } finally {
      applying = false;
    }
  };

  const drain = async (key: string): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      const r = await fetch(api(`/api/v1/backends/${encodeURIComponent(key)}/drain`), {
        method: 'POST', headers: auth(),
      });
      if (!r.ok) {
        const body = (await r.json()) as { message?: string };
        error = body.message ?? `drain ${r.status}`;
        return false;
      }
      await refreshPools();
      return true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };
  /** 드레인 해제 — 다시 새 연결을 받는다. 설정(commit)이 아니다. */
  const undrain = async (key: string): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      const r = await fetch(api(`/api/v1/backends/${encodeURIComponent(key)}/drain`), {
        method: 'DELETE', headers: auth(),
      });
      if (!r.ok) {
        const body = (await r.json()) as { message?: string };
        error = body.message ?? `undrain ${r.status}`;
        return false;
      }
      await refreshPools();
      return true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      return false;
    } finally {
      editing = false;
    }
  };

  const recover = async (): Promise<void> => {
    recovering = true;
    error = undefined;
    try {
      const r = await fetch(api('/api/v1/recover'), { method: 'POST', headers: auth() });
      const body = (await r.json()) as { phase?: string; message?: string };
      if (!r.ok) error = body.message ?? `recover ${r.status}`;
    } finally {
      recovering = false;
    }
  };

  return {
    get token() { return token; },
    set token(v: string) { token = v; },
    get live() { return live; },
    get error() { return error; },
    get head() { return head; },
    get view() { return view; },
    get listeners() { return listeners; },
    get listenerModels() { return listenerModels; },
    get model() { return model; },
    get acmeOrders() { return acmeOrders; },
    get health() { return health; },
    get pools() { return pools; },
    get routes() { return routes; },
    get certs() { return certs; },
    get policies() { return policies; },
    get bindings() { return bindings; },
    get status() { return status; },
    get rendered() { return rendered; },
    get audit() { return audit; },
    get applying() { return applying; },
    get pendingCount() { return pendingCount; },
    get recovering() { return recovering; },
    get editing() { return editing; },
    connect,
    apply,
    recover,
    drain,
    undrain,
    withdraw,
    insertBackend,
    insertPool,
    insertHashPool,
    insertSourceIpHashPool,
    insertHttpListener,
    insertTcpListener,
    insertPassthroughListener,
    insertUdpListener,
    insertTlsPolicy,
    updateListener,
    putResource,
    acmeAccounts,
    hostAddresses,
    createAcmeAccount,
    historyOf,
    revisions,
    rollback,
    clusterNodes,
    clusterHistory,
    proxyFromUrl,
    get traffic() { return traffic; },
    insertHttpsListener,
    insertCertificate,
    insertSniBinding,
    insertHttpRoute,
    insertHttpRedirect,
    insertHttpReject,
    insertPassthroughRoute,
    insertPassthroughReject,
    disconnect() { stop?.(); },
  };
}

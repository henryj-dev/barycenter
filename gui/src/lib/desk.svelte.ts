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
import { deletePatch, putBackendPatch, putCertificatePatch, putHashPoolWithBackendPatch, putHttpListenerPatch, putHttpsListenerPatch, putHttpRedirectPatch, putHttpRejectPatch, putHttpRoutePatch, putPassthroughListenerPatch, putPassthroughRejectPatch, putPassthroughRoutePatch, putPoolWithBackendPatch, putSniBindingPatch, putSourceIpHashPoolWithBackendPatch, putTcpListenerPatch, putTlsPolicyPatch, putUdpListenerPatch, type EditKind, type KeylessAlgorithm, type ProtocolClass, type RedirectStatus, type RejectStatus, type TlsVersion, type UdpPreset, parseListenerOptions, type ListenerOptionFlags } from '@web/edit';
import { pullSse } from '@web/sse-parse';

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

const tokenKey = 'bary.token';

export function createDesk() {
  let token = $state(sessionStorage.getItem(tokenKey) ?? '');
  let live = $state(false);
  let error = $state<string | undefined>();
  let head = $state<string | undefined>();
  let view = $state<ImpactView | undefined>();
  let listeners = $state<ListenersView>({ rows: [] });
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
    const r = await fetch(`/api/v1/plans/${pending.planId}`, { headers: auth() });
    if (!r.ok) {
      error = `plan ${pending.planId} 을 못 읽었다 (${r.status})`;
      view = undefined;
      return;
    }
    const body = (await r.json()) as { impact: Impact };
    view = viewOfImpact(pending, body.impact);
  };

  const refreshListeners = async (impact: ImpactView | undefined): Promise<void> => {
    const r = await fetch('/api/v1/listeners', { headers: auth() });
    if (!r.ok) {
      error = `listeners ${r.status}`;
      listeners = { rows: [] };
      return;
    }
    const body = (await r.json()) as unknown;
    const facts = Array.isArray(body) ? body as ListenerFact[] : [];
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
  let traffic = $state<Map<string, { receivingTraffic: boolean; reasons: string[] }>>(new Map());

  const refreshPools = async (): Promise<void> => {
    const [pr, br, sr] = await Promise.all([
      fetch('/api/v1/pools', { headers: auth() }),
      fetch('/api/v1/backends', { headers: auth() }),
      fetch('/api/v1/backends/status', { headers: auth() }),
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
    pools = viewOfPools(
      asList<PoolFact>(await pr.json()),
      asList<BackendFact>(await br.json()),
      health,
    );
  };

  const onStatus = async (snap: StatusSnap): Promise<void> => {
    head = snap.head;
    status = viewOfStatus(snap);
    if (snap.health !== undefined) health = snap.health;
    await refreshImpact(pickPending(snap.pendingApply ?? []));
    await refreshListeners(view);
    await refreshPools();
    await refreshRoutes();
    await refreshCerts();
    await refreshPolicies();
    await refreshBindings();
    await refreshRendered();
    await refreshAudit();
  };

  const refreshAudit = async (): Promise<void> => {
    const r = await fetch('/api/v1/audit', { headers: auth() });
    if (!r.ok) {
      error = `audit ${r.status}`;
      audit = viewOfAudit([]);
      return;
    }
    audit = viewOfAudit(await r.json());
  };

  const refreshRendered = async (): Promise<void> => {
    const r = await fetch('/api/v1/config/rendered', { headers: auth() });
    if (!r.ok) {
      error = `rendered ${r.status}`;
      rendered = viewOfRendered({});
      return;
    }
    rendered = viewOfRendered(await r.json());
  };

  const refreshBindings = async (): Promise<void> => {
    const r = await fetch('/api/v1/sni-bindings', { headers: auth() });
    if (!r.ok) {
      error = `sni-bindings ${r.status}`;
      bindings = [];
      return;
    }
    bindings = asList<{ key?: unknown; listener?: unknown; hosts?: unknown; certificate?: unknown }>(await r.json())
      .flatMap((b) => {
        if (typeof b.key !== 'string' || typeof b.listener !== 'string' || typeof b.certificate !== 'string') {
          return [];
        }
        const hosts = Array.isArray(b.hosts) ? b.hosts.filter((h): h is string => typeof h === 'string') : [];
        return [{ key: b.key, listener: b.listener, hosts, certificate: b.certificate }];
      });
  };

  const refreshPolicies = async (): Promise<void> => {
    const r = await fetch('/api/v1/tls-policies', { headers: auth() });
    if (!r.ok) {
      error = `tls-policies ${r.status}`;
      policies = [];
      return;
    }
    policies = asList<{ key?: unknown }>(await r.json())
      .map((p) => p.key)
      .filter((k): k is string => typeof k === 'string' && k !== '');
  };

  const refreshCerts = async (): Promise<void> => {
    const [cr, or] = await Promise.all([
      fetch('/api/v1/certificates', { headers: auth() }),
      fetch('/api/v1/acme/orders', { headers: auth() }),
    ]);
    if (!cr.ok) {
      error = `certificates ${cr.status}`;
      certs = { rows: [] };
      return;
    }
    const orders = or.ok ? asList<OrderFact>(await or.json()) : [];
    certs = viewOfCertificates(asList<CertificateFact>(await cr.json()), orders);
  };

  const refreshRoutes = async (): Promise<void> => {
    const r = await fetch('/api/v1/routes', { headers: auth() });
    if (!r.ok) {
      error = `routes ${r.status}`;
      routes = { order: [], warnings: [], errors: [], passthrough: [] };
      return;
    }
    const body = (await r.json()) as { http?: unknown; passthrough?: unknown };
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
    const r = await fetch('/api/v1/events', { headers: auth(), signal: ac.signal });
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
          } else if (frame.event === 'revision' || frame.event === 'apply') {
            const st = await fetch('/api/v1/status', { headers: auth() });
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
    sessionStorage.setItem(tokenKey, token);

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

  const call = async (method: string, path: string, body?: unknown): Promise<{ ok: boolean; status: number; body: Record<string, unknown> }> => {
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

  const insertHttpListener = async (
    key: string,
    body: { bind: string; port: number; pool: string },
    opts?: ListenerOptionFlags,
  ): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      // 단위 해석은 `parseListenerOptions` 한 자리다 — CLI 와 같은 것을 쓴다.
      return await commitPatch(putHttpListenerPatch(key, { ...body, ...parseListenerOptions(opts ?? {}) }));
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
  ): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      return await commitPatch(putTcpListenerPatch(key, body));
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
  ): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      return await commitPatch(putPassthroughListenerPatch(key, body));
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
    body: { bind: string; port: number; pool: string; policy: string; certificate: string },
    opts?: ListenerOptionFlags,
  ): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      return await commitPatch(putHttpsListenerPatch(key, { ...body, ...parseListenerOptions(opts ?? {}) }));
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
  ): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      return await commitPatch(putUdpListenerPatch(key, body));
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
  }): Promise<boolean> => {
    editing = true;
    error = undefined;
    try {
      return await commitPatch(putHttpRoutePatch(input));
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
      const r = await fetch('/api/v1/apply', {
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
      const r = await fetch(`/api/v1/backends/${encodeURIComponent(key)}/drain`, {
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

  const recover = async (): Promise<void> => {
    recovering = true;
    error = undefined;
    try {
      const r = await fetch('/api/v1/recover', { method: 'POST', headers: auth() });
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
    get pools() { return pools; },
    get routes() { return routes; },
    get certs() { return certs; },
    get policies() { return policies; },
    get bindings() { return bindings; },
    get status() { return status; },
    get rendered() { return rendered; },
    get audit() { return audit; },
    get applying() { return applying; },
    get recovering() { return recovering; },
    get editing() { return editing; },
    connect,
    apply,
    recover,
    drain,
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

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
import { viewOfCertificates, type CertificateFact, type CertsView } from '@web/certs-view';
import { pullSse } from '@web/sse-parse';

export type StatusSnap = {
  head?: string;
  pendingApply?: PendingApply[];
  health?: HealthFact[];
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
  let applying = $state(false);
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

  const refreshPools = async (): Promise<void> => {
    const [pr, br] = await Promise.all([
      fetch('/api/v1/pools', { headers: auth() }),
      fetch('/api/v1/backends', { headers: auth() }),
    ]);
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
    if (snap.health !== undefined) health = snap.health;
    await refreshImpact(pickPending(snap.pendingApply ?? []));
    await refreshListeners(view);
    await refreshPools();
    await refreshRoutes();
    await refreshCerts();
  };

  const refreshCerts = async (): Promise<void> => {
    const r = await fetch('/api/v1/certificates', { headers: auth() });
    if (!r.ok) {
      error = `certificates ${r.status}`;
      certs = { rows: [] };
      return;
    }
    certs = viewOfCertificates(asList<CertificateFact>(await r.json()));
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

  const connect = async (): Promise<void> => {
    stop?.();
    error = undefined;
    sessionStorage.setItem(tokenKey, token);
    const ac = new AbortController();
    stop = () => ac.abort();
    const r = await fetch('/api/v1/events', { headers: auth(), signal: ac.signal });
    if (!r.ok || r.body === null) {
      error = r.status === 401 ? '토큰이 거절됐다' : `events ${r.status}`;
      live = false;
      return;
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
      if ((e as { name?: string }).name !== 'AbortError') {
        error = e instanceof Error ? e.message : String(e);
      }
    } finally {
      live = false;
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
    get applying() { return applying; },
    connect,
    apply,
    disconnect() { stop?.(); },
  };
}

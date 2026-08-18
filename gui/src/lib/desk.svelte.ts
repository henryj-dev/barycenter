/**
 * 운영 책상. SSE 를 구독하고, 폴링하지 않는다.
 * Plan·Impact 와 Listeners 가 같은 스트림을 본다 — 연결을 둘로 열지 않는다.
 */
import { pickPending, viewOfImpact, type Impact, type ImpactView, type PendingApply } from '@web/impact-view';
import {
  viewOfListeners, type ListenerFact, type ListenersView,
} from '@web/listeners-view';
import { pullSse } from '@web/sse-parse';

export type StatusSnap = {
  head?: string;
  pendingApply?: PendingApply[];
};

const tokenKey = 'bary.token';

export function createDesk() {
  let token = $state(sessionStorage.getItem(tokenKey) ?? '');
  let live = $state(false);
  let error = $state<string | undefined>();
  let head = $state<string | undefined>();
  let view = $state<ImpactView | undefined>();
  let listeners = $state<ListenersView>({ rows: [] });
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

  const onStatus = async (snap: StatusSnap): Promise<void> => {
    head = snap.head;
    await refreshImpact(pickPending(snap.pendingApply ?? []));
    await refreshListeners(view);
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
    get applying() { return applying; },
    connect,
    apply,
    disconnect() { stop?.(); },
  };
}

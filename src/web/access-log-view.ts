/**
 * 운영 › 액세스 로그 화면의 순수 규칙 (2026-11-22). 화면(`gui/src/lib/ops/AccessLog.svelte`)은 이것을 부르기만 한다.
 *
 * 줄의 모양은 API 가 정한다(`src/control/access-log.ts` 의 `AccessEntry`). 여기서는 그 줄을 **읽기 좋게** 만들 뿐이다 —
 * 없는 값은 `—` 이고, 짓지 않는다.
 */
import type { AccessEntry } from '../control/access-log.js';

export type { AccessEntry };

/** `GET /api/v1/access-log` 의 몸. `state` 가 `ok` 가 아니면 줄이 없다. */
export type AccessLogBody =
  | { state: 'ok'; node?: string; entries: AccessEntry[]; cursor: number; more: boolean; dropped: number; window: { kept: number; from?: string; to?: string } }
  | { state: 'unsupported' | 'unavailable'; reason: string; node?: string };

/** 화면이 거르는 대상. 주소의 `?listener=` 같은 것에서 온다. */
export const ACCESS_TARGETS = ['listener', 'route', 'pool', 'backend'] as const;
export type AccessTarget = (typeof ACCESS_TARGETS)[number];

export const TARGET_LABEL: Readonly<Record<AccessTarget, string>> = {
  listener: '리스너', route: '라우트', pool: '풀', backend: '백엔드',
};

export const STATUS_CLASSES = ['2xx', '3xx', '4xx', '5xx'] as const;

export type AccessQuery = {
  classes: readonly string[];
  target?: { kind: AccessTarget; key: string };
  q: string;
};

/** API 쿼리 문자열. 빈 값은 싣지 않는다. */
export function accessSearch(f: AccessQuery, page: { before?: number; after?: number; limit?: number; format?: 'csv' | 'ndjson' } = {}): string {
  const p = new URLSearchParams();
  if (f.classes.length > 0) p.set('status', f.classes.join(','));
  if (f.target !== undefined) p.set(f.target.kind, f.target.key);
  if (f.q.trim() !== '') p.set('q', f.q.trim());
  if (page.before !== undefined) p.set('before', String(page.before));
  if (page.after !== undefined) p.set('after', String(page.after));
  if (page.limit !== undefined) p.set('limit', String(page.limit));
  if (page.format !== undefined) p.set('format', page.format);
  const s = p.toString();
  return s === '' ? '' : `?${s}`;
}

/** 주소에서 대상 하나를 읽는다. 여럿이면 앞의 것(리스너 · 라우트 · 풀 · 백엔드 순서)이다. */
export function targetOf(params: { get(name: string): string | null }): { kind: AccessTarget; key: string } | undefined {
  for (const kind of ACCESS_TARGETS) {
    const key = params.get(kind);
    if (key !== null && key !== '') return { kind, key };
  }
  return undefined;
}

/** 리소스 화면에서 여는 주소 — 그 대상만 거른 액세스 로그. */
export function accessLogHref(kind: AccessTarget, key: string): string {
  return `/ops/access-log?${kind}=${encodeURIComponent(key)}`;
}

/** 상태의 색. 백엔드가 준 5xx 와 barycenter 가 낸 5xx 는 같은 색이다 — 「누가」 는 `originText` 가 말한다. */
export function statusTone(status: number): 'ok' | 'info' | 'warn' | 'danger' | 'neutral' {
  if (status >= 500) return 'danger';
  if (status >= 400) return 'warn';
  if (status >= 300) return 'info';
  if (status >= 200) return 'ok';
  return 'neutral';
}

/** 「요청」 칸. http 는 메서드 · 호스트 · 경로, stream 은 전송과 SNI. */
export function requestText(e: AccessEntry): string {
  if (e.plane === 'stream') return `${e.transport.toUpperCase()}${e.tls?.sni ? ` · ${e.tls.sni}` : ''}`;
  return `${e.method ?? '—'} ${e.host ?? ''}${e.path ?? ''}`.trim();
}

/** 응답을 누가 냈나. 백엔드를 거쳤으면 백엔드의 상태다. */
export function originText(e: AccessEntry): string {
  if (e.upstreamStatus !== null) {
    return e.upstreamStatus === e.status ? `백엔드가 ${e.status} 로 답했어요` : `백엔드는 ${e.upstreamStatus}, 클라이언트는 ${e.status} 를 받았어요`;
  }
  if (e.upstreamAddr !== null) return '백엔드에 붙었지만 상태를 받지 못했어요';
  return 'barycenter 가 백엔드 없이 답했어요';
}

export function durationText(ms: number | null): string {
  if (ms === null) return '—';
  if (ms < 1) return '<1ms';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}

export function bytesText(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1024 / 1024).toFixed(1)}MB`;
}

/** 「어디로」 칸 — 라우트 → 풀 → 백엔드. 이름을 못 풀었으면 엔진이 고른 주소를 보인다. */
export function pathText(e: AccessEntry): string {
  const parts = [e.route?.key, e.pool, e.backend ?? e.upstreamAddr].filter((x): x is string => x !== null && x !== undefined);
  return parts.length === 0 ? '—' : parts.join(' → ');
}

/** 펼친 줄의 항목. 값이 없으면 `—` 다. */
export function detailItems(e: AccessEntry): { label: string; value: string; mono?: boolean }[] {
  const v = (x: string | number | null | undefined): string => (x === null || x === undefined || x === '' ? '—' : String(x));
  return [
    { label: '시각', value: new Date(e.at).toLocaleString(), mono: true },
    { label: '응답', value: originText(e) },
    { label: '리스너', value: v(e.listener), mono: true },
    { label: '라우트', value: v(e.route?.key), mono: true },
    { label: '풀', value: v(e.pool), mono: true },
    { label: '백엔드', value: e.backend === null ? v(e.upstreamAddr) : `${e.backend}${e.upstreamAddr === null ? '' : ` (${e.upstreamAddr})`}`, mono: true },
    { label: '걸린 시간', value: `${durationText(e.durationMs)} · 연결 ${durationText(e.timing.connectMs)}${e.plane === 'http' ? ` · 첫 응답 ${durationText(e.timing.headerMs)}` : ''}`, mono: true },
    { label: '받은 · 보낸', value: `${bytesText(e.bytesIn)} · ${bytesText(e.bytesOut)}`, mono: true },
    { label: '클라이언트', value: v(e.client), mono: true },
    ...(e.plane === 'http' ? [
      { label: 'X-Forwarded-For', value: v(e.forwardedFor), mono: true },
      { label: 'User-Agent', value: v(e.userAgent), mono: true },
      { label: 'Referer', value: v(e.referer), mono: true },
      { label: '프로토콜', value: v(e.protocol), mono: true },
      { label: '요청 ID', value: v(e.requestId), mono: true },
    ] : []),
    { label: 'TLS', value: e.tls === null ? '—' : `${v(e.tls.sni)}${e.tls.version === null ? '' : ` · ${e.tls.version}`}`, mono: true },
    { label: '노드', value: v(e.node), mono: true },
    { label: '줄 이름', value: e.id, mono: true },
  ];
}

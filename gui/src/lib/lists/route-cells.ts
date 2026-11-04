/**
 * 라우트 한 줄의 칸 — 콘솔 시안 `colsOf('routes')` · `cells('routes', r)` 그대로.
 *
 * 목록(HTTP · 패스스루), 상세 개요(시안 `ovRows` — 열 이름과 칸 글), 상세 머리의 배지(시안 `dpBadge` — 칸 중 첫 배지)가
 * 같은 값을 쓴다. 칸은 `m()`(고정폭) · `x()`(보통 글) · `b()`(배지)이고 링크가 아니다.
 *
 * 시안과 다른 곳(사실이 더 정확한 쪽):
 *   · 「평가 순서」 는 엔진이 실제로 보는 순서다(`route-order.ts`). 시안처럼 리스너마다 우선순위로 세지 않는다.
 *   · 패스스루의 끊기는 「연결을 끊어요」 다 — 패스스루는 응답 코드가 없다(시안 `reject 403`).
 *   · 풀이 외부 주소인지(시안 「(외부)」)는 모델에 없어서 적지 않는다.
 */
import { b, m, x, type Cell } from '../ui/cells.js';

/** 시안 `colsOf('routes')` — HTTP · 패스스루가 같은 열이다. */
export const ROUTE_COLS = ['이름', '리스너', '호스트(SNI)', '경로 접두사', '우선순위', '동작', '출발지 규칙', '요청 헤더', '평가 순서'] as const;

export type RouteAct = {
  kind: string; pool?: string; websocket?: boolean; to?: string; status?: number; rewritePrefix?: string; requestHeaders?: unknown[];
};

/** 칸을 만드는 사실 — 목록의 행이 그대로 이것을 갖는다. */
export type RouteFacts = {
  key: string;
  listener: string;
  /** HTTP 는 호스트, 패스스루는 SNI. */
  hosts: string[];
  /** HTTP 만. 패스스루는 빈 배열(시안 「—」). */
  paths: string[];
  priority: number;
  act: RouteAct;
  rules: number;
  headers: number;
  ord: number | undefined;
  /** 가려졌으면 그 까닭(엔진 경고 문구). */
  shadow: string | undefined;
  pass: boolean;
};

type Obj = Record<string, unknown>;
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
const actOf = (v: unknown): RouteAct => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as RouteAct : { kind: '' });

/** head 의 HTTP 라우트 → 사실. `ord` · `shadow` 는 그 지역의 `routeOrder` 에서 읽는다. */
export function httpRouteFacts(r: Obj, meta: { ord: Map<string, number>; shadow: Map<string, string> }): RouteFacts {
  const key = String(r['key']);
  const act = actOf(r['action']);
  const paths = strs(r['pathPrefixes']).length > 0 ? strs(r['pathPrefixes']) : [typeof r['pathPrefix'] === 'string' ? r['pathPrefix'] : '/'];
  return {
    key, listener: String(r['listener'] ?? ''), hosts: strs(r['hosts']), paths, priority: Number(r['priority'] ?? 0), act,
    rules: Array.isArray(r['sourceRules']) ? r['sourceRules'].length : 0,
    headers: Array.isArray(act.requestHeaders) ? act.requestHeaders.length : 0,
    ord: meta.ord.get(key), shadow: meta.shadow.get(key), pass: false,
  };
}

/** head 의 패스스루 라우트 → 사실. 순서는 SNI 목록의 순서다(`viewOfRoutes`). */
export function passRouteFacts(r: Obj, ord: number | undefined): RouteFacts {
  return {
    key: String(r['key']), listener: String(r['listener'] ?? ''), hosts: strs(r['snis']), paths: [], priority: Number(r['priority'] ?? 0),
    act: actOf(r['action']), rules: 0, headers: 0, ord, shadow: undefined, pass: true,
  };
}

/** 시안 `act` — 프록시 · redirect 는 글, reject 만 ✕ 배지. */
export function actCell(f: RouteFacts): Cell {
  const a = f.act;
  if (a.kind === 'proxy') {
    const rw = a.rewritePrefix === undefined ? '' : ` · ${f.paths.join(', ')} → ${a.rewritePrefix}`;
    return x(`프록시 → ${a.pool ?? ''}${a.websocket === true ? ' · WebSocket' : ''}${rw}`);
  }
  if (a.kind === 'redirect') return x(`redirect → ${a.to ?? ''} · ${a.status ?? ''}`);
  return b('danger', '✕', f.pass ? '연결을 끊어요' : `reject ${a.status ?? ''}`.trim());
}

/** 시안 `pc` — 경로가 여럿이면 첫 경로 + 「+N」, 마우스를 올리면 전부. */
export function pathCell(f: RouteFacts): Cell {
  if (f.pass) return m('—');
  return f.paths.length > 1 ? m(`${f.paths[0]} +${f.paths.length - 1}`, f.paths.join('\n')) : m(f.paths[0]);
}

/** 시안 평가 순서 칸 — 가려졌으면 경고 배지(마우스를 올리면 까닭). */
export function ordCell(f: RouteFacts): Cell {
  return f.shadow !== undefined ? b('warn', '▲', `#${f.ord ?? '—'} · 가려짐`, f.shadow) : m(`#${f.ord ?? '—'}`);
}

/** 시안 `cells('routes', r)` — `ROUTE_COLS` 순서. */
export function routeCells(f: RouteFacts): Cell[] {
  return [
    m(f.key), m(f.listener), m(f.hosts.join(', ')), pathCell(f), m(f.priority), actCell(f),
    f.rules > 0 ? b('info', '↳', `출발지 규칙 ${f.rules}`) : x('—'),
    f.headers > 0 ? b('info', '＋', `헤더 ${f.headers}`) : x('—'),
    ordCell(f),
  ];
}

/** 시안 `dpBadge` — 칸 중 첫 배지. 없으면 undefined. */
export function routeBadge(f: RouteFacts): Extract<Cell, { kind: 'badge' }> | undefined {
  return routeCells(f).find((c): c is Extract<Cell, { kind: 'badge' }> => c.kind === 'badge');
}

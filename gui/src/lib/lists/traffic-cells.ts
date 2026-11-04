/**
 * 트래픽 목록 넷(리스너 · 풀 · 백엔드 · 주소 집합)의 행과 열 — 콘솔 시안 `colsOf(page)` · `cells(page, r)` 그대로.
 *
 * 목록(`lists/*List.svelte`)과 상세 개요(`detail/CellOverview.svelte`, 시안 `ovRows`)가 같은 열을 쓴다 —
 * 시안 개요는 `colsOf(page)` 의 라벨과 `cells(page, sel)` 의 글을 한 칸씩 늘어놓은 것이다.
 * 상세 머리의 상태 배지(시안 `dpBadge`)는 그 칸들 가운데 첫 배지다(`firstBadge`).
 *
 * 값은 이미 받은 것(head 모델 · 헬스 · 상태 API · 적용 대기)만 읽는다. 시안의 값을 API 가 주지 않으면 「—」 다
 * (주소 집합의 「마지막 갱신」, 헬스체크 주기를 안 적은 풀).
 */
import { itemOf, itemsOf, relationsOf } from '@web/resources';
import { trafficMarkOf } from '@web/pools-view';
import type { Column } from '#lib/ui';
import { b, m, x, type Cell } from '#lib/ui/cells.ts';
import type { createDesk } from '#lib/desk.svelte.ts';
import { isPendingResource } from '#lib/pending';
import { HEALTH_MARK, ago, backendHealth, poolMark, sourceAllowSummary, hcText, type HealthKind } from '#lib/detail/facts';
import type { ListenerMark } from '@web/listeners-view';

type Desk = ReturnType<typeof createDesk>;
type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Obj : undefined);

/** 시안 프로토콜 글 — HTTP · HTTPS · TCP · UDP · TLS 패스스루. */
export const PROTOCOL_TEXT: Record<string, string> = {
  http: 'HTTP', https: 'HTTPS', tcp: 'TCP', udp: 'UDP', tls_passthrough: 'TLS 패스스루',
};

// ── 리스너 ───────────────────────────────────────────────────────────────────

export type ListenerRow = {
  key: string; protocol: string; bind: string; action: string; routes: number; src: string;
  mark: ListenerMark; pending: boolean; enabled: boolean; hosts: string; redirect?: number;
};

/** 기본 풀 / 동작 — 시안 `v.behavior === 'reject' ? '거절' : v.pool`. 패스스루는 「SNI 매칭 없음 폴백」 이 기본 동작이다. */
const listenerAction = (l: Obj | undefined): string => {
  if (l === undefined) return '—';
  const p = l['protocol'];
  if (p === 'http' || p === 'https') {
    const da = obj(l['http'])?.['defaultAction'];
    return typeof obj(da)?.['pool'] === 'string' ? String(obj(da)!['pool']) : '거절';
  }
  if (p === 'tls_passthrough') {
    const fb = obj(l['onUnmatchedSni'])?.['pool'];
    return typeof fb === 'string' ? fb : '거절';
  }
  return typeof l['defaultPool'] === 'string' ? l['defaultPool'] : '—';
};

export const listenerRowsOf = (desk: Desk): ListenerRow[] => desk.listeners.rows.map((r) => {
  const l = itemOf(desk.model, 'listener', r.key);
  const routeKind = r.protocol === 'tls_passthrough' ? 'passthroughRoute' : 'httpRoute';
  const hosts = Array.isArray(l?.['hosts']) ? (l['hosts'] as string[]).join(', ') : '';
  return {
    key: r.key, protocol: PROTOCOL_TEXT[r.protocol] ?? r.protocol, bind: `${r.bind}:${r.port}`, action: listenerAction(l),
    routes: r.protocol === 'tcp' || r.protocol === 'udp' ? 0 : itemsOf(desk.model, routeKind).filter((x) => x['listener'] === r.key).length,
    src: sourceAllowSummary(desk.model, r.sourceAllow).text, mark: r.mark,
    pending: isPendingResource(desk.pendingResources, 'listener', r.key), enabled: r.enabled, hosts,
    ...(r.redirect === undefined ? {} : { redirect: r.redirect.port }),
  };
});

/**
 * 상태 — 시안 `r.pend && ok ? ◐ 적용 대기 : ok ? ● 정상 : open ? ◐ 반영대기 : ◑ 반영대기`.
 * 「반영대기(열림)」 은 커밋했지만 소켓을 아직 안 연 리스너다(`join`). 꺼 둔 리스너의 소켓 상태도 head 와 같으면 정상이다 —
 * 켜짐 · 꺼짐은 「활성화」 칸이 말한다(시안).
 */
export const listenerState = (r: Pick<ListenerRow, 'mark' | 'pending'>): Cell =>
  r.mark === 'join' ? b('pending', '◐', '반영대기') : r.pending ? b('pending', '◐', '적용 대기') : b('ok', '●', '정상');

export const listenerColumns = <T extends ListenerRow>(): Column<T>[] => [
  { key: 'key', label: '이름', mono: true, text: (r) => r.key, sort: (r) => r.key, hideable: false },
  { key: 'protocol', label: '프로토콜', value: (r) => x(r.protocol), sort: true },
  { key: 'bind', label: '바인드:포트', value: (r) => m(r.bind, r.redirect === undefined ? undefined : `HTTP :${r.redirect} 로 오면 HTTPS 로 보내요`), sort: true },
  // 시안에 없는 열 — 「컬럼 ▾」 에서 켠다(server_name, ADR-VHOST).
  { key: 'hosts', label: '호스트', value: (r) => m(r.hosts), sort: true, hidden: true },
  { key: 'action', label: '기본 풀 / 동작', value: (r) => m(r.action), sort: true },
  { key: 'routes', label: '라우트', value: (r) => m(String(r.routes)), sort: (r) => r.routes },
  { key: 'src', label: '출발지 제한', value: (r) => x(r.src), sort: true },
  { key: 'state', label: '상태', value: (r) => listenerState(r), sort: true },
  { key: 'enabled', label: '활성화', value: (r) => x(r.enabled ? '● 켜짐' : '○ 꺼짐'), sort: true },
];

// ── 백엔드 ───────────────────────────────────────────────────────────────────

export type BackendRow = {
  key: string; pool: string; host: string; port: string; addr: string; weight: number; health: HealthKind;
  receiving: boolean | undefined; draining: boolean; why: string[]; seen?: string;
};

export const backendRowsOf = (desk: Desk): BackendRow[] => itemsOf(desk.model, 'backend').map((bk) => {
  const key = String(bk['key']);
  const t = desk.traffic.get(key);
  const seen = ago(t?.observedAt);
  return {
    key, pool: String(bk['pool']), host: String(bk['host']), port: String(bk['port']), addr: `${String(bk['host'])}:${String(bk['port'])}`,
    weight: typeof bk['weight'] === 'number' ? bk['weight'] : 1,
    health: backendHealth(desk, key),
    receiving: t?.receivingTraffic, draining: t?.reasons.includes('draining') === true,
    // 이유 코드는 사람 말로 바꾼다(제안 #9) — 드레인은 「드레인」 칸이 따로 말하므로 뺀다.
    why: trafficMarkOf(t === undefined ? undefined : { ...t, reasons: t.reasons.filter((r) => r !== 'draining') })?.reasons ?? [],
    ...(seen === undefined ? {} : { seen }),
  };
});

const healthCell = (h: HealthKind): Cell => { const k = HEALTH_MARK[h]; return b(k.tone, k.icon, k.text); };
/** 트래픽 수신 — 시안 「● 수신 중」 / 「○ 수신 안 함」. 상태 API 를 못 읽었으면 모른다(「—」). 까닭은 마우스를 올리면 보인다. */
const receivingCell = (r: BackendRow): Cell =>
  r.receiving === undefined ? x('—') : r.receiving ? b('ok', '●', '수신 중') : b('neutral', '○', '수신 안 함', r.why.length > 0 ? r.why.join(' · ') : undefined);

export const backendColumns = <T extends BackendRow>(): Column<T>[] => [
  { key: 'key', label: '이름', mono: true, text: (r) => r.key, sort: (r) => r.key, hideable: false },
  { key: 'pool', label: '풀', value: (r) => m(r.pool), sort: true },
  { key: 'addr', label: '호스트:포트', value: (r) => m(r.addr), sort: true },
  { key: 'weight', label: '가중치', value: (r) => m(r.weight), sort: (r) => r.weight },
  { key: 'health', label: '헬스', value: (r) => healthCell(r.health), sort: true },
  { key: 'receiving', label: '트래픽 수신', value: (r) => receivingCell(r), sort: true },
  { key: 'draining', label: '드레인', value: (r) => (r.draining ? b('drain', '⇣', '드레인 중') : x('—')), sort: true },
  { key: 'seen', label: '마지막 관측', value: (r) => x(r.seen), sort: true },
];

// ── 풀 ──────────────────────────────────────────────────────────────────────

export type PoolRow = { key: string; family: string; algo: string; backends: Cell; hc: string; tls: boolean; total: number };

export const poolRowsOf = (desk: Desk): PoolRow[] => desk.pools.rows.map((p) => {
  const pm = itemOf(desk.model, 'pool', p.key);
  const mk = poolMark(desk, p.key);
  return {
    key: p.key, family: p.protocolClass.toUpperCase(), algo: p.algorithm, backends: b(mk.tone, mk.icon, mk.text),
    hc: hcText(pm), tls: obj(pm?.['upstreamTls'])?.['enabled'] === true, total: p.backends.length,
  };
});

export const poolColumns = <T extends PoolRow>(): Column<T>[] => [
  { key: 'key', label: '이름', mono: true, text: (r) => r.key, sort: (r) => r.key, hideable: false },
  { key: 'family', label: '프로토콜 계열', value: (r) => x(r.family), sort: true },
  { key: 'algo', label: '알고리즘', value: (r) => m(r.algo), sort: true },
  { key: 'backends', label: '백엔드(정상 / 전체)', value: (r) => r.backends, sort: true },
  { key: 'hc', label: '헬스체크', value: (r) => m(r.hc), sort: true },
  { key: 'tls', label: '업스트림 TLS', value: (r) => x(r.tls ? '켜짐' : '꺼짐'), sort: true },
];

// ── 주소 집합 ────────────────────────────────────────────────────────────────

export type AddressSetRow = { key: string; count: number; source: string; cloudflare: boolean; listeners: number };

/** 출처 — 시안 「Cloudflare 공개 목록」 · 「직접 입력」. */
export const setSourceText = (s: Obj | undefined): string => (s?.['source'] === 'cloudflare' ? 'Cloudflare 공개 목록' : '직접 입력');

export const addressSetRowsOf = (desk: Desk): AddressSetRow[] => itemsOf(desk.model, 'addressSet').map((s) => {
  const key = String(s['key']);
  // 시안 「사용하는 리스너」 — 출발지 제한 · 신뢰 대역으로 이 집합을 쓰는 리스너 수. 라우트 출발지 규칙은 연결된 리소스 탭이 보인다.
  const listeners = new Set(relationsOf(desk.model, { kind: 'addressSet', key }).usedBy.filter((e) => e.from.kind === 'listener').map((e) => e.from.key)).size;
  return {
    key, count: Array.isArray(s['cidrs']) ? s['cidrs'].length : 0, source: setSourceText(s), cloudflare: s['source'] === 'cloudflare', listeners,
  };
});

export const addressSetColumns = <T extends AddressSetRow>(): Column<T>[] => [
  { key: 'key', label: '이름', mono: true, text: (r) => r.key, sort: (r) => r.key, hideable: false },
  { key: 'count', label: '대역 수', value: (r) => x(`${r.count}개`), sort: (r) => r.count },
  { key: 'source', label: '출처', value: (r) => x(r.source), sort: true },
  // 마지막 갱신 시각은 모델에 없다 — 「—」(지어내지 않는다).
  { key: 'updated', label: '마지막 갱신', value: () => x('—') },
  { key: 'listeners', label: '사용하는 리스너', value: (r) => x(`${r.listeners}개`), sort: (r) => r.listeners },
];

// ── 개요 · 상세 머리 ─────────────────────────────────────────────────────────

/** 열 하나의 칸 — `value` 가 없으면(이름 칸) 고정폭 글. */
export const cellOf = <T>(c: Column<T>, r: T): Cell => (c.value !== undefined ? c.value(r) : m(c.text?.(r) ?? ''));

/** 시안 `ovRows` — 열 라벨과 칸. 「컬럼 ▾」 에서 숨겨 둔 열(시안에 없는 열)은 개요에 안 둔다. */
export const overviewOf = <T>(columns: readonly Column<T>[], r: T): { label: string; cell: Cell }[] =>
  columns.filter((c) => c.hidden !== true).map((c) => ({ label: c.label, cell: cellOf(c, r) }));

/** 시안 `dpBadge` — 칸 가운데 첫 배지. 없으면 undefined. */
export const firstBadge = <T>(columns: readonly Column<T>[], r: T): Extract<Cell, { kind: 'badge' }> | undefined => {
  for (const c of columns) {
    const v = c.value?.(r);
    if (v?.kind === 'badge') return v;
  }
  return undefined;
};

/**
 * **전체 합산** — 전역 화면의 기본은 모든 지역을 합쳐 한 번에 보는 것이다 (2026-11-04 사용자 결정,
 * docs/design-global-mode.md §2.5, 시안 `const agg`). 지역을 고르는 것은 「좁혀 보기」 다.
 *
 * 이 파일은 **순수 함수만** 둔다(룬 · Svelte 없음) — 시험이 바로 부른다(`tests/unit/gui-global-aggregate.test.ts`).
 * 지역마다 붙는 데이터 원본은 `regions.svelte.ts`, 목록이 쓰는 훅은 `use-aggregate.svelte.ts` 다.
 *
 *   - 행 키: 지역이 다르면 같은 이름도 다른 행이다 → `rowId(지역, 키)` · `splitRowId`.
 *   - 합치기: 지역마다 받은 행에 `region` 을 달아 지역 순서대로 잇는다 → `mergeRegionRows`.
 *   - 열: 「지역」 열은 맨 끝이다(시안 `lcols = colsOf(page).concat(glob ? ['지역'] : [])`) → `withRegionColumn`.
 *   - 알림: 행이 빠진 지역은 목록 위에 한 줄씩 → `regionNotices`. 연락 없는 지역의 행은 **지어내지 않는다**(§2.4).
 *   - 주소: 행의 상세 · 수정은 그 지역으로 좁혀 연다 → `inRegion` (셸이 `?region=` 을 읽어 좁힌다).
 *     만들기(`/new`)는 좁히지 않는다 — 합산 목록 위 드로어에서 「쓸 지역」 을 고른다(`FormDrawer`, 시안 `wreg`).
 */

/** 연락 없는 지역의 이름 — 어디서나 이 말 하나다(시안 「○ 연락 없음」, 톤 neutral). `scope.svelte.ts` 가 다시 내보낸다. */
export const LOST_LABEL = '연락 없음';

/** 셸이 읽는 좁혀 보기 주소 인자 — `/traffic/listener/a?region=icn` 은 icn 으로 좁혀 그 상세를 연다. */
export const REGION_PARAM = 'region';

/**
 * 전체 합산으로 그리는 화면(주소 그대로, 목록만). 여기 없는 자리는 합산에서 지역 고르기(`/regions`)로 보낸다 —
 * 아직 지역 하나만 그릴 줄 아는 화면이 빈 화면을 보이지 않게. **화면을 바꾼 에이전트가 여기에 주소를 더한다.**
 */
export const AGGREGATE_PATHS: readonly string[] = ['/traffic/listener', '/traffic/backend',
  '/traffic/pool', '/traffic/address-set', '/traffic/route/http', '/traffic/route/passthrough',
  '/tls/certificate', '/tls/policy', '/tls/sni',
  // 운영 화면 — 대시보드 · 상태 · 적용 대기 · 기록 · 렌더된 설정(지역을 그 자리에서 고른다).
  '/', '/ops/status', '/change/pending', '/ops/audit', '/ops/rendered',
];

/**
 * 이 주소가 합산 화면인가. 끝의 `/` 는 무시한다. 목록과 그 목록의 만들기(`<목록>/new`, `<목록>/new/<단계>`)다 —
 * 만들기는 합산 목록 위에 드로어를 연다(`FormDrawer` 의 「쓸 지역」). 상세(`/traffic/listener/<key>`)는 아니다.
 */
export const isAggregatePath = (pathname: string): boolean => {
  const p = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  return AGGREGATE_PATHS.includes(p) || isAggregateCreatePath(p);
};

/** 합산 목록의 만들기 주소인가 — `<목록>/new` 또는 `<목록>/new/<단계>`(리스너 프로토콜 · 빠른 프록시 · 경로별 묶음). */
export const isAggregateCreatePath = (pathname: string): boolean =>
  AGGREGATE_PATHS.some((p) => p !== '/' && /^\/new(\/[^/]+)?\/?$/.test(pathname.startsWith(p) ? pathname.slice(p.length) : '-'));

/**
 * 합산인데 이 주소를 못 그린다 — 어디로 보낼까. 합산 목록의 상세 주소면 그 목록으로(「◎ 전역」 을 눌러 돌아올 때),
 * 아니면 지역 고르기.
 */
export const aggregateFallback = (pathname: string): string =>
  AGGREGATE_PATHS.find((p) => pathname.startsWith(`${p}/`)) ?? '/regions';

/** 지역 하나의 지금 상태 — 사이드바 · 알림 · 쓰기 판정이 이것 하나를 본다. */
export type RegionState = 'ok' | 'loading' | 'lost' | 'rejected';

/**
 * 지역의 상태를 고른다.
 *
 *   요약이 인증 거절(`auth: 'rejected'`)          → rejected
 *   요약이 못 닿음 · 중계가 못 닿았다고 답함(`lost`) → lost
 *   스트림이 붙어 있음(`live`, 짧은 끊김 유예 포함)  → ok
 *   붙었다가 끊김(head 있음) · 오류                  → lost — 마지막 값을 지금 값처럼 보이지 않는다(§2.4)
 *   아직 한 번도 안 붙음                             → loading
 */
export function regionStateOf(o: {
  reachable: boolean; auth?: string | undefined; lost: boolean; live: boolean; head?: string | undefined; error?: string | undefined;
}): RegionState {
  if (o.auth === 'rejected') return 'rejected';
  if (!o.reachable || o.lost) return 'lost';
  if (o.live) return 'ok';
  if (o.head !== undefined || o.error !== undefined) return 'lost';
  return 'loading';
}

/** 지역마다 다른 행 키. 지역 이름을 인코딩하므로 첫 `/` 가 경계다 — 키에 `/` 가 있어도 갈린다. */
export const rowId = (region: string, key: string): string => `${encodeURIComponent(region)}/${key}`;

/** `rowId` 를 되돌린다. 합산 행 키가 아니면(지역 인스턴스 · 좁혀 보기) undefined. */
export function splitRowId(id: string): { region: string; key: string } | undefined {
  const i = id.indexOf('/');
  if (i <= 0) return undefined;
  try { return { region: decodeURIComponent(id.slice(0, i)), key: id.slice(i + 1) }; } catch { return undefined; }
}

/** 합산 행 — 원래 행에 지역 이름과 지역마다 다른 키(`rid`)를 단다. */
export type RegionRow<T> = T & { region: string; rid: string };

/**
 * 지역마다 받은 행을 하나로 잇는다 — 지역 순서대로, 지역 안에서는 받은 순서대로(시안 `[].concat(...regions.map(…))`).
 * `ok` 가 아닌 지역은 넘기지 않는다(부르는 쪽이 거른다) — 여기서는 받은 것만 잇는다.
 */
export function mergeRegionRows<T>(parts: readonly { region: string; rows: readonly T[] }[], key: (row: T) => string): RegionRow<T>[] {
  return parts.flatMap((p) => p.rows.map((r) => ({ ...r, region: p.region, rid: rowId(p.region, key(r)) })));
}

/**
 * 「지역」 열을 맨 끝에 붙인다 — 시안 콘솔 목록 `lcols = colsOf(page).concat(glob ? ['지역'] : [])`,
 * 칸은 `cells(page, r).concat(glob ? [{ t: r.reg, mono: true }] : [])`. 받은 배열은 바꾸지 않는다.
 */
export function withRegionColumn<C>(columns: readonly C[], region: C): C[] {
  return [...columns, region];
}

/** 목록 위 알림 한 줄. `region` 은 지역 이름. */
export type RegionNotice = { region: string; state: Exclude<RegionState, 'ok'>; icon: string; text: string };

/**
 * 행이 빠졌거나 아직 안 온 지역마다 한 줄(시안 「○ <지역> 연락 없음 — 이 지역의 행은 빠졌어요」).
 * 모두 `ok` 면 빈 배열이다.
 */
export function regionNotices(regions: readonly { name: string; state: RegionState }[]): RegionNotice[] {
  return regions.flatMap((r): RegionNotice[] => {
    if (r.state === 'lost') return [{ region: r.name, state: 'lost', icon: '○', text: `${r.name} ${LOST_LABEL} — 이 지역의 행은 빠졌어요` }];
    if (r.state === 'rejected') return [{ region: r.name, state: 'rejected', icon: '✕', text: `${r.name} 인증 거절 — 이 지역의 행은 빠졌어요` }];
    if (r.state === 'loading') return [{ region: r.name, state: 'loading', icon: '↻', text: `${r.name} 불러오는 중 — 이 지역의 행은 곧 들어와요` }];
    return [];
  });
}

/**
 * 합산 목록의 불러오기 상태 — `DataTable` 의 `loading` · `error` (`lists/list-state.ts` 의 합산판).
 * 한 지역이라도 행을 줬으면 목록을 그린다(빠진 지역은 알림이 말한다). 아무도 안 줬으면: 오는 중인 지역이 있으면 불러오는 중,
 * 지역이 없거나 모두 빠졌으면 오류 한 줄.
 */
export function aggregateListState(regions: readonly { state: RegionState }[]): { loading: boolean; error?: string } {
  if (regions.some((r) => r.state === 'ok')) return { loading: false };
  if (regions.some((r) => r.state === 'loading')) return { loading: true };
  return { loading: false, error: regions.length === 0 ? '지역이 없어요.' : '어느 지역과도 연결되지 않았어요. 지역 화면에서 상태를 봐요.' };
}

/**
 * 이 화면 주소를 그 지역으로 좁혀 연다 — `?region=<이름>` 을 단다(있던 인자는 둔다, 해시는 끝에).
 * 셸(`routes/+layout.svelte`)이 읽어 그 지역으로 좁히고 인자를 지운다. 새 탭으로 열어도 같은 지역이다.
 */
export function inRegion(href: string, region: string): string {
  const hash = href.indexOf('#');
  const [base, frag] = hash < 0 ? [href, ''] : [href.slice(0, hash), href.slice(hash)];
  const q = new URLSearchParams(base.includes('?') ? base.slice(base.indexOf('?') + 1) : '');
  q.set(REGION_PARAM, region);
  return `${base.includes('?') ? base.slice(0, base.indexOf('?')) : base}?${q.toString()}${frag}`;
}

/**
 * **운영 화면의 전체 합산** — 대시보드 · 상태 · 적용 대기 · 기록 (2026-11-04 사용자 결정, docs/design-global-mode.md §2.5).
 *
 * 순수 함수만 둔다(룬 · Svelte 없음) — 시험이 바로 부른다(`tests/unit/gui-global-aggregate-ops.test.ts`).
 * 화면은 지역마다 붙은 desk(`useAggregate().entries`)에서 값을 읽어 여기에 넘긴다.
 *
 *   - 지역 상태 배지: 붙지 않은 지역은 「모른다」 다 — 0 으로 세지 않는다(§2.4) → `regionBadge`.
 *   - 합계: 붙은(`ok`) 지역만 더한다. 빠진 지역은 합계 위에 한 줄씩 알린다 → `sumTally` · `tallyNotices`.
 *   - 기록: 지역마다 받은 묶음을 시각 순서(새것부터)로 하나로 잇는다 → `mergeByTime`.
 *   - 적용 대기: 지역마다 한 항목(시안 `groupsOf`). 고른 지역은 언제나 남긴다 → `pendingRow` · `pendingShown` · `pendingDefault`.
 */
import { LOST_LABEL, mergeRegionRows, regionNotices, type RegionNotice, type RegionRow, type RegionState } from '../global/aggregate';

export type BadgeTone = 'ok' | 'pending' | 'warn' | 'danger' | 'neutral' | 'info';
export type RegionBadge = { tone: BadgeTone; icon: string; text: string };

/** 지역 하나의 상태 배지. `ok` 는 부르는 쪽이 자기 판정(미완 전환 · 비정상)으로 덮는다. */
export function regionBadge(state: RegionState): RegionBadge {
  if (state === 'lost') return { tone: 'neutral', icon: '○', text: LOST_LABEL };
  if (state === 'rejected') return { tone: 'danger', icon: '✕', text: '인증 거절' };
  if (state === 'loading') return { tone: 'info', icon: '↻', text: '불러오는 중' };
  return { tone: 'ok', icon: '●', text: '정상' };
}

/** 합계 위 알림 — 목록의 「행은 빠졌어요」 대신 「합계에서 빠졌어요」. 모두 붙어 있으면 빈 배열. */
export function tallyNotices(regions: readonly { name: string; state: RegionState }[]): RegionNotice[] {
  return regionNotices(regions).map((n) => ({
    ...n,
    text: n.state === 'loading' ? `${n.region} 불러오는 중 — 곧 합계에 들어와요`
      : `${n.region} ${n.state === 'lost' ? LOST_LABEL : '인증 거절'} — 합계에서 빠졌어요`,
  }));
}

/** 지역 하나의 대시보드 숫자. 인증서는 가장 가까운 만료 하나(자료 없음이 먼저)를 든다. */
export type Tally = {
  listeners: number; serving: number; joining: number;
  backends: number; healthy: number; unhealthy: number; drained: number; idle: number;
  certSoon: number; nearest?: { key: string; region?: string; hasMaterial: boolean; days?: number };
  pending: number; unfinished: boolean;
};

/** 인증서 만료가 더 가까운 쪽이 작다 — 자료 없음이 가장 앞이다. */
export const certOrder = (c: { hasMaterial: boolean; days?: number | undefined }): number => (c.hasMaterial ? c.days ?? 0 : -Infinity);

/** 붙은 지역의 숫자를 더한다. 가장 가까운 인증서는 지역을 달아 하나만 남긴다. */
export function sumTally(parts: readonly { region: string; tally: Tally }[]): Tally & { regions: number; unfinishedIn: string[] } {
  const zero: Tally = { listeners: 0, serving: 0, joining: 0, backends: 0, healthy: 0, unhealthy: 0, drained: 0, idle: 0, certSoon: 0, pending: 0, unfinished: false };
  let nearest: Tally['nearest'];
  const sum = parts.reduce((a, { region, tally: t }) => {
    if (t.nearest !== undefined && (nearest === undefined || certOrder(t.nearest) < certOrder(nearest))) nearest = { ...t.nearest, region };
    return {
      listeners: a.listeners + t.listeners, serving: a.serving + t.serving, joining: a.joining + t.joining,
      backends: a.backends + t.backends, healthy: a.healthy + t.healthy, unhealthy: a.unhealthy + t.unhealthy,
      drained: a.drained + t.drained, idle: a.idle + t.idle, certSoon: a.certSoon + t.certSoon,
      pending: a.pending + t.pending, unfinished: a.unfinished || t.unfinished,
    };
  }, zero);
  return { ...sum, ...(nearest === undefined ? {} : { nearest }), regions: parts.length, unfinishedIn: parts.filter((p) => p.tally.unfinished).map((p) => p.region) };
}

const ms = (s: string | undefined): number => { const n = s === undefined ? NaN : new Date(s).getTime(); return Number.isNaN(n) ? -Infinity : n; };

/**
 * 지역마다 받은 줄을 시각 순서(새것부터)로 잇는다. 시각이 같으면 지역 순서 · 받은 순서를 지킨다(안정 정렬).
 * 시각이 없는 줄은 끝이다. 행마다 `region` · `rid` 가 붙는다(`mergeRegionRows`).
 */
export function mergeByTime<T>(parts: readonly { region: string; rows: readonly T[] }[], key: (row: T) => string, at: (row: T) => string | undefined): RegionRow<T>[] {
  return mergeRegionRows(parts, key).map((r, i) => ({ r, i, t: ms(at(r)) })).sort((a, b) => (b.t - a.t) || (a.i - b.i)).map((x) => x.r);
}

/** 적용 대기 화면 왼쪽의 항목 한 줄 — `PendingImpact` 의 `plans` 로 넘긴다. */
export type PlanRow = {
  name: string; head?: string; by: string; title: string; tone: BadgeTone; text: string; lost: boolean;
  /** 그 지역의 지금 값을 안다(붙어 있다). 거짓이면 영향 · 적용을 그리지 않고 `title` 한 줄만 쓴다 — 지난 값을 지금 값처럼 보이지 않는다. */
  known: boolean;
};

/** 지역 하나의 적용 대기 사실. `state` 가 `ok` 가 아니면 나머지는 보지 않는다(모른다). */
export type PendingFact = {
  name: string; state: RegionState;
  head?: string | undefined; view?: { revision: string } | undefined;
  pending: readonly string[]; failed?: { revision: string } | undefined; by?: string;
};

/**
 * 항목 한 줄을 만든다(시안 `planList`). 붙지 않은 지역은 「모른다」 — 적용 대기를 0 으로 쓰지 않는다.
 * @param lostMessage 연락 없는 지역의 한 줄(`scope.svelte.ts` 의 `LOST_MESSAGE`). 순수 모듈이라 받아 쓴다.
 */
export function pendingRow(f: PendingFact, lostMessage: string): PlanRow {
  if (f.state !== 'ok') {
    const b = regionBadge(f.state);
    const title = f.state === 'lost' ? lostMessage : f.state === 'rejected' ? '이 지역이 인증을 거절했어요.' : '이 지역을 불러오는 중이에요.';
    return { name: f.name, by: '', title, tone: b.tone, text: b.text, lost: f.state === 'lost', known: false };
  }
  const revs = [...f.pending].sort((a, b) => Number(a) - Number(b)).map((r) => `r${r}`);
  const head = f.head === undefined ? {} : { head: f.head };
  if (f.view !== undefined) {
    return { name: f.name, ...head, by: f.by ?? '', title: `r${f.view.revision} 적용 — 커밋 ${revs.length}건 포함${revs.length > 0 ? ` (${revs.join(', ')})` : ''}`, tone: 'pending', text: '적용 대기', lost: false, known: true };
  }
  if (f.failed !== undefined) return { name: f.name, ...head, by: '', title: `r${f.failed.revision} 적용이 실패했어요`, tone: 'danger', text: '적용 실패', lost: false, known: true };
  return { name: f.name, ...head, by: '', title: '적용할 변경이 없어요.', tone: 'ok', text: '최신', lost: false, known: true };
}

/** 할 일이 있는 지역 — 적용 대기 · 적용 실패 · 모름(연락 없음 · 인증 거절 · 불러오는 중). */
const hasWork = (f: PendingFact): boolean => f.state !== 'ok' || f.view !== undefined || f.pending.length > 0 || f.failed !== undefined;

/** 왼쪽에 보일 지역 — 할 일이 있는 지역과, 고른 지역(적용한 뒤 결과를 보도록 남긴다). 지역 순서 그대로. */
export const pendingShown = (facts: readonly PendingFact[], picked: string | undefined): PendingFact[] =>
  facts.filter((f) => f.name === picked || hasWork(f));

/** 처음 고를 지역 — 적용 대기가 있는 붙은 지역, 없으면 적용 실패, 없으면 붙은 첫 지역, 없으면 첫 지역. */
export function pendingDefault(facts: readonly PendingFact[]): string | undefined {
  const ok = facts.filter((f) => f.state === 'ok');
  return (ok.find((f) => f.view !== undefined || f.pending.length > 0) ?? ok.find((f) => f.failed !== undefined) ?? ok[0] ?? facts[0])?.name;
}

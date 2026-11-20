/**
 * 트래픽 통계 화면이 읽는 모양과 숫자 표기 (2026-11-20).
 *
 * API(`GET /api/v1/traffic` · `/traffic/:kind/:id`)의 본문을 그대로 받는다. 화면은 여기 있는 함수로만 숫자를 쓴다.
 */

export type TrafficKind = 'listener' | 'httpRoute' | 'passthroughRoute' | 'pool' | 'backend';

export type TrafficPoint = {
  at: string;
  rps: number;
  status: { s1: number; s2: number; s3: number; s4: number; s5: number };
  bytesInPerS: number;
  bytesOutPerS: number;
  avgMs?: number;
};

export type TrafficWindow = { from?: string; to?: string; samples: number };

export type TrafficSummaryRow = {
  kind: TrafficKind;
  key: string;
  last?: TrafficPoint;
  window: { requests: number; errors5xx: number; bytesIn: number; bytesOut: number; avgMs?: number };
};

/** 숫자가 없는 두 상태. 이유를 그대로 보인다. */
export type TrafficOff = { state: 'unsupported' | 'unavailable'; reason: string; node?: string };

export type TrafficSeriesBody =
  | TrafficOff
  | { state: 'ok'; node?: string; intervalS: number; window: TrafficWindow; kind: TrafficKind; key: string; points: TrafficPoint[] };

export type TrafficSummaryBody =
  | TrafficOff
  | { state: 'ok'; node?: string; intervalS: number; window: TrafficWindow; rows: TrafficSummaryRow[] };

/** stream 은 연결을 센다. 단위 이름이 종류마다 다르다. */
export const unitOf = (stream: boolean): string => (stream ? '연결' : '요청');

const trim = (x: number): string => {
  if (x === 0) return '0';
  if (x >= 100) return Math.round(x).toLocaleString('ko-KR');
  if (x >= 10) return x.toFixed(1).replace(/\.0$/, '');
  return x.toFixed(2).replace(/0$/, '').replace(/\.0$/, '');
};

/** 초당 수 — `12.5/s`. */
export const rateText = (x: number): string => `${trim(x)}/s`;

/** 바이트 — 1024 단위. `perSecond` 면 `/s` 를 붙인다. */
export function bytesText(x: number, perSecond = false): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = x;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${trim(v)} ${units[i]}${perSecond ? '/s' : ''}`;
}

/** 걸린 시간 — 1 초가 넘으면 초로. */
export const msText = (x: number): string => (x >= 1000 ? `${trim(x / 1000)} s` : `${trim(x)} ms`);

/** 큰 수 — 천 단위 쉼표. */
export const countText = (x: number): string => Math.round(x).toLocaleString('ko-KR');

/**
 * 축의 위 끝 — 1 · 2 · 5 × 10ⁿ 중 값보다 크거나 같은 가장 작은 것. 값이 없으면 1.
 * 눈금 다섯을 함께 낸다(0 포함).
 */
export function niceScale(max: number): { top: number; ticks: number[] } {
  if (!(max > 0) || !Number.isFinite(max)) return { top: 1, ticks: [0, 0.25, 0.5, 0.75, 1] };
  const exp = Math.floor(Math.log10(max));
  const base = 10 ** exp;
  const step = [1, 2, 2.5, 5, 10].find((m) => m * base >= max) ?? 10;
  const top = step * base;
  return { top, ticks: [0, 1, 2, 3, 4].map((i) => (top * i) / 4) };
}

/** `unsupported` · `unavailable` 의 제목. */
export const OFF_TITLE: Record<TrafficOff['state'], string> = {
  unsupported: '이 엔진은 트래픽을 세지 않아요',
  unavailable: '트래픽 카운터를 읽지 못했어요',
};

/** 창의 길이 — `지난 12분` 처럼. 표본이 둘 미만이면 없다. */
export function windowText(w: TrafficWindow): string | undefined {
  if (w.samples < 2 || w.from === undefined || w.to === undefined) return undefined;
  const min = Math.round((Date.parse(w.to) - Date.parse(w.from)) / 60_000);
  return min < 1 ? '지난 1분 안' : `지난 ${min}분`;
}

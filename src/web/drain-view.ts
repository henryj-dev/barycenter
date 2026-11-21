/**
 * 드레인 진행을 화면 말로 (2026-11-21). 백엔드 상세의 「드레인 진행」 과 백엔드 목록의 「드레인」 칸이 같은 말을 한다.
 *
 * 서버가 주는 것: `drain_condition`(새 연결 막음 · 다 빠짐 · 기한 넘김), 엔진이 알릴 때만 진행 중 연결 · 세션 수,
 * 그리고 누가 · 언제 걸었고 기한이 언제인가. **기한은 관측이다** — 지나도 드레인은 그대로다(§4.4). 숫자가 없으면
 * 「모름」 이다 — 0 으로 채우지 않는다(0 이면 「다 빠졌다」 로 읽힌다).
 */

export type DrainCondition = 'no_new_traffic' | 'quiesced' | 'deadline_exceeded';
export type DrainTone = 'ok' | 'warn' | 'drain';

export const DRAIN_CONDITION_MARK: Readonly<Record<DrainCondition, { tone: DrainTone; icon: string; text: string }>> = {
  no_new_traffic: { tone: 'drain', icon: '⇣', text: '새 연결을 막았어요' },
  quiesced: { tone: 'ok', icon: '●', text: '다 빠졌어요 — 빼도 돼요' },
  deadline_exceeded: { tone: 'warn', icon: '▲', text: '기한을 넘겼어요 — 연결이 남아 있어요' },
};

/** 드레인을 걸 때 고르는 기한. 값은 초다. `0` 은 「기한 없음」 이다. */
export const DRAIN_DEADLINES: readonly { value: number; label: string }[] = [
  { value: 0, label: '기한 없음' },
  { value: 300, label: '5분' },
  { value: 900, label: '15분' },
  { value: 3600, label: '1시간' },
  { value: 14_400, label: '4시간' },
];

/** 기한까지 남은 시간 또는 지난 시간. */
export function deadlineText(deadlineAt: string | undefined, now = Date.now()): string {
  if (deadlineAt === undefined) return '없음';
  const t = Date.parse(deadlineAt);
  if (Number.isNaN(t)) return deadlineAt;
  const s = Math.round((t - now) / 1000);
  const span = (x: number): string => (x < 60 ? `${x}초` : x < 3600 ? `${Math.floor(x / 60)}분` : `${Math.floor(x / 3600)}시간 ${Math.floor((x % 3600) / 60)}분`);
  return s >= 0 ? `${span(s)} 남음` : `${span(-s)} 지남`;
}

export type DrainStatusBody = {
  drain_condition: DrainCondition;
  inflight?: number;
  active_sessions?: number;
  started_at?: string;
  started_by?: string;
  deadline_at?: string;
};

/** 「드레인 진행」 의 줄들. 숫자가 없으면 「모름」 이라고 말한다. */
export function drainLines(s: DrainStatusBody, now = Date.now()): { label: string; value: string; tone?: DrainTone }[] {
  const m = DRAIN_CONDITION_MARK[s.drain_condition];
  const count = (n: number | undefined): string => (n === undefined ? '모름 — 엔진이 알리지 않아요' : String(n));
  return [
    { label: '진행', value: `${m.icon} ${m.text}`, tone: m.tone },
    { label: '진행 중 요청', value: count(s.inflight) },
    { label: '열린 세션', value: count(s.active_sessions) },
    { label: '건 사람', value: s.started_by ?? '—' },
    { label: '건 시각', value: s.started_at === undefined ? '—' : new Date(s.started_at).toLocaleString() },
    { label: '기한', value: deadlineText(s.deadline_at, now), ...(s.drain_condition === 'deadline_exceeded' ? { tone: 'warn' as const } : {}) },
  ];
}

/** 목록의 「드레인」 칸 — 기한을 넘긴 드레인은 경고 색이다. */
export function drainCell(drain: { deadlineAt?: string; deadlineExceeded: boolean } | undefined): { tone: DrainTone; icon: string; text: string } {
  if (drain?.deadlineExceeded === true) return { tone: 'warn', icon: '▲', text: '기한 넘김' };
  return { tone: 'drain', icon: '⇣', text: drain?.deadlineAt === undefined ? '드레인 중' : '드레인 중 · 기한' };
}

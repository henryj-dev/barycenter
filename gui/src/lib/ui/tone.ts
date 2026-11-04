/** 의미 톤 — 토큰의 전경·배경 쌍과 1:1 이다(`--ok` / `--ok-bg` …). `accent` 는 리더(★) 같은 강조다. */
export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'pending' | 'drain' | 'accent';
/** 시안의 기본 아이콘. 같은 톤이라도 뜻이 다르면(적용하면 열림 ◐ / 닫힘 ◑) `icon` 으로 바꾼다. */
export const TONE_ICON: Record<Tone, string> = {
  ok: '●', danger: '✕', info: '↻', neutral: '○', drain: '⇣', pending: '◐', warn: '▲', accent: '★',
};

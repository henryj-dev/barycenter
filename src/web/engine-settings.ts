/**
 * 엔진 전역 설정 폼 (2026-11-20) — GUI 「엔진 설정」 화면(`/ops/engine`)과 그 테스트가 같이 쓴다.
 *
 * 모델 `EngineSettings` 의 세 칸만 다룬다. 범위는 해독기(`decodeEngineSettings`)와 같다. 기본값은 렌더러가 쓰는 값이다 —
 * 칸을 비우면 몸체에서 빠지고 렌더러가 기본을 낸다. 쓰기는 다른 리소스처럼 changeset 의 `put engine` 이다.
 */

export const ENGINE_LIMITS = {
  workerShutdownTimeoutS: { min: 1, max: 86_400 },
  membershipDictKb: { min: 64, max: 1_048_576, def: 1024 },
  acmeDictKb: { min: 32, max: 1_048_576, def: 64 },
} as const;

export type EngineForm = { shutdown: string; membership: string; acme: string };
export type EngineBody = { workerShutdownTimeoutS?: number; membershipDictKb?: number; acmeDictKb?: number };

const numText = (v: unknown): string => (typeof v === 'number' && Number.isFinite(v) ? String(v) : '');

/** 모델(없으면 빈 객체) → 폼 값. */
export function engineFormOf(settings: unknown): EngineForm {
  const s = (typeof settings === 'object' && settings !== null ? settings : {}) as Record<string, unknown>;
  return { shutdown: numText(s['workerShutdownTimeoutS']), membership: numText(s['membershipDictKb']), acme: numText(s['acmeDictKb']) };
}

const rangeError = (v: string, min: number, max: number, unit: string): string | undefined => {
  const t = v.trim();
  if (t === '') return undefined;
  const n = Number(t);
  return Number.isInteger(n) && n >= min && n <= max ? undefined : `${min}–${max} 사이의 정수(${unit})예요.`;
};

/** 칸마다 오류. 비운 칸은 오류가 아니다(기본값). */
export function engineErrors(f: EngineForm): { shutdown?: string; membership?: string; acme?: string } {
  const L = ENGINE_LIMITS;
  const shutdown = rangeError(f.shutdown, L.workerShutdownTimeoutS.min, L.workerShutdownTimeoutS.max, '초');
  const membership = rangeError(f.membership, L.membershipDictKb.min, L.membershipDictKb.max, 'KB');
  const acme = rangeError(f.acme, L.acmeDictKb.min, L.acmeDictKb.max, 'KB');
  return {
    ...(shutdown === undefined ? {} : { shutdown }),
    ...(membership === undefined ? {} : { membership }),
    ...(acme === undefined ? {} : { acme }),
  };
}

/** 폼 값 → `put engine` 의 몸체. 비운 칸은 싣지 않는다 — 렌더러가 기본값을 낸다. */
export function engineBody(f: EngineForm): EngineBody {
  const n = (v: string): number | undefined => (v.trim() === '' ? undefined : Number(v.trim()));
  const shutdown = n(f.shutdown);
  const membership = n(f.membership);
  const acme = n(f.acme);
  return {
    ...(shutdown === undefined ? {} : { workerShutdownTimeoutS: shutdown }),
    ...(membership === undefined ? {} : { membershipDictKb: membership }),
    ...(acme === undefined ? {} : { acmeDictKb: acme }),
  };
}

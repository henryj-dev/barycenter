/**
 * TLS 정책 폼(만들기 드로어 · 분할 인라인 · 설정 탭)이 같이 쓰는 선택지와 몸체 — 콘솔 시안 `fieldsFor('tlspol')`.
 *
 * 시안의 선택지(`TLS 1.2` · `TLS 1.3`, `modern-2026` · `intermediate-2026`, 거절 · 허용)에 모델에만 있는 값을 더한다:
 * 최대 버전 「제한 없음」(안 적으면 위를 막지 않는다 — 모델 기본). 몸체는 모델 기본과 같은 칸을 싣지 않는다.
 */
import type { TlsVersion } from '../../../../src/web/edit.js';
import type { Item } from '../../../../src/web/resources.js';

export type MaxVersion = TlsVersion | 'none';
export type Cipher = 'modern-2026' | 'intermediate-2026';
export type Mismatch = 'allow' | 'reject_421';

export const VERSIONS: { value: TlsVersion; label: string }[] = [{ value: '1.2', label: 'TLS 1.2' }, { value: '1.3', label: 'TLS 1.3' }];
export const MAX_VERSIONS: { value: MaxVersion; label: string }[] = [...VERSIONS, { value: 'none', label: '제한 없음' }];
export const CIPHERS: { value: Cipher; label: string }[] = [{ value: 'modern-2026', label: 'modern-2026' }, { value: 'intermediate-2026', label: 'intermediate-2026' }];
export const MISMATCH: { value: Mismatch; label: string }[] = [{ value: 'reject_421', label: '거절' }, { value: 'allow', label: '허용' }];
/** 해독기의 상한(2년). 되돌릴 수 없는 설정에서 오타는 비싸다. */
export const HSTS_MAX = 63_072_000;

export type PolicyForm = {
  min: TlsVersion; max: MaxVersion; cipher: Cipher; mismatch: Mismatch;
  hsts: boolean; maxAge: string | number; subdomains: boolean;
  /** 브라우저 preload 목록에 올려도 된다는 표시. max-age 1년 이상 · 하위 도메인 켜짐이 필요하다(`invalid_hsts`). */
  preload: boolean;
};

/** preload 가 요구하는 최소 max-age(1년). 해독기 · 검증기와 같은 값이다. */
export const PRELOAD_MIN_AGE = 31_536_000;

/** head 의 정책 → 폼 값. */
export const policyForm = (p: Item | undefined): PolicyForm => {
  const h = p?.['hsts'] as { maxAgeSeconds?: number; includeSubdomains?: boolean; preload?: boolean } | undefined;
  return {
    min: p?.['minVersion'] === '1.3' ? '1.3' : '1.2',
    max: p?.['maxVersion'] === '1.2' || p?.['maxVersion'] === '1.3' ? p['maxVersion'] : 'none',
    cipher: p?.['cipherPolicy'] === 'modern-2026' ? 'modern-2026' : 'intermediate-2026',
    mismatch: p?.['sniHostMismatch'] === 'reject_421' ? 'reject_421' : 'allow',
    hsts: h !== undefined,
    maxAge: String(h?.maxAgeSeconds ?? 31_536_000),
    subdomains: h?.includeSubdomains === true,
    preload: h?.preload === true,
  };
};

export const rangeError = (f: Pick<PolicyForm, 'min' | 'max'>): string | undefined =>
  (f.max !== 'none' && f.max < f.min ? '최대 버전이 최소 버전보다 낮아요.' : undefined);

/** 시안 「초 단위 정수를 입력해요.」 + 해독기 상한. */
export const ageError = (f: Pick<PolicyForm, 'hsts' | 'maxAge'>): string | undefined => (!f.hsts ? undefined
  : !/^\d+$/.test(String(f.maxAge).trim()) ? '초 단위 정수를 입력해요.'
  : Number(f.maxAge) > HSTS_MAX ? `${HSTS_MAX}초(2년)까지예요.` : undefined);

/** preload 의 조건 — max-age 1년 이상과 하위 도메인. */
export const preloadError = (f: Pick<PolicyForm, 'hsts' | 'maxAge' | 'preload' | 'subdomains'>): string | undefined => (!f.hsts || !f.preload ? undefined
  : !f.subdomains ? 'preload 는 하위 도메인을 켜야 해요.'
  : Number(f.maxAge) < PRELOAD_MIN_AGE ? `preload 는 max-age 가 ${PRELOAD_MIN_AGE}초(1년) 이상이어야 해요.` : undefined);

/**
 * 폼 값 → 모델 몸체(키 뺌). `base` 는 head 의 정책 — 폼에 없는 칸은 그대로 둔다.
 * 기본값과 같은 칸은 싣지 않는다(최대 버전 제한 없음 · intermediate · 허용 · HSTS 꺼짐).
 */
export const policyBody = (f: PolicyForm, base?: Item): Record<string, unknown> => {
  const { key: _k, minVersion: _a, maxVersion: _b, cipherPolicy: _c, sniHostMismatch: _d, hsts: oldHsts, ...rest } = base ?? {};
  const keepHsts = (oldHsts ?? {}) as Record<string, unknown>;
  const { maxAgeSeconds: _m, includeSubdomains: _s, preload: _p, ...hstsRest } = keepHsts;
  return {
    ...rest,
    minVersion: f.min,
    ...(f.max === 'none' ? {} : { maxVersion: f.max }),
    ...(f.cipher === 'intermediate-2026' ? {} : { cipherPolicy: f.cipher }),
    ...(f.mismatch === 'allow' ? {} : { sniHostMismatch: f.mismatch }),
    ...(f.hsts ? { hsts: { ...hstsRest, maxAgeSeconds: Number(f.maxAge), ...(f.subdomains ? { includeSubdomains: true } : {}), ...(f.preload ? { preload: true } : {}) } } : {}),
  };
};

// ── SNI 바인딩의 TLS 버전 덮어쓰기 (2026-11-20) ──────────────────────────────

/** TLS 버전 덮어쓰기 — 빈 값은 「정책을 따라요」. */
export type OverrideText = { min: '' | '1.2' | '1.3'; max: '' | '1.2' | '1.3' };

/** 모델의 `override` → 폼 값. */
export const overrideOf = (item: Readonly<Record<string, unknown>> | undefined): OverrideText => {
  const o = item?.['override'] as { minVersion?: unknown; maxVersion?: unknown } | undefined;
  const v = (x: unknown): OverrideText['min'] => (x === '1.2' || x === '1.3' ? x : '');
  return { min: v(o?.minVersion), max: v(o?.maxVersion) };
};

/** 폼 값 → 모델의 `override`. 둘 다 비면 없다. */
export const overrideBody = (o: OverrideText): { minVersion?: '1.2' | '1.3'; maxVersion?: '1.2' | '1.3' } | undefined =>
  o.min === '' && o.max === '' ? undefined : { ...(o.min === '' ? {} : { minVersion: o.min }), ...(o.max === '' ? {} : { maxVersion: o.max }) };

/**
 * 실제로 쓰일 범위가 비었나. 덮지 않은 쪽은 리스너 정책 값이다(렌더러와 같은 규칙: `override ?? policy`).
 * 최소가 최대보다 크면 그 호스트는 어느 버전으로도 손을 못 잡는다.
 */
export const overrideError = (o: OverrideText, policy: { min?: string; max?: string }): string | undefined => {
  const min = o.min === '' ? policy.min : o.min;
  const max = o.max === '' ? policy.max : o.max;
  if (min === undefined || max === undefined) return undefined;
  return Number(min) > Number(max) ? `최소 TLS ${min} 이 최대 TLS ${max} 보다 높아요. 이 호스트는 연결할 수 없어요.` : undefined;
};

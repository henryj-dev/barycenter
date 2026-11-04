/**
 * TLS 정책 폼(만들기 드로어 · 분할 인라인 · 설정 탭)이 같이 쓰는 선택지와 몸체 — 콘솔 시안 `fieldsFor('tlspol')`.
 *
 * 시안의 선택지(`TLS 1.2` · `TLS 1.3`, `modern-2026` · `intermediate-2026`, 거절 · 허용)에 모델에만 있는 값을 더한다:
 * 최대 버전 「제한 없음」(안 적으면 위를 막지 않는다 — 모델 기본). 몸체는 모델 기본과 같은 칸을 싣지 않는다.
 */
import type { TlsVersion } from '@web/edit';
import type { Item } from '@web/resources';

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
};

/** head 의 정책 → 폼 값. */
export const policyForm = (p: Item | undefined): PolicyForm => {
  const h = p?.['hsts'] as { maxAgeSeconds?: number; includeSubdomains?: boolean } | undefined;
  return {
    min: p?.['minVersion'] === '1.3' ? '1.3' : '1.2',
    max: p?.['maxVersion'] === '1.2' || p?.['maxVersion'] === '1.3' ? p['maxVersion'] : 'none',
    cipher: p?.['cipherPolicy'] === 'modern-2026' ? 'modern-2026' : 'intermediate-2026',
    mismatch: p?.['sniHostMismatch'] === 'reject_421' ? 'reject_421' : 'allow',
    hsts: h !== undefined,
    maxAge: String(h?.maxAgeSeconds ?? 31_536_000),
    subdomains: h?.includeSubdomains === true,
  };
};

export const rangeError = (f: Pick<PolicyForm, 'min' | 'max'>): string | undefined =>
  (f.max !== 'none' && f.max < f.min ? '최대 버전이 최소 버전보다 낮아요.' : undefined);

/** 시안 「초 단위 정수를 입력해요.」 + 해독기 상한. */
export const ageError = (f: Pick<PolicyForm, 'hsts' | 'maxAge'>): string | undefined => (!f.hsts ? undefined
  : !/^\d+$/.test(String(f.maxAge).trim()) ? '초 단위 정수를 입력해요.'
  : Number(f.maxAge) > HSTS_MAX ? `${HSTS_MAX}초(2년)까지예요.` : undefined);

/**
 * 폼 값 → 모델 몸체(키 뺌). `base` 는 head 의 정책 — 폼에 없는 칸(HSTS `preload` …)은 그대로 둔다.
 * 기본값과 같은 칸은 싣지 않는다(최대 버전 제한 없음 · intermediate · 허용 · HSTS 꺼짐).
 */
export const policyBody = (f: PolicyForm, base?: Item): Record<string, unknown> => {
  const { key: _k, minVersion: _a, maxVersion: _b, cipherPolicy: _c, sniHostMismatch: _d, hsts: oldHsts, ...rest } = base ?? {};
  const keepHsts = (oldHsts ?? {}) as Record<string, unknown>;
  const { maxAgeSeconds: _m, includeSubdomains: _s, ...hstsRest } = keepHsts;
  return {
    ...rest,
    minVersion: f.min,
    ...(f.max === 'none' ? {} : { maxVersion: f.max }),
    ...(f.cipher === 'intermediate-2026' ? {} : { cipherPolicy: f.cipher }),
    ...(f.mismatch === 'allow' ? {} : { sniHostMismatch: f.mismatch }),
    ...(f.hsts ? { hsts: { ...hstsRest, maxAgeSeconds: Number(f.maxAge), ...(f.subdomains ? { includeSubdomains: true } : {}) } } : {}),
  };
};

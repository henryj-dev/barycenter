/**
 * 풀의 「백엔드로 가는 TLS」 폼 (§4.3 · 2026-10-31).
 *
 * 모델과 CLI(`--upstream-tls` · `--upstream-sni` · `--upstream-ca` · `--upstream-verify`)에는 있었는데 GUI 에는
 * 칸이 없었다. 그래서 HTTPS 백엔드(예: barycenterd 의 :8443)를 GUI 로 만든 풀은 평문으로 붙어 거절당했다.
 * 도그푸딩에서 잡았다.
 *
 * 검증기와 같은 규칙을 폼이 먼저 말한다. 저장 못 하는 patch 를 만들지 않는다(`upstreamTlsField` 와 같은 규칙).
 */
import { upstreamTlsField, type UpstreamTlsInput } from './edit.js';

/** 폼 칸. 문자열은 빈 문자열이 「없음」 이다. */
export type UpstreamTlsForm = {
  on: boolean;
  sni: string;
  caBundle: string;
  verify: boolean;
};

export const UPSTREAM_TLS_OFF: UpstreamTlsForm = { on: false, sni: '', caBundle: '', verify: false };

const obj = (v: unknown): Record<string, unknown> | undefined =>
  (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 모델의 풀 하나 → 폼 칸. */
export function upstreamTlsFormOf(pool: Readonly<Record<string, unknown>> | undefined): UpstreamTlsForm {
  const t = obj(pool?.['upstreamTls']);
  if (t === undefined || t['enabled'] !== true) return { ...UPSTREAM_TLS_OFF };
  return { on: true, sni: str(t['sni']), caBundle: str(t['caBundle']), verify: t['verify'] === true };
}

/** 폼이 저장을 막는 이유. 없으면 undefined. 검증기의 문구를 사람 말로 옮겼다. */
export function upstreamTlsIssue(protocolClass: string, f: UpstreamTlsForm): string | undefined {
  if (!f.on) return undefined;
  if (protocolClass === 'udp') return 'UDP 풀은 백엔드로 TLS 를 못 써요. 엔진이 지원하지 않아요.';
  if (f.verify && f.caBundle.trim() === '') return '인증서 검증을 켜려면 신뢰할 CA 인증서를 골라야 해요.';
  return undefined;
}

/** 폼 칸 → 빌더 입력. 꺼져 있으면 undefined(평문). */
export function upstreamTlsInputOf(f: UpstreamTlsForm): UpstreamTlsInput | undefined {
  if (!f.on) return undefined;
  return {
    enabled: true,
    ...(f.sni.trim() === '' ? {} : { sni: f.sni.trim() }),
    ...(f.caBundle.trim() === '' ? {} : { caBundle: f.caBundle.trim() }),
    ...(f.verify ? { verify: true } : {}),
  };
}

/**
 * 풀 정의를 통째로 다시 쓸 body — `upstreamTls` 만 바꾸고 나머지 칸은 그대로 둔다(헬스체크 · hash 키 등).
 * 끄면 칸을 지운다. `key` 는 body 에 안 싣는다(put 의 key 가 따로 있다).
 */
export function poolBodyWithUpstreamTls(
  pool: Readonly<Record<string, unknown>>, f: UpstreamTlsForm,
): Record<string, unknown> {
  const issue = upstreamTlsIssue(str(pool['protocolClass']), f);
  if (issue !== undefined) throw new Error(issue);
  const { key: _key, upstreamTls: _old, ...rest } = pool;
  return { ...rest, ...upstreamTlsField(upstreamTlsInputOf(f)) };
}

/** CA 번들로 고를 수 있는 인증서 — 자료가 있는 것만(자료가 없으면 렌더가 낼 파일이 없다). */
export function caBundleChoices(certificates: readonly Readonly<Record<string, unknown>>[]): string[] {
  return certificates
    .filter((c) => typeof c['key'] === 'string' && typeof c['materialRef'] === 'string')
    .map((c) => c['key'] as string)
    .sort();
}

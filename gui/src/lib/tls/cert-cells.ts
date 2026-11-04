/**
 * 인증서 만료일 칸 — 콘솔 시안 `cells('certs', r)` 의 마지막 줄 그대로(순수 · 루트 시험이 직접 읽는다).
 *
 * ```js
 * const d = v.days, ex = d < 0 ? b('danger', '✕', v.exp + ' (만료됨)') : d <= 30 ? b('warn', '▲', v.exp + ' (' + d + '일 전)') : m(v.exp);
 * ```
 * 넉넉하면 **배지가 없다**(날짜만, 고정폭). 자료가 없으면 남은 날을 모르므로 날짜 자리 글만 둔다 —
 * ACME 는 시안 새 인증서의 `exp` 「발급 대기」, 업로드는 모른다(「—」).
 */
// `.js` 로 적는다 — 루트 시험(tsc · vitest)이 이 파일을 직접 읽는다.
import { b, m, type Cell } from '../ui/cells.js';

/** 만료 칸이 읽는 것 — `CertRow`(`@web/certs-view`)의 일부. */
export type CertExpiry = { acme: boolean; notAfter: string | undefined; expiresInDays: number | undefined };

/** 만료 날짜 글 — `2026-11-10` · 「발급 대기」 · ''(모른다). */
export const certExp = (c: CertExpiry): string => (c.notAfter !== undefined ? c.notAfter.slice(0, 10) : c.acme ? '발급 대기' : '');

export const certExpiryCell = (c: CertExpiry): Cell => {
  const exp = certExp(c), d = c.expiresInDays;
  if (d === undefined) return m(exp);
  return d < 0 ? b('danger', '✕', `${exp} (만료됨)`) : d <= 30 ? b('warn', '▲', `${exp} (${d}일 전)`) : m(exp);
};

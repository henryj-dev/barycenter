/**
 * TLS 화면(인증서 · TLS 정책 · SNI 바인딩)이 같이 읽는 값 — 콘솔 시안 `cells(page, r)` · `colsOf(page)` 그대로.
 *
 * 목록 칸 · 분할 머리 · 상세 개요(`ovRows` = 열 이름 + 그 행의 칸)가 같은 칸을 쓴다. 그래서 한곳에 둔다.
 * 값은 실제 API 가 준 것만 쓴다. 모르면 「—」 다(가짜 값을 짓지 않는다).
 */
import { itemOf, itemsOf, relationsOf, type Item } from '@web/resources';
import { b, m, x, type Cell } from '#lib/ui/cells.ts';
import type { CertRow } from '@web/certs-view';
import { certExp, certExpiryCell } from './cert-cells.ts';
import type { createDesk } from '#lib/desk.svelte.ts';

type Desk = ReturnType<typeof createDesk>;

/** 시안 `colsOf` — 열 이름과 순서. */
export const COLS = {
  certificate: ['이름', '도메인', '발급자', '만료일', '사용처'],
  tlsPolicy: ['이름', '최소 버전', '최대 버전', '암호군', 'HSTS', 'SNI-Host 불일치'],
  sniBinding: ['이름', '리스너', '호스트 수', '호스트', '인증서'],
} as const;

/** 모델의 버전 값(`1.2`)을 시안 글(`TLS 1.2`)로. */
export const tlsVersion = (v: unknown): string => (typeof v === 'string' && v !== '' ? `TLS ${v}` : '');
/** 암호군 — 안 적으면 모델 기본(`intermediate-2026`)이다. */
export const cipherOf = (p: Item): string => (typeof p['cipherPolicy'] === 'string' ? p['cipherPolicy'] : 'intermediate-2026');
export const hstsAgeOf = (p: Item): number | undefined => {
  const h = p['hsts'] as { maxAgeSeconds?: unknown } | undefined;
  return typeof h?.maxAgeSeconds === 'number' ? h.maxAgeSeconds : undefined;
};

// ── 인증서 ──

/** 사용처 — 시안 「리스너 2 · SNI 3」 · 「사용처 없음」. 풀(업스트림 CA)도 센다. */
export const certUsage = (desk: Desk, key: string): string => {
  const by = relationsOf(desk.model, { kind: 'certificate', key }).usedBy;
  const n = (kind: string): number => by.filter((e) => e.from.kind === kind).length;
  const parts = [['리스너', n('listener')], ['SNI', n('sniBinding')], ['풀', n('pool')]] as const;
  const known = parts.reduce((a, [, k]) => a + k, 0);
  const text = [...parts.filter(([, k]) => k > 0).map(([l, k]) => `${l} ${k}`), ...(by.length > known ? [`기타 ${by.length - known}`] : [])].join(' · ');
  return by.length === 0 ? '사용처 없음' : text;
};

/** 발급자 — 시안 「ACME」 · 「업로드」. */
export const certIssuer = (c: CertRow): string => (c.acme ? 'ACME' : '업로드');

/** 만료 날짜 · 만료일 칸 — 시안 그대로(`cert-cells.ts`, 루트 시험이 직접 잰다). */
export { certExp, certExpiryCell };

/** ACME 의도의 도메인(설정) — 없으면 자료의 SAN. 시안 「도메인」 칸은 쉼표로 잇는다. */
export const certDomains = (desk: Desk, c: CertRow): string[] => {
  const acme = itemOf(desk.model, 'certificate', c.key)?.['acme'] as { domains?: string[] } | undefined;
  return acme?.domains ?? c.domains;
};

/** 시안 `cells('certs', r)`. */
export const certCells = (desk: Desk, c: CertRow): Cell[] =>
  [m(c.key), m(certDomains(desk, c).join(', ')), x(certIssuer(c)), certExpiryCell(c), x(certUsage(desk, c.key))];

// ── TLS 정책 ──

/** 시안 `cells('tlspol', r)`. 최대 버전을 안 적었으면 제한이 없다(「—」). */
export const tlsPolicyCells = (p: Item): Cell[] => {
  const age = hstsAgeOf(p);
  return [m(String(p['key'])), x(tlsVersion(p['minVersion'])), x(tlsVersion(p['maxVersion'])), m(cipherOf(p)),
    x(age === undefined ? '꺼짐' : `max-age ${age}s`), x(p['sniHostMismatch'] === 'reject_421' ? '거절' : '허용')];
};

// ── SNI 바인딩 ──

export const sniHosts = (s: Item): string[] => (Array.isArray(s['hosts']) ? (s['hosts'] as unknown[]).map(String) : []);

/**
 * 시안 `cells('sni', r)`. 인증서가 head 에 없으면 그 칸을 위험 배지로 둔다 — 시안에는 없지만 이미 있던 표시다
 * (그대로 두면 plan 이 막힌다).
 */
export const sniCells = (desk: Desk, s: Item): Cell[] => {
  const hs = sniHosts(s), cert = String(s['certificate'] ?? '');
  const missing = cert !== '' && itemOf(desk.model, 'certificate', cert) === undefined;
  return [m(String(s['key'])), m(String(s['listener'] ?? '')), x(`${hs.length}개`),
    m(hs.length === 0 ? '' : `${hs[0]}${hs.length > 1 ? ` 외 ${hs.length - 1}` : ''}`, hs.length > 1 ? hs.join('\n') : undefined),
    missing ? b('danger', '✕', `${cert} — 없음`) : m(cert)];
};

/** 상세 개요 · 머리 배지에 쓰는 그 리소스의 칸(시안 `cellsSel`). 없으면 빈 배열. */
export const cellsOf = (desk: Desk, kind: keyof typeof COLS, key: string): Cell[] => {
  if (kind === 'certificate') {
    const c = desk.certs.rows.find((r) => r.key === key);
    return c === undefined ? [] : certCells(desk, c);
  }
  const it = itemsOf(desk.model, kind).find((i) => String(i['key']) === key);
  if (it === undefined) return [];
  return kind === 'tlsPolicy' ? tlsPolicyCells(it) : sniCells(desk, it);
};

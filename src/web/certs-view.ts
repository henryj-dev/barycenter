/**
 * Certificates 화면이 읽는 값 — DESIGN.md §8.1 · §10
 *
 * 만료는 자료에서 온다. 설정에 적은 날짜를 믿으면 알람이 거짓이다.
 * 자료가 없으면(ACME 발급 전) 목록에서 빼지 않는다. 주문·챌린지 상태는
 * GET /certificates 에 없다 — 의도는 `acme` 필드고, 주문은 운영 상태다.
 */
export type CertificateFact = {
  key: string;
  facts?: null;
  expiresInDays?: number;
  notAfter?: string;
  domains?: string[];
  acme?: { account: string; domains: string[] };
};

export type CertMark = 'missing' | 'expired' | 'ok';

export type CertRow = {
  key: string;
  hasMaterial: boolean;
  acme: boolean;
  domains: string[];
  expiresInDays: number | undefined;
  notAfter: string | undefined;
  mark: CertMark;
};

export type CertsView = { rows: CertRow[] };

export function viewOfCertificates(certs: readonly CertificateFact[]): CertsView {
  const rows = certs.map((c) => {
    const hasMaterial = c.facts !== null && c.expiresInDays !== undefined;
    const domains = c.domains ?? c.acme?.domains ?? [];
    const mark: CertMark = !hasMaterial
      ? 'missing'
      : (c.expiresInDays ?? 0) < 0
        ? 'expired'
        : 'ok';
    return {
      key: c.key,
      hasMaterial,
      acme: c.acme !== undefined,
      domains: [...domains],
      expiresInDays: hasMaterial ? c.expiresInDays : undefined,
      notAfter: hasMaterial ? c.notAfter : undefined,
      mark,
    };
  });
  rows.sort((a, b) => rank(a) - rank(b) || a.key.localeCompare(b.key));
  return { rows };
}

/** 만료 → 자료 없음 → 남은 일수. 바인딩된 죽은 인증서가 제일 먼저다. */
function rank(r: CertRow): number {
  if (r.mark === 'expired') return r.expiresInDays ?? -1;
  if (r.mark === 'missing') return 1_000_000;
  return 2_000_000 + (r.expiresInDays ?? 0);
}

/**
 * Audit 화면이 읽는 값 — DESIGN.md §5.2 · §10
 *
 * GET /api/v1/audit 는 로그다. 모델이 아니다.
 * before/after 본문은 API 가 안 준다. 폴링하지 않는다.
 */
export type AuditView = {
  rows: AuditRow[];
};

export type AuditRow = {
  id: string;
  at: string | undefined;
  principal: string;
  action: string;
  subject: string | undefined;
  revision: string | undefined;
};

const text = (v: unknown): string | undefined =>
  (typeof v === 'string' && v !== '' ? v : undefined);

export function viewOfAudit(body: unknown): AuditView {
  const list = Array.isArray(body) ? body : [];
  const rows: AuditRow[] = [];
  for (const item of list) {
    const rec = item !== null && typeof item === 'object' ? item as Record<string, unknown> : {};
    const id = text(rec['id']);
    const principal = text(rec['principal']);
    const action = text(rec['action']);
    if (id === undefined || principal === undefined || action === undefined) continue;
    rows.push({
      id,
      at: text(rec['at']),
      principal,
      action,
      subject: text(rec['subject']),
      revision: text(rec['revision']),
    });
  }
  return { rows };
}

/**
 * **전환(오퍼레이션)** 을 화면이 말하는 법 (2026-11-21) — `GET /api/v1/operations` · `/operations/:id`.
 *
 * 적용 · 롤백 · 다시 렌더는 모두 오퍼레이션 하나를 남긴다. 끝나지 않은 것(`terminal: false`)은
 * 「취소」 할 수 있다 — 예약한 슬롯을 반납하고 실패로 닫는다. **이미 활성화된 것은 되돌리지 않는다** — 그건 롤백이다.
 *
 * 순수 함수만 둔다 — 시험이 바로 부른다(`tests/unit/ops-drafts.test.ts`).
 */

export type OperationRow = {
  id: string;
  planId: string;
  revision: string;
  activationEpoch: string;
  generation: string;
  phase: string;
  detail: unknown;
  createdAt: string | null;
  updatedAt: string | null;
  createdBy: string | null;
  terminal: boolean;
};

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

export function parseOperation(body: unknown): OperationRow | undefined {
  const r = rec(body);
  const id = str(r?.['id']);
  const phase = str(r?.['phase']);
  if (r === undefined || id === undefined || phase === undefined) return undefined;
  return {
    id, phase,
    planId: str(r['planId']) ?? '',
    revision: str(r['revision']) ?? '',
    activationEpoch: str(r['activationEpoch']) ?? '',
    generation: str(r['generation']) ?? '',
    detail: r['detail'],
    createdAt: str(r['createdAt']) ?? null,
    updatedAt: str(r['updatedAt']) ?? null,
    createdBy: str(r['createdBy']) ?? null,
    terminal: r['terminal'] === true,
  };
}

export function parseOperations(body: unknown): OperationRow[] {
  if (!Array.isArray(body)) return [];
  return body.map(parseOperation).filter((o): o is OperationRow => o !== undefined);
}

/** 단계의 사람 말과 색. 모르는 단계는 이름 그대로다. */
const PHASE_TEXT: Readonly<Record<string, { text: string; tone: 'ok' | 'warn' | 'danger' | 'info' | 'neutral' }>> = {
  preflight: { text: '점검', tone: 'info' },
  publish_intent: { text: '게시 준비', tone: 'info' },
  published: { text: '게시함', tone: 'info' },
  membership_staged: { text: '멤버십 올림', tone: 'info' },
  reload_intent: { text: 'reload 준비', tone: 'info' },
  reload_observed: { text: 'reload 확인', tone: 'info' },
  activated: { text: '활성', tone: 'ok' },
  partially_activated: { text: '일부만 활성 — 다시 시도 중', tone: 'warn' },
  partial_exhausted: { text: '일부만 활성 — 재시도 끝', tone: 'danger' },
  failed: { text: '실패', tone: 'danger' },
  superseded: { text: '다른 적용이 대신함', tone: 'neutral' },
  no_operation: { text: '할 일 없음', tone: 'neutral' },
};

export function phaseMark(phase: string): { text: string; tone: 'ok' | 'warn' | 'danger' | 'info' | 'neutral' } {
  return PHASE_TEXT[phase] ?? { text: phase, tone: 'neutral' };
}

/** 취소할 수 있는가. 서버도 같은 판정을 한다(`ControlPlane.cancel`: 활성은 409). */
export const cancellable = (o: Pick<OperationRow, 'terminal' | 'phase'>): boolean =>
  !o.terminal && o.phase !== 'activated';

/** `detail` 에서 사람이 읽을 사실만 꺼낸다 — 취소 · 실패 이유 · 평면 · reload 여부. */
export function detailFacts(detail: unknown): { label: string; value: string }[] {
  const d = rec(detail);
  if (d === undefined) return [];
  const out: { label: string; value: string }[] = [];
  if (d['cancelled'] === true) out.push({ label: '취소', value: `취소함${str(d['by']) === undefined ? '' : ` · ${String(d['by'])}`}` });
  for (const k of ['reason', 'error', 'failure', 'message'] as const) {
    const v = d[k];
    if (typeof v === 'string' && v !== '') out.push({ label: '이유', value: v });
    else if (rec(v) !== undefined) out.push({ label: '이유', value: JSON.stringify(v) });
  }
  if (Array.isArray(d['planes'])) out.push({ label: '평면', value: (d['planes'] as unknown[]).map(String).join(', ') || '—' });
  if (typeof d['reload'] === 'boolean') out.push({ label: 'reload', value: d['reload'] ? '함' : '안 함' });
  if (d['membershipOnly'] === true) out.push({ label: '종류', value: '멤버십만 (reload 없음)' });
  return out;
}

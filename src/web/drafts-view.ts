/**
 * **변경 초안 · 충돌** (2026-11-21) — 커밋하지 않은 changeset 을 화면이 말하는 법.
 *
 * GUI 의 「저장」 은 한 번에 head → changeset → patch → plan → commit 을 한다. 중간에 실패하면 지금까지는
 * changeset 을 버렸다. 그러면 남이 먼저 커밋해서(head 가 움직여서) 실패한 변경도 사라진다 — 다시 입력해야 한다.
 * 이 파일은 그런 실패를 가른다: **충돌이면 초안으로 남기고, 내용이 틀렸으면 버린다.**
 *
 * 순수 함수만 둔다 — 시험이 바로 부른다(`tests/unit/ops-drafts.test.ts`).
 */
import { RESOURCES, type ResourceKind } from './resources.js';

/** 실패 응답 하나. `code` 는 서버의 `StoreError.code` 다. */
export type FailedCall = { status: number; code?: string; message?: string };

/**
 * 실패의 종류.
 * - `stale`    head 가 움직였다 · plan 이 만료됐다 — 같은 patch 를 최신 head 에 다시 계획하면 된다.
 * - `changed`  다른 사람이 같은 초안을 먼저 고쳤다(412) — 다시 읽고 다시 고친다.
 * - `invalid`  내용이 틀렸다(4xx) — 초안으로 남겨도 커밋할 수 없다.
 * - `other`    그 밖(5xx · 연결) — 초안으로 남긴다. 나중에 다시 해 본다.
 */
export type FailureKind = 'stale' | 'changed' | 'invalid' | 'other';

export function failureKind(f: FailedCall): FailureKind {
  if (f.status === 412 || f.code === 'precondition_failed') return 'changed';
  if (f.status === 409 && f.code === 'PLAN_STALE') return 'stale';
  if (f.status >= 400 && f.status < 500) return 'invalid';
  return 'other';
}

/** 이 실패면 changeset 을 버리지 않고 초안으로 남긴다. */
export const keepsDraft = (k: FailureKind): boolean => k !== 'invalid';

/** 초안으로 남겼을 때 화면에 쓰는 말. 서버 문장을 뒤에 붙인다. */
export function keptDraftMessage(k: FailureKind, serverMessage?: string): string {
  const tail = serverMessage === undefined || serverMessage === '' ? '' : ` (${serverMessage})`;
  switch (k) {
    case 'stale':
      return `다른 변경이 먼저 커밋됐어요. 바꾼 내용은 초안으로 남겼어요 — 변경 › 초안에서 「최신 head 로 다시 계획」 을 눌러요.${tail}`;
    case 'changed':
      return `다른 사람이 이 초안을 먼저 고쳤어요. 초안을 다시 읽고 고쳐요.${tail}`;
    case 'other':
      return `저장을 끝내지 못했어요. 바꾼 내용은 초안으로 남겼어요 — 변경 › 초안에서 다시 해요.${tail}`;
    case 'invalid':
      return serverMessage ?? '내용이 틀렸어요.';
  }
}

/** `GET /api/v1/changesets` 의 한 줄. */
export type DraftRow = {
  id: string;
  baseRevision: string;
  state: 'open' | 'sealed';
  patch: unknown[];
  ops: number;
  createdAt: string;
  createdBy: string;
  sealedAt: string | null;
  stale: boolean;
  etag: string;
};

const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/** 응답을 읽는다. 모양이 다른 줄은 뺀다 — 지어내지 않는다. */
export function parseDrafts(body: unknown): DraftRow[] {
  if (!Array.isArray(body)) return [];
  const out: DraftRow[] = [];
  for (const x of body) {
    const r = rec(x);
    const id = str(r?.['id']);
    const state = r?.['state'];
    if (r === undefined || id === undefined || (state !== 'open' && state !== 'sealed')) continue;
    const patch = Array.isArray(r['patch']) ? r['patch'] as unknown[] : [];
    out.push({
      id, state, patch,
      baseRevision: str(r['baseRevision']) ?? '',
      ops: typeof r['ops'] === 'number' ? r['ops'] : patch.length,
      createdAt: str(r['createdAt']) ?? '',
      createdBy: str(r['createdBy']) ?? '',
      sealedAt: str(r['sealedAt']) ?? null,
      stale: r['stale'] === true,
      etag: str(r['etag']) ?? '',
    });
  }
  return out;
}

const labelOf = (kind: string): string =>
  Object.hasOwn(RESOURCES, kind) ? RESOURCES[kind as ResourceKind].label : kind === 'engine' ? '엔진 설정' : kind;

/** patch 한 줄을 사람 말로: `리스너 web 고치기` · `풀 a 지우기` · `백엔드 a → b 이름 바꾸기`. */
export function opLine(op: unknown): string {
  const o = rec(op);
  const kind = str(o?.['kind']) ?? '?';
  // 엔진 설정은 하나뿐이라 key(`engine`)를 말하지 않는다.
  const key = kind === 'engine' ? '' : str(o?.['key']) ?? '?';
  const what = `${labelOf(kind)}${key === '' ? '' : ` ${key}`}`;
  switch (o?.['op']) {
    case 'put': return `${what} 만들기 · 고치기`;
    case 'delete': return `${what} 지우기`;
    case 'rename': return `${what} → ${str(o?.['to']) ?? '?'} 이름 바꾸기`;
    default: return `${what} (알 수 없는 op)`;
  }
}

/** 초안 한 줄의 요약 — 첫 op 와 나머지 수. */
export function draftSummary(d: Pick<DraftRow, 'patch'>): string {
  if (d.patch.length === 0) return '빈 초안';
  const first = opLine(d.patch[0]);
  return d.patch.length === 1 ? first : `${first} 외 ${d.patch.length - 1}건`;
}

/** 초안의 상태 표시. */
export function draftMark(d: Pick<DraftRow, 'state' | 'stale'>): { tone: 'ok' | 'warn' | 'info'; text: string } {
  if (d.stale) return { tone: 'warn', text: '▲ head 가 바뀌었어요' };
  if (d.state === 'sealed') return { tone: 'info', text: '◐ 계획함' };
  return { tone: 'ok', text: '● 열림' };
}

/** 계획의 영향을 짧게 — 초안 화면이 커밋 전에 보인다. 적용 대기 화면이 전체를 보인다. */
export function impactLines(impact: {
  requiresReload?: boolean;
  affectedListeners?: readonly unknown[];
  sessionImpact?: readonly { effect: string }[];
  socketChanges?: { added: readonly unknown[]; removed: readonly unknown[] };
  bindTransitions?: readonly unknown[];
} | undefined): { tone: 'ok' | 'warn' | 'danger'; text: string }[] {
  if (impact === undefined) return [{ tone: 'warn', text: '영향을 몰라요.' }];
  const out: { tone: 'ok' | 'warn' | 'danger'; text: string }[] = [];
  const resets = (impact.sessionImpact ?? []).filter((s) => s.effect === 'may_reset').length;
  out.push(resets > 0
    ? { tone: 'danger', text: `기존 연결이 끊길 수 있는 곳 ${resets}개` }
    : { tone: 'ok', text: '끊기는 연결이 없어요.' });
  const listeners = impact.affectedListeners?.length ?? 0;
  if (listeners > 0) out.push({ tone: 'warn', text: `영향을 받는 리스너 ${listeners}개` });
  const added = impact.socketChanges?.added.length ?? 0;
  const removed = impact.socketChanges?.removed.length ?? 0;
  if (added + removed > 0) out.push({ tone: 'warn', text: `소켓 열기 ${added}개 · 닫기 ${removed}개` });
  if ((impact.bindTransitions?.length ?? 0) > 0) out.push({ tone: 'danger', text: '두 번에 나눠 적용해야 해요 — 적용 대기 화면에서 확인해요.' });
  out.push(impact.requiresReload === true
    ? { tone: 'warn', text: '적용하면 nginx 를 reload 해요.' }
    : { tone: 'ok', text: 'reload 없이 적용돼요.' });
  return out;
}

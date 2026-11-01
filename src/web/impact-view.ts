/**
 * Plan·Impact 화면이 읽는 값 — DESIGN.md §5.4 · §10
 *
 * GUI 는 diff 가 아니라 **영향**을 보여 준다. 이 모듈은 API 의 `Impact` 를
 * 화면에 올릴 문장으로 접는다. 렌더는 여기 없고, 그래서 테스트가 브라우저를
 * 열지 않는다.
 *
 * **새 필드는 전부 선택이다.** plan 은 JSONB 로 저장되므로 이 회차 전에 만들어진
 * plan 에는 아래 항목이 없다. 없는 것을 없는 대로 그리지 않으면, 옛 plan 을
 * 적용하려던 사람이 화면을 못 연다.
 */
export type Impact = {
  requiresReload: boolean;
  /**
   * 롤백이 만든 plan 이면 이것만 있다(`config-store` 의 rollback). 영향을 미리 재지 않는다 —
   * 그래서 아래 필드가 **없을 수 있다.** 화면은 그것을 「영향을 모른다」 로 그린다.
   */
  rollbackOf?: string;
  topologyEpochChange?: boolean;
  affectedListeners: { key: string; protocol: string; bind: string; port: number;
    change?: string }[];
  sessionImpact?: { protocol: string; effect: string; why: string }[];
  certificateChanges?: { key: string; change: string; notAfter?: string }[];
  socketChanges: { added: string[]; removed: string[] };
  routeOrderChanges?: {
    moved: { listener: string; key: string; from: number | null; to: number | null }[];
    warnings: { kind: string; listener: string; routes: string[]; message: string }[];
  };
  capabilityWarnings?: { kind: string; message: string }[];
  /** reload 로 못 여는 소켓 (2026-11-01). 있으면 apply 가 거절한다. 옛 plan 에는 없다. */
  bindTransitions?: { opens: string; blockedBy: string[]; message: string }[];
  planes: readonly string[];
  confDiff?: { before: number; after: number };
};

export type PendingApply = { planId: string; revision: string };

export type ImpactView = {
  planId: string;
  revision: string;
  requiresReload: boolean;
  headline: string;
  socketsAdded: string[];
  socketsRemoved: string[];
  planes: string[];
  listeners: string[];
  /** 프로토콜별 기존 세션. **영향 없는 것은 안 싣는다.** */
  sessions: string[];
  certificates: string[];
  routeWarnings: string[];
  capabilityWarnings: string[];
  /** 이것이 있으면 적용이 막힌다 — reload 로 못 여는 소켓. */
  bindBlockers: string[];
  /** 롤백 plan 이면 되돌아가는 리비전. 이때 위 목록은 비어 있다 — 「없다」 가 아니라 「재지 않았다」 다. */
  rollbackOf?: string;
};

const CHANGE_WORD: Record<string, string> = {
  added: '추가', removed: '삭제', changed: '변경', replaced: '교체',
};

/** `2026-06-01T00:00:00.000Z` → `2026-06-01`. 화면에 시각까지는 필요 없다. */
const day = (iso: string): string => iso.slice(0, 10);

const SESSION_WORD: Record<string, string> = {
  may_reset: '기존 연결·세션이 끊길 수 있다',
  new_only: '새 연결·새 요청부터 바뀐다',
};

/**
 * 롤백 plan — 영향을 재지 않았다. **모르는 것을 「영향 없음」 으로 그리지 않는다.**
 * reload 가 필요한지 모르므로 필요하다고 본다(경고 쪽으로 기운다).
 */
function viewOfRollback(pending: PendingApply, rollbackOf: string): ImpactView {
  return {
    planId: pending.planId,
    revision: pending.revision,
    requiresReload: true,
    headline: `r${rollbackOf} 의 내용으로 되돌린다 — 영향은 미리 재지 않았다`,
    socketsAdded: [],
    socketsRemoved: [],
    planes: [],
    listeners: [],
    sessions: [],
    certificates: [],
    routeWarnings: [],
    capabilityWarnings: [],
    bindBlockers: [],
    rollbackOf,
  };
}

export function viewOfImpact(pending: PendingApply, impact: Impact): ImpactView {
  if (impact.socketChanges === undefined && impact.rollbackOf !== undefined) {
    return viewOfRollback(pending, impact.rollbackOf);
  }
  const added = [...impact.socketChanges.added];
  const removed = [...impact.socketChanges.removed];
  /**
   * **머리글이 `requiresReload` 만 보면 거짓이 된다.**
   *
   * 멤버십 평면이 없는 엔진에서는 산출물이 같아도 세대가 새로 서고 epoch 이 움직인다
   * (§7.3). 전에는 그 경우에도 "세대 전환 없이 반영된다" 고 적었다.
   */
  const headline = impact.requiresReload
    ? 'reload 가 필요하다 — 진행 중 세션은 엔진이 기다려 주지만 재촉할 수 없다'
    : impact.topologyEpochChange === true
      ? '산출물은 같지만 이 엔진은 세대를 새로 세운다 — 멤버십 평면이 없다'
      : '산출물이 같다 — 세대 전환 없이 반영된다';

  // **끊기는 것을 먼저 말한다.** 접는 순서가 곧 읽는 순서다.
  const rank = (e: string): number => (e === 'may_reset' ? 0 : 1);
  const sessions = (impact.sessionImpact ?? [])
    .filter((s) => s.effect !== 'none')
    .sort((a, b) => rank(a.effect) - rank(b.effect))
    .map((s) => `${s.protocol} — ${SESSION_WORD[s.effect] ?? s.effect}: ${s.why}`);

  return {
    planId: pending.planId,
    revision: pending.revision,
    requiresReload: impact.requiresReload,
    headline,
    socketsAdded: added,
    socketsRemoved: removed,
    planes: [...impact.planes],
    listeners: impact.affectedListeners.map(
      (l) => `${l.key}  ${l.protocol}  ${l.bind}:${l.port}`
        + (l.change === undefined ? '' : `  (${CHANGE_WORD[l.change] ?? l.change})`),
    ),
    sessions,
    certificates: (impact.certificateChanges ?? []).map(
      (c) => `${c.key} ${CHANGE_WORD[c.change] ?? c.change}`
        // 만료는 자료에서 온다. 모르면 **안 적는다** — 화면이 날짜를 지어내지 않는다.
        + (c.notAfter === undefined ? '' : ` — ${day(c.notAfter)} 만료`),
    ),
    routeWarnings: (impact.routeOrderChanges?.warnings ?? []).map((w) => w.message),
    capabilityWarnings: (impact.capabilityWarnings ?? []).map((w) => w.message),
    bindBlockers: (impact.bindTransitions ?? []).map((b) => b.message),
  };
}

/**
 * 적용할 plan 을 고른다 — **가장 새 리비전의 것**(2026-10-31, web-01).
 *
 * 저장마다 plan 이 하나씩 쌓이고, 서버는 미적용 plan 을 리비전 오름차순으로 준다. 전에는 첫 번째(가장
 * 오래된 것)를 골랐는데, 서버는 head 의 plan 만 받는다 — 「적용해요」 가 늘 `PLAN_STALE`
 * (「이 plan 은 r10 인데 head 는 r19」)로 거절됐다. 가장 새 plan 을 적용하면 그 리비전의 설정 전체가
 * 반영되므로 앞의 변경도 함께 간다. 리비전은 숫자로 비교한다(문자열이면 "9" 가 "10" 보다 크다).
 */
export function pickPending(
  pending: readonly PendingApply[],
  /**
   * 주면 **head 의 plan 만** 고른다 (2026-11-01). head 의 적용이 실패하면 그 plan 은 목록에서 빠지고, 남은 가장 새
   * plan 은 head 보다 옛것이라 적용하면 언제나 `PLAN_STALE` 이었다. 그때는 아무것도 안 고르고 화면이 「다시 시도」 를 보인다.
   */
  head?: string,
): PendingApply | undefined {
  let best: PendingApply | undefined;
  for (const p of pending) {
    if (best === undefined || BigInt(p.revision) > BigInt(best.revision)) best = p;
  }
  if (head !== undefined && best !== undefined && best.revision !== head) return undefined;
  return best;
}

/** `GET /status` 의 `failedApply` — head 의 적용이 실패했고 다시 시도할 수 있다. */
export type FailedApply = { revision: string; planId: string; failure: string };

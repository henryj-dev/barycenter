/**
 * Plan·Impact 화면이 읽는 값 — DESIGN.md §5.4 · §10
 *
 * GUI 는 diff 가 아니라 **영향**을 보여 준다. 이 모듈은 API 의 `Impact` 를
 * 화면에 올릴 문장으로 접는다. 렌더는 여기 없고, 그래서 테스트가 브라우저를
 * 열지 않는다.
 */
export type Impact = {
  requiresReload: boolean;
  affectedListeners: { key: string; protocol: string; bind: string; port: number }[];
  socketChanges: { added: string[]; removed: string[] };
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
};

export function viewOfImpact(pending: PendingApply, impact: Impact): ImpactView {
  const added = [...impact.socketChanges.added];
  const removed = [...impact.socketChanges.removed];
  const headline = impact.requiresReload
    ? 'reload 가 필요하다 — 진행 중 세션은 엔진이 기다려 주지만 재촉할 수 없다'
    : '산출물이 같다 — 세대 전환 없이 반영된다';
  return {
    planId: pending.planId,
    revision: pending.revision,
    requiresReload: impact.requiresReload,
    headline,
    socketsAdded: added,
    socketsRemoved: removed,
    planes: [...impact.planes],
    listeners: impact.affectedListeners.map(
      (l) => `${l.key}  ${l.protocol}  ${l.bind}:${l.port}`,
    ),
  };
}

export function pickPending(
  pending: readonly PendingApply[],
): PendingApply | undefined {
  return pending[0];
}

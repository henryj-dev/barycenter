/**
 * **리소스별 적용 대기** (#126 후속) — `GET /api/v1/config/pending-resources` 를 화면이 쓰는 모양으로.
 *
 * 엔진이 돌리는 리비전과 head 가 다른 리소스에 「◐ 적용 대기」 를 붙인다. 리스너 단위가 아니라 (kind, key) 단위다.
 * 지운 리소스는 행이 없다 — 적용 대기 화면이 「지울 것」 으로 따로 보인다.
 * 못 읽으면 아무것도 안 붙인다. 모르는 것을 「적용 대기」 라고 지어내지 않는다.
 */
// **별칭(`#lib` · `@web`)을 안 쓴다** — 단위 시험(tests/unit)과 루트 typecheck 가 이 파일을 그대로 읽는다.

export type PendingChange = 'added' | 'changed' | 'removed';
export type PendingResourcesView = {
  activeRevision: string | null;
  headRevision: string | undefined;
  /** `kind/key` → 바뀜. added · changed · removed 모두. */
  changes: ReadonlyMap<string, PendingChange>;
  /** 지울 것 — head 에 없어서 목록에 행이 없다. */
  removed: readonly { kind: string; key: string }[];
};

export const EMPTY_PENDING: PendingResourcesView = {
  activeRevision: null, headRevision: undefined, changes: new Map(), removed: [],
};

export const PENDING_MARK = { tone: 'pending', icon: '◐', text: '적용 대기' } as const satisfies { tone: string; icon: string; text: string };

const id = (kind: string, key: string): string => `${kind}/${key}`;
const CHANGES = new Set<string>(['added', 'changed', 'removed']);

/** API 응답을 읽는다. 모양이 틀린 줄은 버린다. */
export function viewOfPendingResources(body: unknown): PendingResourcesView {
  if (typeof body !== 'object' || body === null) return EMPTY_PENDING;
  const b = body as { activeRevision?: unknown; headRevision?: unknown; resources?: unknown };
  const changes = new Map<string, PendingChange>();
  const removed: { kind: string; key: string }[] = [];
  for (const r of Array.isArray(b.resources) ? b.resources as unknown[] : []) {
    const x = (r ?? {}) as { kind?: unknown; key?: unknown; change?: unknown };
    if (typeof x.kind !== 'string' || typeof x.key !== 'string' || typeof x.change !== 'string' || !CHANGES.has(x.change)) continue;
    changes.set(id(x.kind, x.key), x.change as PendingChange);
    if (x.change === 'removed') removed.push({ kind: x.kind, key: x.key });
  }
  return {
    activeRevision: typeof b.activeRevision === 'string' ? b.activeRevision : null,
    headRevision: typeof b.headRevision === 'string' ? b.headRevision : undefined,
    changes, removed,
  };
}

/** 이 리소스가 적용 대기인가 — 더했거나 바꿨다. 지운 것은 행이 없으므로 여기서 묻지 않는다. */
export function isPendingResource(view: PendingResourcesView, kind: string, key: string): boolean {
  const c = view.changes.get(id(kind, key));
  return c === 'added' || c === 'changed';
}

/**
 * **상세 머리 · 분할 상세** (시안 `selPendD`) — 상태 배지 옆에 적용 대기를 단다.
 * 상태가 이미 적용 대기 톤이면(리스너 「◐ 적용하면 열림」) 그것 하나만 둔다 — 한 자리에 적용 대기 표시를 둘 두지 않는다.
 */
export function headerMarks<M extends { tone: string; icon: string; text: string }>(
  mark: M | undefined, pending: boolean,
): (M | typeof PENDING_MARK)[] {
  const base: (M | typeof PENDING_MARK)[] = mark === undefined ? [] : [mark];
  if (!pending || mark?.tone === 'pending') return base;
  return [...base, PENDING_MARK];
}

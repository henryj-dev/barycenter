/**
 * GUI 가 changeset 에 얹는 패치 — DESIGN.md §5.3 · §10
 *
 * 저장(commit)과 적용(apply)은 다르다. 여기서 만드는 것은 patch 뿐이다.
 * 메서드×경로 ALLOW/DENY 는 WAF 다. 여기 없다.
 */
export type EditKind = 'backend' | 'listener' | 'pool';

export type DeleteOp = { op: 'delete'; kind: EditKind; key: string };

export function deletePatch(kind: EditKind, key: string): DeleteOp[] {
  if (key === '') throw new Error('키가 비어 있다');
  return [{ op: 'delete', kind, key }];
}

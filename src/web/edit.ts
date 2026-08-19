/**
 * GUI 가 changeset 에 얹는 패치 — DESIGN.md §5.3 · §10
 *
 * 저장(commit)과 적용(apply)은 다르다. 여기서 만드는 것은 patch 뿐이다.
 * 메서드×경로 ALLOW/DENY 는 WAF 다. 여기 없다.
 */
export type EditKind = 'backend' | 'listener' | 'pool';

export type DeleteOp = { op: 'delete'; kind: EditKind; key: string };

export type PutBackendOp = {
  op: 'put';
  kind: 'backend';
  key: string;
  body: { pool: string; host: string; port: number; weight: number };
};

export function deletePatch(kind: EditKind, key: string): DeleteOp[] {
  if (key === '') throw new Error('키가 비어 있다');
  return [{ op: 'delete', kind, key }];
}

export function putBackendPatch(
  key: string,
  body: { pool: string; host: string; port: number; weight?: number },
): PutBackendOp[] {
  if (key === '') throw new Error('키가 비어 있다');
  if (body.pool === '') throw new Error('풀이 비어 있다');
  if (body.host === '') throw new Error('호스트가 비어 있다');
  if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
    throw new Error('포트가 1–65535 정수가 아니다');
  }
  const weight = body.weight ?? 1;
  if (!Number.isInteger(weight) || weight < 1) throw new Error('가중치가 1 이상 정수가 아니다');
  return [{ op: 'put', kind: 'backend', key, body: { pool: body.pool, host: body.host, port: body.port, weight } }];
}

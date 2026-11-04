/**
 * 리스너 만들기 드로어의 「활성화」 · 「HTTP/2」(시안 `fieldsFor('listeners', v, true, 'drawer')`).
 *
 * 만들기 patch 빌더(`put*ListenerPatch`)는 이 둘을 받지 않는다 — 기본(켜짐)이면 그대로 `desk.insert*Listener` 를 쓰고,
 * 끈 때만 같은 빌더가 만든 put 본문에 `enabled: false` · `http2: false` 를 얹어 `desk.putResource` 로 올린다(같은 commit 이다).
 * 모양 검사는 그대로 저장소(해독기 · 검증기)가 한다.
 */
export type ListenerSwitches = { enabled: boolean; http2?: boolean };

/** 기본값과 같은가 — 그러면 원래 만들기 길을 쓴다. */
export const plainSwitches = (s: ListenerSwitches): boolean => s.enabled && s.http2 !== false;

/** patch 의 첫 put 에 스위치를 얹은 본문. */
export function switchedBody(ops: readonly { key: string; body: object }[], s: ListenerSwitches): { key: string; body: Record<string, unknown> } {
  const op = ops[0];
  if (op === undefined) throw new Error('만들 리스너가 없다');
  const body: Record<string, unknown> = { ...(op.body as Record<string, unknown>) };
  if (!s.enabled) body['enabled'] = false;
  if (s.http2 === false) body['http2'] = false;
  return { key: op.key, body };
}

/**
 * 트래픽 목록의 불러오기 상태 — `DataTable` 의 `loading` · `error` · `onretry` (#126 후속).
 *
 * 전에는 `loading={!desk.live}` 하나였다. 연결이 끊기면 목록이 뼈대(skeleton)로 바뀌고, 다시 붙을 때까지
 * 그대로 남았다 — 읽는 사람은 「불러오는 중」 인지 「끊긴 것」 인지 모른다.
 *
 *   붙어 있다                       → 목록
 *   한 번도 못 붙었고 오류도 없다   → 불러오는 중
 *   오류가 있거나, 붙었다가 끊겼다 → 오류 + 「다시 불러와요」(스트림을 다시 연다)
 *
 * `desk.live` 는 이미 짧은 끊김(`RECONNECT_GRACE_MS`)을 붙은 것으로 본다 — 배포 1–2 초에 오류가 번쩍이지 않는다.
 */
import type { createDesk } from '#lib/desk.svelte.ts';

type Desk = ReturnType<typeof createDesk>;

export function listState(desk: Desk): { loading: boolean; error?: string; onretry?: () => void } {
  if (desk.live) return { loading: false };
  // head 가 있으면 한 번은 붙었다(스냅샷이 head 를 준다).
  const lost = desk.head !== undefined;
  if (desk.error === undefined && !lost) return { loading: true };
  return {
    loading: false,
    error: desk.error ?? '실시간 연결이 끊겼어요. 다시 붙는 중이에요.',
    onretry: () => { void desk.connect(); },
  };
}

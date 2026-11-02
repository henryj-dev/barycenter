import { goto } from '$app/navigation';
import { toast } from '#lib/ui';
import { takeCommitNote } from '#lib/commit-note';

/**
 * 저장(commit)이 끝난 뒤 — 시안: 「커밋했어요」 토스트를 띄우고, 만든(고친) 리소스를 보인다.
 *
 * 적용 대기 화면으로 끌고 가지 않는다. 저장은 아직 트래픽이 아니고, 그것은 셸 위의 적용 대기 배너가
 * 늘 알린다. 사람은 방금 만든 것을 먼저 확인하고 싶다(2026-10-30, 인증서 넣기 뒤에 목록·상세로 가야 한다는 지적).
 *
 * `href` 가 없으면 지금 화면에 머문다(목록에서 켜고 끄기 · 목록에서 삭제 · 롤백).
 * 실패하면 아무 데도 가지 않는다 — 오류는 셸 배너가 보인다.
 */
export const after = (href?: string, title = '커밋했어요') => (ok: boolean): void => {
  if (!ok) return;
  if (takeCommitNote()) toast.ok(title, '트래픽이 안 바뀌는 변경이라 바로 반영했어요. 적용할 것은 없어요.');
  else toast.ok(title, '적용 대기에 들어갔어요. 적용해야 트래픽이 바뀌어요.');
  if (href !== undefined) void goto(href);
};

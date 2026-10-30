import { goto } from '$app/navigation';

/** 저장(commit)이 끝나면 적용 대기 화면으로 간다 — 저장은 아직 트래픽이 아니다. */
export const after = (ok: boolean): void => {
  if (ok) void goto('/change/pending');
};

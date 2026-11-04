<script lang="ts">
  /**
   * 라우트 설정 탭의 아래 줄 — 콘솔 시안 `tSet` 블록: 안내 · 「되돌리기」 · 「저장」(32px). 안내 문구와 색은 시안 `hintTxt` 그대로:
   * 오류가 있으면 「✕ 오류가 있는 항목을 고쳐요」(위험 색), 바꿨으면 「저장하면 커밋하고 적용 대기에 새 리비전이 생겨요.」(보라),
   * 적용 대기면 「◐ 적용 대기 중인 변경이 있어요.」, 아니면 「바뀐 값이 없어요.」(흐린 색).
   * 「저장」 은 폼을 보낸다(`type="submit"`). 바꾼 것이 없으면 잠기고 흐리다(opacity .5).
   */
  import { Button } from '#lib/ui';

  let { dirty, invalid, pending, saving, onrevert }: {
    dirty: boolean; invalid: boolean; pending: boolean; saving: boolean; onrevert: () => void;
  } = $props();
  const hint = $derived(invalid ? '✕ 오류가 있는 항목을 고쳐요' : dirty ? '저장하면 커밋하고 적용 대기에 새 리비전이 생겨요.'
    : pending ? '◐ 적용 대기 중인 변경이 있어요.' : '바뀐 값이 없어요.');
  const color = $derived(invalid ? 'var(--danger)' : dirty ? 'var(--pending)' : 'var(--tx3)');
</script>

<div class="foot">
  <span class="hint" style:color>{hint}</span>
  <Button disabled={!dirty || saving} onclick={onrevert}>되돌리기</Button>
  <span class="sv" data-off={!dirty}><Button variant="primary" type="submit" loading={saving} disabled={!dirty}>{saving ? '저장 중' : '저장'}</Button></span>
</div>

<style>
  .foot { display: flex; align-items: center; gap: 10px; padding-top: 12px; border-top: 1px solid var(--bd); flex-wrap: wrap; }
  .hint { flex: 1; font-size: 12px; }
  .sv[data-off='true'] :global(.btn:disabled) { border-color: var(--accent); background: var(--accent); color: var(--accent-fg); opacity: .5; }
</style>

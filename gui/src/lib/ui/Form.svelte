<script lang="ts">
  /**
   * 폼 틀 — 디자인 시스템 §3 「폼 레이아웃」. 라벨 200px · 입력 최대 560px 의 2열(좁으면 1열).
   * 입력 폭을 늘리지 않는다. 아래 버튼 줄은 `actions` 다. 「저장하면 커밋해요. 적용은 따로 해요.」
   */
  import type { Snippet } from 'svelte';
  let { children, actions, onsubmit, note }: {
    children: Snippet; actions?: Snippet; onsubmit?: (e: SubmitEvent) => void; note?: string;
  } = $props();
</script>

<form class="form" onsubmit={(e) => { e.preventDefault(); onsubmit?.(e); }}>
  {@render children()}
  {#if actions}
    <div class="actions">
      {@render actions()}
      {#if note}<span class="note">{note}</span>{/if}
    </div>
  {/if}
</form>

<style>
  .form { max-width: 860px; display: flex; flex-direction: column; gap: 20px; }
  .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding-top: 16px; border-top: 1px solid var(--bd); }
  .note { font: var(--t-cap); color: var(--tx3); margin-left: 8px; }
</style>

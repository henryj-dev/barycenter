<script lang="ts">
  /**
   * 폼 틀 — 디자인 시스템 §3 「폼 레이아웃」. 라벨 200px · 입력 최대 560px 의 2열(좁으면 1열).
   * 입력 폭을 늘리지 않는다. 아래 버튼 줄은 `actions` 다. 「저장하면 커밋해요. 적용은 따로 해요.」
   */
  import type { Snippet } from 'svelte';
  import { formLayout } from './form-layout.ts';
  let { children, actions, onsubmit, note, id }: {
    children: Snippet; actions?: Snippet; onsubmit?: (e: SubmitEvent) => void; note?: string;
    /** 폼 밖의 버튼(드로어 아래 줄)이 `form={id}` 로 이 폼을 보낸다. */
    id?: string;
  } = $props();
  /** 드로어 · 인라인 수정 안이면 구획 사이 16px(콘솔). */
  const compact = formLayout() === 'compact';
</script>

<form class="form" class:compact {id} onsubmit={(e) => { e.preventDefault(); onsubmit?.(e); }}>
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
  .form.compact { gap: 16px; }
  .actions { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding-top: 16px; border-top: 1px solid var(--bd); }
  .note { font: var(--t-cap); color: var(--tx3); margin-left: 8px; }
</style>

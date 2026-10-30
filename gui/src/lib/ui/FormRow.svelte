<script lang="ts">
  /**
   * 폼 한 줄 — 라벨 · 입력 · (오류 또는 도움말). `FormSection` 의 2열 격자 안에서 쓴다.
   * `for` 는 입력의 id 다. 입력이 여럿이면(바인드 + 포트) 첫 칸의 id 를 준다.
   */
  import type { Snippet } from 'svelte';
  import FieldMessage from './FieldMessage.svelte';
  let { label, for: htmlFor, required = false, error, help, children }: {
    label: string; for?: string; required?: boolean; error?: string; help?: string; children: Snippet;
  } = $props();
</script>

<label class="lbl" for={htmlFor}>{label}{#if required}<span class="req" aria-hidden="true"> *</span>{/if}</label>
<div class="ctl">
  {@render children()}
  {#if error}<FieldMessage tone="error">{error}</FieldMessage>{:else if help}<FieldMessage>{help}</FieldMessage>{/if}
</div>

<style>
  .lbl { padding-top: 6px; font: var(--t-small); color: var(--tx); }
  .req { color: var(--danger); }
  .ctl { min-width: 0; }
  @media (max-width: 720px) { .lbl { padding-top: 8px; } }
</style>

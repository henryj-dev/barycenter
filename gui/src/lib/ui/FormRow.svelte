<script lang="ts">
  /**
   * 폼 한 줄 — 라벨 · 입력 · (오류 또는 도움말). `FormSection` 의 2열 격자 안에서 쓴다.
   * `for` 는 입력의 id 다. 입력이 여럿이면(바인드 + 포트) 첫 칸의 id 를 준다.
   * `warn` 이면 도움말이 경고 색이고 입력 테두리도 경고 색이다 — 콘솔 `fieldsFor` 의 `o.warn`(`f.hc` · `f.bd` = --warn).
   */
  import type { Snippet } from 'svelte';
  import FieldMessage from './FieldMessage.svelte';
  import { formLayout } from './form-layout.ts';
  let { label, for: htmlFor, required = false, error, help, warn = false, children }: {
    label: string; for?: string; required?: boolean; error?: string; help?: string;
    /** 도움말을 경고 톤으로(시안 `warn`). 오류가 있으면 오류가 이긴다. */
    warn?: boolean; children: Snippet;
  } = $props();
  /** 드로어 · 인라인 수정 안이면 라벨이 흐린색(`--tx2`)이다 — 콘솔 `fieldsFor` 마크업. */
  const compact = formLayout() === 'compact';
</script>

<label class="lbl" class:compact for={htmlFor}>{label}{#if required}<span class="req" aria-hidden="true"> *</span>{/if}</label>
<div class="ctl" data-warn={warn && !error ? true : undefined}>
  {@render children()}
  {#if error}<FieldMessage tone="error">{error}</FieldMessage>{:else if help}<FieldMessage tone={warn ? 'warn' : 'help'}>{help}</FieldMessage>{/if}
</div>

<style>
  .lbl { padding-top: 6px; font: var(--t-small); color: var(--tx); }
  .lbl.compact { color: var(--tx2); }
  .req { color: var(--danger); }
  .ctl { min-width: 0; }
  /* 시안 `f.bd`: 경고면 입력 테두리가 --warn 이다(단위 상자 안의 입력은 상자가 테두리를 진다). */
  .ctl[data-warn] > :global(input.in), .ctl[data-warn] :global(.box), .ctl[data-warn] :global(.num),
  .ctl[data-warn] :global(.ta), .ctl[data-warn] :global(.trigger) { border-color: var(--warn); }
  @media (max-width: 720px) { .lbl { padding-top: 8px; } }
</style>

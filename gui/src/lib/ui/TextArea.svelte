<script lang="ts">
  /**
   * 여러 줄 입력 — 디자인 시스템 §3. `TextInput` 과 같은 테두리·색이다. PEM 처럼 붙여 넣는 값을 받는다.
   * 줄마다 검사하는 목록이면 `ListInput` 을 쓴다.
   */
  import type { HTMLTextareaAttributes } from 'svelte/elements';

  let { value = $bindable(''), invalid = false, mono = true, rows = 6, ...rest }: {
    value?: string;
    invalid?: boolean;
    mono?: boolean;
    rows?: number;
  } & Omit<HTMLTextareaAttributes, 'value' | 'rows'> = $props();
</script>

<textarea class="ta" class:mono {rows} spellcheck="false" aria-invalid={invalid || undefined} bind:value {...rest}></textarea>

<style>
  .ta {
    display: block;
    width: 100%;
    min-width: 0;
    padding: 6px 10px;
    background: var(--bg-input);
    border: 1px solid var(--bd-strong);
    border-radius: var(--r-md);
    color: var(--tx);
    font: 400 13px/20px var(--font);
    resize: vertical;
    transition: border-color var(--dur-fast) var(--ease);
  }
  .ta.mono { font-family: var(--mono); white-space: pre; }
  .ta::placeholder { color: var(--tx3); }
  .ta:not(:disabled):hover { border-color: var(--tx3); }
  .ta:focus { outline: 2px solid var(--focus); outline-offset: 0; }
  .ta[aria-invalid='true'] { border-color: var(--danger); }
  .ta:disabled { background: var(--bg-hover); border-color: var(--bd); color: var(--tx3); cursor: not-allowed; }
</style>

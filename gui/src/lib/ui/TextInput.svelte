<script lang="ts">
  /**
   * 텍스트 입력 — 디자인 시스템 §3. 높이 32 · 고정폭 글꼴(값은 대개 주소·이름이다).
   * `invalid` 면 테두리가 위험 색이다. 오류 문구는 `FieldMessage` 가 한다.
   */
  import type { HTMLInputAttributes } from 'svelte/elements';

  let { value = $bindable(''), invalid = false, mono = true, width, ...rest }: {
    value?: string | number;
    invalid?: boolean;
    /** 사람 말(설명·이름)을 받는 칸이면 false. */
    mono?: boolean;
    width?: string;
  } & Omit<HTMLInputAttributes, 'value'> = $props();
</script>

<input class="in" class:mono aria-invalid={invalid || undefined} style:width bind:value {...rest} />

<style>
  .in {
    width: 100%;
    min-width: 0;
    height: 32px;
    padding: 0 10px;
    background: var(--bg-input);
    border: 1px solid var(--bd-strong);
    border-radius: var(--r-md);
    color: var(--tx);
    font: 400 13px/1 var(--font);
    transition: border-color var(--dur-fast) var(--ease);
  }
  .in.mono { font-family: var(--mono); }
  .in::placeholder { color: var(--tx3); }
  .in:not(:disabled):hover { border-color: var(--tx3); }
  .in:focus { outline: 2px solid var(--focus); outline-offset: 0; }
  .in[aria-invalid='true'] { border-color: var(--danger); }
  .in:disabled { background: var(--bg-hover); border-color: var(--bd); color: var(--tx3); cursor: not-allowed; }
</style>

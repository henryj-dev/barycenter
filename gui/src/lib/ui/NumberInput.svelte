<script lang="ts">
  /** 숫자 + 단위 — 디자인 시스템 §3. 단위 칸이 오른쪽에 붙는다(s · ms · m · MB …). */
  import type { HTMLInputAttributes } from 'svelte/elements';

  let { value = $bindable(), unit, label, invalid = false, width = '72px', ...rest }: {
    value?: number | string;
    unit?: string;
    /** 단위만 보이는 칸이라 스크린 리더용 이름이 필요하다. */
    label: string;
    invalid?: boolean;
    width?: string;
  } & Omit<HTMLInputAttributes, 'value' | 'type'> = $props();
</script>

<span class="num" aria-invalid={invalid || undefined} data-disabled={rest.disabled === true}>
  <input type="number" aria-label={label} bind:value style:width {...rest} />
  {#if unit}<span class="unit">{unit}</span>{/if}
</span>

<style>
  .num {
    display: inline-flex;
    height: 32px;
    border: 1px solid var(--bd-strong);
    border-radius: var(--r-md);
    overflow: hidden;
    background: var(--bg-input);
    transition: border-color var(--dur-fast) var(--ease);
  }
  .num:hover { border-color: var(--tx3); }
  .num:focus-within { outline: 2px solid var(--focus); outline-offset: 0; }
  .num[aria-invalid='true'] { border-color: var(--danger); }
  .num[data-disabled='true'] { background: var(--bg-hover); border-color: var(--bd); }
  input {
    border: 0;
    background: transparent;
    padding: 0 10px;
    color: var(--tx);
    font: 400 13px/1 var(--mono);
    text-align: right;
    outline: none;
    min-width: 0;
  }
  input:disabled { color: var(--tx3); cursor: not-allowed; }
  .unit {
    padding: 0 10px;
    display: grid;
    place-items: center;
    background: var(--bg-hover);
    border-left: 1px solid var(--bd);
    color: var(--tx2);
    font: 400 12px/1 var(--mono);
  }
</style>

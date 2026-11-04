<script lang="ts">
  /**
   * 텍스트 입력 — 디자인 시스템 §3. 높이 32 · 고정폭 글꼴(값은 대개 주소·이름이다).
   * `invalid` 면 테두리가 위험 색이다. 오류 문구는 `FieldMessage` 가 한다.
   * `unit` 이면 오른쪽에 단위 꼬리표가 붙는다 — 콘솔 `fieldsFor` 의 `f.unit`(s · MB · ms · req/s · 개 …):
   * 테두리 상자 안에 입력 + 꼬리표(0 10px · --bg-hover · 왼쪽 --bd 선 · --tx2 · 고정폭 12px).
   */
  import type { HTMLInputAttributes } from 'svelte/elements';

  let { value = $bindable(''), invalid = false, mono = true, width, size = 'md', unit, ...rest }: {
    value?: string | number;
    invalid?: boolean;
    /** 사람 말(설명·이름)을 받는 칸이면 false. */
    mono?: boolean;
    width?: string;
    /** md 32px(기본) · sm 28px · 12px(콘솔 목록 도구 줄 · 작은 칸). */
    size?: 'md' | 'sm';
    /** 단위 꼬리표(시안 `unit`). 값에는 붙지 않는다 — 보이기만 한다. */
    unit?: string;
  } & Omit<HTMLInputAttributes, 'value'> = $props();
</script>

{#if unit}
  <span class="box" data-size={size} aria-invalid={invalid || undefined} data-disabled={rest.disabled === true} style:width>
    <input class="in" class:mono aria-invalid={invalid || undefined} bind:value {...rest} />
    <span class="unit" aria-hidden="true">{unit}</span>
  </span>
{:else}
  <input class="in" class:mono data-size={size} aria-invalid={invalid || undefined} style:width bind:value {...rest} />
{/if}

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
  .in[data-size='sm'] { height: 28px; font-size: 12px; }
  .in::placeholder { color: var(--tx3); }
  .in:not(:disabled):hover { border-color: var(--tx3); }
  .in:focus { outline: 2px solid var(--focus); outline-offset: 0; }
  .in[aria-invalid='true'] { border-color: var(--danger); }
  .in:disabled { background: var(--bg-hover); border-color: var(--bd); color: var(--tx3); cursor: not-allowed; }

  /* 단위 꼬리표가 있으면 테두리는 바깥 상자가 진다(시안 `f.dText` 상자). */
  .box {
    display: flex;
    width: 100%;
    min-width: 0;
    height: 32px;
    border: 1px solid var(--bd-strong);
    border-radius: var(--r-md);
    overflow: hidden;
    background: var(--bg-input);
    transition: border-color var(--dur-fast) var(--ease);
  }
  .box[data-size='sm'] { height: 28px; }
  .box[data-size='sm'] .in { font-size: 12px; }
  .box .in { flex: 1; height: 100%; border: 0; border-radius: 0; background: transparent; }
  .box .in:focus { outline: none; }
  .box:not([data-disabled='true']):hover { border-color: var(--tx3); }
  .box:focus-within { outline: 2px solid var(--focus); outline-offset: 0; }
  .box[aria-invalid='true'] { border-color: var(--danger); }
  .box[data-disabled='true'] { background: var(--bg-hover); border-color: var(--bd); }
  .unit {
    flex: none;
    display: grid;
    place-items: center;
    padding: 0 10px;
    background: var(--bg-hover);
    border-left: 1px solid var(--bd);
    color: var(--tx2);
    font: 400 12px/1 var(--mono);
  }
</style>

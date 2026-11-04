<script lang="ts">
  /**
   * 찾기 칸 — 「⌕」 + 입력 + (값이 있으면) 「✕」.
   * `sm`(기본, 콘솔 목록 도구 줄): 높이 28px · 폭 240px · 12px. `md`(디자인 시스템 §4 견본): 32px · 260px · 13px.
   * 화면은 날 `<input>` 을 그리지 않고 이것을 쓴다(`ui-adoption` 시험).
   */
  let { value = $bindable(''), placeholder = '이름·주소로 찾기', label = '찾기', size = 'sm', width, oninput }: {
    value?: string;
    placeholder?: string;
    /** 스크린 리더 이름. */
    label?: string;
    size?: 'sm' | 'md';
    width?: string;
    oninput?: (v: string) => void;
  } = $props();
</script>

<div class="search" data-size={size} style:width>
  <span aria-hidden="true">⌕</span>
  <input aria-label={label} {placeholder} bind:value oninput={() => oninput?.(value)} />
  {#if value !== ''}<button type="button" class="clr" aria-label="지우기" onclick={() => { value = ''; oninput?.(''); }}>✕</button>{/if}
</div>

<style>
  .search {
    display: flex; align-items: center; gap: 8px; height: 28px; width: 240px; max-width: 100%; padding: 0 10px;
    background: var(--bg-input); border: 1px solid var(--bd-strong); border-radius: var(--r-md); color: var(--tx3); font-size: 12px;
  }
  .search[data-size='md'] { height: 32px; width: 260px; font-size: 13px; }
  .search:focus-within { outline: 2px solid var(--focus); outline-offset: -2px; }
  input { flex: 1; min-width: 0; border: 0; background: transparent; color: var(--tx); font: inherit; font-family: var(--font); outline: none; height: 24px; padding: 0; }
  .search[data-size='md'] input { height: 28px; }
  input::placeholder { color: var(--tx3); }
  .clr { border: 0; background: transparent; color: var(--tx3); padding: 0 2px; }
</style>

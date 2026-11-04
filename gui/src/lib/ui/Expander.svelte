<script lang="ts">
  /**
   * 접는 머리 버튼 — 「▸ 포함된 커밋 · 3」 · 「▾ 영향 없음 · 4건」 · 접는 폼 구획 제목.
   * 콘솔 시안 그대로 글자 버튼이다(테두리 · 배경 없음, 12px 600). `aria-expanded` 를 단다.
   * `tone` 은 글자 색(영향 없음은 ok). `block` 이면 폭을 다 쓰고 아래 줄을 긋는다(시안 `sec.foldD` 접는 구획 제목).
   * 내용은 부르는 쪽이 `{#if open}` 으로 그린다.
   */
  import type { Snippet } from 'svelte';
  import type { Tone } from './tone.ts';
  let { open = $bindable(false), tone, block = false, ontoggle, children }: {
    open?: boolean;
    tone?: Tone;
    block?: boolean;
    ontoggle?: (open: boolean) => void;
    children: Snippet;
  } = $props();
</script>

<button type="button" class="ex" class:block aria-expanded={open} style:color={tone === undefined ? undefined : `var(--${tone})`}
  onclick={() => { open = !open; ontoggle?.(open); }}>{open ? '▾' : '▸'} {@render children()}</button>

<style>
  .ex { border: 0; background: transparent; padding: 0; font: 600 12px/16px var(--font); color: var(--tx2); text-align: left; }
  .ex.block { width: 100%; border-bottom: 1px solid var(--bd); padding: 0 0 6px; margin-bottom: 10px; letter-spacing: .4px; }
</style>

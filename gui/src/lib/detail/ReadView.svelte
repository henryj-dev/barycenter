<script lang="ts">
  /**
   * 쓸 수 없는 설정 탭 — 콘솔 시안 `tSetView` 블록 그대로(최대 900px · 사이 14px):
   * 까닭 한 줄(시안 `roMsg`, 13px · --tx2) → 읽기 구획(`ViewSections`) → 「이 지역에서 열기 ↗」 · 「리더(…)에서 열기 ↗」(32px, 강조 테두리).
   * 갈 주소를 모르면 버튼을 안 그린다. 전체 합산(지역을 안 골랐다)이면 버튼 자리에 「지역 고르기」 를 둔다(시안 밖 — 있던 길).
   */
  import { getContext, type Snippet } from 'svelte';
  import { page } from '$app/state';
  import { Button } from '#lib/ui';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import { blockedMessage, openIn } from '#lib/global/open-in.ts';
  import ViewSections, { type ViewSection } from './ViewSections.svelte';

  let { sections, children }: { sections: readonly ViewSection[]; children?: Snippet } = $props();
  const scope = getContext<Scope | undefined>('scope');
  const msg = $derived(blockedMessage(scope));
  const open = $derived(openIn(scope, page.url.pathname));
</script>

<div class="view">
  {#if msg !== undefined}<div class="msg" role="status">{msg}</div>{/if}
  <ViewSections {sections} />
  {#if open !== undefined}
    <div><Button outline="accent" href={open.href} target="_blank" rel="noopener">{open.label}</Button></div>
  {:else if scope?.aggregate === true}
    <div><Button href="/regions">지역 고르기</Button></div>
  {/if}
  {#if children}{@render children()}{/if}
</div>

<style>
  /* 값은 콘솔 시안 `tSetView` 블록의 인라인 style 그대로다. */
  .view { display: flex; flex-direction: column; gap: 14px; max-width: 900px; }
  .msg { font-size: 13px; color: var(--tx2); }
</style>

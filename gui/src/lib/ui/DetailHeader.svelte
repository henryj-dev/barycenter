<script lang="ts">
  /**
   * 상세 페이지 머리 — 디자인 시스템 §5 「상세 페이지 패턴」.
   * 경로(목록 / 이름) · 제목(고정폭) · 상태 배지 · 오른쪽 버튼 · 메타 줄(발급자 · 만료 · 사용처 …) · 탭.
   */
  import type { Snippet } from 'svelte';
  import Tabs, { type TabItem } from './Tabs.svelte';

  let { crumbs, title, badges, actions, meta = [], tabs, currentTab = '', tabLabel = '상세' }: {
    crumbs: readonly { label: string; href?: string }[];
    title: string;
    badges?: Snippet;
    actions?: Snippet;
    meta?: readonly { label: string; value: string; mono?: boolean }[];
    tabs?: readonly TabItem[];
    currentTab?: string;
    tabLabel?: string;
  } = $props();
</script>

<header class="dh">
  <nav class="crumb" aria-label="경로">
    {#each crumbs as c, i (i)}
      {#if i > 0}<span aria-hidden="true">/</span>{/if}
      {#if c.href}<a href={c.href}>{c.label}</a>{:else}<span class="here">{c.label}</span>{/if}
    {/each}
  </nav>
  <div class="row">
    <h1>{title}</h1>
    {#if badges}{@render badges()}{/if}
    <div class="grow"></div>
    {#if actions}<div class="act">{@render actions()}</div>{/if}
  </div>
  {#if meta.length > 0}
    <div class="meta">
      {#each meta as m (m.label)}<span>{m.label} <b class:mono={m.mono}>{m.value}</b></span>{/each}
    </div>
  {/if}
  {#if tabs}<div class="tabs"><Tabs items={tabs} current={currentTab} label={tabLabel} /></div>{/if}
</header>

<style>
  .dh { padding: 14px 20px 0; background: var(--bg-panel); border-bottom: 1px solid var(--bd); }
  .crumb { font: var(--t-cap); color: var(--tx3); display: flex; gap: 6px; flex-wrap: wrap; }
  .here { color: var(--tx2); }
  .row { display: flex; align-items: center; gap: 12px; margin-top: 8px; flex-wrap: wrap; }
  h1 { margin: 0; font: 700 22px/30px var(--mono); overflow-wrap: anywhere; }
  .grow { flex: 1; }
  .act { display: flex; gap: 8px; flex-wrap: wrap; }
  .meta { display: flex; gap: 24px; margin: 12px 0 0; font: var(--t-cap); color: var(--tx3); flex-wrap: wrap; }
  .meta b { color: var(--tx); font-weight: 500; }
  .mono { font-family: var(--mono); }
  .tabs { margin-top: 8px; }
  .dh:not(:has(.tabs)) { padding-bottom: 14px; }
</style>

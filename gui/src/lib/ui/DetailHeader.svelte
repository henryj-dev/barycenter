<script lang="ts">
  /**
   * 상세 페이지 머리 — 콘솔 「Detail page」 마크업(디자인 시스템 §5 와 다르면 콘솔이 이긴다).
   * 머리 줄 `padding:14px 20px 0 · gap:10px`: 제목(고정폭 18px · 600) · 상태 배지 · 빈 칸 · 오른쪽 버튼(28px, 화면이 그린다).
   * 탭 줄 `padding:8px 20px 0 · 아래 --bd 선`(수 배지).
   * 경로 줄은 콘솔 상세에 없다 — 경로는 위 막대(TopBar)가 그린다. `crumbs` 는 시안 밖 하위 화면(URL로 다시 만들기)이
   * 상세로 돌아갈 길이 필요할 때만 준다.
   * 메타 줄(디자인 시스템 §5 「발급자 <b>ACME</b>  만료 <b>2026-11-10</b>  사용처 <b>리스너 2 · SNI 3</b>」)은 시안이 그 리소스에
   * 둔 곳(인증서)만 준다 — 라벨은 흐린 12px, 값은 기본색 500(날짜 · 주소 · 수는 `mono`). 비우면 줄을 안 그린다.
   */
  import type { Snippet } from 'svelte';
  import Tabs, { type TabItem } from './Tabs.svelte';

  let { crumbs = [], title, badges, actions, meta = [], tabs, currentTab = '', tabLabel = '상세' }: {
    crumbs?: readonly { label: string; href?: string }[];
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
  {#if crumbs.length > 0}
    <nav class="crumb" aria-label="경로">
      {#each crumbs as c, i (i)}
        {#if i > 0}<span aria-hidden="true">/</span>{/if}
        {#if c.href}<a href={c.href}>{c.label}</a>{:else}<span class="here">{c.label}</span>{/if}
      {/each}
    </nav>
  {/if}
  <div class="row">
    <h1>{title}</h1>
    {#if badges}{@render badges()}{/if}
    <div class="grow"></div>
    {#if actions}{@render actions()}{/if}
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
  .crumb { font: var(--t-cap); color: var(--tx3); display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  .here { color: var(--tx2); }
  /* 콘솔: display:flex · gap:10px · align-items:center · flex-wrap:wrap. 버튼도 이 줄의 간격을 쓴다. */
  .row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
  /* 콘솔: font-family:var(--mono) · font-size:18px · font-weight:600. */
  h1 { margin: 0; font: 600 18px/26px var(--mono); overflow-wrap: anywhere; }
  .grow { flex: 1; }
  .meta { display: flex; gap: 24px; margin: 12px 0 0; font: var(--t-cap); color: var(--tx3); flex-wrap: wrap; }
  .meta b { color: var(--tx); font-weight: 500; }
  .mono { font-family: var(--mono); }
  /* 콘솔 탭 줄: padding:8px 20px 0 — 머리의 좌우 20px 안이라 위 8px 만 둔다. */
  .tabs { margin-top: 8px; }
  .dh:not(:has(.tabs)) { padding-bottom: 14px; }
</style>

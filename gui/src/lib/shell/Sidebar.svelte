<script lang="ts">
  /**
   * 사이드바 — 디자인 시안 「App Shell」. 제품명과 지금 지역, 그 아래 메뉴 그룹. 접으면 아이콘만(56px).
   * 적용 대기 항목에 건수 배지. 전역 모드면 클러스터를 숨기고, 아래에 지역 상자를 둔다.
   */
  import { NAV_GROUPS } from '@web/nav';
  import type { Place } from '@web/page';

  let { place, collapsed = $bindable(false), pending = 0, global = false, regionLabel, regionHref }: {
    place: Place;
    collapsed?: boolean;
    pending?: number;
    global?: boolean;
    regionLabel: string;
    /** 전역 모드면 지역 고르기 화면. */
    regionHref?: string;
  } = $props();

  const groups = $derived(NAV_GROUPS.map((g) => ({ ...g, items: g.items.filter((i) => !(global && i.place === 'cluster')) })));
</script>

<aside class="sb" aria-label="주 메뉴" data-collapsed={collapsed}>
  <div class="brand">
    <span class="logo" aria-hidden="true">b</span>
    {#if !collapsed}<div class="name"><div>barycenter</div><div class="region">{regionLabel}</div></div>{/if}
  </div>
  <nav>
    {#each groups as g, gi (gi)}
      <div class="group">
        {#if g.title !== '' && !collapsed}<div class="gt">{g.title}</div>{/if}
        {#if collapsed && gi > 1}<div class="rule"></div>{/if}
        {#each g.items as it (it.place)}
          <a class="item" href={it.href} title={it.label} aria-current={place === it.place ? 'page' : undefined}>
            <span class="ic" aria-hidden="true">{it.icon}</span>
            {#if !collapsed}<span class="lb">{it.label}</span>{/if}
            {#if it.place === 'impact' && pending > 0}<span class="badge" aria-label="{pending}건">{pending}</span>{/if}
          </a>
        {/each}
      </div>
    {/each}
  </nav>
  {#if global && regionHref && !collapsed}
    <div class="regions">
      <div class="gt">지역</div>
      <a class="item" href={regionHref} aria-current={place === 'regions' ? 'page' : undefined}><span class="ic" aria-hidden="true">◎</span><span class="lb">지역 고르기</span></a>
      <div class="ro">전역 화면은 읽기만 해요.</div>
    </div>
  {/if}
  <div class="foot">
    <button type="button" aria-label={collapsed ? '메뉴 펼치기' : '메뉴 접기'} aria-expanded={!collapsed} onclick={() => { collapsed = !collapsed; }}>{collapsed ? '»' : '«'}</button>
    {#if !collapsed}<span>메뉴 접기</span>{/if}
  </div>
</aside>

<style>
  .sb {
    flex: none; width: 240px; background: var(--bg-panel); border-right: 1px solid var(--bd);
    display: flex; flex-direction: column; transition: width var(--dur) var(--ease); overflow: hidden; height: 100vh; position: sticky; top: 0;
  }
  .sb[data-collapsed='true'] { width: 56px; }
  .brand { height: 52px; flex: none; display: flex; align-items: center; gap: 10px; padding: 0 14px; border-bottom: 1px solid var(--bd); }
  .logo { flex: none; width: 28px; height: 28px; border-radius: var(--r-md); background: var(--accent); color: var(--accent-fg); display: grid; place-items: center; font: 700 14px/1 var(--font); }
  .name { min-width: 0; font: 700 14px/18px var(--font); }
  .region { font: 400 11px/14px var(--mono); color: var(--tx3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  nav { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 8px; }
  .group { margin-bottom: 8px; }
  .gt { padding: 8px 10px 4px; font: 600 11px/14px var(--font); letter-spacing: .5px; color: var(--tx3); }
  .rule { height: 1px; background: var(--bd); margin: 6px 8px; }
  .item {
    width: 100%; height: 34px; display: flex; align-items: center; gap: 10px; padding: 0 10px; border-radius: var(--r-md);
    color: var(--tx2); font: 400 13px/1 var(--font); text-decoration: none; position: relative;
  }
  .sb[data-collapsed='true'] .item { justify-content: center; padding: 0; }
  .item:hover { background: var(--bg-hover); color: var(--tx); text-decoration: none; }
  .item[aria-current='page'] { background: var(--bg-sel); color: var(--tx); font-weight: 600; box-shadow: inset 3px 0 0 var(--accent); }
  .ic { flex: none; width: 18px; text-align: center; font-size: 14px; color: var(--tx3); }
  .item[aria-current='page'] .ic { color: var(--accent); }
  .lb { flex: 1; text-align: left; white-space: nowrap; }
  .badge {
    min-width: 20px; height: 18px; padding: 0 6px; border-radius: 9px; background: var(--pending); color: var(--accent-fg);
    font: 700 11px/18px var(--font); text-align: center;
  }
  /* 접으면 아이콘 오른쪽 위 모서리에 작게 — 아이콘을 덮지 않는다 */
  .sb[data-collapsed='true'] .badge { position: absolute; right: 0; top: 0; min-width: 14px; height: 14px; padding: 0 3px; font-size: 9px; line-height: 14px; }
  .regions { flex: none; padding: 8px; border-top: 1px solid var(--bd); }
  .ro { padding: 4px 10px 0; font: var(--t-cap); color: var(--tx3); }
  .foot { flex: none; border-top: 1px solid var(--bd); padding: 8px; display: flex; align-items: center; gap: 8px; }
  .sb[data-collapsed='true'] .foot { justify-content: center; }
  .foot button { width: 32px; height: 32px; border: 1px solid var(--bd-strong); background: transparent; color: var(--tx2); border-radius: var(--r-md); font-size: 13px; }
  .foot span { font: var(--t-cap); color: var(--tx3); }
</style>

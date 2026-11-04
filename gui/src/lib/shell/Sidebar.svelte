<script lang="ts" module>
  import type { Tone } from '#lib/ui';
  /** 지역 상자의 한 줄 — 셸이 지역 요약(`/api/v1/regions`)으로 만든다. */
  export type SideRegion = { name: string; current: boolean; tone: Tone; icon: string; text: string; pickable: boolean };
</script>

<script lang="ts">
  /**
   * 사이드바 — 디자인 시안 「App Shell」. 제품명과 지금 지역, 그 아래 메뉴 그룹. 접으면 아이콘만(56px).
   * 적용 대기 항목에 건수 배지. 전역 모드면 클러스터를 숨기고, 아래에 지역 상자를 둔다.
   *
   * 지역 상자(시안 `regionList`): 「지역 · N곳」 머리, 첫 줄 「◎ 전역 · 전체 합산」, 그 아래 지역마다 한 줄 — 상태 표시
   * (● 대기 N · ○ 연락 없음 · ✕ 인증 거절). 지역 줄을 누르면 그 지역만 좁혀 본다. 「◎ 전역」 을 누르면 다시 합산이다
   * (2026-11-04, docs/design-global-mode.md §2.5). 연락 없거나 인증이 거절된 지역은 못 고른다. 접으면 작은 상자 하나(→ 지역 화면).
   * 아래 한 줄은 쓰기 여부다: 합산이면 행마다 그 행의 지역에 쓰고(만들 때는 지역을 고른다), 좁혀 보면 그 지역에 바로 쓴다.
   */
  import { NAV_GROUPS } from '@web/nav';
  import type { Place } from '@web/page';

  let { place, collapsed = $bindable(false), pending = 0, global = false, regionLabel, regionHref, regions = [], chosen, onpick, onwiden }: {
    place: Place;
    collapsed?: boolean;
    pending?: number;
    global?: boolean;
    regionLabel: string;
    /** 전역 모드면 지역 고르기 화면. */
    regionHref?: string;
    regions?: readonly SideRegion[];
    /** 전역에서 좁혀 보는 지역. 없으면 전체 합산이다. */
    chosen?: string;
    onpick?: (name: string) => void;
    /** 「◎ 전역 · 전체 합산」 을 눌렀다 — 좁혀 보기를 푼다. */
    onwiden?: () => void;
  } = $props();
  const aggregate = $derived(chosen === undefined);

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
    <div class="regions" role="group" aria-label="지역">
      <a class="rh" href={regionHref} aria-current={place === 'regions' ? 'page' : undefined}>지역 · {regions.length}곳</a>
      <div class="rl">
        <button type="button" class="rg" aria-current={aggregate ? 'true' : undefined} title="전역 지역으로 이동"
          onclick={() => { if (!aggregate) onwiden?.(); }}>
          <span style:color="var(--info)" aria-hidden="true">◎</span><span class="rn">전역</span><span class="rv">전체 합산</span>
        </button>
        {#each regions as r (r.name)}
          <button type="button" class="rg" aria-current={r.current ? 'true' : undefined} disabled={!r.pickable && !r.current}
            title={r.pickable || r.current ? `${r.name} 지역으로 이동` : `${r.name} — ${r.text}`}
            onclick={() => { if (!r.current && r.pickable) onpick?.(r.name); }}>
            <span style:color="var(--{r.tone})" aria-hidden="true">{r.icon}</span><span class="rn">{r.name}</span><span class="rv">{r.text}</span>
          </button>
        {/each}
      </div>
      <div class="ro">{aggregate ? '행을 고치면 그 행의 지역에 써요. 만들 때는 지역을 골라요.' : '고른 지역에 바로 써요.'}</div>
    </div>
  {:else if global && regionHref}
    <div class="regions mini">
      <a class="item" href={regionHref} title={chosen === undefined ? '전체 합산 — 지역 화면' : `지역: ${chosen} — 다른 지역 고르기`} aria-label={chosen === undefined ? '전체 합산 · 지역 화면' : `지역 ${chosen}`}
        aria-current={place === 'regions' ? 'page' : undefined}><span class="ic" aria-hidden="true">◎</span></a>
    </div>
  {/if}
  <div class="foot">
    <button type="button" aria-label={collapsed ? '메뉴 펼치기' : '메뉴 접기'} aria-expanded={!collapsed} onclick={() => { collapsed = !collapsed; }}>{collapsed ? '»' : '«'}</button>
    {#if !collapsed}<span>메뉴 접기</span>{/if}
  </div>
</aside>

<style>
  /* 값은 시안(Console 셸 · App Shell)의 인라인 style 그대로다. */
  .sb {
    flex: none; width: 240px; background: var(--bg-panel); border-right: 1px solid var(--bd);
    display: flex; flex-direction: column; transition: width var(--dur) var(--ease); overflow: hidden; height: 100vh; position: sticky; top: 0;
  }
  .sb[data-collapsed='true'] { width: 56px; }
  .brand { height: 52px; flex: none; display: flex; align-items: center; gap: 10px; padding: 0 14px; border-bottom: 1px solid var(--bd); }
  .logo { flex: none; width: 28px; height: 28px; border-radius: var(--r-md); background: var(--accent); color: var(--accent-fg); display: grid; place-items: center; font-weight: 700; font-size: 14px; }
  .name { min-width: 0; }
  .name > div:first-child { font-weight: 700; font-size: 14px; line-height: 18px; }
  .region { font-family: var(--mono); font-size: 11px; color: var(--tx3); line-height: 14px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  nav { flex: 1; overflow-y: auto; overflow-x: hidden; padding: 8px 8px; }
  .group { margin-bottom: 8px; }
  .gt { padding: 8px 10px 4px; font-size: 11px; font-weight: 600; letter-spacing: .5px; color: var(--tx3); }
  .rule { height: 1px; background: var(--bd); margin: 6px 8px; }
  .item {
    width: 100%; height: 34px; display: flex; align-items: center; gap: 10px; padding: 0 10px; justify-content: flex-start;
    border: 0; border-radius: var(--r-md); background: transparent; color: var(--tx2); font-size: 13px; font-weight: 400;
    position: relative; box-shadow: none; text-decoration: none; white-space: nowrap;
    transition: background-color var(--dur-fast) var(--ease), filter var(--dur-fast) var(--ease);
  }
  .sb[data-collapsed='true'] .item { justify-content: center; padding: 0; }
  /* 시안의 버튼 hover — 배경 위에 얇은 막(--hov)을 덮는다. 글자색은 그대로다. */
  .item:hover { background-image: linear-gradient(var(--hov), var(--hov)); color: var(--tx2); text-decoration: none; }
  .item:active { filter: brightness(.9); }
  .item[aria-current='page'] { background-color: var(--bg-sel); color: var(--tx); font-weight: 600; box-shadow: inset 3px 0 0 var(--accent); }
  .ic { flex: none; width: 18px; text-align: center; font-size: 14px; color: var(--tx3); }
  .item[aria-current='page'] .ic { color: var(--accent); }
  .lb { flex: 1; text-align: left; }
  .badge {
    display: block; min-width: 20px; height: 18px; padding: 0 6px; border-radius: 9px; background: var(--pending); color: var(--accent-fg);
    font-size: 11px; font-weight: 700; line-height: 18px; position: static;
  }
  /* 접으면 아이콘 오른쪽 위(2px · 2px) — 크기는 그대로다 */
  .sb[data-collapsed='true'] .badge { position: absolute; right: 2px; top: 2px; }
  .regions { flex: none; padding: 8px; border-top: 1px solid var(--bd); }
  .regions:not(.mini) { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  .rh { font-size: 11px; color: var(--tx3); text-decoration: none; }
  .rh:hover, .rh[aria-current='page'] { color: var(--tx); text-decoration: none; }
  .rl { display: flex; flex-direction: column; gap: 4px; max-height: 180px; overflow-y: auto; }
  .rg {
    width: 100%; display: flex; align-items: center; gap: 8px; font-family: var(--mono); font-size: 12px; color: var(--tx2); font-weight: 400;
    border: 0; background: transparent; padding: 5px 6px; border-radius: var(--r-sm); text-align: left; box-shadow: none; white-space: nowrap;
  }
  .rg:hover:not(:disabled) { background: var(--bg-hover); color: var(--tx); }
  .rg[aria-current='true'] { color: var(--tx); font-weight: 700; background: var(--bg-sel); box-shadow: inset 3px 0 0 var(--accent); cursor: default; }
  .rg:disabled { cursor: not-allowed; }
  .rn { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; }
  .rv { font-size: 11px; color: var(--tx3); }
  .ro { font-size: 12px; line-height: 16px; color: var(--tx3); }
  .foot { flex: none; border-top: 1px solid var(--bd); padding: 8px; display: flex; align-items: center; gap: 8px; justify-content: flex-start; }
  .sb[data-collapsed='true'] .foot { justify-content: center; }
  .foot button { width: 32px; height: 32px; border: 1px solid var(--bd-strong); background: transparent; color: var(--tx2); border-radius: var(--r-md); font-size: 13px; }
  .foot button:hover { background-image: linear-gradient(var(--hov), var(--hov)); }
  .foot button:active { filter: brightness(.9); }
  .foot span { font-size: 12px; color: var(--tx3); }
</style>

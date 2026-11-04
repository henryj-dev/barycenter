<script lang="ts">
  /**
   * 연결된 리소스 탭 — 모든 리소스가 같다. 콘솔 시안 `tRel` · `relRows` 그대로:
   * 테두리 상자 안에 줄마다 종류(100px, 흐린색) · 이름(고정폭) · 설명(흐린색). 풀은 아래에 「소속 백엔드 · N」 표(시안 `subTabD`)를 더 둔다.
   *
   * 줄은 `relationRows` 가 만든다(탭 이름 옆의 수도 같은 함수 — 수가 줄 수와 같다). 문구는 리소스마다 시안 말이다.
   * 시안에 없는 기존 동작: 이름을 누르면 그 상세로 간다(같은 글 모양) · head 에 없는 대상은 이름 뒤에 위험 색 「— head 에 없어요」.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { itemsOf, resourcePath, type ResourceKind } from '@web/resources';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { DRAIN_MARK, HEALTH_MARK, backendDraining, backendHealth } from './facts';
  import { relationRows } from './relation-rows';

  let { kind }: { kind: ResourceKind } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const rows = $derived(relationRows(desk, kind, key));
  const members = $derived(kind !== 'pool' ? [] : itemsOf(desk.model, 'backend').filter((b) => b['pool'] === key).map((b) => {
    const k = String(b['key']);
    return { n: k, hp: `${String(b['host'])}:${String(b['port'])}`, w: String(b['weight'] ?? 1), m: backendDraining(desk, k) ? DRAIN_MARK : HEALTH_MARK[backendHealth(desk, k)] };
  }));
</script>

<div class="rel">
  {#each rows as r, i (i)}
    <div class="row">
      <span class="k">{r.k}</span>
      {#if r.href !== undefined}<a class="n" href={r.href}>{r.n}</a>{:else}<span class="n">{r.n}{#if r.missing} <span class="miss">— head 에 없어요</span>{/if}</span>{/if}
      <span class="note">{r.note}</span>
    </div>
  {/each}
  {#if rows.length === 0}<div class="row"><span class="none">연결된 리소스가 없어요.</span></div>{/if}
</div>

{#if kind === 'pool'}
  <div class="sub">
    <div class="st">소속 백엔드 · {members.length}</div>
    <div class="tbl">
      <div class="tr th"><span>이름</span><span>호스트:포트</span><span>가중치</span><span>헬스</span></div>
      {#each members as b (b.n)}
        <div class="tr">
          <a class="mono lnk" href={resourcePath('backend', b.n)}>{b.n}</a><span class="mono">{b.hp}</span><span class="mono">{b.w}</span>
          <span><span class="bdg" style:background="var(--{b.m.tone}-bg)" style:color="var(--{b.m.tone})">{b.m.icon} {b.m.text}</span></span>
        </div>
      {/each}
    </div>
  </div>
{/if}

<style>
  /* 값은 시안 `tRel` · `subTabD` 블록의 인라인 style 그대로다. */
  .rel { display: flex; flex-direction: column; border: 1px solid var(--bd); border-radius: var(--r-md); overflow: hidden; font-size: 13px; }
  .row { display: grid; grid-template-columns: 100px 1fr 1fr; gap: 12px; padding: 10px 14px; border-top: 1px solid var(--bd); }
  .k, .note, .none { color: var(--tx3); }
  .none { grid-column: 1 / -1; }
  .n { font-family: var(--mono); color: var(--tx); text-decoration: none; overflow-wrap: anywhere; }
  a.n:hover, .lnk:hover { text-decoration: underline; }
  .miss { font-family: var(--font); color: var(--danger); }
  .sub { display: flex; flex-direction: column; margin-top: 14px; }
  .st { font-size: 12px; font-weight: 600; color: var(--tx2); margin-bottom: 6px; }
  .tbl { border: 1px solid var(--bd); border-radius: var(--r-md); overflow: hidden; font-size: 13px; }
  .tr { display: grid; grid-template-columns: 1fr 1.4fr .6fr 1.2fr; gap: 12px; padding: 0 12px; height: var(--row-h); align-items: center; border-top: 1px solid var(--bd); }
  .tr.th { height: 28px; background: var(--bg-hover); font-size: 12px; font-weight: 600; color: var(--tx2); border-top: 0; }
  .mono { font-family: var(--mono); }
  .lnk { color: var(--tx); text-decoration: none; }
  .bdg { display: inline-flex; align-items: center; gap: 6px; height: 22px; padding: 0 8px; border-radius: var(--r-sm); font-size: 12px; font-weight: 500; }
</style>

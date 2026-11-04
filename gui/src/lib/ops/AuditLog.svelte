<script lang="ts">
  /**
   * 기록 — 누가 · 언제 · 무엇을 (`/api/v1/audit`, 시안 「기록」). 변경 하나(changeset create → patch → plan → commit → apply)를
   * 한 묶음으로 접고 펼친다. 묶는 규칙과 「자동 적용」 판정은 `audit.ts` 가 한다. 검색은 주체 · 동작 · 대상 · 리비전을 본다.
   *
   * **전체 합산**(전역에서 지역을 안 골랐다, 2026-11-04 · §2.5)이면 지역마다 붙은 desk 의 기록을 묶은 뒤 시각 순서(새것부터)로
   * 하나로 잇고 「지역」 열을 단다(사람 / 토큰 다음). 검색은 지역 이름도 본다. 빠진 지역은 목록 위에 한 줄씩 알린다(§2.4).
   */
  import { getContext } from 'svelte';
  import { Badge, Checkbox, FieldMessage, Skeleton, TextInput } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { useAggregate } from '#lib/global/use-aggregate.svelte.ts';
  import RegionNotices from '#lib/global/RegionNotices.svelte';
  import { clockText, groupAudit, whenText, type ChangeGroup } from './audit';
  import { mergeByTime } from './aggregate-view';
  import { titleOf, wantWhenVisible } from './change-titles.svelte';

  type Desk = ReturnType<typeof createDesk>;
  type Row = ChangeGroup & { region: string; rid: string };
  const desk = getContext<Desk>('desk');
  const agg = useAggregate();
  let q = $state('');
  const groupsOf = (d: Desk): ChangeGroup[] => groupAudit(d.audit.rows, d.status.pending.map((p) => p.revision));
  const groups = $derived<Row[]>(agg.on
    ? mergeByTime(agg.entries.filter((e) => e.state === 'ok').map((e) => ({ region: e.name, rows: groupsOf(e.desk) })), (g) => g.key, (g) => g.at)
    : groupsOf(desk).map((g) => ({ ...g, region: '', rid: g.key })));
  /**
   * 「작업」 · 「대상」 — changeset 이면 무엇을 바꿨는지(시안 `백엔드 demo-2 추가` · `pool web-pool`). 보이는 줄만 읽고,
   * 못 읽으면 「설정 변경」 그대로다. 합산이면 그 줄의 지역 desk 로 읽는다.
   */
  const srcOf = (g: Row): Desk | undefined => (agg.on ? agg.entries.find((e) => e.name === g.region)?.desk : desk);
  const described = (g: Row): { title: string; target: string } => {
    const src = srcOf(g);
    return (src === undefined ? undefined : titleOf(src, g.changeset?.id)) ?? { title: g.title, target: g.target };
  };
  const match = (g: Row, needle: string): boolean => g.region.toLowerCase().includes(needle) ||
    Object.values(described(g)).some((x) => x.toLowerCase().includes(needle)) ||
    g.steps.some((s) => [s.principal, s.action, s.subject ?? '', s.revision ?? ''].some((x) => x.toLowerCase().includes(needle)));
  /**
   * 시안의 기록은 변경만 보인다. 멤버십 슬롯 회수 · 옛 세대 정리 같은 데몬의 일은 숨겨 두고, 고르면 보인다 —
   * 운영에서 그 줄들이 변경 사이를 빽빽이 메웠다(실측).
   */
  let system = $state(false);
  const scoped = $derived(system ? groups : groups.filter((g) => g.change));
  const shown = $derived(q.trim() === '' ? scoped : scoped.filter((g) => match(g, q.trim().toLowerCase())));
</script>

{#if agg.on ? agg.listState.loading : !desk.live}
  <Skeleton height="240px" label="기록을 읽는 중" />
{:else}
  {#if agg.on}<RegionNotices notices={agg.notices} strip={false} />{/if}
  <!-- 시안 「기록」: 패널 하나 · 고정 머리 줄 · 변경 하나가 한 묶음(접기 · 펼치기). 찾기 · 데몬 작업 보기는 목록 화면의 도구 줄 자리다. -->
  <section class="list" aria-label="감사 기록">
    <div class="bar">
      <TextInput bind:value={q} mono={false} width="240px" placeholder="주체 · 동작 · 대상 검색" aria-label="필터" />
      <Checkbox bind:checked={system}>데몬 작업도 보기</Checkbox>
      <span class="grow"></span>
      <span class="count">{q.trim() === '' ? `${scoped.length}건` : `${shown.length} / ${scoped.length}건`}</span>
    </div>
    <div class="row head" aria-hidden="true">
      <span></span><span>시각</span><span>사람 / 토큰</span><span>작업</span><span>대상</span><span>리비전</span><span>결과</span>
    </div>
    {#if groups.length === 0 && agg.on && agg.listState.error !== undefined}
      <div class="empty"><FieldMessage tone="error">{agg.listState.error}</FieldMessage></div>
    {:else if groups.length === 0}
      <div class="empty">기록이 없어요.</div>
    {:else if shown.length === 0}
      <div class="empty">일치하는 기록이 없어요. 검색어를 바꿔요.</div>
    {/if}
    {#each shown as g (g.rid)}
      {@const src = srcOf(g)}
      {@const d = described(g)}
      <details class="g">
        <summary class="row" use:wantWhenVisible={{ src: src ?? desk, id: src === undefined ? undefined : g.changeset?.id, ver: g.changeset?.ver ?? '' }}>
          <span class="mk" aria-hidden="true"></span>
          <span class="time" title={g.at === undefined ? undefined : new Date(g.at).toLocaleString()}>{whenText(g.at)}</span>
          <span class="who">{g.who}</span>
          <!-- 시안 전역 기록에는 지역 열이 없다 — 합산이면 지역은 작업 칸의 title 이다. -->
          <span class="tt" title={agg.on ? `${d.title} · ${g.region}` : d.title}>{d.title}</span>
          <span class="tg" title={d.target}>{d.target}</span>
          <span class="rev">{g.revision === undefined ? '' : `r${g.revision}`}</span>
          <span>{#if g.result}<Badge tone={g.result.tone}>{g.result.text}</Badge>{/if}</span>
        </summary>
        <ol class="steps" aria-label="{d.title} 단계">
          {#each g.steps as s (s.id)}
            <li>
              <span class="st">{clockText(s.at)}</span>
              <span class="nm">{s.name}</span>
              <span class="ok">● 성공{#if s.note} · {s.note}{/if}{#if s.principal.replace(/^user:/, '') !== g.who}<span class="by"> · {s.principal.replace(/^user:/, '')}</span>{/if}{#if s.subject}<span class="by"> · <code>{s.subject}</code></span>{/if}</span>
            </li>
          {/each}
          {#if g.waiting}
            <li><span class="st">—</span><span class="nm">apply</span><span class="wait">◐ {g.waiting}<span class="by"> · <a href="/change/pending">적용 대기에서 영향을 봐요</a></span></span></li>
          {/if}
        </ol>
      </details>
    {/each}
  </section>
  <p class="note">감사 기록은 성공한 단계만 남겨요. 자동 적용은 커밋한 사람의 이름으로 apply 에 남아요.</p>
{/if}

<style>
  /* 시안: display:flex;flex:1;min-height:0;flex-direction:column;border:1px solid var(--bd);border-radius:var(--r-lg);background:var(--bg-panel);overflow:auto */
  .list { display: flex; flex: 1; min-height: 0; flex-direction: column; border: 1px solid var(--bd); border-radius: var(--r-lg); background: var(--bg-panel); overflow: auto; }
  /* 목록 화면의 도구 줄(시안 목록: padding 8px 12px · gap 8px · 아래 테두리 · 오른쪽 개수). */
  .bar { flex: none; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px 12px; border-bottom: 1px solid var(--bd); }
  .grow { flex: 1; }
  .count { font-size: 12px; color: var(--tx3); }
  .row {
    display: grid; grid-template-columns: 20px 110px 130px minmax(0, 1fr) 150px 56px 140px; gap: 12px;
    padding: 0 16px; height: var(--row-h); align-items: center; font-size: 13px; color: var(--tx);
  }
  .head {
    position: sticky; top: 0; z-index: 5; height: 32px; background: var(--bg-hover);
    border-bottom: 1px solid var(--bd); font-size: 12px; font-weight: 600; color: var(--tx2);
  }
  .g { border-bottom: 1px solid var(--bd); }
  summary { cursor: pointer; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
  .mk { color: var(--tx2); }
  .mk::before { content: '▸'; }
  .g[open] .mk::before { content: '▾'; }
  .time { font-family: var(--mono); font-size: 12px; color: var(--tx3); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .who { color: var(--tx2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tt { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tg { font-family: var(--mono); font-size: 12px; color: var(--tx2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rev { font-family: var(--mono); color: var(--accent); }
  /* 전체 합산 — 「지역」 열이 사람 / 토큰 다음에 든다. */
  .steps { list-style: none; margin: 0; display: flex; flex-direction: column; padding: 6px 16px 10px 56px; background: var(--bg-page); }
  .steps li { display: grid; grid-template-columns: 110px 160px 1fr; gap: 12px; height: 26px; align-items: center; font-size: 12px; }
  .st { font-family: var(--mono); color: var(--tx3); }
  .nm { font-family: var(--mono); color: var(--tx2); }
  .ok { color: var(--ok); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .wait { color: var(--pending); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .by { color: var(--tx3); }
  .by a { color: var(--accent); text-decoration: none; }
  .by a:hover { text-decoration: underline; }
  code { font-family: var(--mono); }
  .empty { padding: 24px; text-align: center; color: var(--tx3); font-size: 13px; }
  .note { margin: 0; font-size: 12px; color: var(--tx3); }
  @media (max-width: 900px) {
    .row { grid-template-columns: 20px 110px minmax(0, 1fr) 140px; }
    .row > :nth-child(3), .row > :nth-child(5), .row > :nth-child(6) { display: none; }
    .steps { padding-left: 16px; }
    .steps li { grid-template-columns: 80px 120px minmax(0, 1fr); }
  }
</style>

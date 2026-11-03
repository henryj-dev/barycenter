<script lang="ts">
  /**
   * 기록 — 누가 · 언제 · 무엇을 (`/api/v1/audit`, 시안 「기록」). 변경 하나(changeset create → patch → plan → commit → apply)를
   * 한 묶음으로 접고 펼친다. 묶는 규칙과 「자동 적용」 판정은 `audit.ts` 가 한다. 검색은 주체 · 동작 · 대상 · 리비전을 본다.
   */
  import { getContext } from 'svelte';
  import { Badge, FieldMessage, Skeleton, TextInput } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { clockText, groupAudit, whenText, type ChangeGroup } from './audit';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  let q = $state('');
  const groups = $derived(groupAudit(desk.audit.rows, desk.status.pending.map((p) => p.revision)));
  const match = (g: ChangeGroup, needle: string): boolean =>
    g.steps.some((s) => [s.principal, s.action, s.subject ?? '', s.revision ?? ''].some((x) => x.toLowerCase().includes(needle)));
  const shown = $derived(q.trim() === '' ? groups : groups.filter((g) => match(g, q.trim().toLowerCase())));
</script>

{#if !desk.live}
  <Skeleton height="240px" label="기록을 읽는 중" />
{:else}
  <div class="au">
    <div class="bar">
      <TextInput bind:value={q} mono={false} width="260px" placeholder="주체 · 동작 · 대상 검색" aria-label="필터" />
      <span class="grow"></span>
      <span class="count">{q.trim() === '' ? `${groups.length}건` : `${shown.length} / ${groups.length}건`}</span>
    </div>
    <section class="list" aria-label="감사 기록">
      <div class="row head" aria-hidden="true">
        <span></span><span>시각</span><span>사람 / 토큰</span><span>작업</span><span>대상</span><span>리비전</span><span>결과</span>
      </div>
      {#if groups.length === 0}
        <div class="empty"><FieldMessage>기록이 없어요.</FieldMessage></div>
      {:else if shown.length === 0}
        <div class="empty"><FieldMessage>일치하는 기록이 없어요. 검색어를 바꿔요.</FieldMessage></div>
      {/if}
      {#each shown as g (g.key)}
        <details class="g">
          <summary class="row">
            <span class="mk" aria-hidden="true"></span>
            <span class="time" title={g.at === undefined ? undefined : new Date(g.at).toLocaleString()}>{whenText(g.at)}</span>
            <span class="who">{g.who}</span>
            <span class="tt">{g.title}</span>
            <span class="tg" title={g.target}>{g.target}</span>
            <span class="rev">{g.revision === undefined ? '' : `r${g.revision}`}</span>
            <span>{#if g.result}<Badge tone={g.result.tone}>{g.result.text}</Badge>{/if}</span>
          </summary>
          <ol class="steps" aria-label="{g.title} 단계">
            {#each g.steps as s (s.id)}
              <li>
                <span class="time">{clockText(s.at)}</span>
                <span class="nm">{s.name}</span>
                <span class="ok">● 성공{#if s.note} · {s.note}{/if}</span>
                <span class="by">{s.principal}{#if s.subject} · <code>{s.subject}</code>{/if}</span>
              </li>
            {/each}
            {#if g.waiting}
              <li><span class="time">—</span><span class="nm">apply</span><span class="wait">◐ {g.waiting}</span><span class="by"><a href="/change/pending">적용 대기에서 영향을 봐요</a></span></li>
            {/if}
          </ol>
        </details>
      {/each}
    </section>
    <p class="note">감사 기록은 성공한 단계만 남겨요. 자동 적용은 커밋한 사람의 이름으로 apply 에 남아요.</p>
  </div>
{/if}

<style>
  .au { display: flex; flex-direction: column; gap: 12px; }
  .bar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .grow { flex: 1; }
  .count { font: var(--t-cap); color: var(--tx3); }
  .list { border: 1px solid var(--bd); border-radius: var(--r-lg); background: var(--bg-panel); overflow: auto; }
  .row {
    display: grid; grid-template-columns: 20px 130px 140px minmax(0, 1fr) 200px 64px 170px; gap: 12px;
    padding: 0 16px; min-height: var(--row-h); align-items: center; font: var(--t-small); color: var(--tx);
  }
  .head {
    position: sticky; top: 0; z-index: 1; min-height: 32px; background: var(--bg-hover);
    border-bottom: 1px solid var(--bd); font: 600 12px/1 var(--font); color: var(--tx2);
  }
  .g { border-bottom: 1px solid var(--bd); }
  .g:last-child { border-bottom: 0; }
  summary { cursor: pointer; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary:hover { background: var(--bg-hover); }
  summary:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
  .mk::before { content: '▸'; color: var(--tx2); }
  .g[open] .mk::before { content: '▾'; }
  .time { font: 400 12px/1.4 var(--mono); color: var(--tx3); }
  .who { color: var(--tx2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tt { font-weight: 500; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .tg { font: 400 12px/1.4 var(--mono); color: var(--tx2); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .rev { font-family: var(--mono); color: var(--accent); }
  .steps { list-style: none; margin: 0; padding: 6px 16px 10px 56px; background: var(--bg-page); display: flex; flex-direction: column; }
  .steps li { display: grid; grid-template-columns: 110px 160px 160px minmax(0, 1fr); gap: 12px; min-height: 26px; align-items: center; font: var(--t-cap); }
  .nm { font-family: var(--mono); color: var(--tx2); }
  .ok { color: var(--ok); }
  .wait { color: var(--pending); }
  .by { color: var(--tx3); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .by a { color: var(--accent); text-decoration: none; }
  .by a:hover { text-decoration: underline; }
  code { font-family: var(--mono); }
  .empty { padding: 16px; }
  .note { margin: 0; font: var(--t-cap); color: var(--tx3); }
  @media (max-width: 900px) {
    .row { grid-template-columns: 20px 110px minmax(0, 1fr) 150px; }
    .row > :nth-child(3), .row > :nth-child(5), .row > :nth-child(6) { display: none; }
    .steps { padding-left: 16px; }
    .steps li { grid-template-columns: 80px 120px minmax(0, 1fr); }
    .steps .by { display: none; }
  }
</style>

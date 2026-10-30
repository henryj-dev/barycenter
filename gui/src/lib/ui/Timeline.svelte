<script lang="ts" module>
  export type TimelineGroup = {
    key: string;
    time: string;
    title: string;
    who?: string;
    rev?: string;
    /** 펼치면 보이는 단계(changeset create → patch → plan → commit → apply). */
    steps?: readonly { time: string; name: string; ok: boolean; note?: string }[];
  };
</script>

<script lang="ts">
  /** 타임라인 — 디자인 시스템 §8 「기록」. 변경 하나를 한 묶음으로 접고 펼친다. */
  let { groups, empty = '기록이 없어요' }: { groups: readonly TimelineGroup[]; empty?: string } = $props();
  let open = $state<Record<string, boolean>>({});
</script>

<div class="tl">
  {#if groups.length === 0}<p class="empty">{empty}</p>{/if}
  {#each groups as g (g.key)}
    <div class="g">
      <button type="button" aria-expanded={!!open[g.key]} disabled={!g.steps?.length} onclick={() => { open = { ...open, [g.key]: !open[g.key] }; }}>
        <span class="mk">{g.steps?.length ? (open[g.key] ? '▾' : '▸') : ''}</span>
        <span class="time">{g.time}</span>
        <span class="tt"><b>{g.title}</b>{#if g.who}<span class="who"> · {g.who}</span>{/if}</span>
        <span class="rev">{g.rev ?? ''}</span>
      </button>
      {#if open[g.key] && g.steps}
        <div class="steps">
          {#each g.steps as s, i (i)}
            <div class="st"><span class="time">{s.time}</span><span class="nm">{s.name}</span><span class={s.ok ? 'ok' : 'bad'}>{s.ok ? '● 성공' : '✕ 실패'}{#if s.note} · {s.note}{/if}</span></div>
          {/each}
        </div>
      {/if}
    </div>
  {/each}
</div>

<style>
  .tl { background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); overflow: hidden; font: var(--t-small); }
  .empty { margin: 0; padding: 16px; color: var(--tx3); }
  .g { border-bottom: 1px solid var(--bd); }
  .g:last-child { border-bottom: 0; }
  button {
    width: 100%; text-align: left; border: 0; background: transparent; color: var(--tx);
    display: grid; grid-template-columns: 16px 110px minmax(0, 1fr) 64px; gap: 12px; align-items: center;
    padding: 0 12px; min-height: var(--row-h); font: inherit;
  }
  button:disabled { cursor: default; }
  .mk { color: var(--tx2); }
  .time { font: 400 12px/16px var(--mono); color: var(--tx3); }
  .tt b { font-weight: 500; }
  .who { color: var(--tx3); }
  .rev { font-family: var(--mono); color: var(--accent); text-align: right; }
  .steps { padding: 6px 12px 8px 40px; background: var(--bg-page); display: flex; flex-direction: column; }
  .st { display: grid; grid-template-columns: 110px 140px 1fr; gap: 12px; min-height: 26px; align-items: center; font: var(--t-cap); }
  .nm { font-family: var(--mono); color: var(--tx2); }
  .ok { color: var(--ok); }
  .bad { color: var(--danger); }
</style>

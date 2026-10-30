<script lang="ts" module>
  import type { Tone } from './Badge.svelte';
  export type ImpactLine = { tone: Tone; icon: string; text: string };
</script>

<script lang="ts">
  /**
   * 영향 요약 카드 — 디자인 시스템 §8. **끊기는 것을 먼저, 영향 없는 것은 접어서.**
   *
   * 머리: 한 줄 판정(톤 · 아이콘 · 제목 · 부제). 본문: 「끊기거나 바뀌는 것」 목록, 접힌 「영향 없음」,
   * 진행 중이면 `progress`(StepList 등), 끝났으면 `result`. 아래 `footer` 에 적용 버튼.
   */
  import type { Snippet } from 'svelte';
  import { TONE_ICON } from './Badge.svelte';

  let { tone = 'warn', title, sub, breaking = [], quiet = [], quietLabel, progress, result, footer }: {
    tone?: Tone;
    title: string;
    sub?: Snippet;
    breaking?: readonly ImpactLine[];
    quiet?: readonly string[];
    quietLabel?: string;
    progress?: Snippet;
    result?: Snippet;
    footer?: Snippet;
  } = $props();
  let quietOpen = $state(false);
</script>

<section class="ic">
  <header data-tone={tone}>
    <span class="hi" aria-hidden="true">{TONE_ICON[tone]}</span>
    <div><div class="t">{title}</div>{#if sub}<div class="s">{@render sub()}</div>{/if}</div>
  </header>
  <div class="body">
    {#if breaking.length > 0}
      <div>
        <div class="bt">끊기거나 바뀌는 것 · {breaking.length}</div>
        <div class="lines">
          {#each breaking as l, i (i)}<div class="line"><span style:color="var(--{l.tone})">{l.icon}</span><span>{l.text}</span></div>{/each}
        </div>
      </div>
    {/if}
    {#if quiet.length > 0}
      <div class="sec">
        <button type="button" class="qt" aria-expanded={quietOpen} onclick={() => { quietOpen = !quietOpen; }}>
          {quietOpen ? '▾' : '▸'} {quietLabel ?? `영향 없음 · ${quiet.length}건`}
        </button>
        {#if quietOpen}<div class="quiet">{#each quiet as q, i (i)}<div>{q}</div>{/each}</div>{/if}
      </div>
    {/if}
    {#if progress}<div class="sec">{@render progress()}</div>{/if}
    {#if result}{@render result()}{/if}
  </div>
  {#if footer}<footer>{@render footer()}</footer>{/if}
</section>

<style>
  .ic { background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); overflow: hidden; }
  header {
    --c: var(--warn); --cb: var(--warn-bg);
    padding: 14px 16px; background: var(--cb); border-bottom: 1px solid var(--bd); display: flex; gap: 10px; align-items: flex-start;
  }
  header[data-tone='ok'] { --c: var(--ok); --cb: var(--ok-bg); }
  header[data-tone='danger'] { --c: var(--danger); --cb: var(--danger-bg); }
  header[data-tone='info'] { --c: var(--info); --cb: var(--info-bg); }
  header[data-tone='pending'] { --c: var(--pending); --cb: var(--pending-bg); }
  header[data-tone='neutral'] { --c: var(--neutral); --cb: var(--neutral-bg); }
  .hi { color: var(--c); font-weight: 700; font-size: 16px; }
  .t { font: 600 15px/22px var(--font); }
  .s { color: var(--tx2); font: var(--t-small); }
  .body { padding: 12px 16px; display: flex; flex-direction: column; gap: 12px; font: var(--t-small); }
  .bt { font: 600 12px/16px var(--font); color: var(--danger); margin-bottom: 6px; }
  .lines { display: flex; flex-direction: column; gap: 6px; }
  .line { display: flex; gap: 8px; }
  .sec { padding-top: 10px; border-top: 1px solid var(--bd); }
  .body > .sec:first-child { padding-top: 0; border-top: 0; }
  .qt { border: 0; background: transparent; padding: 0; font: 600 12px/16px var(--font); color: var(--ok); }
  .quiet { display: flex; flex-direction: column; gap: 4px; margin-top: 8px; color: var(--tx2); animation: bc-in var(--dur) var(--ease); }
  footer { padding: 10px 16px; border-top: 1px solid var(--bd); display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }
</style>

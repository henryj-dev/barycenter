<script lang="ts">
  /**
   * 「정상이 아닌 이유」 (2026-11-20) — 풀 · 백엔드 개요의 격자 아래. **정상이면 아무것도 안 그린다.**
   *
   * 풀은 풀 자체의 문제와, 정상이 아닌 백엔드마다 그 이유를 한 화면에 든다 — 어느 백엔드를 고쳐야 하는지 바로 보인다.
   * 백엔드 이름은 그 상세로 간다. 판정과 이유는 상태 API(`desk.traffic`)와 헬스에서 읽는다(`problemsOf`).
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { resourcePath } from '@web/resources';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import { inRegion } from '#lib/global/aggregate.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { problemsOf } from './facts';

  let { kind, key: given }: { kind: 'pool' | 'backend'; key?: string } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const link = (path: string): string => (scope?.fixed === true && scope.region !== undefined ? inRegion(path, scope.region.name) : path);
  const key = $derived(given ?? page.params['key'] ?? '');
  const groups = $derived(problemsOf(desk, kind, key));
</script>

{#if groups.length > 0}
  <div class="why" role="group" aria-label="정상이 아닌 이유">
    <div class="t">정상이 아닌 이유</div>
    {#each groups as g, i (g.backend ?? `own-${i}`)}
      <div class="g">
        {#if g.backend !== undefined}<a class="b mono" href={link(resourcePath('backend', g.backend))}>{g.backend}</a>{/if}
        {#each g.lines as l, j (j)}
          <div class="l"><span class="i" style:color="var(--{l.tone})" aria-hidden="true">{l.icon}</span><span>{l.text}</span></div>
        {/each}
      </div>
    {/each}
  </div>
{/if}

<style>
  .why {
    display: flex; flex-direction: column; gap: 10px; margin-top: 16px; padding: 10px 12px;
    background: var(--bg-page); border: 1px solid var(--bd); border-radius: var(--r-md); font: var(--t-small);
  }
  .t { font: var(--t-cap); font-weight: 600; color: var(--tx2); }
  .g { display: flex; flex-direction: column; gap: 4px; }
  .b { color: var(--tx); text-decoration: none; font-weight: 600; }
  .b:hover { text-decoration: underline; }
  .l { display: flex; gap: 8px; }
  .i { flex: none; }
  .mono { font-family: var(--mono); }
</style>

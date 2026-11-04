<script lang="ts">
  /**
   * 클러스터 수렴 — 적용 결과 블록 안의 노드별 한 줄 (시안 `convRows`: ✓ 맞음 · ↻ 진행 · ✕ 실패 · ○ 연락 없음).
   *
   * 적용이 끝나면 노드 상태(`GET /api/v1/cluster/nodes`)를 몇 번 짧게 다시 읽는다. 팔로워는 리더가 게시한 세대를
   * 따라간다 — 그 결과만 보인다. **단계 진행을 지어내지 않는다:** 노드가 보고한 상태 그대로다.
   * 「맞음」 은 리더와 같은 활성 세대이고 `nodeState` 가 맞음이라고 한 노드다. 클러스터가 아니거나 노드가 하나면 안 그린다.
   * 전역은 지역마다 다르므로 묻지 않는다.
   */
  import { getContext, onDestroy } from 'svelte';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { nodeState, type ClusterBody, type ClusterNode } from './cluster';

  let { revision }: { revision?: string | undefined } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');

  /** 다시 읽는 때(적용 뒤 ms). 모두 맞음 · 실패 · 연락 없음으로 정해지면 일찍 멈춘다. */
  const READS = [0, 1500, 3000, 6000, 10000];
  let body = $state<ClusterBody | undefined>();
  let reading = $state(true);
  let timers: ReturnType<typeof setTimeout>[] = [];
  let stopped = false;

  type Conv = { tone: 'ok' | 'info' | 'danger' | 'neutral'; icon: string; text: string };
  const leaderGen = $derived(body?.nodes.find((n) => n.role === 'leader')?.activeGeneration);
  const convOf = (n: ClusterNode): Conv => {
    const s = nodeState(n);
    if (s.text === '연락 없음') return { tone: 'neutral', icon: '○', text: s.text };
    if (s.tone === 'danger') return { tone: 'danger', icon: '✕', text: n.lastError ? `실패 · ${n.lastError.split('\n')[0]}` : '실패' };
    if (s.tone === 'ok' && (leaderGen === undefined || n.activeGeneration === leaderGen)) return { tone: 'ok', icon: '✓', text: '맞음' };
    return { tone: 'info', icon: '↻', text: '진행' };
  };
  const rows = $derived((body?.nodes ?? []).map((n) => ({ name: n.name, gen: n.activeGeneration, ...convOf(n) })));
  const settled = $derived(rows.length > 0 && rows.every((r) => r.tone !== 'info'));
  const okN = $derived(rows.filter((r) => r.tone === 'ok').length);

  const read = async (last: boolean): Promise<void> => {
    if (stopped) return;
    const r = await desk.clusterNodes();
    if (stopped) return;
    if (r !== undefined) body = r as ClusterBody;
    if (last || settled || body?.enabled !== true) { reading = false; stopped = true; timers.forEach(clearTimeout); }
  };
  $effect(() => {
    if (scope?.mode === 'global') { reading = false; return; }
    timers = READS.map((ms, i) => setTimeout(() => { void read(i === READS.length - 1); }, ms));
    return () => timers.forEach(clearTimeout);
  });
  onDestroy(() => { stopped = true; timers.forEach(clearTimeout); });
</script>

{#if body?.enabled === true && rows.length > 1}
  <div class="conv" aria-live="polite">
    <div class="ct">클러스터 수렴{revision === undefined ? '' : ` · r${revision}`} · {rows.length}대 중 {okN}대 맞음{reading && !settled ? ' · 확인하는 중' : ''}</div>
    <ul>
      {#each rows as r (r.name)}
        <li>
          <span class="n">{r.name}{r.name === body.self ? ' · 이 노드' : ''}</span>
          <span class="b" style:color="var(--{r.tone})">{r.icon} {r.text}</span>
          <span class="g">{r.gen ?? '—'}</span>
        </li>
      {/each}
    </ul>
    {#if !reading && !settled}<div class="hint">아직 따라오지 않은 노드가 있어요. 클러스터 화면에서 확인해요.</div>{/if}
  </div>
{/if}

<style>
  .conv { display: flex; flex-direction: column; gap: 8px; padding-top: 12px; border-top: 1px solid var(--bd); }
  .ct { font: 600 12px/16px var(--font); color: var(--tx2); }
  ul { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  li { display: flex; align-items: center; gap: 10px; font: var(--t-small); min-width: 0; }
  .n { flex: none; min-width: 84px; font-family: var(--mono); }
  .b { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .g { flex: none; font-family: var(--mono); color: var(--tx3); }
  .hint { font: var(--t-cap); color: var(--tx3); }
</style>

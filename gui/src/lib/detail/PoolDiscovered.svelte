<script lang="ts">
  /**
   * 풀의 「출처에서 받은 백엔드」 (2026-11-05) — 풀에 백엔드 출처(`discovery`)가 있을 때만 보인다.
   *
   * `GET /api/v1/pools/:id/discovery` 를 읽는다: 지금 쓰는 목록(마지막으로 받은 것) · 마지막 갱신 · 오류 · 상태.
   * 출처가 아직 답하지 않았거나 이 데몬에 그 출처가 없으면 「정적 사용 중」 이다 — 아래 소속 백엔드 표가 그 목록이다.
   * 상태는 이 화면이 붙은 데몬의 것이다(데몬마다 따로 묻는다). 못 읽으면 그렇게 말하고 표는 그대로 둔다.
   */
  import { getContext } from 'svelte';
  import { DISCOVERY_SOURCES } from '@web/discovery';
  import { Badge, FieldMessage } from '#lib/ui';
  import type { Tone } from '#lib/ui/tone.ts';
  import { whenText } from '#lib/ops/audit';
  import type { DiscoveryPoolView, createDesk } from '#lib/desk.svelte.ts';

  let { pool, source, query }: { pool: string; source: string; query: string } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');

  let view = $state<DiscoveryPoolView | undefined>();
  let failed = $state(false);

  $effect(() => {
    void desk.head;
    const k = pool;
    let stop = false;
    const load = async (): Promise<void> => {
      const v = await desk.poolDiscovery(k).catch(() => undefined);
      if (stop) return;
      failed = v === undefined;
      view = v !== undefined && v.source !== null ? v : undefined;
    };
    void load();
    // 출처는 데몬이 주기로 묻는다 — 화면도 가끔 다시 읽는다.
    const t = setInterval(() => { void load(); }, 15_000);
    return () => { stop = true; clearInterval(t); };
  });

  const label = $derived(DISCOVERY_SOURCES.find((s) => s.value === source)?.label ?? source);
  const STATE: Record<DiscoveryPoolView['state'], { tone: Tone; text: string }> = {
    ok: { tone: 'ok', text: '받는 중' },
    pending: { tone: 'pending', text: '아직 답이 없어요' },
    error: { tone: 'danger', text: '오류' },
    unconfigured: { tone: 'warn', text: '이 데몬에 출처 설정이 없어요' },
  };
</script>

<div class="disc">
  <div class="head">
    <span class="t">출처에서 받은 백엔드</span>
    <span class="src mono">{label} · {query}</span>
    {#if view !== undefined}
      <Badge tone={STATE[view.state].tone}>{STATE[view.state].text}</Badge>
      {#if !view.advertised}<Badge tone="neutral">정적 사용 중</Badge>{/if}
    {/if}
  </div>
  {#if failed}
    <FieldMessage>출처 상태를 읽지 못했어요. 아래 표는 정적 백엔드예요.</FieldMessage>
  {:else if view !== undefined}
    <div class="meta">
      <span class="lbl">마지막 갱신</span><span>{whenText(view.lastSuccessAt)}</span>
      {#if view.error !== undefined}
        <span class="lbl">오류</span><span class="bad">{view.error.detail} ({view.error.reason}){view.advertised ? ' — 마지막 목록을 지켜요' : ''}</span>
      {/if}
      {#if view.keptEmpty === true}
        <span class="lbl">빈 목록</span><span>출처가 빈 목록을 줬어요. 마지막 목록을 지켜요.</span>
      {/if}
    </div>
    {#if view.advertised}
      <ul class="eps">
        {#each view.endpoints as e (`${e.host}:${e.port}`)}<li class="mono">{e.host}:{e.port}</li>{:else}<li class="none">받은 백엔드가 0 개예요. 이 풀로 가는 요청은 실패해요.</li>{/each}
      </ul>
    {:else}
      <FieldMessage>출처가 아직 목록을 주지 않아 아래 정적 백엔드를 써요.</FieldMessage>
    {/if}
  {/if}
</div>

<style>
  .disc { border: 1px solid var(--bd); border-radius: var(--r-md); padding: 12px; margin-bottom: 12px; font-size: 13px; display: flex; flex-direction: column; gap: 8px; }
  .head { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .t { font-weight: 600; }
  .src { color: var(--tx2); }
  .mono { font-family: var(--mono); }
  .meta { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; }
  .lbl { color: var(--tx2); }
  .bad { color: var(--danger); }
  .eps { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 2px; }
  .none { color: var(--tx3); }
</style>

<script lang="ts">
  /**
   * 백엔드의 헬스 — 헬스 판정 · 트래픽 수신 · 마지막 관측 · 「트래픽을 받지 않는 이유」 · 드레인.
   * 드레인은 설정(commit)이 아니고 바로 걸린다.
   *
   * 「드레인 진행」 (2026-11-21): 드레인 중이면 `GET /api/v1/backends/:id/drain-status` 를 읽어 보인다 —
   * 새 연결 막음 · 다 빠짐 · 기한 넘김, 진행 중 요청과 세션(엔진이 알릴 때만), 누가 · 언제 · 기한. 5초마다 다시 읽는다.
   * 드레인을 걸 때 기한을 고를 수 있다. 기한은 관측이다 — 지나도 드레인은 풀리지 않는다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { DRAIN_DEADLINES, drainLines } from '@web/drain-view';
  import { Button, DescriptionList, FieldMessage, Select } from '#lib/ui';
  import Writable from '#lib/global/Writable.svelte';
  import type { DrainStatusView, createDesk } from '#lib/desk.svelte.ts';
  import BackendReasons from './BackendReasons.svelte';
  import { DRAIN_MARK, HEALTH_MARK, ago, backendDraining, backendHealth } from './facts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const health = $derived(HEALTH_MARK[backendHealth(desk, key)]);
  const traffic = $derived(desk.traffic.get(key));
  const draining = $derived(backendDraining(desk, key));
  const items = $derived([
    { label: '헬스', value: `${health.icon} ${health.text}`, ...(health.tone === 'ok' || health.tone === 'danger' ? { tone: health.tone } : {}) },
    {
      label: '트래픽 수신',
      value: traffic === undefined ? '모름 — 상태 API 를 못 읽었어요' : traffic.receivingTraffic ? '● 수신 중' : '○ 수신 안 함',
      ...(traffic === undefined ? {} : { tone: traffic.receivingTraffic ? 'ok' as const : 'warn' as const }),
    },
    { label: '드레인', value: draining ? `${DRAIN_MARK.icon} ${DRAIN_MARK.text}` : '—' },
    { label: '마지막 관측', value: ago(traffic?.observedAt) ?? '—', mono: true },
  ]);

  /** 드레인 진행 — 드레인 중일 때만 읽는다. `null` 은 「드레인 중이 아니다」, undefined 는 못 읽음이다. */
  let progress = $state<DrainStatusView | null | undefined>();
  let failed = $state(false);
  $effect(() => {
    const k = key;
    if (!draining) { progress = undefined; failed = false; return; }
    let stop = false;
    const load = async (): Promise<void> => {
      const v = await desk.drainStatus(k);
      if (stop) return;
      failed = v === undefined;
      progress = v;
    };
    void load();
    const t = setInterval(() => { void load(); }, 5_000);
    return () => { stop = true; clearInterval(t); };
  });
  const lines = $derived(progress === undefined || progress === null ? [] : drainLines(progress).map((l) => ({
    label: l.label, value: l.value, ...(l.tone === 'ok' || l.tone === 'warn' ? { tone: l.tone } : {}),
  })));

  // `Select` 는 문자열 값을 받는다 — 초를 문자열로 들고, 보낼 때 숫자로 돌린다.
  const deadlineOptions = DRAIN_DEADLINES.map((d) => ({ value: String(d.value), label: d.label }));
  let deadline = $state('0');
</script>

<div class="bh">
  <DescriptionList {items} />
  <BackendReasons backend={key} />
  {#if draining}
    <div class="dp">
      <div class="t">드레인 진행</div>
      {#if failed}
        <FieldMessage tone="error">드레인 진행을 읽지 못했어요. 잠시 뒤 다시 읽어요.</FieldMessage>
      {:else if lines.length > 0}
        <DescriptionList items={lines} />
      {/if}
    </div>
  {/if}
  <Writable>
    <div class="act">
      {#if traffic === undefined || !draining}
        <Select label="기한" size="sm" width="130px" mono={false} bind:value={deadline} options={deadlineOptions} />
        <Button size="sm" disabled={desk.editing} onclick={() => { void desk.drain(key, Number(deadline) > 0 ? Number(deadline) : undefined); }}>드레인</Button>
      {/if}
      {#if traffic === undefined || draining}<Button size="sm" disabled={desk.editing} onclick={() => { void desk.undrain(key); }}>드레인 해제</Button>{/if}
      <FieldMessage>새 연결을 보내지 않아요. 진행 중인 연결은 끝까지 가요. 설정(커밋)이 아니라 바로 걸려요. 기한이 지나도 드레인은 풀리지 않아요 — 「기한 넘김」 으로 보여요.</FieldMessage>
    </div>
  </Writable>
</div>

<style>
  .bh { display: flex; flex-direction: column; gap: 12px; }
  .act { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .dp { display: flex; flex-direction: column; gap: 6px; padding: 10px 12px; background: var(--bg-page); border: 1px solid var(--bd); border-radius: var(--r-md); }
  .t { font-size: 12px; font-weight: 600; color: var(--tx2); }
</style>

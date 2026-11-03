<script lang="ts">
  /**
   * 백엔드의 헬스 — 헬스 판정 · 트래픽 수신 · 마지막 관측 · 「트래픽을 받지 않는 이유」 · 드레인.
   * 드레인은 설정(commit)이 아니고 바로 걸린다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { Button, DescriptionList, FieldMessage } from '#lib/ui';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';
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
</script>

<div class="bh">
  <DescriptionList {items} />
  <BackendReasons backend={key} />
  <Writable>
    <div class="act">
      {#if traffic === undefined || !draining}<Button size="sm" disabled={desk.editing} onclick={() => { void desk.drain(key); }}>드레인</Button>{/if}
      {#if traffic === undefined || draining}<Button size="sm" disabled={desk.editing} onclick={() => { void desk.undrain(key); }}>드레인 해제</Button>{/if}
      <FieldMessage>새 연결을 보내지 않아요. 진행 중인 연결은 끝까지 가요. 설정(커밋)이 아니라 바로 걸려요.</FieldMessage>
    </div>
  </Writable>
</div>

<style>
  .bh { display: flex; flex-direction: column; gap: 12px; }
  .act { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
</style>

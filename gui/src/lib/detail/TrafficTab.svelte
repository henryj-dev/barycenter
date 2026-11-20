<script lang="ts">
  /**
   * 트래픽 경로 탭의 머리 — 「실시간 트래픽」 그래프 (2026-11-20). 아래에 경로 그림이 이어진다.
   *
   * 이름은 주소에서, stream 인지는 모델에서 읽는다(stream 은 요청이 아니라 연결을 센다).
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { itemOf } from '@web/resources';
  import type { TrafficKind } from '@web/traffic-view';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import TrafficCharts from './TrafficCharts.svelte';

  let { kind }: { kind: Exclude<TrafficKind, 'backend'> } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const stream = $derived.by(() => {
    if (kind === 'passthroughRoute') return true;
    if (kind === 'httpRoute') return false;
    const it = itemOf(desk.model, kind, key);
    if (kind === 'pool') return it !== undefined && it['protocolClass'] !== 'http';
    const p = it?.['protocol'];
    return p === 'tcp' || p === 'udp' || p === 'tls_passthrough';
  });
</script>

{#if key !== ''}
  <div class="head">{#key key}<TrafficCharts {kind} {key} {stream} />{/key}</div>
{/if}

<style>
  .head { margin-bottom: 20px; }
</style>

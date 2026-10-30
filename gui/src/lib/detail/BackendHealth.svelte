<script lang="ts">
  /** 백엔드의 헬스 — 헬스 판정 · 트래픽을 안 받는 이유 · 드레인. 드레인은 설정(commit)이 아니고 바로 걸린다. */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { reasonLabels } from '@web/pools-view';
  import { Button, DescriptionList, FieldMessage } from '#lib/ui';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const health = $derived(desk.health.find((h) => h.backendKey === key)?.state ?? 'unknown');
  const traffic = $derived(desk.traffic.get(key));
  const items = $derived([
    {
      label: '헬스',
      value: health === 'healthy' ? '● 정상' : health === 'unhealthy' ? '✕ 비정상' : '○ 관측 없음 — 아직 재지 못했어요',
      ...(health === 'healthy' ? { tone: 'ok' as const } : health === 'unhealthy' ? { tone: 'danger' as const } : {}),
    },
    {
      label: '트래픽 수신',
      value: traffic === undefined ? '모름 — 상태 API 를 못 읽었어요' : traffic.receivingTraffic ? '받는 중' : '안 받아요',
      ...(traffic === undefined ? {} : { tone: traffic.receivingTraffic ? 'ok' as const : 'warn' as const }),
    },
    ...(traffic !== undefined && traffic.reasons.length > 0 ? [{ label: '이유', value: reasonLabels(traffic.reasons).join(' · ') }] : []),
  ]);
</script>

<DescriptionList {items} />
<Writable>
  <div class="act">
    <Button size="sm" disabled={desk.editing} onclick={() => { void desk.drain(key); }}>드레인</Button>
    <Button size="sm" disabled={desk.editing} onclick={() => { void desk.undrain(key); }}>드레인 해제</Button>
    <FieldMessage>새 연결을 보내지 않아요. 진행 중인 연결은 끝까지 가요. 설정(커밋)이 아니라 바로 걸려요.</FieldMessage>
  </div>
</Writable>

<style>
  .act { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; margin-top: 12px; }
</style>

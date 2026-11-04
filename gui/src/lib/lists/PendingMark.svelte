<script lang="ts">
  /**
   * 목록 행의 「◐ 적용 대기」 (#126 후속) — 이름 칸에, 이름 뒤에 단다. 엔진이 돌리는 것과 head 가 다른 리소스에만.
   * 상태 칸이 없는 목록이 많고, 있는 목록(헬스 · 백엔드 수)은 그 값이 따로 뜻이 있어서 이름 칸으로 모은다.
   * `hide` 는 그 행에 이미 적용 대기 표시가 있을 때(리스너 「◐ 적용하면 열림」) — 한 줄에 둘을 두지 않는다.
   */
  import { getContext } from 'svelte';
  import type { ResourceKind } from '@web/resources';
  import { Badge } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { PENDING_MARK, isPendingResource } from '#lib/pending';

  let { kind, key, hide = false }: { kind: ResourceKind; key: string; hide?: boolean } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const on = $derived(!hide && isPendingResource(desk.pendingResources, kind, key));
</script>

{#if on}<span class="pm" title="커밋했지만 아직 엔진에 적용하지 않은 변경이 있어요"><Badge tone={PENDING_MARK.tone} icon={PENDING_MARK.icon}>{PENDING_MARK.text}</Badge></span>{/if}

<style>
  .pm { margin-left: 6px; white-space: nowrap; }
</style>

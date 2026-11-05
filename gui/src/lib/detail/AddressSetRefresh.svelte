<script lang="ts">
  /**
   * 주소 집합의 「마지막 갱신」 · 「목록 다시 받기」 (2026-11-05) — 시안의 버튼. 출처가 있는 집합에만 보인다.
   *
   * 다시 받기는 `POST /api/v1/address-sets/:id/refresh` 다. **커밋까지이고 적용은 안 한다** — 바뀌면 다른 커밋처럼
   * 적용 대기에 오른다. 마지막 갱신은 `GET /api/v1/address-sets/refresh-status` 의 그 집합 줄이다(없으면 「—」).
   */
  import { getContext } from 'svelte';
  import { addressSourceLabel } from '@web/address-source';
  import { Banner, Button } from '#lib/ui';
  import { whenText } from '#lib/ops/audit';
  import type { AddressSetRefreshRow, createDesk } from '#lib/desk.svelte.ts';

  let { key, source, disabled = false }: { key: string; source: string; disabled?: boolean } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');

  let row = $state<AddressSetRefreshRow | undefined>();
  let busy = $state(false);
  let result = $state<{ tone: 'ok' | 'info' | 'danger'; text: string } | undefined>();

  const load = async (): Promise<void> => {
    const rows = await desk.addressSetRefreshStatus();
    row = rows?.find((r) => r.key === key);
  };
  // head 가 움직이면(데몬이 다시 받아 커밋했다 · 다른 커밋) 다시 읽는다.
  $effect(() => {
    void desk.head;
    void key;
    void load();
  });

  const refresh = async (): Promise<void> => {
    busy = true;
    result = undefined;
    const out = await desk.refreshAddressSet(key);
    busy = false;
    if (!out.ok) result = { tone: 'danger', text: `목록을 받지 못했어요. 집합은 그대로예요. ${out.message}` };
    else if (out.outcome === 'unchanged') result = { tone: 'info', text: `바뀐 게 없어요. 대역 ${out.count}개 그대로예요.` };
    else result = { tone: 'ok', text: `대역 ${out.count}개로 ${out.revision === undefined ? '' : `r${out.revision} 로 `}커밋했어요. 적용 대기에서 적용해요.` };
    await load();
  };
</script>

<div class="bar">
  <div class="meta">
    <span class="lbl">출처</span><span>{addressSourceLabel(source)}</span>
    <span class="lbl">마지막 갱신</span><span>{whenText(row?.refreshedAt)}</span>
    {#if row !== undefined && !row.ok}
      <span class="lbl">마지막 시도</span><span class="bad" title={row.detail}>{whenText(row.checkedAt)} 실패{row.reason === undefined ? '' : ` (${row.reason})`}{row.detail === undefined ? '' : ` — ${row.detail}`}</span>
    {/if}
  </div>
  <Button size="sm" loading={busy} disabled={disabled || busy} onclick={() => { void refresh(); }}>목록 다시 받기</Button>
</div>
{#if result !== undefined}<Banner tone={result.tone}>{result.text}</Banner>{/if}

<style>
  .bar { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
  .meta { display: grid; grid-template-columns: auto 1fr; gap: 4px 12px; font-size: 13px; color: var(--tx); }
  .lbl { color: var(--tx2); }
  .bad { color: var(--danger); }
</style>

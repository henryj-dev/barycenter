<script lang="ts">
  /** 기록 탭 — 이 리소스를 바꾼 리비전과 바뀐 칸 (`GET /api/v1/config/history`). */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { diffFields, type Item, type ResourceKind } from '@web/resources';
  import type { createDesk } from '#lib/desk.svelte.ts';

  type Change = {
    revision: string; change: 'created' | 'changed' | 'deleted' | 'earliest'; rollbackOf: string | null;
    createdAt: string; createdBy: string; note: string | null; before: Item | null; after: Item | null;
  };
  let { kind }: { kind: ResourceKind } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  let rows = $state<Change[] | undefined>();
  let failed = $state(false);
  // head 가 바뀌면 다시 읽는다 — 폴링하지 않는다. 스트림이 head 를 알려 준다.
  $effect(() => {
    void desk.head;
    const k = key;
    void desk.historyOf(kind, k).then((r) => {
      if (k !== key) return;
      failed = r === undefined;
      rows = (r ?? []) as Change[];
    });
  });
  const label: Record<Change['change'], string> = {
    created: '만들었다', changed: '바꿨다', deleted: '뺐다', earliest: '살펴본 기록의 맨 앞 — 이 앞은 안 봤다',
  };
</script>

{#if failed}
  <p class="d-empty">기록을 못 읽었다. 전역 화면은 지역의 기록을 중계하지 않는다 — 그 지역의 GUI 에서 본다.</p>
{:else if rows === undefined}
  <p class="d-empty">기록을 읽는 중이다.</p>
{:else if rows.length === 0}
  <p class="d-empty">최근 리비전에서 이 리소스를 바꾼 적이 없다.</p>
{:else}
  <ol class="d-list">
    {#each rows as r (r.revision)}
      <li class="row">
        <span class="d-mono">r{r.revision}</span>
        <span>{label[r.change]}{r.rollbackOf !== null ? ` (r${r.rollbackOf} 로 롤백)` : ''}</span>
        <span class="d-note">{r.createdBy} · {new Date(r.createdAt).toLocaleString()}</span>
        {#if r.note !== null}<span class="d-note">— {r.note}</span>{/if}
        {#if r.change === 'changed'}
          <ul class="diff">
            {#each diffFields(r.before, r.after) as d (d.path)}
              <li class="d-mono"><span class="d-note">{d.path}</span> {d.before ?? '(없음)'} → {d.after ?? '(없음)'}</li>
            {/each}
          </ul>
        {/if}
      </li>
    {/each}
  </ol>
{/if}

<style>
  .diff { list-style: none; margin: 0.2rem 0 0; padding: 0 0 0 1rem; width: 100%; font-size: 0.8rem; }
  .diff li { padding: 0.1rem 0; overflow-wrap: anywhere; }
</style>

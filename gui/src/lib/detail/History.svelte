<script lang="ts">
  /**
   * 기록 탭 — 이 리소스를 바꾼 리비전과 바뀐 칸 (`GET /api/v1/config/history`).
   * 리비전 하나가 한 줄이고, 바꾼 리비전은 바뀐 칸을 펼쳐 본다(시안 §8 「기록」 처럼 접고 편다).
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { diffFields, type Item, type ResourceKind } from '@web/resources';
  import { Badge, Disclosure, FieldMessage, Skeleton, type Tone } from '#lib/ui';
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
  const LABEL: Record<Change['change'], { text: string; tone: Tone }> = {
    created: { text: '만들었어요', tone: 'ok' },
    changed: { text: '바꿨어요', tone: 'info' },
    deleted: { text: '뺐어요', tone: 'danger' },
    earliest: { text: '살펴본 기록의 맨 앞', tone: 'neutral' },
  };
</script>

{#if failed}
  <FieldMessage>기록을 못 읽었어요. 전역 화면은 지역의 기록을 중계하지 않아요. 그 지역의 GUI 에서 봐요.</FieldMessage>
{:else if rows === undefined}
  <Skeleton height="96px" label="기록을 읽는 중" />
{:else if rows.length === 0}
  <FieldMessage>최근 리비전에서 이 리소스를 바꾼 적이 없어요.</FieldMessage>
{:else}
  <ol class="hist">
    {#each rows as r (r.revision)}
      {@const diff = r.change === 'changed' ? diffFields(r.before, r.after) : []}
      <li>
        <div class="head">
          <code class="rev">r{r.revision}</code>
          <Badge tone={LABEL[r.change].tone} icon={null}>{LABEL[r.change].text}</Badge>
          {#if r.rollbackOf !== null}<Badge tone="pending" icon={null}>r{r.rollbackOf} 로 롤백</Badge>{/if}
          <span class="who">{r.createdBy} · {new Date(r.createdAt).toLocaleString()}</span>
        </div>
        {#if r.change === 'earliest'}<FieldMessage>이 앞은 살펴보지 않았어요.</FieldMessage>{/if}
        {#if r.note !== null}<p class="note">{r.note}</p>{/if}
        {#if diff.length > 0}
          <Disclosure title="바뀐 칸" hint={`${diff.length}개`}>
            <table class="diff">
              <tbody>
                {#each diff as d (d.path)}
                  <tr><th scope="row">{d.path}</th><td class="b">{d.before ?? '(없음)'}</td><td class="arrow">→</td><td class="a">{d.after ?? '(없음)'}</td></tr>
                {/each}
              </tbody>
            </table>
          </Disclosure>
        {/if}
      </li>
    {/each}
  </ol>
{/if}

<style>
  .hist { list-style: none; margin: 0; padding: 0; max-width: 960px; border-top: 1px solid var(--bd); }
  .hist > li { padding: 12px 0; border-bottom: 1px solid var(--bd); display: flex; flex-direction: column; gap: 6px; }
  .head { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
  .rev { font-family: var(--mono); font-size: 13px; color: var(--tx); min-width: 56px; }
  .who { font: var(--t-cap); color: var(--tx3); }
  .note { margin: 0; font: var(--t-small); color: var(--tx2); }
  .diff { border-collapse: collapse; width: 100%; font: 400 12px/18px var(--mono); }
  .diff th { text-align: left; font-weight: 400; color: var(--tx3); padding: 2px 12px 2px 0; white-space: nowrap; vertical-align: top; }
  .diff td { padding: 2px 6px; overflow-wrap: anywhere; vertical-align: top; }
  .diff .b { color: var(--danger); }
  .diff .a { color: var(--ok); }
  .diff .arrow { color: var(--tx3); width: 1%; }
</style>

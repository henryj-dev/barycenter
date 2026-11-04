<script lang="ts">
  /**
   * 라우트 상세의 기록 탭 — 콘솔 시안 `tLog`: 한 줄이 시각(고정폭 12px 흐린색) · 「이름 수정 · 누가」 · 리비전(고정폭 강조색, 오른쪽)이다
   * (열 110px · 나머지 · 40px). 값은 `GET /api/v1/config/history` 에서 읽는다 — 이 리소스를 바꾼 리비전만.
   *
   * 시안과 다른 곳(이미 있는 기능): 바꾼 리비전은 바뀐 칸을 펼쳐 본다(「바뀐 칸」), 롤백 리비전은 그렇다고 말한다.
   * 시각은 오늘이면 「오늘 13:40」, 아니면 「10-12 09:14」 다(시안 표기).
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { diffFields, type Item } from '@web/resources';
  import { Disclosure, FieldMessage, Skeleton } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';

  type Change = {
    revision: string; change: 'created' | 'changed' | 'deleted' | 'earliest'; rollbackOf: string | null;
    createdAt: string; createdBy: string; note: string | null; before: Item | null; after: Item | null;
  };
  let { kind }: { kind: 'httpRoute' | 'passthroughRoute' } = $props();
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
  const WHAT: Record<Change['change'], string> = { created: '만듦', changed: '수정', deleted: '삭제', earliest: '살펴본 기록의 맨 앞' };
  const two = (n: number): string => String(n).padStart(2, '0');
  const when = (iso: string): string => {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const now = new Date();
    const hm = `${two(d.getHours())}:${two(d.getMinutes())}`;
    return d.toDateString() === now.toDateString() ? `오늘 ${hm}` : `${two(d.getMonth() + 1)}-${two(d.getDate())} ${hm}`;
  };
</script>

{#if failed}
  <FieldMessage>기록을 못 읽었어요. 전역 화면은 지역의 기록을 중계하지 않아요. 그 지역의 GUI 에서 봐요.</FieldMessage>
{:else if rows === undefined}
  <Skeleton height="96px" label="기록을 읽는 중" />
{:else if rows.length === 0}
  <FieldMessage>최근 리비전에서 이 리소스를 바꾼 적이 없어요.</FieldMessage>
{:else}
  <ol class="log">
    {#each rows as r (r.revision)}
      {@const diff = r.change === 'changed' ? diffFields(r.before, r.after) : []}
      <li>
        <span class="t" title={new Date(r.createdAt).toLocaleString()}>{when(r.createdAt)}</span>
        <span class="n">{key} {r.rollbackOf !== null ? `r${r.rollbackOf} 로 롤백` : WHAT[r.change]} <span class="w">· {r.createdBy}</span>
          {#if r.note !== null}<span class="note">{r.note}</span>{/if}
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
        </span>
        <span class="r">r{r.revision}</span>
      </li>
    {/each}
  </ol>
{/if}

<style>
  /* 시안 `tLog` 인라인 style 그대로. */
  .log { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
  .log > li { display: grid; grid-template-columns: 110px 1fr 40px; gap: 12px; align-items: start; }
  .t { font-family: var(--mono); font-size: 12px; color: var(--tx3); }
  .w { color: var(--tx3); }
  .n { min-width: 0; overflow-wrap: anywhere; }
  .note { display: block; font-size: 12px; color: var(--tx2); }
  .r { font-family: var(--mono); color: var(--accent); text-align: right; }
  .diff { border-collapse: collapse; width: 100%; font: 400 12px/18px var(--mono); }
  .diff th { text-align: left; font-weight: 400; color: var(--tx3); padding: 2px 12px 2px 0; white-space: nowrap; vertical-align: top; }
  .diff td { padding: 2px 6px; overflow-wrap: anywhere; vertical-align: top; }
  .diff .b { color: var(--danger); }
  .diff .a { color: var(--ok); }
  .diff .arrow { color: var(--tx3); width: 1%; }
</style>

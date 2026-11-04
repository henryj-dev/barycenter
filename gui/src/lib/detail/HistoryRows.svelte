<script lang="ts">
  /**
   * 기록 탭(리스너 · 풀 · 백엔드 · 주소 집합) — 콘솔 시안 `tLog` · `logRows` 그대로.
   * 한 줄에 시각(110px, 고정폭 12px 흐린색) · 「<이름> 수정 · <누가>」 · 리비전(고정폭, 강조색, 오른쪽).
   * 값은 `GET /api/v1/config/history` 다(이 리소스를 바꾼 리비전). 시안에 없지만 있던 것: 바꾼 리비전의 「바뀐 칸」 —
   * 그 줄 아래에 접어 둔다. 롤백한 리비전은 설명에 「r<n> 로 롤백」 을 붙인다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { diffFields, type Item, type ResourceKind } from '@web/resources';
  import { Expander, FieldMessage, Skeleton } from '#lib/ui';
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
  let open = $state<Record<string, boolean>>({});
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
  const VERB: Record<Change['change'], string> = { created: '만듦', changed: '수정', deleted: '삭제', earliest: '살펴본 기록의 맨 앞' };
  const two = (n: number): string => String(n).padStart(2, '0');
  /** 시안 시각 — 오늘이면 「오늘 13:40」, 아니면 「10-12 09:14」. */
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
  <div class="log">
    {#each rows as r (r.revision)}
      {@const diff = r.change === 'changed' ? diffFields(r.before, r.after) : []}
      <div class="ln">
        <span class="t">{when(r.createdAt)}</span>
        <span>{r.change === 'earliest' ? VERB.earliest : `${key} ${VERB[r.change]}`}{#if r.rollbackOf !== null} (r{r.rollbackOf} 로 롤백){/if} <span class="w">· {r.createdBy.replace(/^user:/, '')}</span>{#if r.note !== null && !/^changeset [0-9a-f-]+$/.test(r.note)}<span class="w">{' · '}{r.note}</span>{/if}</span>
        <span class="r">r{r.revision}</span>
      </div>
      {#if diff.length > 0}
        <div class="diff">
          <Expander open={open[r.revision] === true} ontoggle={(o) => { open = { ...open, [r.revision]: o }; }}>바뀐 칸 {diff.length}개</Expander>
          {#if open[r.revision] === true}
            <table>
              <tbody>
                {#each diff as d (d.path)}
                  <tr><th scope="row">{d.path}</th><td class="b">{d.before ?? '(없음)'}</td><td class="arrow">→</td><td class="a">{d.after ?? '(없음)'}</td></tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  /* 값은 시안 `tLog` 블록의 인라인 style 그대로다. */
  .log { display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
  .ln { display: grid; grid-template-columns: 110px 1fr 40px; gap: 12px; }
  .t { font-family: var(--mono); font-size: 12px; color: var(--tx3); }
  .w { color: var(--tx3); }
  .r { font-family: var(--mono); color: var(--accent); text-align: right; }
  .diff { margin-left: 122px; display: flex; flex-direction: column; gap: 4px; }
  table { border-collapse: collapse; width: 100%; font: 400 12px/18px var(--mono); }
  th { text-align: left; font-weight: 400; color: var(--tx3); padding: 2px 12px 2px 0; white-space: nowrap; vertical-align: top; }
  td { padding: 2px 6px; overflow-wrap: anywhere; vertical-align: top; }
  .b { color: var(--danger); }
  .a { color: var(--ok); }
  .arrow { color: var(--tx3); width: 1%; }
</style>

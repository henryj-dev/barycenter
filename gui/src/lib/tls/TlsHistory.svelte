<script lang="ts">
  /**
   * TLS 상세의 기록 탭 — 콘솔 시안 `tLog` 블록: 줄마다 시각(110px, 고정폭 12px 흐림) · 「무엇 · 누가」 · 리비전(강조 색, 오른쪽).
   * 줄은 이 리소스를 바꾼 리비전이다(`GET /api/v1/config/history`). 무엇은 시안 문구 「<이름> 만듦」 · 「<이름> 수정」.
   * 시안에 없는 기존 정보: 롤백 표시 · 커밋 메모 · 「▸ 바뀐 칸 · N」(펼치면 칸마다 전 → 후).
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { diffFields, type Item } from '@web/resources';
  import { Expander, FieldMessage, Skeleton } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import type { COLS } from './tls-view.ts';

  type Change = {
    revision: string; change: 'created' | 'changed' | 'deleted' | 'earliest'; rollbackOf: string | null;
    createdAt: string; createdBy: string; note: string | null; before: Item | null; after: Item | null;
  };
  let { kind }: { kind: keyof typeof COLS } = $props();
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
  const pad = (n: number): string => String(n).padStart(2, '0');
  /** 시안 「오늘 13:40」 · 「10-12 09:14」. */
  const when = (iso: string): string => {
    const d = new Date(iso), now = new Date();
    const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return d.toDateString() === now.toDateString() ? `오늘 ${hm}` : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
  };
  const what = (r: Change): string => r.change === 'created' ? `${key} 만듦` : r.change === 'changed' ? `${key} 수정`
    : r.change === 'deleted' ? `${key} 삭제` : '살펴본 기록의 맨 앞';
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
      <div class="lg">
        <span class="t">{when(r.createdAt)}</span>
        <span>{what(r)}{r.rollbackOf !== null ? ` (r${r.rollbackOf} 로 롤백)` : ''} <span class="w">· {r.createdBy}</span></span>
        <span class="r">r{r.revision}</span>
      </div>
      {#if r.note !== null || diff.length > 0}
        <div class="more">
          {#if r.note !== null}<div class="note">{r.note}</div>{/if}
          {#if diff.length > 0}
            <Expander bind:open={() => open[r.revision] === true, (v) => { open = { ...open, [r.revision]: v }; }}>바뀐 칸 · {diff.length}</Expander>
            {#if open[r.revision]}
              <table class="diff">
                <tbody>
                  {#each diff as d (d.path)}
                    <tr><th scope="row">{d.path}</th><td class="b">{d.before ?? '(없음)'}</td><td class="arrow">→</td><td class="a">{d.after ?? '(없음)'}</td></tr>
                  {/each}
                </tbody>
              </table>
            {/if}
          {/if}
        </div>
      {/if}
    {/each}
  </div>
{/if}

<style>
  /* 값은 콘솔 시안 `tLog` 블록의 인라인 style 그대로다. */
  .log { display: flex; flex-direction: column; gap: 8px; font-size: 13px; }
  .lg { display: grid; grid-template-columns: 110px 1fr 40px; gap: 12px; }
  .t { font-family: var(--mono); font-size: 12px; color: var(--tx3); }
  .w { color: var(--tx3); }
  .r { font-family: var(--mono); color: var(--accent); text-align: right; }
  .more { margin-left: 122px; display: flex; flex-direction: column; gap: 4px; }
  .note { font-size: 12px; color: var(--tx2); }
  .diff { border-collapse: collapse; width: 100%; font: 400 12px/18px var(--mono); }
  .diff th { text-align: left; font-weight: 400; color: var(--tx3); padding: 2px 12px 2px 0; white-space: nowrap; vertical-align: top; }
  .diff td { padding: 2px 6px; overflow-wrap: anywhere; vertical-align: top; }
  .diff .b { color: var(--danger); }
  .diff .a { color: var(--ok); }
  .diff .arrow { color: var(--tx3); width: 1%; }
</style>

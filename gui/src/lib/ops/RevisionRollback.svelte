<script lang="ts">
  /**
   * 리비전 롤백 — 적용 대기 화면 아래 구획 (시안: 라디오 목록 + 「롤백: rN」 위험 버튼 + 확인 대화상자).
   * 롤백은 옛 내용으로 **새 리비전**을 만든다. 트래픽은 위에서 적용해야 바뀐다. 확인은 영향 확인 체크를 지난다.
   * 전역에서 연락 없는 지역이면 버튼을 막고 사유를 쓴다.
   */
  import { getContext } from 'svelte';
  import { Badge, Button, Card, ConfirmDialog, FieldMessage, RadioGroup, Skeleton, toast } from '#lib/ui';
  import { LOST_MESSAGE, type Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';

  type Rev = {
    revision: string; parent: string | null; rollbackOf: string | null; createdAt: string;
    createdBy: string; note: string | null; changeset: string | null;
  };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const ro = $derived(scope?.readOnly === true);
  const lost = $derived(scope?.lost === true);
  const where = $derived(scope?.mode === 'global' && scope.region !== undefined ? ` 지역: ${scope.region.name}` : '');
  let rows = $state<Rev[] | undefined>();
  let failed = $state(false);
  let selected = $state<string | undefined>();
  let asking = $state(false);
  let shown = $state(10);
  $effect(() => {
    void desk.head;
    if (!desk.live) return;
    void desk.revisions().then((r) => { failed = r === undefined; rows = (r ?? []) as Rev[]; });
  });

  /** 새것부터. head 는 고를 수 없다 — 지금 내용이다. */
  const ordered = $derived([...(rows ?? [])].sort((a, b) => (BigInt(b.revision) < BigInt(a.revision) ? -1 : 1)));
  const visible = $derived(ordered.slice(0, shown));
  const pickable = $derived(visible.filter((r) => r.revision !== desk.head));
  const headRev = $derived(visible.find((r) => r.revision === desk.head));
  const byRev = $derived(new Map(ordered.map((r) => [r.revision, r])));
  const summary = (r: Rev): string => r.note ?? (r.rollbackOf !== null ? `r${r.rollbackOf} 로 롤백` : '메모 없음');

  const confirm = (): void => {
    const t = selected;
    if (t === undefined) return;
    const before = scope?.refusals ?? 0;
    const id = toast.progress(`롤백: r${t}`, `r${t} 의 내용으로 새 리비전을 만드는 중이에요.${where}`);
    void desk.rollback(t).catch(() => false).then((ok) => {
      asking = false;
      if (ok) {
        selected = undefined;
        toast.done(id, { tone: 'ok', title: `r${t} 의 내용으로 새 리비전을 만들었어요`, body: `적용 대기에 들어갔어요. 적용해야 트래픽이 바뀌어요.${where}` });
      } else if ((scope?.refusals ?? 0) > before) {
        // 연락 없음 · 403 은 scope 가 지역 이름으로 이미 알렸다.
        toast.close(id);
      } else {
        toast.done(id, { tone: 'danger', title: '롤백하지 못했어요', ...(desk.error === undefined ? {} : { body: desk.error }) });
      }
    });
  };
</script>

<Card title="리비전 롤백" sub="되돌릴 리비전을 선택해요. 롤백하면 새 리비전이 만들어져요." padded={false}>
  {#if failed}
    <div class="pad"><FieldMessage>리비전 목록을 못 읽었어요. 잠시 뒤 다시 열어 봐요.</FieldMessage></div>
  {:else if rows === undefined}
    <div class="pad"><Skeleton height="120px" label="리비전을 불러오는 중" /></div>
  {:else if ordered.length === 0}
    <div class="pad"><FieldMessage>리비전이 없어요.</FieldMessage></div>
  {:else}
    <div class="list">
      {#if headRev !== undefined}
        <div class="rv head"><span class="dot" aria-hidden="true"></span><code>r{headRev.revision}</code><span class="when">{new Date(headRev.createdAt).toLocaleString()}</span><span class="sum">{summary(headRev)} <Badge tone="ok" icon={null}>head</Badge></span><span class="by">{headRev.createdBy}</span></div>
      {/if}
      <RadioGroup label="되돌릴 리비전" direction="column" dot={false} bind:value={selected}
        options={pickable.map((r) => ({ value: r.revision, label: `r${r.revision}`, disabled: ro || desk.editing }))}>
        {#snippet item(o)}
          {@const r = byRev.get(o.value)}
          {#if r !== undefined}
            <span class="rv"><span class="dot" aria-hidden="true"></span><code>r{r.revision}</code>
              <span class="when">{new Date(r.createdAt).toLocaleString()}</span>
              <span class="sum">{summary(r)}{#if r.rollbackOf !== null && r.note !== null} <Badge tone="pending" icon={null}>r{r.rollbackOf} 로 롤백</Badge>{/if}</span>
              <span class="by">{r.createdBy}</span></span>
          {/if}
        {/snippet}
      </RadioGroup>
    </div>
    {#if ordered.length > shown}
      <div class="more"><Button size="sm" variant="text" onclick={() => { shown += 20; }}>더 보기 · {ordered.length - shown}개 남음</Button></div>
    {/if}
  {/if}
  {#if !ro && rows !== undefined && !failed}
    <div class="foot">
      {#if lost}<span class="lost" role="status">✕ {LOST_MESSAGE}</span>{:else}<span class="hint">트래픽은 위에서 적용해야 바뀌어요.</span>{/if}
      <Button error disabled={selected === undefined || lost || desk.editing} loading={desk.editing && asking}
        onclick={() => { asking = true; }}>{selected === undefined ? '롤백' : `롤백: r${selected}`}</Button>
    </div>
  {/if}
</Card>

<ConfirmDialog
  bind:open={asking}
  title={`롤백: r${selected ?? ''}`}
  sub={`r${selected ?? ''} 의 내용으로 새 리비전을 만들어요. 롤백은 커밋까지예요.${where}`}
  lines={[
    { tone: 'warn', icon: '▲', text: `head r${desk.head ?? '?'} 다음에 새 리비전이 생겨요. 그 사이의 변경은 기록에 남아요.` },
    { tone: 'info', icon: '↻', text: `적용하면 r${selected ?? ''} 이후의 변경이 트래픽에서 빠져요. reload 가 필요할 수 있어요.` },
  ]}
  confirmLabel="롤백" danger requireCheck busy={desk.editing}
  onconfirm={confirm}
/>

<style>
  .pad { padding: 12px 16px; }
  .list { display: flex; flex-direction: column; }
  /* RadioGroup 의 선택지를 표 한 줄로 — 고른 줄은 바탕과 동그라미로 보인다(시안). */
  .list :global([role='radiogroup']) { gap: 0; }
  .list :global([role='radio']) { padding: 0; border-bottom: 1px solid var(--bd); border-radius: 0; }
  .list :global([role='radio']:not(:disabled):hover) { background: var(--bg-hover); }
  .list :global([role='radio']:last-child) { border-bottom: 0; }
  .list :global([role='radio'][aria-checked='true']) { background: var(--bg-sel); }
  .list :global([role='radio']:focus-visible) { outline: 2px solid var(--focus); outline-offset: -2px; }
  .rv {
    flex: 1; display: grid; grid-template-columns: 20px 56px 160px minmax(0, 1fr) auto; gap: 12px; align-items: center;
    padding: 0 16px; min-height: var(--row-h); text-align: left; font: var(--t-body);
  }
  .rv.head { color: var(--tx2); border-bottom: 1px solid var(--bd); }
  .dot { width: 16px; height: 16px; border-radius: 50%; border: 1px solid var(--bd-strong); background: var(--bg-input); transition: border-width var(--dur-fast) var(--ease); }
  .list :global([role='radio'][aria-checked='true'] .dot) { border: 5px solid var(--accent); }
  code { font-family: var(--mono); color: var(--accent); }
  .when, .by { font-size: 12px; color: var(--tx3); }
  .sum { display: inline-flex; gap: 6px; align-items: center; flex-wrap: wrap; min-width: 0; }
  @media (max-width: 720px) { .rv { grid-template-columns: 20px 56px minmax(0, 1fr); padding: 6px 16px; } .when, .by { display: none; } }
  .more { padding: 6px 16px; border-top: 1px solid var(--bd); }
  .foot { padding: 10px 16px; border-top: 1px solid var(--bd); display: flex; justify-content: flex-end; align-items: center; gap: 12px; }
  .hint { flex: 1; font: var(--t-small); color: var(--tx3); }
  .lost { flex: 1; font: var(--t-small); color: var(--danger); }
</style>

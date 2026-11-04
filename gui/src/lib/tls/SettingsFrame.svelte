<script lang="ts" module>
  /** 보기 구획 하나 — 시안 `viewSecs` 의 `{ t, f: [{ l, v, ff }] }`. */
  export type ViewSection = { t: string; f: { l: string; v: string; mono?: boolean }[] };
</script>

<script lang="ts">
  /**
   * 상세의 설정 탭 틀 — 콘솔 시안 `tSet` 블록(쓸 수 있을 때)과 `tSetView` 블록(쓸 수 없을 때).
   *
   * **쓸 수 있으면** 폼(최대 760px, 콘솔 격자 150px · 480px — `setFormLayout('compact')`) 아래에 줄 하나:
   * 안내(시안 `hintTxt` — 오류 · 바뀜 · 적용 대기 · 바뀐 값 없음) · 「되돌리기」 · 「저장」(32px, 바뀐 것이 없으면 흐림 .5).
   * **쓸 수 없으면**(팔로워 · 연락 없음) 구획마다 이름 · 값 격자(시안 `viewSecs`)와 까닭 한 줄(`WriteNote` — 「이 지역에서 열기 ↗」 · 「리더에서 열기 ↗」).
   * 전역에서 지역을 골랐으면 폼 위에 「쓸 지역」 한 줄(`Writable target`)이 붙는다.
   */
  import { getContext, type Snippet } from 'svelte';
  import { Button, setFormLayout, toast } from '#lib/ui';
  import Writable from '#lib/global/Writable.svelte';
  import WriteNote from '#lib/global/WriteNote.svelte';
  import type { Scope } from '#lib/global/scope.svelte.ts';

  let { view, dirty, invalid = false, pending = false, saving = false, onsave, onrevert, children }: {
    view: readonly ViewSection[];
    dirty: boolean;
    invalid?: boolean;
    pending?: boolean;
    saving?: boolean;
    onsave: () => void;
    onrevert: () => void;
    children: Snippet;
  } = $props();
  setFormLayout('compact');
  const scope = getContext<Scope | undefined>('scope');

  const hint = $derived(invalid ? '✕ 오류가 있는 항목을 고쳐요' : dirty ? '저장하면 커밋하고 적용 대기에 새 리비전이 생겨요.'
    : pending ? '◐ 적용 대기 중인 변경이 있어요.' : '바뀐 값이 없어요.');
  const hintColor = $derived(invalid ? 'var(--danger)' : dirty ? 'var(--pending)' : 'var(--tx3)');
  const save = (): void => {
    if (!dirty || saving) return;
    if (invalid) { toast.fail('입력을 확인해요', '오류가 있는 항목을 고쳐요.'); return; }
    onsave();
  };
  /** 시안 `viewSecs.w` — 칸이 셋 이상이면 한 줄, 둘이면 반, 하나면 사분의 일. */
  const width = (n: number): string => (n >= 3 ? '100%' : n === 2 ? 'calc(50% - 8px)' : 'calc(25% - 12px)');
</script>

{#if scope?.blocked === true}
  <div class="view">
    <div class="secs">
      {#each view as sec (sec.t)}
        <div class="vs" style:width={width(sec.f.length)}>
          <div class="vt">{sec.t}</div>
          <div class="vg">{#each sec.f as f (f.l)}<div><div class="vl">{f.l}</div><div class="vv" class:mono={f.mono}>{f.v}</div></div>{/each}</div>
        </div>
      {/each}
    </div>
    <WriteNote />
  </div>
{:else}
  <Writable target>
    <form class="set" onsubmit={(e) => { e.preventDefault(); save(); }}>
      <div class="fields">{@render children()}</div>
      <div class="foot">
        <span class="hint" style:color={hintColor}>{hint}</span>
        <Button disabled={!dirty || saving} onclick={onrevert}>되돌리기</Button>
        <span class="sv" data-off={!dirty}><Button variant="primary" type="submit" loading={saving} disabled={!dirty}>{saving ? '저장 중' : '저장'}</Button></span>
      </div>
    </form>
  </Writable>
{/if}

<style>
  /* 값은 콘솔 시안 `tSet` · `tSetView` 블록의 인라인 style 그대로다. */
  .set { display: flex; flex-direction: column; gap: 16px; max-width: 760px; }
  .fields { display: flex; flex-direction: column; gap: 16px; }
  .foot { display: flex; align-items: center; gap: 10px; padding-top: 12px; border-top: 1px solid var(--bd); flex-wrap: wrap; }
  .hint { flex: 1; font-size: 12px; }
  .sv[data-off='true'] :global(.btn:disabled) { border-color: var(--accent); background: var(--accent); color: var(--accent-fg); opacity: .5; }
  .view { display: flex; flex-direction: column; gap: 14px; max-width: 900px; }
  .secs { display: flex; flex-wrap: wrap; gap: 14px 16px; }
  .vs { min-width: 0; }
  .vt { font-size: 12px; font-weight: 600; color: var(--tx2); letter-spacing: .4px; padding-bottom: 6px; border-bottom: 1px solid var(--bd); margin-bottom: 8px; }
  .vg { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 24px; }
  .vl { font-size: 12px; color: var(--tx3); }
  .vv { font-family: var(--font); font-size: 13px; white-space: pre-line; overflow-wrap: anywhere; }
  .vv.mono { font-family: var(--mono); }
</style>

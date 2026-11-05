<script lang="ts" module>
  /** 키 순서와 무관한 JSON — 「바뀐 값이 있나」 를 head 의 본문과 폼이 만든 본문으로 견준다. */
  export function sameBody(a: unknown, b: unknown): boolean {
    const norm = (v: unknown): unknown => (Array.isArray(v) ? v.map(norm)
      : typeof v === 'object' && v !== null ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm((v as Record<string, unknown>)[k])])) : v);
    return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
  }
</script>

<script lang="ts">
  /**
   * 상세 설정 탭의 틀 — 모든 리소스가 같다. 콘솔 시안 `tSet` 블록(쓸 수 있을 때)과 `tSetView` 블록(쓸 수 없을 때).
   *
   * **쓸 수 있으면** 폼(폭 760px · 구획 사이 16px · 콘솔 격자 150px · 480px — `setFormLayout('compact')`) 아래에 위에 선을 긋고
   * 「안내 · 되돌리기 · 저장」(32px). 안내 문구와 색은 인라인 수정과 같다(시안 `hintTxt`):
   *   · 오류 → 「✕ 오류가 있는 항목을 고쳐요」(위험 색) · 바꿨으면 「저장하면 커밋하고 적용 대기에 새 리비전이 생겨요.」(보라)
   *   · 적용 대기면 「◐ 적용 대기 중인 변경이 있어요.」 · 아니면 「바뀐 값이 없어요.」
   * 「저장」 · 「되돌리기」 는 바꾼 것이 없으면 잠긴다. 저장의 뜻은 부르는 쪽이 정한다.
   * 전역에서 지역을 골랐으면 위에 「쓸 지역」 한 줄(`Writable target`).
   * **쓸 수 없으면**(`scope.blocked` — 팔로워 · 연락 없음 · 전체 합산) 읽기 구획(`ReadView` — 시안 `tSetView`, `view` 또는 `kind` 의 `viewSecsOf`).
   */
  import { getContext, type Snippet } from 'svelte';
  import { page } from '$app/state';
  import { Button, setFormLayout, toast } from '#lib/ui';
  import type { ResourceKind } from '@web/resources';
  import Writable from '#lib/global/Writable.svelte';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { isPendingResource } from '#lib/pending';
  import ReadView from './ReadView.svelte';
  import { viewSecsOf, type ViewSection } from './view-secs';
  import { viewContextOf } from './facts';

  let { kind, view, dirty, invalid = false, pending: pendingIn, saving: savingIn, onsave, onrevert, children, after }: {
    /** 「적용 대기」 를 이 리소스로 판정한다. 안 주면 `pending` 을 준다. */
    kind?: ResourceKind;
    /** 쓸 수 없을 때의 읽기 구획(시안 `viewSecs`). 안 주면 `kind` 로 만든다. 둘 다 없으면 쓸 수 없어도 폼을 그린다(쓰기는 `Writable` 이 막는다). */
    view?: readonly ViewSection[];
    dirty: boolean;
    invalid?: boolean;
    /** 적용 대기 — 안 주면 `kind` 로 desk 에서 본다. */
    pending?: boolean;
    /** 저장 중 — 안 주면 desk 가 쓰는 중인지 본다. */
    saving?: boolean;
    onsave: () => void;
    onrevert: () => void;
    children: Snippet;
    /** 저장 줄 아래에 더 둘 것(접은 JSON 수정 등 — 시안에 없지만 있던 것). */
    after?: Snippet;
  } = $props();
  setFormLayout('compact');
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const key = $derived(page.params['key'] ?? '');
  const pending = $derived(pendingIn ?? (kind !== undefined && isPendingResource(desk.pendingResources, kind, key)));
  const saving = $derived(savingIn ?? desk.editing);
  /** 읽기 구획 — 안 주면 `kind` 로 설정 폼의 구획 · 칸 전부(`viewSecsOf`, 분할 상세 보기 모드와 같다). */
  const sections = $derived(view ?? (kind === undefined ? undefined : viewSecsOf(desk.model, kind, key, viewContextOf(desk, kind, key))));
  const hint = $derived(invalid ? '✕ 오류가 있는 항목을 고쳐요' : dirty ? '저장하면 커밋하고 적용 대기에 새 리비전이 생겨요.'
    : pending ? '◐ 적용 대기 중인 변경이 있어요.' : '바뀐 값이 없어요.');
  const hintColor = $derived(invalid ? 'var(--danger)' : dirty ? 'var(--pending)' : 'var(--tx3)');
  const save = (): void => {
    if (!dirty || saving) return;
    if (invalid) { toast.fail('입력을 확인해요', '오류가 있는 항목을 고쳐요.'); return; }
    onsave();
  };
</script>

{#if scope?.blocked === true && sections !== undefined}
  <ReadView {sections} />
{:else}
  <Writable>
    <form class="set" onsubmit={(e) => { e.preventDefault(); save(); }}>
      <div class="secs">{@render children()}</div>
      <div class="foot">
        <span class="hint" style:color={hintColor}>{hint}</span>
        <Button disabled={!dirty || saving} onclick={onrevert}>되돌리기</Button>
        <span class="sv" data-off={!dirty}><Button variant="primary" type="submit" loading={saving} disabled={!dirty}>{saving ? '저장 중' : '저장'}</Button></span>
      </div>
      {#if after}{@render after()}{/if}
    </form>
  </Writable>
{/if}

<style>
  /* 값은 시안 `tSet` 블록의 인라인 style 그대로다. */
  .set { display: flex; flex-direction: column; gap: 16px; max-width: 760px; }
  .secs { display: flex; flex-direction: column; gap: 16px; }
  .foot { display: flex; align-items: center; gap: 10px; padding-top: 12px; border-top: 1px solid var(--bd); flex-wrap: wrap; }
  .hint { flex: 1; font-size: 12px; }
  .sv[data-off='true'] :global(.btn:disabled) { border-color: var(--accent); background: var(--accent); color: var(--accent-fg); opacity: .5; }
</style>

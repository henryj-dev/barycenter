<script lang="ts">
  /**
   * 분할 상세의 인라인 수정 — 콘솔 시안 `inlModeD` 블록 · 디자인 시스템 §5 「분할 패턴」 의 저장 / 되돌리기.
   *
   * 본문(여백 12px 16px)에 그 리소스의 인라인 필드(`FormSection` · `FormRow`, 콘솔 격자 150px · 480px)를 두고,
   * 바닥에 붙은 줄에 안내 · 「상세 페이지 ↗」 · 「되돌리기」 · 「저장」 을 둔다. 안내 문구와 색은 시안 `hintTxt` 그대로:
   *   · 오류가 있으면 「✕ 오류가 있는 항목을 고쳐요」(위험 색)
   *   · 바꿨으면 「저장하면 커밋하고 적용 대기에 새 리비전이 생겨요.」(보라)
   *   · 적용 대기면 「◐ 적용 대기 중인 변경이 있어요.」 · 아니면 「바뀐 값이 없어요.」(흐린 색)
   * 「저장」 은 바꾼 것이 없으면 잠기고 흐리다(opacity .5). 오류가 있는데 누르면 시안처럼 토스트로 알린다.
   *
   * 필드는 시안 `INL[page]` 목록의 것만 둔다 — 나머지는 「상세 페이지 ↗」 의 설정 탭이다.
   * 저장 · 되돌리기의 뜻(어떤 patch 를 보내는가)은 부르는 쪽이 정한다. 여기는 틀과 문구만 한다.
   */
  import type { Snippet } from 'svelte';
  import { Button, setFormLayout, toast } from '#lib/ui';

  let { dirty, invalid = false, pending = false, saving = false, detailHref, onsave, onrevert, children }: {
    /** 고친 값이 처음과 다른가. */
    dirty: boolean;
    /** 칸에 오류가 있는가(각 칸의 오류 문구는 `FormRow error` 가 보인다). */
    invalid?: boolean;
    /** 이 리소스에 적용 대기 중인 변경이 있는가(시안 `selBase.pend`). */
    pending?: boolean;
    /** 저장 중 — 「저장」 이 스피너다. */
    saving?: boolean;
    /** 「상세 페이지 ↗」 주소. 없으면 안 그린다. */
    detailHref?: string;
    onsave: () => void;
    onrevert: () => void;
    children: Snippet;
  } = $props();
  setFormLayout('compact');

  const hint = $derived(invalid ? '✕ 오류가 있는 항목을 고쳐요' : dirty ? '저장하면 커밋하고 적용 대기에 새 리비전이 생겨요.'
    : pending ? '◐ 적용 대기 중인 변경이 있어요.' : '바뀐 값이 없어요.');
  const hintColor = $derived(invalid ? 'var(--danger)' : dirty ? 'var(--pending)' : 'var(--tx3)');
  const save = (): void => {
    if (!dirty || saving) return;
    if (invalid) { toast.fail('입력을 확인해요', '오류가 있는 항목을 고쳐요.'); return; }
    onsave();
  };
</script>

<form class="inl" onsubmit={(e) => { e.preventDefault(); save(); }}>
  <div class="fields">{@render children()}</div>
  <div class="foot">
    <span class="hint" style:color={hintColor}>{hint}</span>
    {#if detailHref !== undefined}<a class="det" href={detailHref}>상세 페이지 ↗</a>{/if}
    <Button size="sm" disabled={!dirty || saving} onclick={onrevert}>되돌리기</Button>
    <span class="sv" data-off={!dirty}><Button size="sm" variant="primary" type="submit" loading={saving} disabled={!dirty}>{saving ? '저장 중' : '저장'}</Button></span>
  </div>
</form>

<style>
  /* 값은 콘솔 시안 `inlModeD` 블록의 인라인 style 그대로다. */
  .inl { display: flex; flex-direction: column; min-height: 100%; }
  .fields { flex: 1; padding: 12px 16px; display: flex; flex-direction: column; gap: 16px; }
  .foot {
    position: sticky; bottom: 0; display: flex; align-items: center; gap: 10px; padding: 10px 16px;
    background: var(--bg-panel); border-top: 1px solid var(--bd); flex-wrap: wrap;
  }
  .hint { flex: 1; font-size: 12px; }
  .det { color: var(--accent); font: 500 12px/1 var(--font); text-decoration: none; }
  .det:hover { text-decoration: underline; }
  /* 시안: 바꾼 것이 없으면 「저장」 은 강조 색 그대로 흐리기만 한다(opacity .5). */
  .sv[data-off='true'] :global(.btn:disabled) { border-color: var(--accent); background: var(--accent); color: var(--accent-fg); opacity: .5; }
</style>

<script lang="ts">
  /**
   * 버튼 — 디자인 시스템 §2.
   *
   * 변형: primary(주요) · secondary(보조) · danger(위험) · text(텍스트) · icon(아이콘, `label` 필수).
   * 상태: loading(스피너 + 누를 수 없음) · error(테두리가 위험 색 — 「다시 시도해요」) · disabled.
   * `href` 를 주면 링크로 그린다(모양은 같다).
   */
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';
  import Spinner from './Spinner.svelte';

  type Variant = 'primary' | 'secondary' | 'danger' | 'text' | 'icon';
  let {
    variant = 'secondary', size = 'md', loading = false, error = false, disabled = false,
    type = 'button', href, label, outline, dim = false, expanded, children, ...rest
  }: {
    variant?: Variant;
    /**
     * 보조 버튼을 톤 색 테두리 · 글자로(배경 없음). 콘솔 「이 지역에서 열기 ↗」(accent, 600) ·
     * 디자인 시스템 §7 「롤백해요…」(danger, 600) · 토스트 견본(ok · info). `error` 와 달리 상태가 아니라 뜻이다.
     */
    outline?: 'accent' | 'danger' | 'ok' | 'info' | 'pending';
    /**
     * 비활성일 때 모양을 그대로 두고 흐리기만 한다(opacity .45) — 콘솔 대화상자 · 드로어의 확인 버튼(`dlgOp` · `modalOp`).
     * 기본 비활성은 디자인 시스템 §2 의 회색(테두리 --bd · 배경 --bg-hover · 글 --tx3)이다.
     */
    dim?: boolean;
    /** 펼침 버튼(「▸ 포함된 커밋 · 3」 같은 접는 머리)이면 펼친 상태 — `aria-expanded` 로 나간다. */
    expanded?: boolean;
    /** md 32px(기본) · sm 28px(콘솔의 작은 버튼 줄) · xs 24px(디자인 시스템 §2 「작게 24px」 · 분할 머리 · 일괄 작업 줄). */
    size?: 'md' | 'sm' | 'xs';
    loading?: boolean;
    error?: boolean;
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
    href?: string;
    /** 아이콘 버튼의 이름(스크린 리더). 다른 변형에서는 `title` 로 쓴다. */
    label?: string;
    children?: Snippet;
  } & Omit<HTMLButtonAttributes, 'type' | 'disabled'> = $props();
</script>

{#if href !== undefined && !disabled}
  <a class="btn" data-variant={variant} data-size={size} data-error={error} data-outline={outline} {href} aria-label={variant === 'icon' ? label : undefined} title={label}>
    {@render children?.()}
  </a>
{:else}
  <button
    class="btn" data-variant={variant} data-size={size} data-error={error} data-loading={loading}
    data-outline={outline} data-dim={dim} aria-expanded={expanded}
    {type} disabled={disabled || loading} aria-busy={loading} aria-label={variant === 'icon' ? label : undefined}
    title={label} {...rest}
  >
    {#if loading}<Spinner />{/if}
    {@render children?.()}
  </button>
{/if}

<style>
  .btn {
    height: 32px;
    padding: 0 14px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    border: 1px solid var(--bd-strong);
    border-radius: var(--r-md);
    background: transparent;
    color: var(--tx);
    font: 500 13px/1 var(--font);
    white-space: nowrap;
    text-decoration: none;
    cursor: pointer;
    transition: background-color var(--dur-fast) var(--ease), filter var(--dur-fast) var(--ease), border-color var(--dur-fast) var(--ease);
  }
  .btn[data-size='sm'] { height: 28px; padding: 0 12px; font-size: 12px; }
  .btn[data-size='xs'] { height: 24px; padding: 0 10px; font-size: 12px; border-radius: var(--r-sm); }
  .btn:not(:disabled):hover { background-image: linear-gradient(var(--hov), var(--hov)); color: var(--tx); }
  .btn:not(:disabled):active { filter: brightness(.9); }
  .btn:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; }

  /* 주요 */
  .btn[data-variant='primary'] { border-color: var(--accent); background: var(--accent); color: var(--accent-fg); font-weight: 600; }
  .btn[data-variant='primary']:not(:disabled):hover { border-color: var(--focus); background: var(--focus); color: var(--accent-fg); filter: brightness(1.08); }
  /* 보조 */
  .btn[data-variant='secondary']:not(:disabled):hover { border-color: var(--tx3); background: var(--bg-hover); }
  .btn[data-variant='secondary'][data-loading='true'] { color: var(--tx2); }
  /* 위험 */
  .btn[data-variant='danger'] { border-color: var(--danger); background: var(--danger); color: var(--accent-fg); font-weight: 600; }
  .btn[data-variant='danger']:not(:disabled):hover { color: var(--accent-fg); filter: brightness(1.1); }
  /* 텍스트 */
  .btn[data-variant='text'] { border-color: transparent; padding: 0 8px; color: var(--accent); }
  .btn[data-variant='text']:not(:disabled):hover { background: var(--bg-hover); color: var(--accent); text-decoration: underline; }
  .btn[data-variant='text'][data-loading='true'] { color: var(--tx2); }
  .btn[data-variant='text'][data-error='true'] { border-color: transparent; color: var(--danger); }
  /* 아이콘 */
  .btn[data-variant='icon'] { width: 32px; padding: 0; border-color: transparent; color: var(--tx2); font-weight: 600; font-size: 16px; }
  .btn[data-variant='icon'][data-size='sm'] { width: 28px; }
  .btn[data-variant='icon'][data-size='xs'] { width: 24px; }
  .btn[data-variant='icon']:not(:disabled):hover { background: var(--bg-hover); color: var(--tx); }
  .btn[data-variant='icon'][data-error='true'] { border-color: var(--danger); color: var(--danger); font-weight: 700; font-size: 14px; }

  /* 로딩 — 누를 수 없지만 비활성처럼 흐리지 않는다 */
  .btn[data-loading='true'] { opacity: .85; cursor: progress; }
  /* 오류 — 테두리만 위험 색. 보조는 글자도 */
  .btn[data-error='true'] { border-color: var(--danger); }
  .btn[data-variant='secondary'][data-error='true'] { color: var(--danger); }

  /* 비활성 — 변형과 무관하게 같다 */
  .btn:disabled:not([data-loading='true']) {
    border-color: var(--bd);
    background: var(--bg-hover);
    color: var(--tx3);
    filter: none;
  }
  .btn[data-variant='secondary']:disabled:not([data-loading='true']),
  .btn[data-variant='text']:disabled,
  .btn[data-variant='icon']:disabled { background: transparent; }
  .btn[data-variant='text']:disabled, .btn[data-variant='icon']:disabled { border-color: transparent; }

  /* 톤 테두리 보조 버튼(`outline`) */
  .btn[data-outline='accent'] { --oc: var(--accent); font-weight: 600; }
  .btn[data-outline='danger'] { --oc: var(--danger); font-weight: 600; }
  .btn[data-outline='ok'] { --oc: var(--ok); }
  .btn[data-outline='info'] { --oc: var(--info); }
  .btn[data-outline='pending'] { --oc: var(--pending); font-weight: 600; }
  .btn[data-outline]:not([data-outline='undefined']) { border-color: var(--oc); color: var(--oc); background: transparent; }
  .btn[data-outline]:not([data-outline='undefined']):not(:disabled):hover { border-color: var(--oc); color: var(--oc); }

  /* 흐리기만 하는 비활성(`dim`) — 모양은 그 변형 그대로 */
  .btn[data-dim='true']:disabled:not([data-loading='true']) { opacity: .45; filter: none; }
  .btn[data-dim='true'][data-variant='primary']:disabled { border-color: var(--accent); background: var(--accent); color: var(--accent-fg); }
  .btn[data-dim='true'][data-variant='danger']:disabled { border-color: var(--danger); background: var(--danger); color: var(--accent-fg); }
  .btn[data-dim='true'][data-variant='secondary']:disabled { border-color: var(--bd-strong); color: var(--tx); }
</style>

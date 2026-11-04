<script lang="ts" module>
  import type { Snippet } from 'svelte';
  /**
   * 드로어 안의 자식이 아래 버튼 줄을 드로어에 넘기는 자리. `CreateForm` 이 쓴다 —
   * 폼은 본문(스크롤)에, 「취소」 · 「만들기」 는 드로어 바닥(고정)에 있어야 해서다.
   */
  export type DrawerContext = { footer: Snippet | undefined; close: () => void };
  export const DRAWER = Symbol('bc-drawer');
</script>

<script lang="ts">
  /**
   * 오른쪽 드로어 — 콘솔 시안의 `drawer` 마크업(`drD` · `drTitle` · `drSub` · `drW` · `wregD`).
   *
   * 화면 전체를 어둡게(rgba(0,0,0,.45)) 덮고, 오른쪽에서 밀려 나온다(`bc-slide`). 폭은 시안 `drW` —
   * 기본 500px, 빠른 프록시 560px, 경로별 묶음 680px. 머리: 제목(16px 600) · 부제(12px 흐린색) · `region`
   * (전역의 「쓸 지역」 한 줄) · ✕. 본문은 스크롤한다(여백 16px 20px). 바닥: `footer` 스니펫 또는 자식이 넘긴 버튼 줄.
   * 어둡게 덮은 곳을 누르거나 Esc 면 닫힌다. 열리면 초점이 안으로 가고 Tab 은 안에서만 돈다. 닫히면 연 자리로 돌아간다.
   * 안의 폼은 콘솔 격자(라벨 150px · 입력 480px)로 그린다(`form-layout.ts`).
   */
  import { setContext, tick } from 'svelte';
  import { setFormLayout } from './form-layout.ts';

  let { open = true, title, sub, width = 500, onclose, region, footer, children }: {
    open?: boolean;
    title: string;
    sub?: string;
    /** 시안 `drW`. */
    width?: number;
    onclose: () => void;
    /** 머리 아래 한 줄 — 전역에서 「쓸 지역」 고르기(시안 `wregD`). */
    region?: Snippet;
    /** 바닥 버튼 줄. 없으면 자식이 `DRAWER` 문맥으로 넘긴 것을 그린다. */
    footer?: Snippet;
    children: Snippet;
  } = $props();

  setFormLayout('compact');
  const ctx: DrawerContext = $state({ footer: undefined, close: () => onclose() });
  setContext(DRAWER, ctx);

  let aside: HTMLElement | undefined = $state();
  const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';
  const focusables = (): HTMLElement[] => (aside === undefined ? [] : [...aside.querySelectorAll<HTMLElement>(FOCUSABLE)]);

  $effect(() => {
    if (!open) return;
    const before = document.activeElement as HTMLElement | null;
    void tick().then(() => {
      // 본문의 첫 칸으로 — 없으면 드로어 자체로.
      const body = aside?.querySelector<HTMLElement>('.dbody');
      (body?.querySelector<HTMLElement>(FOCUSABLE) ?? aside)?.focus();
    });
    return () => { before?.focus?.(); };
  });

  const key = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onclose(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (f.length === 0) { e.preventDefault(); return; }
    const first = f[0]!, last = f[f.length - 1]!;
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  };
  const bottom = $derived(footer ?? ctx.footer);
</script>

{#if open}
  <div class="dr">
    <div class="scrim" role="presentation" onclick={onclose}></div>
    <div class="panel" bind:this={aside} role="dialog" aria-modal="true" aria-label={title} tabindex="-1" style:width="{width}px" onkeydown={key}>
      <div class="dhead">
        <div class="grow">
          <div class="title">{title}</div>
          {#if sub}<div class="sub">{sub}</div>{/if}
          {#if region}<div class="region">{@render region()}</div>{/if}
        </div>
        <button type="button" class="x" aria-label="닫기" onclick={onclose}>✕</button>
      </div>
      <div class="dbody">{@render children()}</div>
      {#if bottom}<div class="dfoot">{@render bottom()}</div>{/if}
    </div>
  </div>
{/if}

<style>
  /* 값은 콘솔 시안 `drawer` 마크업 그대로다. */
  .dr { position: fixed; inset: 0; z-index: 45; }
  .scrim { position: absolute; inset: 0; background: rgba(0, 0, 0, .45); }
  .panel {
    position: absolute; top: 0; right: 0; bottom: 0; max-width: 100%; background: var(--bg-panel);
    border-left: 1px solid var(--bd-strong); box-shadow: var(--sh-pop); display: flex; flex-direction: column;
    animation: bc-slide var(--dur) var(--ease); outline: none;
  }
  .dhead { flex: none; display: flex; align-items: center; gap: 10px; padding: 14px 20px; border-bottom: 1px solid var(--bd); }
  .grow { flex: 1; min-width: 0; }
  .title { font-size: 16px; font-weight: 600; line-height: 24px; }
  .sub { font-size: 12px; color: var(--tx3); }
  .region { display: flex; align-items: center; gap: 8px; margin-top: 6px; font-size: 12px; color: var(--tx2); }
  .x { width: 32px; height: 32px; border: 0; border-radius: var(--r-md); background: transparent; color: var(--tx2); font-size: 14px; flex: none; }
  .dbody { flex: 1; min-height: 0; overflow: auto; padding: 16px 20px; }
  .dfoot { flex: none; display: flex; align-items: center; gap: 10px; padding: 12px 20px; border-top: 1px solid var(--bd); }
  @keyframes bc-slide { from { transform: translateX(28px); opacity: 0; } to { transform: none; opacity: 1; } }
</style>

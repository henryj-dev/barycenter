<script lang="ts">
  /**
   * 상단 바 — 디자인 시안 「Console」 셸의 Top bar. 브레드크럼 · (클러스터면) 노드 칩 · head 리비전 · 실시간 연결 ·
   * 적용 대기 버튼(건수, 누르면 영향 화면) · 사용자 메뉴(내 계정 · 테마 · 로그아웃).
   * 값(높이 · 간격 · 글꼴 · 색 토큰)은 시안의 인라인 style 그대로다.
   * **로그인 상태에서는 토큰 칸을 어디에도 안 보인다** — 토큰 연결은 로그인 화면에 있다.
   */
  import { tick } from 'svelte';
  import type { ConnState } from '@web/reconnect';
  import { ROLE_LABEL } from '#lib/account/text';
  import type { Role } from '#lib/account/api';

  type Theme = 'system' | 'dark' | 'light';
  let { crumbs, monoLast = false, node, standby = false, head, conn, pending = 0, user, role, mfa, theme = $bindable('system'), onlogout, ondisconnect }: {
    crumbs: readonly { label: string; href?: string }[];
    /** 상세 화면이면 마지막 칸(리소스 이름)을 고정폭으로 쓴다(시안 `ff: var(--mono)`). */
    monoLast?: boolean;
    /** 클러스터면 이 노드 이름. */
    node?: string;
    /** 이 노드가 팔로워인가 — 노드 칩이 「· 리더」 · 「· 팔로워」 를 붙인다. */
    standby?: boolean;
    head?: string;
    conn: ConnState;
    pending?: number;
    /** 사람 계정이면 이름. 토큰으로 붙었으면 undefined. */
    user?: string;
    role?: Role;
    /** 사람 계정의 인증 앱 등록 여부 — 메뉴 머리 「역할 · MFA 켜짐」. */
    mfa?: boolean;
    theme?: Theme;
    onlogout: () => void;
    ondisconnect: () => void;
  } = $props();

  const roleLabel = $derived(role === undefined ? undefined : ROLE_LABEL[role] ?? role);
  const themeLabel: Record<Theme, string> = { system: '시스템', dark: '다크', light: '라이트' };

  /** 시안 `connMap` — [이름, 색, 점 모양, 깜빡임]. 「대기」 는 시안에 없다(전역에서 붙을 곳이 아직 없다). */
  const CONN: Record<ConnState, [string, string, string, string]> = {
    live: ['실시간 수신 중', 'var(--ok)', '50%', 'none'],
    reconnecting: ['재연결 중', 'var(--warn)', '50%', 'bc-pulse 1s infinite'],
    down: ['끊김', 'var(--danger)', '2px', 'none'],
    idle: ['지역을 고르면 붙어요', 'var(--tx3)', '50%', 'none'],
  };
  const cn = $derived(CONN[conn]);
  const nodeLbl = $derived(node === undefined ? '' : `${node} · ${standby ? '팔로워' : '리더'}`);

  // ── 사용자 메뉴 (시안: data-pop — 밖을 누르거나 Esc 면 닫힌다) ──
  let open = $state(false);
  let pop: HTMLDivElement | undefined = $state();
  let trigger: HTMLButtonElement | undefined = $state();
  const close = (refocus = false): void => { open = false; if (refocus) trigger?.focus(); };
  const toggle = async (): Promise<void> => {
    open = !open;
    if (open) { await tick(); pop?.querySelector<HTMLElement>('[role^="menuitem"]')?.focus(); }
  };
  const outside = (e: MouseEvent): void => { if (open && !(e.target as Element).closest?.('[data-pop]')) close(); };
  /** ↑↓ 로 항목을 옮긴다. Esc 로 닫고 버튼으로 돌아간다. */
  const menuKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); close(true); return; }
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
    e.preventDefault();
    const items = [...(pop?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const at = items.indexOf(document.activeElement as HTMLElement);
    items[(at + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length]?.focus();
  };
</script>

<svelte:document onmousedown={outside} onkeydown={(e) => { if (open && e.key === 'Escape') close(); }} />

<header class="tb">
  <nav class="crumbs" aria-label="경로">
    {#each crumbs as c, i (i)}
      {@const last = i === crumbs.length - 1}
      <span class="cr" class:last>
        {#if i > 0}<span class="sep" aria-hidden="true">/</span>{/if}
        {#if c.href && !last}
          <a class="cb" href={c.href}>{c.label}</a>
        {:else}
          <span class="cb" class:mono={last && monoLast} aria-current={last ? 'page' : undefined}>{c.label}</span>
        {/if}
      </span>
    {/each}
  </nav>
  {#if node}<span class="chip node" title="보고 있는 노드" aria-label="보고 있는 노드: {nodeLbl}" style:color={standby ? 'var(--tx)' : 'var(--accent)'}>{nodeLbl}</span>{/if}
  {#if head}<span class="chip" title="현재 head 리비전">head <b>r{head}</b></span>{/if}
  <span class="conn" role="status" aria-label="실시간 연결 상태: {cn[0]}" style:border-color={conn === 'live' ? 'var(--bd)' : cn[1]} style:color={cn[1]}>
    <span class="dot" aria-hidden="true" style:border-radius={cn[2]} style:animation={cn[3]}></span>{cn[0]}
  </span>
  {#if pending > 0}
    <a class="pending" href="/change/pending" aria-label="적용 대기 {pending}건, 영향 화면으로">◐ 적용 대기<span class="n">{pending}</span></a>
  {/if}
  <div class="um" data-pop="1">
    <button type="button" class="user" bind:this={trigger} aria-haspopup="menu" aria-expanded={open} onclick={() => { void toggle(); }}>
      <span class="av" aria-hidden="true">{(user ?? '토').slice(0, 1).toUpperCase()}</span>{user ?? '토큰'}<span class="caret" aria-hidden="true">▼</span>
    </button>
    {#if open}
      <div class="pop" role="menu" tabindex="-1" aria-label="사용자 메뉴" bind:this={pop} onkeydown={menuKey}>
        {#if user !== undefined}
          <div class="hd" role="presentation">
            <div class="hn">{user}</div>
            {#if roleLabel !== undefined}<div class="hs">{roleLabel} · MFA {mfa === true ? '켜짐' : '꺼짐'}</div>{/if}
          </div>
          <a role="menuitem" class="mi" href="/account" onclick={() => close()}>내 계정</a>
        {/if}
        {#each ['system', 'dark', 'light'] as const as t (t)}
          <button type="button" role="menuitemradio" class="mi" aria-checked={theme === t} onclick={() => { theme = t; }}>
            <span class="mk" aria-hidden="true">{theme === t ? '✓' : ''}</span>테마: {themeLabel[t]}
          </button>
        {/each}
        {#if user !== undefined}
          <button type="button" role="menuitem" class="mi danger" onclick={() => { close(); onlogout(); }}>로그아웃</button>
        {:else}
          <button type="button" role="menuitem" class="mi danger" onclick={() => { close(); ondisconnect(); }}>연결 끊기</button>
        {/if}
      </div>
    {/if}
  </div>
</header>

<style>
  .tb {
    flex: none; height: 52px; background: var(--bg-panel); border-bottom: 1px solid var(--bd);
    display: flex; align-items: center; gap: 12px; padding: 0 20px; position: sticky; top: 0; z-index: var(--z-header);
  }
  .crumbs { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; font-size: 13px; overflow: hidden; }
  .cr { display: inline-flex; align-items: center; gap: 8px; color: var(--tx3); font-weight: 400; white-space: nowrap; }
  .cr.last { color: var(--tx); font-weight: 600; }
  .sep { color: var(--tx3); }
  .cb {
    border: 0; background: transparent; padding: 2px 4px; border-radius: var(--r-sm);
    color: inherit; font-size: 13px; font-weight: inherit; font-family: inherit; text-decoration: none; cursor: default;
  }
  a.cb { cursor: pointer; }
  a.cb:hover { color: inherit; text-decoration: none; background-image: linear-gradient(var(--hov), var(--hov)); }
  .cb.mono { font-family: var(--mono); }
  .chip {
    flex: none; height: 26px; padding: 0 10px; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--bd-strong);
    border-radius: var(--r-sm); font-size: 12px; color: var(--tx2); white-space: nowrap;
  }
  .chip b { font-family: var(--mono); color: var(--tx); font-weight: 600; }
  .chip.node { background: transparent; font-family: var(--mono); }
  .conn {
    flex: none; height: 26px; padding: 0 10px; display: inline-flex; align-items: center; gap: 6px; border-radius: 13px;
    border: 1px solid var(--bd); background: transparent; font-size: 12px; white-space: nowrap;
  }
  .dot { width: 8px; height: 8px; background: currentColor; }
  .pending {
    flex: none; height: 32px; padding: 0 12px; display: inline-flex; align-items: center; gap: 8px; border-radius: var(--r-md);
    border: 1px solid var(--pending); background: var(--pending-bg); color: var(--pending); font-weight: 600; font-size: 13px; text-decoration: none; white-space: nowrap;
    transition: background-color var(--dur-fast) var(--ease), filter var(--dur-fast) var(--ease);
  }
  .pending:hover { color: var(--pending); text-decoration: none; background-image: linear-gradient(var(--hov), var(--hov)); }
  .pending:active { filter: brightness(.9); }
  .n { min-width: 20px; height: 18px; padding: 0 6px; border-radius: 9px; background: var(--pending); color: var(--accent-fg); font-size: 11px; font-weight: 700; line-height: 18px; text-align: center; }
  .um { position: relative; flex: none; }
  .user {
    height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 4px; border: 1px solid transparent; background: transparent;
    border-radius: var(--r-md); color: var(--tx); font-size: 13px; white-space: nowrap;
  }
  .user:hover { background-image: linear-gradient(var(--hov), var(--hov)); }
  .av { width: 24px; height: 24px; border-radius: 50%; background: var(--accent-bg); color: var(--accent); display: grid; place-items: center; font-size: 12px; font-weight: 700; }
  .caret { color: var(--tx3); font-size: 10px; }
  .pop {
    position: absolute; right: 0; top: 38px; z-index: 30; width: 220px; background: var(--bg-panel); border: 1px solid var(--bd-strong);
    border-radius: var(--r-md); box-shadow: var(--sh-pop); padding: 4px; animation: bc-in var(--dur) var(--ease);
  }
  .hd { padding: 8px 10px; border-bottom: 1px solid var(--bd); margin-bottom: 4px; }
  .hn { font-size: 13px; font-weight: 600; }
  .hs { font-size: 12px; color: var(--tx3); }
  .mi {
    width: 100%; display: flex; align-items: center; text-align: left; padding: 6px 10px; border: 0; border-radius: var(--r-sm);
    background: transparent; color: var(--tx); font-size: 13px; text-decoration: none; white-space: nowrap;
  }
  .mi:hover { color: var(--tx); text-decoration: none; background-image: linear-gradient(var(--hov), var(--hov)); }
  .mi.danger, .mi.danger:hover { color: var(--danger); }
  /* 테마 항목 — 시안에 없는 기능이라 같은 모양의 줄로 둔다. 고른 것에 ✓ */
  .mk { width: 16px; flex: none; color: var(--accent); font-weight: 700; }
  @media (max-width: 860px) {
    .tb { padding: 0 12px; gap: 8px; }
    .chip { display: none; }
  }
</style>

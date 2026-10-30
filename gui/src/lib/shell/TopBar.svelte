<script lang="ts">
  /**
   * 상단 바 — 디자인 시안 「App Shell」. 브레드크럼 · (클러스터면) 노드 칩 · head 리비전 · 실시간 연결 ·
   * 적용 대기 버튼(건수, 누르면 영향 화면) · 사용자 메뉴(내 계정 · 테마 · 로그아웃).
   * **로그인 상태에서는 토큰 칸을 어디에도 안 보인다** — 토큰 연결은 로그인 화면에 있다.
   */
  import { ConnectionStatus, Menu, type MenuItem } from '#lib/ui';

  type Theme = 'system' | 'dark' | 'light';
  let { crumbs, node, head, conn, pending = 0, user, role, theme = $bindable('system'), onlogout, ondisconnect, menuOpen = $bindable(false) }: {
    crumbs: readonly { label: string; href?: string }[];
    /** 클러스터면 이 노드 이름. */
    node?: string;
    head?: string;
    conn: 'live' | 'reconnecting' | 'down';
    pending?: number;
    /** 사람 계정이면 이름. 토큰으로 붙었으면 undefined. */
    user?: string;
    role?: string;
    theme?: Theme;
    onlogout: () => void;
    ondisconnect: () => void;
    /** 좁은 화면의 메뉴 버튼(사이드바 열기). */
    menuOpen?: boolean;
  } = $props();

  const themeLabel: Record<Theme, string> = { system: '시스템', dark: '다크', light: '라이트' };
  const items = $derived<MenuItem[]>([
    ...(user !== undefined ? [{ label: '내 계정', href: '/account' }] : []),
    ...(['system', 'dark', 'light'] as const).map((t): MenuItem => ({ label: `테마: ${themeLabel[t]}`, checked: theme === t, onselect: () => { theme = t; } })),
    user !== undefined ? { label: '로그아웃', danger: true, onselect: onlogout } : { label: '연결 끊기', danger: true, onselect: ondisconnect },
  ]);
</script>

<header class="tb">
  <button type="button" class="burger" aria-label="메뉴 열기" aria-expanded={menuOpen} onclick={() => { menuOpen = !menuOpen; }}>☰</button>
  <nav class="crumbs" aria-label="경로">
    {#each crumbs as c, i (i)}
      {#if i > 0}<span class="sep" aria-hidden="true">/</span>{/if}
      {#if c.href && i < crumbs.length - 1}<a href={c.href}>{c.label}</a>{:else}<span class:last={i === crumbs.length - 1}>{c.label}</span>{/if}
    {/each}
  </nav>
  {#if node}<span class="chip mono" title="보고 있는 노드">{node}</span>{/if}
  {#if head}<span class="chip" title="현재 head 리비전">head <b class="mono">r{head}</b></span>{/if}
  <ConnectionStatus state={conn} />
  {#if pending > 0}
    <a class="pending" href="/change/pending" aria-label="적용 대기 {pending}건, 영향 화면으로">◐ 적용 대기<span class="n">{pending}</span></a>
  {/if}
  <Menu {items} label="사용자 메뉴">
    {#snippet trigger({ open, toggle })}
      <button type="button" class="user" aria-haspopup="menu" aria-expanded={open} onclick={toggle}>
        <span class="av" aria-hidden="true">{(user ?? '토').slice(0, 1).toUpperCase()}</span>
        <span class="un">{user ?? '토큰'}</span>{#if role}<span class="role">{role}</span>{/if}<span class="caret" aria-hidden="true">▼</span>
      </button>
    {/snippet}
  </Menu>
</header>

<style>
  .tb {
    flex: none; height: 52px; background: var(--bg-panel); border-bottom: 1px solid var(--bd);
    display: flex; align-items: center; gap: 12px; padding: 0 20px; position: sticky; top: 0; z-index: var(--z-header);
  }
  .burger { display: none; border: 0; background: transparent; color: var(--tx2); font-size: 18px; padding: 4px; }
  .crumbs { flex: 1; min-width: 0; display: flex; align-items: center; gap: 8px; font: var(--t-small); overflow: hidden; white-space: nowrap; }
  .crumbs a, .crumbs span { color: var(--tx2); }
  .crumbs .last { color: var(--tx); font-weight: 600; }
  .sep { color: var(--tx3) !important; }
  .chip {
    flex: none; height: 26px; padding: 0 10px; display: inline-flex; align-items: center; gap: 6px; border: 1px solid var(--bd-strong);
    border-radius: var(--r-sm); font: 400 12px/1 var(--font); color: var(--tx2); white-space: nowrap;
  }
  .chip b { color: var(--tx); font-weight: 600; }
  .mono { font-family: var(--mono); }
  .pending {
    flex: none; height: 32px; padding: 0 12px; display: inline-flex; align-items: center; gap: 8px; border-radius: var(--r-md);
    border: 1px solid var(--pending); background: var(--pending-bg); color: var(--pending); font: 600 13px/1 var(--font); text-decoration: none; white-space: nowrap;
  }
  .pending:hover { color: var(--pending); text-decoration: none; filter: brightness(1.1); }
  .n { min-width: 20px; height: 18px; padding: 0 6px; border-radius: 9px; background: var(--pending); color: var(--accent-fg); font: 700 11px/18px var(--font); text-align: center; }
  .user { height: 32px; display: flex; align-items: center; gap: 8px; padding: 0 8px 0 4px; border: 1px solid transparent; background: transparent; border-radius: var(--r-md); color: var(--tx); font: var(--t-small); }
  .user:hover { background: var(--bg-hover); }
  .av { width: 24px; height: 24px; border-radius: 50%; background: var(--accent-bg); color: var(--accent); display: grid; place-items: center; font: 700 12px/1 var(--font); }
  .role { color: var(--tx3); font: var(--t-cap); }
  .caret { color: var(--tx3); font-size: 10px; }
  @media (max-width: 860px) {
    .tb { padding: 0 12px; gap: 8px; }
    .burger { display: block; }
    .chip, .un, .role { display: none; }
  }
</style>

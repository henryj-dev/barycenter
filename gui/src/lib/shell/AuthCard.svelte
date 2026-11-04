<script lang="ts">
  /**
   * 혼자 서는 화면(로그인 · 초대 수락 · 재설정 · 이메일 확인)의 카드 — 시안 「Login」.
   * 카드: 제목(18/26 · 600)과 한 줄 설명(13 · --tx2), 그 아래 본문. 카드 밖 아래에 가운데 링크 줄(`links`).
   * 로고 줄과 400px 기둥은 셸(`+layout.svelte`)이 그린다.
   */
  import type { Snippet } from 'svelte';
  let { title, sub, children, links }: { title: string; sub?: string; children: Snippet; links?: Snippet } = $props();
</script>

<div class="card">
  <div><h1>{title}</h1>{#if sub}<p>{sub}</p>{/if}</div>
  {@render children()}
</div>
{#if links}<div class="links">{@render links()}</div>{/if}

<style>
  .card { background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); padding: 24px; display: flex; flex-direction: column; gap: 16px; }
  h1 { margin: 0; font-size: 18px; font-weight: 600; line-height: 26px; }
  p { margin: 2px 0 0; color: var(--tx2); font-size: 13px; }
  .links { display: flex; justify-content: center; gap: 16px; font-size: 13px; }
  .links :global(a) { color: var(--accent); text-decoration: none; padding: 0; }
  .links :global(a:hover) { color: var(--focus); text-decoration: underline; }
</style>

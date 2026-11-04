<script lang="ts">
  /**
   * 입력 아래 한 줄 — 오류(✕, 위험 색) · 맞음(✓, 정상 색) · 경고(경고 색) · 도움말(흐린 색).
   * 경고는 콘솔 `f.hc = var(--warn)` 이다 — 표시(▲)는 시안 문구가 가진 곳에만 있어서 문구가 직접 단다.
   */
  import type { Snippet } from 'svelte';
  let { tone = 'help', id, children }: { tone?: 'error' | 'ok' | 'warn' | 'help'; id?: string; children: Snippet } = $props();
</script>

<div class="msg" data-tone={tone} {id} role={tone === 'error' ? 'alert' : undefined}>
  {#if tone === 'error'}✕ {:else if tone === 'ok'}✓ {/if}{@render children()}
</div>

<style>
  .msg { margin-top: 4px; font: var(--t-cap); color: var(--tx3); }
  .msg[data-tone='error'] { color: var(--danger); }
  .msg[data-tone='ok'] { color: var(--ok); }
  .msg[data-tone='warn'] { color: var(--warn); }
</style>

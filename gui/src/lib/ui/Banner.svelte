<script lang="ts">
  /**
   * 배너 — 디자인 시스템 §7. 화면 위쪽에 한 줄로 알린다(적용 대기 · 연결 끊김 …).
   * 오른쪽 `action` 스니펫에 버튼이나 링크를 둔다. `ondismiss` 가 있으면 ✕ 로 닫는다.
   */
  import type { Snippet } from 'svelte';
  import { TONE_ICON, type Tone } from './Badge.svelte';
  let { tone = 'info', icon, ondismiss, action, children }: {
    tone?: Tone; icon?: string; ondismiss?: () => void; action?: Snippet; children: Snippet;
  } = $props();
</script>

<div class="banner" data-tone={tone} role={tone === 'danger' ? 'alert' : 'status'}>
  <span class="icon" aria-hidden="true">{icon ?? TONE_ICON[tone]}</span>
  <span class="body">{@render children()}</span>
  {#if action}{@render action()}{/if}
  {#if ondismiss}<button type="button" class="x" aria-label="배너 닫기" onclick={ondismiss}>✕</button>{/if}
</div>

<style>
  .banner {
    --c: var(--info); --cb: var(--info-bg);
    display: flex; align-items: center; gap: 12px; padding: 10px 16px;
    background: var(--cb); border: 1px solid var(--c); border-radius: var(--r-md); font: var(--t-small); color: var(--tx);
  }
  .banner[data-tone='ok'] { --c: var(--ok); --cb: var(--ok-bg); }
  .banner[data-tone='warn'] { --c: var(--warn); --cb: var(--warn-bg); }
  .banner[data-tone='danger'] { --c: var(--danger); --cb: var(--danger-bg); }
  .banner[data-tone='pending'] { --c: var(--pending); --cb: var(--pending-bg); }
  .banner[data-tone='drain'] { --c: var(--drain); --cb: var(--drain-bg); }
  .banner[data-tone='neutral'] { --c: var(--neutral); --cb: var(--neutral-bg); }
  .icon { color: var(--c); font-weight: 700; }
  .body { flex: 1; min-width: 0; }
  .banner :global(.banner-action) {
    height: 24px; padding: 0 10px; display: inline-flex; align-items: center; border: 1px solid var(--c);
    background: transparent; color: var(--c); border-radius: var(--r-sm); font: 600 12px/1 var(--font); text-decoration: none; white-space: nowrap;
  }
  .x { border: 0; background: transparent; color: var(--tx3); padding: 2px 4px; }
</style>

<script lang="ts" module>
  /** 의미 톤 — 토큰의 전경·배경 쌍과 1:1 이다. */
  export type Tone = 'ok' | 'warn' | 'danger' | 'info' | 'neutral' | 'pending' | 'drain' | 'accent';
  /** 시안의 기본 아이콘. 같은 톤이라도 뜻이 다르면(적용하면 열림 ◐ / 닫힘 ◑) `icon` 으로 바꾼다. */
  export const TONE_ICON: Record<Tone, string> = {
    ok: '●', danger: '✕', info: '↻', neutral: '○', drain: '⇣', pending: '◐', warn: '▲', accent: '★',
  };
</script>

<script lang="ts">
  /**
   * 상태 배지 — 디자인 시스템 §6. 색만으로 뜻을 전하지 않는다 — 언제나 아이콘과 글이 같이 간다.
   * 예: 헬스(● 정상 · ✕ 비정상 · ↻ 확인 중 · ○ 관측 없음), 드레인(⇣), 리스너(◐ 적용하면 열림 · ◑ 닫힘),
   * 리더(★)·스탠바이(☆), 인증서(▲ 만료 임박 · ✕ 만료됨).
   */
  import type { Snippet } from 'svelte';
  let { tone = 'neutral', icon, title, children }: { tone?: Tone; icon?: string | null; title?: string; children: Snippet } = $props();
</script>

<span class="badge" data-tone={tone} {title}>
  {#if icon !== null}<span aria-hidden="true">{icon ?? TONE_ICON[tone]}</span>{/if}{@render children()}
</span>

<style>
  .badge {
    height: 22px;
    padding: 0 8px;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    border-radius: var(--r-sm);
    font: 500 12px/1 var(--font);
    white-space: nowrap;
    background: var(--neutral-bg);
    color: var(--neutral);
  }
  .badge[data-tone='ok'] { background: var(--ok-bg); color: var(--ok); }
  .badge[data-tone='warn'] { background: var(--warn-bg); color: var(--warn); }
  .badge[data-tone='danger'] { background: var(--danger-bg); color: var(--danger); }
  .badge[data-tone='info'] { background: var(--info-bg); color: var(--info); }
  .badge[data-tone='pending'] { background: var(--pending-bg); color: var(--pending); }
  .badge[data-tone='drain'] { background: var(--drain-bg); color: var(--drain); }
  .badge[data-tone='accent'] { background: var(--accent-bg); color: var(--accent); }
</style>

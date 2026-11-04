<script lang="ts" module>
  /** 톤과 기본 아이콘은 `tone.ts` 에 있다(.ts 에서도 쓰려고 — `cells.ts`). 여기서 다시 내보낸다. */
  export { TONE_ICON, type Tone } from './tone.ts';
</script>

<script lang="ts">
  /**
   * 상태 배지 — 디자인 시스템 §6. 색만으로 뜻을 전하지 않는다 — 언제나 아이콘과 글이 같이 간다.
   * 예: 헬스(● 정상 · ✕ 비정상 · ↻ 확인 중 · ○ 관측 없음), 드레인(⇣), 리스너(◐ 적용하면 열림 · ◑ 닫힘),
   * 리더(★)·스탠바이(☆), 인증서(▲ 만료 임박 · ✕ 만료됨).
   */
  import type { Snippet } from 'svelte';
  import { TONE_ICON, type Tone } from './tone.ts';
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

<script lang="ts">
  /**
   * 혼자 서는 화면의 칸 하나 — 시안 「Login」 의 필드: 라벨(13 · --tx2) 위, 입력(높이 36 · 14px, 라벨과 4px) 아래,
   * 그 아래 도움말(12 · --tx3). `code` 면 인증 코드 칸(높이 44 · 고정폭 22px · 자간 8 · 가운데)이다.
   * 입력 자체는 `#lib/ui` 의 `TextInput` 이다 — 여기서는 크기만 시안대로 맞춘다.
   */
  import type { Snippet } from 'svelte';
  let { label, for: htmlFor, help, code = false, children }: { label: string; for: string; help?: string; code?: boolean; children: Snippet } = $props();
</script>

<div class="f" class:code>
  <label for={htmlFor}>{label}</label>
  {@render children()}
  {#if help}<div class="help">{help}</div>{/if}
</div>

<style>
  .f { display: flex; flex-direction: column; }
  label { font-size: 13px; color: var(--tx2); }
  .f :global(input) { margin-top: 4px; width: 100%; height: 36px; padding: 0 10px; font-size: 14px; }
  .f.code { gap: 8px; }
  .f.code :global(input) { margin-top: 0; height: 44px; padding: 0 12px; font-family: var(--mono); font-size: 22px; letter-spacing: 8px; text-align: center; }
  .help { margin-top: 4px; font-size: 12px; color: var(--tx3); }
  .f.code .help { margin-top: 0; }
</style>

<script lang="ts" module>
  /** 보기 구획 하나 — 시안 `viewSecs` 의 `{ t, f: [{ l, v, ff }] }`. */
  export type ViewSection = { t: string; f: { l: string; v: string; mono?: boolean }[] };
</script>

<script lang="ts">
  /**
   * 읽기 구획 — 콘솔 시안 `viewSecs` 블록 그대로. 분할 상세의 보기 모드(`viewModeD`)와 쓸 수 없는 설정 탭(`tSetView`)이 같이 쓴다.
   * 구획마다 머리(12px · 600 · --tx2 · 아래 선) + 이름 · 값 격자(auto-fit 220px · 간격 10px 24px).
   * 구획 너비(시안 `sec.w`): 칸이 셋 이상이면 한 줄, 둘이면 반, 하나면 사분의 일.
   */
  let { sections }: { sections: readonly ViewSection[] } = $props();
  const width = (n: number): string => (n >= 3 ? '100%' : n === 2 ? 'calc(50% - 8px)' : 'calc(25% - 12px)');
</script>

<div class="secs">
  {#each sections as sec (sec.t)}
    <div class="vs" style:width={width(sec.f.length)}>
      <div class="vt">{sec.t}</div>
      <div class="vg">{#each sec.f as f (f.l)}<div><div class="vl">{f.l}</div><div class="vv" class:mono={f.mono}>{f.v}</div></div>{/each}</div>
    </div>
  {/each}
</div>

<style>
  /* 값은 콘솔 시안 `viewSecs` 블록의 인라인 style 그대로다. */
  .secs { display: flex; flex-wrap: wrap; gap: 14px 16px; }
  .vs { min-width: 0; }
  .vt { font-size: 12px; font-weight: 600; color: var(--tx2); letter-spacing: .4px; padding-bottom: 6px; border-bottom: 1px solid var(--bd); margin-bottom: 8px; }
  .vg { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px 24px; }
  .vl { font-size: 12px; color: var(--tx3); }
  .vv { font-family: var(--font); font-size: 13px; white-space: pre-line; overflow-wrap: anywhere; }
  .vv.mono { font-family: var(--mono); }
</style>

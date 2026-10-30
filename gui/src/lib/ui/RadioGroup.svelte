<script lang="ts" generics="T extends string">
  /** 라디오 묶음 — 디자인 시스템 §3. 고르면 테두리가 두꺼워진다(5px 강조 색). ←→↑↓ 로 옮긴다. */
  type Option = { value: T; label?: string; disabled?: boolean };
  let { value = $bindable(), options, label, direction = 'row', onchange }: {
    value?: T; options: readonly Option[]; label: string; direction?: 'row' | 'column'; onchange?: (v: T) => void;
  } = $props();

  const pick = (v: T): void => { value = v; onchange?.(v); };
  const key = (e: KeyboardEvent, i: number): void => {
    const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (d === 0) return;
    e.preventDefault();
    const n = options[(i + d + options.length) % options.length];
    if (n && !n.disabled) pick(n.value);
  };
</script>

<div class="rg" role="radiogroup" aria-label={label} data-dir={direction}>
  {#each options as o, i (o.value)}
    <button type="button" role="radio" aria-checked={o.value === value} tabindex={o.value === value || (value === undefined && i === 0) ? 0 : -1}
      disabled={o.disabled} onclick={() => pick(o.value)} onkeydown={(e) => key(e, i)}>
      <span class="dot" aria-hidden="true"></span>{o.label ?? o.value}
    </button>
  {/each}
</div>

<style>
  .rg { display: flex; gap: 20px; flex-wrap: wrap; }
  .rg[data-dir='column'] { flex-direction: column; gap: 8px; }
  button { display: inline-flex; gap: 8px; align-items: center; border: 0; background: transparent; color: var(--tx); font: 400 13px/18px var(--font); padding: 2px; }
  button:disabled { color: var(--tx3); }
  .dot { width: 16px; height: 16px; border-radius: 50%; border: 1px solid var(--bd-strong); background: var(--bg-input); flex: none; transition: border-width var(--dur-fast) var(--ease); }
  button[aria-checked='true'] .dot { border: 5px solid var(--accent); }
</style>

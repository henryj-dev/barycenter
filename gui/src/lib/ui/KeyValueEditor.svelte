<script lang="ts" module>
  export type KvRow = { op?: string; name: string; value: string };
</script>

<script lang="ts">
  /**
   * 키-값 행 편집기 — 디자인 시스템 §3 (헤더 규칙). 한 행 = 동작 · 이름 · 값 · 삭제.
   * 동작이 `del`(제거)이면 값 칸이 잠긴다. `ops` 를 비우면 동작 칸 없이 이름 · 값만이다(§12 헤더 행 편집기).
   */
  import Button from './Button.svelte';
  import TextInput from './TextInput.svelte';

  let { rows = $bindable([]), ops = [{ value: 'set', label: '설정' }, { value: 'add', label: '추가' }, { value: 'del', label: '제거' }], namePlaceholder = 'Header-Name', addLabel = '＋ 규칙을 더해요' }: {
    rows?: KvRow[];
    ops?: readonly { value: string; label: string }[];
    namePlaceholder?: string;
    addLabel?: string;
  } = $props();

  const withOp = $derived(ops.length > 0);
  const add = (): void => { rows = [...rows, { ...(withOp ? { op: ops[0]!.value } : {}), name: '', value: '' }]; };
  const drop = (i: number): void => { rows = rows.filter((_, n) => n !== i); };
</script>

<div class="kv">
  {#each rows as r, i (i)}
    <div class="row" data-op={withOp}>
      {#if withOp}
        <select aria-label="동작" bind:value={r.op} onchange={() => { if (r.op === 'del') r.value = ''; }}>
          {#each ops as o (o.value)}<option value={o.value}>{o.label}</option>{/each}
        </select>
      {/if}
      <TextInput aria-label="이름" placeholder={namePlaceholder} bind:value={r.name} />
      <TextInput aria-label="값" placeholder={r.op === 'del' ? '값 없음' : '값'} disabled={r.op === 'del'} bind:value={r.value} />
      <Button variant="icon" label="행 삭제" onclick={() => drop(i)}>✕</Button>
    </div>
  {/each}
  <div><Button variant="text" size="sm" onclick={add}>{addLabel}</Button></div>
</div>

<style>
  .kv { display: flex; flex-direction: column; gap: 6px; }
  .row { display: grid; grid-template-columns: 1fr 1fr 32px; gap: 6px; }
  .row[data-op='true'] { grid-template-columns: 96px 1fr 1fr 32px; }
  select {
    height: 32px; padding: 0 8px; background: var(--bg-input); border: 1px solid var(--bd-strong);
    border-radius: var(--r-md); color: var(--tx); font: 400 13px/1 var(--font);
  }
  select:focus { outline: 2px solid var(--focus); outline-offset: 0; }
</style>

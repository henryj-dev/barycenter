<script lang="ts" module>
  export type StepState = 'todo' | 'running' | 'done' | 'failed';
</script>

<script lang="ts">
  /**
   * 진행 단계 — 디자인 시스템 §8 「적용 단계」(렌더 → 검증 → 게시 → reload → 활성화 확인).
   * 끝난 것 ●(정상) · 하는 중 스피너(정보) · 실패 ✕(위험) · 아직 ○(중립).
   */
  import Spinner from './Spinner.svelte';
  let { steps, label = '진행 단계' }: { steps: readonly { name: string; state: StepState }[]; label?: string } = $props();
  const icon = { todo: '○', done: '●', failed: '✕', running: '' } as const;
</script>

<ol class="steps" aria-label={label}>
  {#each steps as s (s.name)}
    <li data-state={s.state}>{#if s.state === 'running'}<Spinner size={10} />{:else}<span aria-hidden="true">{icon[s.state]}</span>{/if}{s.name}</li>
  {/each}
</ol>

<style>
  .steps { display: flex; gap: 6px; flex-wrap: wrap; list-style: none; margin: 0; padding: 0; }
  li {
    display: inline-flex; align-items: center; gap: 6px; height: 24px; padding: 0 8px; border-radius: var(--r-sm);
    font: 400 12px/1 var(--font); background: var(--neutral-bg); color: var(--neutral);
  }
  li[data-state='done'] { background: var(--ok-bg); color: var(--ok); }
  li[data-state='running'] { background: var(--info-bg); color: var(--info); }
  li[data-state='failed'] { background: var(--danger-bg); color: var(--danger); }
</style>

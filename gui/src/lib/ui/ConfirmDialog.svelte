<script lang="ts" module>
  import type { Tone } from './Badge.svelte';
  export type ConfirmLine = { tone: Tone; icon: string; text: string };
</script>

<script lang="ts">
  /**
   * 확인 대화상자 — 디자인 시스템 §7.
   *
   * 제목에 결과를 먼저 쓴다. 본문 상자에 변경 요약(`lines`). 확인 버튼은 동작 이름이다. 위험 작업은
   * 빨강 버튼이다. Esc 로 취소한다. **포커스는 취소 버튼에 먼저 간다.**
   * `requireCheck` 면 「위 영향을 확인했어요」 를 눌러야, `requireName` 이면 이름을 똑같이 넣어야 확인이 열린다.
   */
  import Button from './Button.svelte';
  import Checkbox from './Checkbox.svelte';
  import TextInput from './TextInput.svelte';

  let { open = $bindable(false), title, sub, lines = [], confirmLabel, danger = true, requireCheck = false, requireName, busy = false, onconfirm, oncancel }: {
    open?: boolean;
    title: string;
    sub?: string;
    lines?: readonly ConfirmLine[];
    confirmLabel: string;
    danger?: boolean;
    requireCheck?: boolean;
    requireName?: string;
    busy?: boolean;
    onconfirm: () => void;
    oncancel?: () => void;
  } = $props();

  let checked = $state(false);
  let typed = $state('');
  let cancelEl: HTMLDivElement | undefined = $state();
  const blocked = $derived((requireCheck && !checked) || (requireName !== undefined && typed !== requireName));

  $effect(() => {
    if (!open) { checked = false; typed = ''; return; }
    queueMicrotask(() => cancelEl?.querySelector('button')?.focus());
  });
  const cancel = (): void => { open = false; oncancel?.(); };
  const key = (e: KeyboardEvent): void => {
    if (!open) return;
    if (e.key === 'Escape') { e.preventDefault(); cancel(); }
  };
</script>

<svelte:window onkeydown={key} />

{#if open}
  <div class="backdrop" role="presentation" onclick={cancel}>
    <div class="dlg" role="dialog" aria-modal="true" aria-label={title} tabindex="-1" onclick={(e) => e.stopPropagation()} onkeydown={() => {}}>
      <div class="head"><div class="title">{title}</div>{#if sub}<div class="sub">{sub}</div>{/if}</div>
      {#if lines.length > 0}
        <div class="lines">
          {#each lines as l, i (i)}<div class="line"><span style:color="var(--{l.tone})">{l.icon}</span><span>{l.text}</span></div>{/each}
        </div>
      {/if}
      {#if requireCheck}<div class="extra"><Checkbox bind:checked>위 영향을 확인했어요</Checkbox></div>{/if}
      {#if requireName !== undefined}
        <div class="extra">
          <label for="dlg-name" class="nl">삭제하려면 이름을 똑같이 넣어요: <b>{requireName}</b></label>
          <div class="ni"><TextInput id="dlg-name" bind:value={typed} autocomplete="off" /></div>
        </div>
      {/if}
      <div class="foot">
        <div bind:this={cancelEl}><Button onclick={cancel}>취소</Button></div>
        <Button variant={danger ? 'danger' : 'primary'} disabled={blocked} loading={busy} onclick={onconfirm}>{confirmLabel}</Button>
      </div>
    </div>
  </div>
{/if}

<style>
  .backdrop {
    position: fixed; inset: 0; z-index: var(--z-modal); background: rgba(0, 0, 0, .5);
    display: grid; place-items: center; padding: 16px;
  }
  .dlg {
    width: 100%; max-width: 460px; background: var(--bg-panel); border: 1px solid var(--bd-strong);
    border-radius: var(--r-lg); box-shadow: var(--sh-modal); animation: bc-in var(--dur) var(--ease); outline: none;
  }
  .head { padding: 16px 20px 0; }
  .title { font: var(--t-h); }
  .sub { color: var(--tx2); font: var(--t-small); margin-top: 4px; }
  .lines {
    margin: 14px 20px; padding: 12px; background: var(--bg-page); border: 1px solid var(--bd);
    border-radius: var(--r-md); font: var(--t-small); display: flex; flex-direction: column; gap: 6px;
  }
  .line { display: flex; gap: 8px; }
  .extra { padding: 0 20px 14px; }
  .lines + .extra, .head + .extra { padding-top: 0; }
  .head + .extra { margin-top: 14px; }
  .nl { font: var(--t-cap); color: var(--tx2); }
  .nl b { font-family: var(--mono); color: var(--tx); }
  .ni { margin-top: 6px; }
  .foot { padding: 12px 20px; border-top: 1px solid var(--bd); display: flex; justify-content: flex-end; gap: 8px; }
  .head + .foot { margin-top: 14px; }
</style>

<script lang="ts">
  /**
   * 여러 줄 목록 입력 — 디자인 시스템 §3. 한 줄에 하나(CIDR · 호스트 …). 왼쪽에 줄 번호가 있고
   * 틀린 줄은 번호 칸이 위험 색이다. 아래에 「유효 n / 전체 m개」 와 틀린 줄 목록.
   *
   * 검사는 `check` 가 한다 — 줄 하나를 받아 틀렸으면 이유를, 맞으면 undefined 를 돌려준다.
   */
  let { value = $bindable(''), check, label, minRows = 4, placeholder }: {
    value?: string;
    check?: (line: string) => string | undefined;
    label: string;
    minRows?: number;
    placeholder?: string;
  } = $props();

  const lines = $derived(value.split('\n'));
  const errs = $derived(lines.flatMap((l, i) => {
    const t = l.trim();
    if (t === '' || check === undefined) return [];
    const m = check(t);
    return m === undefined ? [] : [{ n: i + 1, t, m }];
  }));
  const bad = $derived(new Set(errs.map((e) => e.n)));
  const total = $derived(lines.filter((l) => l.trim() !== '').length);
  const rows = $derived(Math.max(minRows, lines.length));
</script>

<div class="li" data-bad={errs.length > 0}>
  <div class="gutter" aria-hidden="true">
    {#each Array.from({ length: rows }, (_, i) => i + 1) as n (n)}<div data-bad={bad.has(n)}>{n}</div>{/each}
  </div>
  <textarea aria-label={label} wrap="off" rows={rows} spellcheck="false" {placeholder} bind:value></textarea>
</div>
{#if check !== undefined && total > 0}
  <div class="foot">
    <span data-tone={errs.length > 0 ? 'error' : 'ok'}>{errs.length > 0 ? `✕ ${errs.length}줄 오류` : '✓ 모두 맞아요'}</span>
    <span class="count">유효 {total - errs.length} / 전체 {total}개</span>
  </div>
  {#if errs.length > 0}
    <ul class="errs">{#each errs as e (e.n)}<li>✕ {e.n}행 <code>{e.t}</code> — {e.m}</li>{/each}</ul>
  {/if}
{/if}

<style>
  .li {
    display: flex; border: 1px solid var(--bd-strong); border-radius: var(--r-md); background: var(--bg-input);
    overflow: hidden; font: 400 13px/20px var(--mono);
  }
  .li[data-bad='true'] { border-color: var(--danger); }
  .li:focus-within { outline: 2px solid var(--focus); outline-offset: 0; }
  .gutter { flex: none; width: 36px; background: var(--bg-hover); padding: 6px 0; text-align: right; }
  .gutter div { padding: 0 8px; height: 20px; color: var(--tx3); }
  .gutter div[data-bad='true'] { color: var(--danger); background: var(--danger-bg); }
  textarea {
    flex: 1; min-width: 0; border: 0; background: transparent; color: var(--tx); font: inherit;
    padding: 6px 10px; resize: none; overflow: hidden; white-space: pre; outline: none;
  }
  .foot { margin-top: 6px; display: flex; justify-content: space-between; font: var(--t-cap); }
  [data-tone='error'] { color: var(--danger); }
  [data-tone='ok'] { color: var(--ok); }
  .count { color: var(--tx3); }
  .errs { list-style: none; margin: 6px 0 0; padding: 0; display: flex; flex-direction: column; gap: 2px; font: var(--t-cap); color: var(--danger); }
  code { font-family: var(--mono); }
</style>

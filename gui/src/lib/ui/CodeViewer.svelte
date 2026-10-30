<script lang="ts">
  /**
   * 코드 뷰어 — 디자인 시스템 §8 (nginx.conf). 줄 번호 · 문법 색(지시어·문자열·숫자·주석) · 검색(↑↓ 로 결과 이동).
   * 맞는 줄은 선택 배경, 지금 결과는 경고 배경과 왼쪽 막대. 머리 줄 왼쪽은 `head` 스니펫(파일 이름 · 리비전 선택).
   */
  import type { Snippet } from 'svelte';
  let { code, head, maxHeight = '520px' }: { code: string; head?: Snippet; maxHeight?: string } = $props();

  const KW = /^(upstream|server_name|server|listen|location|proxy_pass|proxy_read_timeout|proxy_connect_timeout|proxy_set_header|ssl_certificate_key|ssl_certificate|ssl_protocols|ssl_preread|keepalive|weight|down|backup|ssl|http2|http|stream|events|include|return|map|geo|if|set|allow|deny|access_log|error_log|worker_processes|worker_connections|resolver|lua_shared_dict|balancer_by_lua_block|content_by_lua_block|init_worker_by_lua_block|add_header|client_max_body_size|limit_req|limit_req_zone|limit_conn|limit_conn_zone|real_ip_header|set_real_ip_from|pid)$/;
  const tokenize = (line: string): { t: string; c: string }[] =>
    line.split(/(#.*$|"[^"]*"|'[^']*'|\b\d[\w.:/]*|\b[a-z_][a-z0-9_]*\b)/)
      .filter((x) => x !== '' && x !== undefined)
      .map((t) => ({
        t,
        c: t[0] === '#' ? 'var(--syn-c)' : t[0] === '"' || t[0] === "'" ? 'var(--syn-s)' : /^\d/.test(t) ? 'var(--syn-n)'
          : KW.test(t) ? 'var(--syn-k)' : 'var(--tx)',
      }));

  let q = $state('');
  let idx = $state(0);
  let box: HTMLDivElement | undefined = $state();
  const lines = $derived(code.split('\n'));
  const hits = $derived(q.trim() === '' ? [] : lines.flatMap((l, i) => (l.toLowerCase().includes(q.trim().toLowerCase()) ? [i] : [])));
  const cur = $derived(hits.length === 0 ? -1 : hits[idx % hits.length]!);
  const go = (d: number): void => {
    if (hits.length === 0) return;
    idx = (idx + d + hits.length) % hits.length;
    queueMicrotask(() => box?.querySelector('[data-cur="true"]')?.scrollIntoView({ block: 'center' }));
  };
</script>

<div class="cv">
  <div class="bar">
    {#if head}{@render head()}{/if}
    <div class="grow"></div>
    <div class="find">
      <span aria-hidden="true">⌕</span>
      <input aria-label="설정 검색" placeholder="검색" bind:value={q} oninput={() => { idx = 0; go(0); }}
        onkeydown={(e) => { if (e.key === 'Enter') { e.preventDefault(); go(e.shiftKey ? -1 : 1); } }} />
      <span class="cnt">{q.trim() === '' ? '' : hits.length === 0 ? '0건' : `${(idx % hits.length) + 1}/${hits.length}`}</span>
      <button type="button" aria-label="이전 결과" onclick={() => go(-1)}>↑</button>
      <button type="button" aria-label="다음 결과" onclick={() => go(1)}>↓</button>
    </div>
  </div>
  <div class="code" bind:this={box} style:max-height={maxHeight}>
    {#each lines as l, i (i)}
      <div class="ln" data-hit={hits.includes(i)} data-cur={i === cur}>
        <span class="n">{i + 1}</span><span class="src">{#each tokenize(l) as tk, j (j)}<span style:color={tk.c}>{tk.t}</span>{/each}</span>
      </div>
    {/each}
  </div>
</div>

<style>
  .cv { background: var(--bg-panel); border: 1px solid var(--bd); border-radius: var(--r-lg); overflow: hidden; }
  .bar { display: flex; align-items: center; gap: 8px; padding: 8px 12px; border-bottom: 1px solid var(--bd); font: var(--t-cap); flex-wrap: wrap; }
  .grow { flex: 1; }
  .find { display: flex; align-items: center; gap: 6px; border: 1px solid var(--bd-strong); border-radius: var(--r-sm); padding: 0 4px 0 8px; background: var(--bg-input); }
  .find span { color: var(--tx3); }
  .find input { width: 110px; height: 24px; border: 0; background: transparent; color: var(--tx); font: var(--t-cap); outline: none; padding: 0; }
  .cnt { font-family: var(--mono); min-width: 34px; text-align: right; }
  .find button { border: 0; background: transparent; color: var(--tx2); padding: 0 4px; }
  .code { font: 400 12.5px/20px var(--mono); padding: 8px 0; overflow: auto; }
  .ln { display: grid; grid-template-columns: 52px 1fr; }
  .ln[data-hit='true'] { background: var(--bg-sel); }
  .ln[data-cur='true'] { background: var(--warn-bg); box-shadow: inset 3px 0 0 var(--warn); }
  .n { text-align: right; padding-right: 12px; color: var(--tx3); user-select: none; }
  .src { white-space: pre; }
</style>

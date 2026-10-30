<script lang="ts">
  /**
   * 리스너 수정 — `/traffic/listener/<key>/edit` (2026-10-30, 경로 분리).
   *
   * 고치는 칸: 바인드 · 포트 · 켜짐 · 출발지 제한 · 기본 동작. 나머지 칸(헤더 규칙·레이트리밋·TLS
   * 결박 …)은 head 의 값을 그대로 싣는다 — `editListenerPatch`. 저장은 commit 이고, 적용은
   * 적용 대기 화면에서 한다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { parseSourceAllow, type ListenerEdit } from '@web/edit';
  import { after } from '#lib/after';
  import SourceAllow from '#lib/SourceAllow.svelte';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const model = $derived(desk.listenerModels.find((l) => l['key'] === key));
  const protocol = $derived(typeof model?.['protocol'] === 'string' ? model['protocol'] : '');
  const isHttp = $derived(protocol === 'http' || protocol === 'https');
  const hasPool = $derived(isHttp || protocol === 'tcp' || protocol === 'udp');
  const poolClass = $derived(isHttp ? 'http' : protocol);
  const poolKeys = $derived(desk.pools.rows.filter((p) => p.protocolClass === poolClass).map((p) => p.key));

  let bind = $state('');
  let port = $state(0);
  let enabled = $state(true);
  let allow = $state('');
  /** 풀 key, 또는 HTTP 계열의 '거절'을 뜻하는 빈 문자열. */
  let action = $state('');
  let problem = $state<string | undefined>();
  let loaded = $state<string | undefined>();

  // head 값으로 한 번 채운다. 그 뒤 SSE 로 모델이 바뀌어도 입력 중인 값을 덮지 않는다.
  $effect(() => {
    if (model === undefined || loaded === key) return;
    bind = String(model['bind'] ?? '');
    port = Number(model['port'] ?? 0);
    enabled = model['enabled'] !== false;
    allow = Array.isArray(model['sourceAllow']) ? (model['sourceAllow'] as string[]).join('\n') : '';
    const http = model['http'] as { defaultAction?: unknown } | undefined;
    const da = isHttp ? http?.defaultAction : model['defaultPool'] === undefined ? undefined : { pool: model['defaultPool'] };
    action = typeof da === 'object' && da !== null ? String((da as { pool: unknown }).pool) : '';
    loaded = key;
  });

  const save = (): void => {
    problem = undefined;
    let edit: ListenerEdit;
    try {
      edit = {
        bind,
        port: Number(port),
        enabled,
        sourceAllow: parseSourceAllow(allow),
        ...(hasPool ? { defaultAction: action === '' ? 'reject' as const : { pool: action } } : {}),
      };
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
      return;
    }
    void desk.updateListener(key, edit).then(after);
  };
</script>

{#if model !== undefined}
  <Writable>
    <form class="edit" onsubmit={(e) => { e.preventDefault(); save(); }}>
      <label><span>프로토콜</span><input class="mono" value={protocol} disabled /></label>
      <label><span>바인드</span><input class="mono" bind:value={bind} disabled={desk.editing} /></label>
      <label><span>포트</span><input class="mono" type="number" min="1" max="65535" bind:value={port} disabled={desk.editing} /></label>
      <label class="check"><input type="checkbox" bind:checked={enabled} disabled={desk.editing} /> <span>켜짐 — 끄면 소켓을 안 연다</span></label>
      {#if hasPool}
        <label>
          <span>기본 동작</span>
          <select bind:value={action} disabled={desk.editing}>
            {#if isHttp}<option value="">거절</option>{/if}
            {#each poolKeys as p (p)}<option value={p}>풀 {p}</option>{/each}
          </select>
        </label>
      {/if}
      <SourceAllow editing={desk.editing} bind:value={allow} />
      {#if problem !== undefined}<p class="err" role="alert">{problem}</p>{/if}
      <p class="note">저장하면 커밋된다. 트래픽은 아직 안 바뀐다 — 적용 대기 화면에서 적용한다.</p>
      <p class="actions">
        <button type="submit" disabled={desk.editing}>저장</button>
        <a href={`/traffic/listener/${encodeURIComponent(key)}`}>취소</a>
      </p>
    </form>
  </Writable>
{/if}

<style>
  .actions a { color: var(--mute); }
  .mono { font-family: var(--data); }
  .edit { display: grid; grid-template-columns: 1fr 1fr; gap: 0.8rem 1rem; }
  label { display: flex; flex-direction: column; gap: 0.25rem; }
  label span { font-size: 0.8rem; color: var(--mute); }
  .check { flex-direction: row; align-items: center; gap: 0.5rem; grid-column: 1 / -1; }
  input, select {
    background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.45rem 0.6rem;
  }
  input:disabled, select:disabled { opacity: 0.6; }
  .err { color: var(--ember); grid-column: 1 / -1; margin: 0; }
  .note { grid-column: 1 / -1; font-size: 0.8rem; color: var(--mute); margin: 0; }
  .actions { grid-column: 1 / -1; display: flex; gap: 1rem; align-items: center; margin: 0; }
  button {
    background: var(--plate); border: 1px solid var(--rule); color: var(--ink);
    padding: 0.5rem 0.95rem; cursor: pointer;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  @media (max-width: 640px) { .edit { grid-template-columns: 1fr; } }
</style>

<script lang="ts">
  /**
   * 빠른 프록시 만들기 — URL 하나로 풀 · 백엔드 · 리스너(또는 기존 리스너의 라우트)를 한 번에 (시안).
   * 펴는 규칙은 CLI `bary proxy create` 와 같은 `proxyFromUrlPatch` 다. 저장은 커밋까지다.
   */
  import { getContext } from 'svelte';
  import { parseSourceAllow, proxyFromUrlPatch, type ProxyFromUrlInput } from '@web/edit';
  import { after } from '#lib/after';
  import SourceAllow from '#lib/SourceAllow.svelte';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const httpListeners = $derived(desk.listeners.rows
    .filter((l) => l.mark !== 'leave' && (l.protocol === 'http' || l.protocol === 'https')).map((l) => l.key));
  const certs = $derived(desk.certs.rows.filter((c) => c.hasMaterial).map((c) => c.key));

  let name = $state('');
  let url = $state('');
  let target = $state<'new' | 'existing'>('new');
  let protocol = $state<'http' | 'https'>('http');
  let bind = $state('0.0.0.0');
  let port = $state(80);
  let listener = $state('');
  let hosts = $state('');
  let path = $state('');
  let policy = $state('');
  let certificate = $state('');
  let allow = $state('');
  let problem = $state<string | undefined>();

  const input = $derived.by((): ProxyFromUrlInput => {
    const hostList = hosts.split(/[\s,]+/).filter((h) => h !== '');
    return {
      name: name.trim(),
      url: url.trim(),
      ...(target === 'new'
        ? {
            listen: { bind, port: Number(port) },
            protocol,
            ...(protocol === 'https' ? { tls: { policy, certificate } } : {}),
          }
        : { listener }),
      ...(hostList.length > 0 ? { hosts: hostList } : {}),
      ...(path.trim() === '' ? {} : { pathPrefix: path.trim() }),
    };
  });
  /** 무엇이 만들어지나 — 저장 전에 보여 준다. 틀린 입력이면 그 말을 보여 준다. */
  const preview = $derived.by((): { ops: { kind: string; key: string }[]; error?: string } => {
    if (name.trim() === '' || url.trim() === '') return { ops: [], error: '이름과 대상 URL 을 넣으면 만들 리소스가 여기 보인다.' };
    try {
      const sa = target === 'new' ? parseSourceAllow(allow) : undefined;
      return { ops: proxyFromUrlPatch({ ...input, ...(sa === undefined ? {} : { sourceAllow: sa }) }).map((o) => ({ kind: o.kind, key: o.key })) };
    } catch (e) {
      return { ops: [], error: e instanceof Error ? e.message : String(e) };
    }
  });
  const save = (): void => {
    problem = undefined;
    try {
      const sa = target === 'new' ? parseSourceAllow(allow) : undefined;
      void desk.proxyFromUrl({ ...input, ...(sa === undefined ? {} : { sourceAllow: sa }) }).then(after);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
  };
</script>

{#if !desk.live}
  <p class="d-empty">연결하면 여기서 만든다.</p>
{:else}
  <Writable>
    <form class="q" onsubmit={(e) => { e.preventDefault(); save(); }}>
      <label><span>이름 — 풀·리스너·라우트의 key 가 된다</span><input class="d-mono" bind:value={name} placeholder="app" /></label>
      <label><span>대상 URL</span><input class="d-mono" bind:value={url} placeholder="http://10.0.0.5:8080/" /></label>
      <fieldset>
        <legend class="d-note">리스너</legend>
        <label class="radio"><input type="radio" bind:group={target} value="new" /> 새 리스너</label>
        <label class="radio"><input type="radio" bind:group={target} value="existing" disabled={httpListeners.length === 0} /> 기존 리스너에 라우트로</label>
      </fieldset>
      {#if target === 'new'}
        <label><span>프로토콜</span>
          <select bind:value={protocol}><option value="http">HTTP</option><option value="https">HTTPS</option></select>
        </label>
        <label><span>바인드</span><input class="d-mono" bind:value={bind} /></label>
        <label><span>포트</span><input class="d-mono" type="number" min="1" max="65535" bind:value={port} /></label>
        {#if protocol === 'https'}
          <label><span>TLS 정책</span>
            <select bind:value={policy}><option value="">고른다</option>{#each desk.policies as p (p)}<option value={p}>{p}</option>{/each}</select>
          </label>
          <label><span>인증서 (자료 있는 것)</span>
            <select bind:value={certificate}><option value="">고른다</option>{#each certs as c (c)}<option value={c}>{c}</option>{/each}</select>
          </label>
        {/if}
      {:else}
        <label><span>리스너</span>
          <select bind:value={listener}><option value="">고른다</option>{#each httpListeners as l (l)}<option value={l}>{l}</option>{/each}</select>
        </label>
      {/if}
      <label><span>호스트 {target === 'new' ? '(선택)' : ''} — 쉼표로 여럿</span><input class="d-mono" bind:value={hosts} placeholder="app.example.com" /></label>
      <label><span>경로 접두사 (선택)</span><input class="d-mono" bind:value={path} placeholder="/" /></label>
      {#if target === 'new'}<SourceAllow editing={desk.editing} bind:value={allow} />{/if}

      <div class="sum">
        <p class="d-h3">만들 리소스</p>
        {#if preview.error !== undefined}
          <p class="d-note">{preview.error}</p>
        {:else}
          <ul class="d-list">{#each preview.ops as o (o.kind + o.key)}<li><span class="d-note">{o.kind}</span><span class="d-mono">{o.key}</span></li>{/each}</ul>
        {/if}
      </div>
      {#if problem !== undefined}<p class="d-warn" role="alert">{problem}</p>{/if}
      <p class="d-note">저장하면 커밋된다. 트래픽은 적용 대기 화면에서 적용해야 바뀐다.</p>
      <p><button type="submit" disabled={desk.editing || preview.error !== undefined}>만들기</button></p>
    </form>
  </Writable>
{/if}

<style>
  .q { display: grid; grid-template-columns: 1fr 1fr; gap: 0.8rem 1rem; }
  label { display: flex; flex-direction: column; gap: 0.25rem; }
  label span { font-size: 0.8rem; color: var(--mute); }
  fieldset, .sum { grid-column: 1 / -1; border: 0; padding: 0; margin: 0; display: flex; gap: 1rem; flex-wrap: wrap; }
  .sum { flex-direction: column; gap: 0.3rem; }
  .radio { flex-direction: row; align-items: center; gap: 0.4rem; font-size: 0.85rem; }
  input, select { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.45rem 0.6rem; }
  button { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.5rem 0.95rem; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .q > p { grid-column: 1 / -1; margin: 0; }
  @media (max-width: 640px) { .q { grid-template-columns: 1fr; } }
</style>

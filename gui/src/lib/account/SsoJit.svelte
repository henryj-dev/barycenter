<script lang="ts">
  /**
   * SSO 공급자 설정.
   *   · JIT — **기본 꺼짐**(공통 정책). 켜면 연결 없는 SSO 사용자가 처음 올 때 auditor 계정이 새로 생긴다.
   *   · 역할 클레임·매핑 — 권한 정본을 IdP 로 둔 계정만 쓴다(B3). SSO 로그인 때마다 이 매핑으로 역할을 맞춘다.
   *     IdP 쪽 변경은 **다음 SSO 로그인까지 반영되지 않는다**(받아들인 지연). 매핑에 없는 값은 로그인 거부.
   */
  import { onMount } from 'svelte';
  import { accountApi, type SsoProviders } from './api';

  let data = $state<SsoProviders | undefined>();
  let error = $state<string | undefined>();
  let claim = $state('');
  /** 한 줄에 하나: `IdP 값 = 역할` */
  let mapText = $state('');
  let saved = $state(false);

  const current = $derived(data?.providers.find((p) => p.issuer === data?.configured));
  const jitOn = $derived(current?.jitEnabled === true);

  const load = async (): Promise<void> => {
    const r = await accountApi.ssoProviders();
    if (!r.ok) { error = r.message; return; }
    data = r.data;
    const p = r.data.providers.find((x) => x.issuer === r.data.configured);
    claim = p?.roleClaim ?? '';
    mapText = Object.entries(p?.roleMap ?? {}).map(([k, v]) => `${k} = ${v}`).join('\n');
  };
  onMount(() => { void load(); });

  const toggle = async (): Promise<void> => {
    if (data?.configured == null) return;
    const r = await accountApi.setJit(data.configured, !jitOn);
    error = r.ok ? undefined : r.message;
    await load();
  };
  const saveRoles = async (): Promise<void> => {
    if (data?.configured == null) return;
    const map: Record<string, string> = {};
    for (const line of mapText.split('\n')) {
      const at = line.indexOf('=');
      if (at <= 0) continue;
      map[line.slice(0, at).trim()] = line.slice(at + 1).trim();
    }
    const r = await accountApi.setRoles(data.configured, claim.trim() === '' ? null : claim.trim(), map);
    error = r.ok ? undefined : r.message;
    saved = r.ok;
    await load();
  };
</script>

{#if data?.configured != null}
  <section>
    <h2>SSO 공급자</h2>
    <p><span class="mono">{data.configured}</span></p>
    <p>자동 계정(JIT): <strong>{jitOn ? '켜짐 (auditor 로만 만든다)' : '꺼짐 (연결 없는 SSO 로그인은 거절)'}</strong>
      <button type="button" onclick={() => { void toggle(); }}>{jitOn ? '끈다' : '켠다'}</button></p>
    <form onsubmit={(e) => { e.preventDefault(); void saveRoles(); }}>
      <p class="note">권한 정본을 IdP 로 둔 사람만 쓴다. IdP 쪽 역할 변경은 그 사람의 <strong>다음 SSO 로그인</strong>에 반영된다.</p>
      <label><span>역할 클레임 이름 (예: roles)</span><input bind:value={claim} placeholder="roles" /></label>
      <label><span>매핑 — 한 줄에 하나, <code>IdP 값 = auditor|operator|admin</code></span>
        <textarea rows="4" bind:value={mapText} placeholder={'viewer = auditor\nops = operator'}></textarea></label>
      <button type="submit">저장</button>
      {#if saved}<p class="ok" role="status">저장했다</p>{/if}
    </form>
    {#if error !== undefined}<p class="err" role="alert">{error}</p>{/if}
  </section>
{/if}

<style>
  section { display: grid; gap: 0.5rem; margin: 1.5rem 0; }
  form { display: grid; gap: 0.5rem; max-width: 28rem; }
  h2 { font-size: 1rem; margin: 0; }
  p { margin: 0; font-size: 0.9rem; }
  .note { color: var(--mute); }
  .mono, code { font-family: var(--data); }
  label { display: flex; flex-direction: column; gap: 0.25rem; }
  span { font-size: 0.8rem; color: var(--mute); }
  input, textarea { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.45rem 0.6rem; font-family: var(--data); }
  button { justify-self: start; background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.4rem 0.75rem; cursor: pointer; margin-left: 0.4rem; }
  form button { margin-left: 0; }
  .ok { color: var(--moss); }
  .err { color: var(--ember); }
</style>

<script lang="ts">
  /**
   * 공급자별 JIT — **기본 꺼짐**(공통 정책). 켜면 연결이 없는 SSO 사용자가 처음 올 때 auditor 계정이 새로 생긴다.
   * 이름·이메일이 같은 기존 계정에 붙지 않는다. 역할 올리기는 관리자가 한다.
   */
  import { onMount } from 'svelte';
  import { accountApi, type SsoProviders } from './api';

  let data = $state<SsoProviders | undefined>();
  let error = $state<string | undefined>();

  const load = async (): Promise<void> => {
    const r = await accountApi.ssoProviders();
    if (r.ok) data = r.data; else error = r.message;
  };
  onMount(() => { void load(); });

  const jitOn = $derived(
    data?.configured === null || data === undefined
      ? false
      : data.providers.some((p) => p.issuer === data!.configured && p.jitEnabled),
  );
  const toggle = async (): Promise<void> => {
    if (data?.configured == null) return;
    const r = await accountApi.setJit(data.configured, !jitOn);
    error = r.ok ? undefined : r.message;
    await load();
  };
</script>

{#if data?.configured != null}
  <section>
    <h2>SSO 자동 계정 (JIT)</h2>
    <p><span class="mono">{data.configured}</span> — 지금 <strong>{jitOn ? '켜짐 (auditor 로만 만든다)' : '꺼짐 (연결 없는 SSO 로그인은 거절)'}</strong></p>
    <button type="button" onclick={() => { void toggle(); }}>{jitOn ? '끈다' : '켠다'}</button>
    {#if error !== undefined}<p class="err" role="alert">{error}</p>{/if}
  </section>
{/if}

<style>
  section { display: grid; gap: 0.5rem; margin: 1.5rem 0; }
  h2 { font-size: 1rem; margin: 0; }
  p { margin: 0; font-size: 0.9rem; }
  .mono { font-family: var(--data); }
  button { justify-self: start; background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.45rem 0.8rem; cursor: pointer; }
  .err { color: var(--ember); }
</style>

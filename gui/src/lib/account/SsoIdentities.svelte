<script lang="ts">
  /**
   * 연결된 SSO 계정. 잇기·끊기 둘 다 **비밀번호를 다시 넣는다**(공통 정책). 이메일·이름이 같다고 저절로
   * 이어지지 않는다. 비밀번호가 없는 계정(SSO 로 생긴 것)은 더 잇거나 끊지 못한다 — 유일한 증거가 IdP 다.
   */
  import { accountApi, type Me } from './api';

  let { me, onChanged }: { me: Me; onChanged: () => Promise<void> } = $props();

  let password = $state('');
  let error = $state<string | undefined>();

  const link = async (): Promise<void> => {
    const r = await accountApi.linkSso(password);
    password = '';
    if (!r.ok) { error = r.message; return; }
    window.location.assign(r.data.url);
  };
  const unlink = async (issuer: string, subject: string): Promise<void> => {
    const r = await accountApi.unlinkSso(issuer, subject, password);
    password = '';
    if (!r.ok) { error = r.message; return; }
    error = undefined;
    await onChanged();
  };
</script>

<section>
  <h2>SSO 연결</h2>
  {#if me.identities.length === 0}
    <p>연결된 SSO 계정이 없다.</p>
  {:else}
    <ul>
      {#each me.identities as i (i.issuer + i.subject)}
        <li>
          <span class="mono">{i.issuer}</span> · {i.subject}
          {#if me.hasPassword}<button type="button" class="quiet" onclick={() => { void unlink(i.issuer, i.subject); }}>끊기</button>{/if}
        </li>
      {/each}
    </ul>
  {/if}
  {#if me.hasPassword}
    <label><span>비밀번호 확인 (잇기·끊기)</span><input type="password" autocomplete="current-password" bind:value={password} /></label>
    <button type="button" onclick={() => { void link(); }}>SSO 계정 잇기</button>
  {:else}
    <p>SSO 로 만든 계정이라 비밀번호가 없다 — 연결을 바꾸려면 관리자에게 부탁한다.</p>
  {/if}
  {#if error !== undefined}<p class="err" role="alert">{error}</p>{/if}
</section>

<style>
  section { display: grid; gap: 0.6rem; max-width: 30rem; }
  h2 { font-size: 1rem; margin: 0; }
  p { margin: 0; font-size: 0.9rem; color: var(--mute); }
  ul { margin: 0; padding-left: 1.1rem; font-size: 0.9rem; }
  .mono { font-family: var(--data); }
  label { display: flex; flex-direction: column; gap: 0.25rem; }
  span { font-size: 0.8rem; color: var(--mute); }
  input { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.45rem 0.6rem; }
  button { justify-self: start; background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.5rem 0.85rem; cursor: pointer; }
  .quiet { border-color: transparent; color: var(--mute); padding: 0.2rem 0.4rem; }
  .err { color: var(--ember); }
</style>

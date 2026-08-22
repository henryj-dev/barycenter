<script lang="ts">
  import { getContext, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { createDesk } from '$lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const stateKey = 'bary.oidc.state';
  // PKCE 검증자와 nonce 도 같은 자리에 산다 (검수 S-06 나머지). 서버는 상태를 안
  // 가지므로 시작과 교환 사이를 잇는 것은 이 세 값뿐이다.
  const verifierKey = 'bary.oidc.verifier';
  const nonceKey = 'bary.oidc.nonce';

  let startError = $state<string | undefined>();
  let starting = $state(false);
  let exchanging = $state(false);

  const startLogin = async (): Promise<void> => {
    startError = undefined;
    starting = true;
    try {
      const r = await fetch('/api/v1/oidc/authorization-request');
      if (!r.ok) {
        startError = r.status === 404 ? 'OIDC 가 설정되지 않았다' : `authorize ${r.status}`;
        return;
      }
      const body = (await r.json()) as {
        url?: unknown; state?: unknown; nonce?: unknown; code_verifier?: unknown;
      };
      if (typeof body.url !== 'string' || typeof body.state !== 'string'
        || typeof body.code_verifier !== 'string' || typeof body.nonce !== 'string') {
        startError = 'authorize 응답이 아니다';
        return;
      }
      sessionStorage.setItem(stateKey, body.state);
      sessionStorage.setItem(verifierKey, body.code_verifier);
      sessionStorage.setItem(nonceKey, body.nonce);
      window.location.assign(body.url);
    } catch (e) {
      startError = e instanceof Error ? e.message : String(e);
    } finally {
      starting = false;
    }
  };

  const exchange = async (code: string, state: string): Promise<void> => {
    const want = sessionStorage.getItem(stateKey);
    const verifier = sessionStorage.getItem(verifierKey);
    const nonce = sessionStorage.getItem(nonceKey);
    // **한 번 쓰고 지운다.** 남겨 두면 다음 콜백이 옛 검증자로 교환을 시도한다.
    sessionStorage.removeItem(stateKey);
    sessionStorage.removeItem(verifierKey);
    sessionStorage.removeItem(nonceKey);
    if (want === null || want !== state) {
      startError = 'state 가 맞지 않는다';
      return;
    }
    if (verifier === null) {
      startError = '이 브라우저에서 시작한 로그인이 아니다';
      return;
    }
    exchanging = true;
    try {
      const r = await fetch('/api/v1/oidc/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          code, code_verifier: verifier, ...(nonce === null ? {} : { nonce }),
        }),
      });
      const body = (await r.json()) as { id_token?: unknown; message?: unknown };
      if (!r.ok || typeof body.id_token !== 'string') {
        startError = typeof body.message === 'string' ? body.message : `token ${r.status}`;
        return;
      }
      desk.token = body.id_token;
      await desk.connect();
      await goto('/');
    } catch (e) {
      startError = e instanceof Error ? e.message : String(e);
    } finally {
      exchanging = false;
    }
  };

  onMount(() => {
    const code = page.url.searchParams.get('code');
    const state = page.url.searchParams.get('state');
    if (code !== null && state !== null) void exchange(code, state);
  });
</script>

<section>
  <button type="button" onclick={() => { void startLogin(); }} disabled={starting || exchanging}>
    IdP로 로그인
  </button>
  <p>해시 토큰은 위 칸에 넣는다. 폴링하지 않는다.</p>
  {#if startError !== undefined}
    <p class="err" role="alert">{startError}</p>
  {/if}
</section>

<style>
  section { display: grid; gap: 0.75rem; margin: 1.5rem 0; }
  button {
    justify-self: start;
    background: var(--plate);
    border: 1px solid var(--rule);
    color: var(--ink);
    padding: 0.5rem 0.85rem;
    cursor: pointer;
  }
  button:disabled { opacity: 0.6; cursor: default; }
  p { margin: 0; color: var(--mute); font-size: 0.9rem; }
  .err { color: var(--ember); }
</style>

<script lang="ts">
  import { getContext, onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import type { createDesk } from '$lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
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
      const body = (await r.json()) as { url?: unknown; state?: unknown };
      if (typeof body.url !== 'string' || typeof body.state !== 'string') {
        startError = 'authorize 응답이 아니다';
        return;
      }
      window.location.assign(body.url);
    } catch (e) {
      startError = e instanceof Error ? e.message : String(e);
    } finally {
      starting = false;
    }
  };

  const exchange = async (code: string, state: string): Promise<void> => {
    if (state === '') {
      startError = 'state 가 없다';
      return;
    }
    exchanging = true;
    try {
      const r = await fetch('/api/v1/oidc/token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ code, state }),
      });
      const body = (await r.json()) as { authenticated?: unknown; message?: unknown };
      if (!r.ok || body.authenticated !== true) {
        startError = typeof body.message === 'string' ? body.message : `token ${r.status}`;
        return;
      }
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

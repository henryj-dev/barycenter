<script lang="ts">
  /** TLS 정책 목록 — HTTPS 리스너가 참조한다. 리스너 화면에 있던 것을 옮겼다. */
  import { getContext } from 'svelte';
  import { itemsOf, relationsOf, resourcePath } from '@web/resources';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const rows = $derived(itemsOf(desk.model, 'tlsPolicy'));
</script>

{#if !desk.live}
  <p class="d-empty">연결하면 head TLS 정책이 여기 온다.</p>
{:else}
  <Writable><p class="new"><a class="d-link" href="/tls/policy/new">TLS 정책 만들기</a></p></Writable>
  {#if rows.length === 0}
    <p class="d-empty">TLS 정책이 없다. HTTPS 리스너를 열려면 하나가 필요하다.</p>
  {:else}
    <ul class="d-list">
      {#each rows as p (p['key'])}
        {@const k = String(p['key'])}
        <li>
          <a class="d-mono" href={resourcePath('tlsPolicy', k)}>{k}</a>
          <span class="d-mono d-note">TLS {String(p['minVersion'])}+</span>
          <span class="d-note">쓰는 리스너 {relationsOf(desk.model, { kind: 'tlsPolicy', key: k }).usedBy.length}개</span>
        </li>
      {/each}
    </ul>
  {/if}
{/if}

<style>.new { text-align: right; margin: 0 0 0.5rem; }</style>

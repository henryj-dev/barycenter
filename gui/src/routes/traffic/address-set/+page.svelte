<script lang="ts">
  /** 주소 집합 목록 — 리스너의 출발지 제한이 `@이름` 으로 참조한다 (#114). */
  import { getContext } from 'svelte';
  import { itemsOf, relationsOf, resourcePath } from '@web/resources';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const rows = $derived(itemsOf(desk.model, 'addressSet'));
</script>

{#if !desk.live}
  <p class="d-empty">연결하면 head 주소 집합이 여기 온다.</p>
{:else}
  <Writable><p class="new"><a class="d-link" href="/traffic/address-set/new">주소 집합 만들기</a></p></Writable>
  {#if rows.length === 0}
    <p class="d-empty">주소 집합이 없다. CLI 의 <code>bary address-set sync cloudflare</code> 로도 만든다.</p>
  {:else}
    <ul class="d-list">
      {#each rows as s (s['key'])}
        {@const k = String(s['key'])}
        <li>
          <a class="d-mono" href={resourcePath('addressSet', k)}>@{k}</a>
          <span class="d-note">대역 {Array.isArray(s['cidrs']) ? s['cidrs'].length : 0}개</span>
          <span class="d-note">{s['source'] === undefined ? '손으로 적음' : String(s['source'])}</span>
          <span class="d-note">쓰는 리스너 {relationsOf(desk.model, { kind: 'addressSet', key: k }).usedBy.length}개</span>
        </li>
      {/each}
    </ul>
  {/if}
{/if}

<style>.new { text-align: right; margin: 0 0 0.5rem; }</style>

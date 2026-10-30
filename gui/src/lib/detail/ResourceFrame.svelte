<script lang="ts">
  /**
   * 상세 화면의 틀 — 모든 리소스가 같다 (2026-10-30, 경로 분리 #124).
   *
   * 경로(목록 / key) · 제목 · 탭 · 수정·빼기 버튼을 그린다. 탭 내용은 그 아래 라우트 파일이 그린다.
   * 탭은 **주소다**(`<key>/settings` …) — 새로고침·북마크·링크가 그 탭으로 바로 온다.
   */
  import { getContext, type Snippet } from 'svelte';
  import { page } from '$app/state';
  import { RESOURCES, itemOf, resourcePath, type ResourceKind } from '@web/resources';
  import { after } from '#lib/after';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  let { kind, children }: { kind: ResourceKind; children: Snippet } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const spec = $derived(RESOURCES[kind]);
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, kind, key));
  const base = $derived(resourcePath(kind, key));
  const rest = $derived(page.url.pathname.slice(base.length).replace(/^\//, '').replace(/\/$/, ''));
  const extraLabel: Record<string, string> = { rebuild: 'URL로 다시 만들기' };
  const extra = $derived(extraLabel[rest]);
</script>

<p class="crumb">
  <a href={spec.base}>{spec.label}</a> /
  <a class="mono" href={base}>{key}</a>{#if extra !== undefined} / {extra}{/if}
</p>

{#if !desk.live}
  <p class="empty">연결하면 head {spec.label}가 여기 온다.</p>
{:else if item === undefined}
  <p class="empty">
    {spec.label} <span class="mono">{key}</span> 가 head 에 없다. 이름을 확인하거나
    <a href={spec.base}>목록</a>으로 간다.
  </p>
{:else}
  <header class="head">
    <h2 class="mono">{key}</h2>
    <Writable>
      <p class="actions">
        {#if spec.editable && rest !== 'settings'}
          <a class="button" href={resourcePath(kind, key, 'settings')}>수정</a>
        {/if}
        {#if spec.extras.includes('rebuild') && rest !== 'rebuild'}
          <a class="button" href={resourcePath(kind, key, 'rebuild')}>URL로 다시 만들기</a>
        {/if}
        <button type="button" disabled={desk.editing} onclick={() => { void desk.withdraw(kind, key).then(after); }}>
          설정에서 뺀다
        </button>
      </p>
    </Writable>
  </header>
  {#if extra === undefined}
    <nav class="tabs" aria-label="{spec.label} 상세">
      {#each spec.tabs as t (t.slug)}
        <a href={resourcePath(kind, key, t.slug)} aria-current={rest === t.slug ? 'page' : undefined}>{t.label}</a>
      {/each}
    </nav>
  {/if}
  {@render children()}
{/if}

<style>
  .crumb { font-size: 0.8rem; color: var(--mute); margin: 0 0 1rem; }
  .crumb a, .empty a { color: var(--mute); }
  .empty { color: var(--mute); }
  .mono { font-family: var(--data); }
  .head { display: flex; justify-content: space-between; align-items: baseline; gap: 1rem; flex-wrap: wrap; }
  h2 { font-size: 1.15rem; margin: 0; }
  .actions { display: flex; gap: 0.6rem; margin: 0; }
  .button, button {
    background: var(--plate); border: 1px solid var(--rule); color: var(--ink);
    padding: 0.35rem 0.75rem; font-size: 0.8rem; cursor: pointer; text-decoration: none; font: inherit;
  }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
  .tabs { display: flex; gap: 1.1rem; border-bottom: 1px solid var(--rule); margin: 1rem 0 1.25rem; flex-wrap: wrap; }
  .tabs a {
    color: var(--mute); text-decoration: none; font-size: 0.85rem; padding: 0.4rem 0;
    border-bottom: 2px solid transparent; margin-bottom: -1px;
  }
  .tabs a[aria-current='page'] { color: var(--ink); border-bottom-color: var(--ember); }
</style>

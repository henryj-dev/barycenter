<script lang="ts">
  /**
   * 설정 탭 — **여기가 수정하는 자리다** (시안: 「수정」 은 설정 탭으로 간다).
   *
   * 리스너는 폼, 인증서는 보기만(자료를 다시 넣는 것이 수정이다), 나머지는 JSON 수정이다 —
   * 리소스별 폼은 디자인을 들일 때 만든다. 쓰기가 막혀 있으면(전역 모드) 모든 칸을 보기로 편다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { RESOURCES, flattenFields, itemOf, type ResourceKind } from '@web/resources';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import ListenerForm from '#lib/listener/ListenerForm.svelte';
  import JsonEdit from './JsonEdit.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  let { kind }: { kind: ResourceKind } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, kind, key));
  const fields = $derived(item === undefined ? [] : flattenFields(item));
  const writable = $derived(RESOURCES[kind].editable && scope?.readOnly !== true);
</script>

{#if item !== undefined}
  {#if writable && kind === 'listener'}
    <ListenerForm />
    <details class="all">
      <summary class="d-note">모든 칸 보기 — 폼에 없는 칸은 저장해도 그대로 남는다</summary>
      <dl class="d-dl">{#each fields as f (f.path)}<dt>{f.path}</dt><dd>{f.value}</dd>{/each}</dl>
    </details>
  {:else if writable}
    <JsonEdit {kind} />
  {:else}
    {#if kind === 'certificate'}
      <p class="d-note">인증서는 자료를 다시 넣어 바꾼다 — <a class="d-link" href="/tls/certificate/new">인증서 넣기</a>에서 같은 이름으로 넣는다.</p>
    {/if}
    <dl class="d-dl">{#each fields as f (f.path)}<dt>{f.path}</dt><dd>{f.value}</dd>{/each}</dl>
    <details>
      <summary class="d-note">전체 정의 (head 모델, JSON)</summary>
      <pre class="d-pre">{JSON.stringify(item, null, 2)}</pre>
    </details>
  {/if}
{/if}

<style>.all { margin-top: 1.5rem; }</style>

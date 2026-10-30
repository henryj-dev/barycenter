<script lang="ts">
  /**
   * 설정 수정 — **JSON 으로 통째로** (리스너 말고 모든 리소스, 2026-10-30).
   *
   * 리소스마다 폼을 따로 짜기 전까지 쓰는 정직한 길이다. head 의 값을 그대로 펴 두고, 고친
   * 것을 `put` 으로 올린다. 모양·참조 검사는 저장소가 한다 — 틀리면 그 말을 그대로 보여 준다.
   * `create` 면 key 칸을 같이 받는다(주소 집합처럼 만들기 폼이 없는 리소스).
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { RESOURCES, itemOf, type ResourceKind } from '@web/resources';
  import { after } from '#lib/after';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  let { kind, create = false, template = {} }: {
    kind: ResourceKind; create?: boolean; template?: Record<string, unknown>;
  } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const routeKey = $derived(page.params['key'] ?? '');
  const item = $derived(create ? undefined : itemOf(desk.model, kind, routeKey));
  let newKey = $state('');
  let text = $state('');
  let problem = $state<string | undefined>();
  let loaded = $state<string | undefined>();

  // head 값으로 한 번 채운다. 그 뒤 스트림이 모델을 바꿔도 고치던 글을 덮지 않는다.
  $effect(() => {
    const id = create ? '(new)' : routeKey;
    if (loaded === id) return;
    if (!create && item === undefined) return;
    const { key: _k, ...body } = (create ? template : item) as Record<string, unknown>;
    text = JSON.stringify(body, null, 2);
    loaded = id;
  });

  const save = (): void => {
    problem = undefined;
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (e) {
      problem = `JSON 이 아니다: ${e instanceof Error ? e.message : String(e)}`;
      return;
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      problem = '객체여야 한다 — { … }';
      return;
    }
    const k = create ? newKey : routeKey;
    void desk.putResource(kind, k, body as Record<string, unknown>).then(after);
  };
</script>

<Writable>
  <form onsubmit={(e) => { e.preventDefault(); save(); }}>
    {#if create}
      <label><span>key</span><input class="d-mono" bind:value={newKey} placeholder="cloudflare" disabled={desk.editing} /></label>
    {/if}
    <label>
      <span>{RESOURCES[kind].label} 정의 (key 를 뺀 JSON)</span>
      <textarea class="d-mono" bind:value={text} rows="18" spellcheck="false" disabled={desk.editing}></textarea>
    </label>
    {#if problem !== undefined}<p class="d-warn" role="alert">{problem}</p>{/if}
    <p class="d-note">저장하면 커밋된다. 트래픽은 아직 안 바뀐다 — 적용 대기 화면에서 적용한다. 모양이 틀리면 저장소가 거절하고 그 이유를 위에 띄운다.</p>
    <p><button type="submit" disabled={desk.editing}>저장</button></p>
  </form>
</Writable>

<style>
  form { display: flex; flex-direction: column; gap: 0.8rem; }
  label { display: flex; flex-direction: column; gap: 0.3rem; }
  label span { font-size: 0.8rem; color: var(--mute); }
  input, textarea { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.45rem 0.6rem; font-size: 0.82rem; }
  textarea { resize: vertical; }
  button { background: var(--plate); border: 1px solid var(--rule); color: var(--ink); padding: 0.5rem 0.95rem; cursor: pointer; }
  button:disabled { opacity: 0.5; cursor: not-allowed; }
</style>

<script lang="ts">
  /**
   * 설정 탭(리스너 · 풀 · 백엔드 · 주소 집합) — **여기가 수정하는 자리다**(시안 `dpEdit`: 「수정」 은 설정 탭으로 간다).
   * 폼은 시안 `fieldsFor(page, v, false, 'form')` 의 구획 그대로이고 맨 아래 줄이 「안내 · 되돌리기 · 저장」 이다(`SettingsFrame`).
   * 시안에 없지만 있던 것: 폼에 없는 칸까지 통째로 고치는 「JSON 으로 고치기」 — 저장 줄 아래에 접어 둔다.
   * 쓰기가 막혀 있으면(전역 모드 · 팔로워) 공통 설정 탭(`Settings`)이 모든 칸을 보기로 편다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { RESOURCES, itemOf } from '@web/resources';
  import { Disclosure } from '#lib/ui';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import ListenerForm from '#lib/listener/ListenerForm.svelte';
  import PoolSettings from '#lib/pool/PoolSettings.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import JsonEdit from './JsonEdit.svelte';
  import BackendSettings from './BackendSettings.svelte';
  import AddressSetSettings from './AddressSetSettings.svelte';
  import Settings from './Settings.svelte';

  let { kind }: { kind: 'listener' | 'pool' | 'backend' | 'addressSet' } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, kind, key));
  const writable = $derived(RESOURCES[kind].editable && scope?.readOnly !== true);
</script>

{#if !writable}
  <Settings {kind} />
{:else if item !== undefined}
  <div class="ts">
    {#if kind === 'listener'}<ListenerForm />
    {:else if kind === 'pool'}<PoolSettings />
    {:else if kind === 'backend'}<BackendSettings />
    {:else}<AddressSetSettings />{/if}
    <div class="json">
      <Disclosure title="JSON 으로 고치기" hint="폼에 없는 칸까지 통째로"><JsonEdit {kind} /></Disclosure>
    </div>
  </div>
{/if}

<style>
  .ts { display: flex; flex-direction: column; gap: 16px; }
  .json { max-width: 760px; }
</style>

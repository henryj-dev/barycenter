<script lang="ts">
  /**
   * TLS 상세의 설정 탭 — 리소스마다 시안 `fieldsFor(page, v, false, 'form')` 폼(`CertificateSettings` · `TlsPolicySettings` ·
   * `SniBindingSettings`). 그 아래 「JSON 으로 고치기」(정책 · SNI — 폼에 없는 칸까지) · 「전체 정의」(인증서 — 보기만)는
   * 시안에 없는 기존 길이다. 다른 리소스의 설정 탭과 같은 자리 · 같은 모양(접힘)으로 둔다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { itemOf } from '@web/resources';
  import { CodeViewer, Disclosure } from '#lib/ui';
  import JsonEdit from '#lib/detail/JsonEdit.svelte';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CertificateSettings from './CertificateSettings.svelte';
  import TlsPolicySettings from './TlsPolicySettings.svelte';
  import SniBindingSettings from './SniBindingSettings.svelte';
  import type { COLS } from './tls-view.ts';

  let { kind }: { kind: keyof typeof COLS } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, kind, key));
</script>

{#if item !== undefined}
  <div class="set">
    {#key key}
      {#if kind === 'certificate'}<CertificateSettings />{:else if kind === 'tlsPolicy'}<TlsPolicySettings />{:else}<SniBindingSettings />{/if}
    {/key}
    {#if kind === 'certificate'}
      <Disclosure title="전체 정의" hint="head 모델 · JSON">
        <CodeViewer code={JSON.stringify(item, null, 2)} maxHeight="420px" />
      </Disclosure>
    {:else if scope?.blocked !== true}
      <Disclosure title="JSON 으로 고치기" hint="폼에 없는 칸까지 통째로">
        <JsonEdit {kind} />
      </Disclosure>
    {/if}
  </div>
{/if}

<style>
  .set { display: flex; flex-direction: column; gap: 16px; max-width: 900px; }
</style>

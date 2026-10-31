<script lang="ts">
  /**
   * 설정 탭 — **여기가 수정하는 자리다** (시안: 「수정」 은 설정 탭으로 간다).
   *
   * 리스너는 폼, 풀은 업스트림 TLS 폼 + JSON 수정, 인증서는 보기만(자료를 다시 넣는 것이 수정이다), 나머지는 JSON 수정이다.
   * 쓰기가 막혀 있으면(전역 모드) 모든 칸을 보기로 편다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { RESOURCES, flattenFields, itemOf, type ResourceKind } from '@web/resources';
  import { Banner, Button, Card, CodeViewer, DescriptionList, Disclosure } from '#lib/ui';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import ListenerForm from '#lib/listener/ListenerForm.svelte';
  import PoolTlsForm from '#lib/pool/PoolTlsForm.svelte';
  import JsonEdit from './JsonEdit.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  let { kind }: { kind: ResourceKind } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, kind, key));
  const fields = $derived(item === undefined ? [] : flattenFields(item).map((f) => ({ label: f.path, value: f.value, mono: true })));
  const writable = $derived(RESOURCES[kind].editable && scope?.readOnly !== true);
</script>

{#if item !== undefined}
  <div class="set">
    {#if writable && kind === 'listener'}
      <ListenerForm />
      <Disclosure title="모든 칸 보기" hint="폼에 없는 칸은 저장해도 그대로 남아요">
        <DescriptionList labelWidth="220px" items={fields} />
      </Disclosure>
    {:else if writable && kind === 'pool'}
      <PoolTlsForm />
      <JsonEdit {kind} />
    {:else if writable}
      <JsonEdit {kind} />
    {:else}
      {#if kind === 'certificate' && scope?.readOnly !== true}
        <Banner tone="info">
          인증서는 자료를 다시 넣어서 바꿔요. 같은 이름으로 넣어요.
          {#snippet action()}<Button size="sm" href="/tls/certificate/new">인증서 넣기</Button>{/snippet}
        </Banner>
      {/if}
      <Card title="설정">
        <DescriptionList labelWidth="220px" items={fields} />
      </Card>
      <Disclosure title="전체 정의" hint="head 모델 · JSON">
        <CodeViewer code={JSON.stringify(item, null, 2)} maxHeight="420px" />
      </Disclosure>
    {/if}
  </div>
{/if}

<style>
  .set { display: flex; flex-direction: column; gap: 16px; max-width: 960px; }
</style>

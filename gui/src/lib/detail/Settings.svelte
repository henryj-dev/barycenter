<script lang="ts">
  /**
   * 설정 탭 — **여기가 수정하는 자리다** (시안: 「수정」 은 설정 탭으로 간다).
   *
   * 리스너는 폼, 풀은 헬스체크 폼(2026-11-02) + 업스트림 TLS 폼 + JSON 수정, 백엔드 · 주소 집합은 폼(시안 「기본」) + JSON 수정,
   * 인증서는 보기만(자료를 다시 넣는 것이 수정이다), 나머지는 JSON 수정이다.
   * 쓰기가 막혀 있으면(전역 모드 · 팔로워) 시안 `tSetView` 읽기 구획(`ReadView` — 까닭 · 「기본」 구획 · 「이 지역에서 열기 ↗」)으로
   * 편다. 「기본」 은 개요와 같은 사람 말 줄(`summaryOf` · 리스너는 `detailOfListener`)이고, 모든 칸은 아래 「전체 정의」 가 보인다.
   * 전역에서 지역을 골랐으면 **첫 폼만** 「쓸 지역」 한 줄을 단다(`Writable target`) — 풀처럼 폼이 여럿이어도 한 번만 보인다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { RESOURCES, flattenFields, itemOf, summaryOf, type ResourceKind } from '@web/resources';
  import { detailOfListener } from '@web/listeners-view';
  import { Banner, Button, CodeViewer, Disclosure } from '#lib/ui';
  import ReadView from './ReadView.svelte';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import ListenerForm from '#lib/listener/ListenerForm.svelte';
  import PoolTlsForm from '#lib/pool/PoolTlsForm.svelte';
  import PoolBasicsForm from '#lib/pool/PoolBasicsForm.svelte';
  import PoolHealthForm from '#lib/pool/PoolHealthForm.svelte';
  import JsonEdit from './JsonEdit.svelte';
  import BackendSettings from './BackendSettings.svelte';
  import AddressSetSettings from './AddressSetSettings.svelte';
  import HttpRouteForm from '#lib/forms/HttpRouteForm.svelte';
  import PassthroughRouteForm from '#lib/forms/PassthroughRouteForm.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  let { kind }: { kind: ResourceKind } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, kind, key));
  /** 읽기 구획(시안 `viewSecs`) — 「기본」 하나. 사람 말 줄이 없으면 모든 칸을 그대로 든다. */
  const view = $derived.by(() => {
    if (item === undefined) return [];
    const lines = kind === 'listener' ? detailOfListener(item) : summaryOf(kind, item);
    const f = lines.length > 0 ? lines.map((l) => ({ l: l.label, v: l.value, mono: true }))
      : flattenFields(item).map((x) => ({ l: x.path, v: x.value, mono: true }));
    return [{ t: '기본', f }];
  });
  const writable = $derived(RESOURCES[kind].editable && scope?.readOnly !== true);
</script>

{#if item !== undefined}
  <div class="set">
    {#if writable && kind === 'listener'}
      <ListenerForm />
      <!-- 폼이 모델의 칸을 다 고친다(#126 후속). 폼에 없는 칸은 다른 리소스처럼 접힌 JSON 수정이 맡는다. -->
      <Disclosure title="JSON 으로 고치기" hint="폼에 없는 칸까지 통째로">
        <JsonEdit {kind} />
      </Disclosure>
    {:else if writable && kind === 'pool'}
      <!-- 기본 · 전송(알고리즘 · hash 키 · PROXY 송신) → 헬스체크 → 업스트림 TLS → JSON -->
      <PoolBasicsForm />
      <PoolHealthForm />
      <PoolTlsForm />
      <JsonEdit {kind} />
    {:else if writable && (kind === 'backend' || kind === 'addressSet')}
      {#if kind === 'backend'}<BackendSettings />{:else}<AddressSetSettings />{/if}
      <Disclosure title="JSON 으로 고치기" hint="폼에 없는 칸까지 통째로">
        <JsonEdit {kind} />
      </Disclosure>
    {:else if writable && (kind === 'httpRoute' || kind === 'passthroughRoute')}
      <!-- 라우트는 만들기 폼의 수정 모드(시안 `fieldsFor('routes')`) + 접은 JSON 수정. -->
      {#if kind === 'httpRoute'}<HttpRouteForm edit />{:else}<PassthroughRouteForm edit />{/if}
      <Disclosure title="JSON 으로 고치기" hint="폼에 없는 칸까지 통째로">
        <JsonEdit {kind} />
      </Disclosure>
    {:else if writable}
      <JsonEdit {kind} target />
    {:else}
      {#if kind === 'certificate' && scope?.readOnly !== true}
        <Banner tone="info">
          인증서는 자료를 다시 넣어서 바꿔요. 같은 이름으로 넣어요.
          {#snippet action()}<Button size="sm" href="/tls/certificate/new">인증서 넣기</Button>{/snippet}
        </Banner>
      {/if}
      <ReadView sections={view}>
        <Disclosure title="전체 정의" hint="head 모델 · JSON">
          <CodeViewer code={JSON.stringify(item, null, 2)} maxHeight="420px" />
        </Disclosure>
      </ReadView>
    {/if}
  </div>
{/if}

<style>
  .set { display: flex; flex-direction: column; gap: 16px; max-width: 960px; }
</style>

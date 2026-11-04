<script lang="ts">
  /**
   * HTTP 라우트 분할 상세의 인라인 수정 — 콘솔 시안 `INL.routes`: 호스트 · 경로 접두사 · 우선순위(「기본」),
   * 풀 · 경로 바꾸기(「동작」, 풀로 보낼 때만). 나머지 칸은 「상세 페이지 ↗」 의 설정 탭이다.
   *
   * 처음 값은 마운트할 때 head 에서 한 번 읽는다(고른 행이 바뀌면 `ListSplit` 이 다시 만든다). 저장은 설정 탭과 같은 길이다 —
   * head 값을 폼 값으로 펴서(`httpRouteStateOf`) 이 다섯 칸만 바꾸고, 같은 patch 빌더로 몸통을 지어 `desk.putResource` 로 보낸다.
   * 폼이 그리지 못하는 칸(출발지 규칙 동작의 요청 헤더 · 경로 바꾸기)이 있으면 저장하면 사라지므로 여기서는 막는다.
   * 합산이면 `ListSplit` 이 그 행의 지역 desk 를 문맥으로 준다(`InRegion`).
   */
  import { getContext } from 'svelte';
  import { itemOf, itemsOf } from '@web/resources';
  import { Banner, FormRow, FormSection, Select, TextInput } from '#lib/ui';
  import { after } from '#lib/after';
  import InlineEdit from '#lib/detail/InlineEdit.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { fromTokens } from '#lib/forms/source-rules';
  import { rewriteError } from '#lib/forms/rewrite';
  import {
    PRIORITY_HELP, httpRouteBody, httpRouteStateOf, poolShareCount, poolShareText, priorityError, routeHostsError, routePathsError,
  } from '#lib/forms/route-edit';

  let { routeKey, detailHref, pending }: { routeKey: string; detailHref: string; pending: boolean } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  // svelte-ignore state_referenced_locally
  const item = itemOf(desk.model, 'httpRoute', routeKey);
  const start = item === undefined ? undefined : httpRouteStateOf(item);
  type Inl = { hosts: string; pathPrefix: string; priority: string; pool: string | undefined; rewritePrefix: string };
  const pick = (s: NonNullable<typeof start>['state']): Inl => ({ hosts: s.hosts, pathPrefix: s.pathPrefix, priority: s.priority, pool: s.pool, rewritePrefix: s.rewritePrefix });
  let base = $state<Inl | undefined>(start === undefined ? undefined : pick(start.state));
  let f = $state<Inl | undefined>(start === undefined ? undefined : pick(start.state));
  let saving = $state(false);

  const proxy = start?.state.action === 'proxy';
  const pools = $derived(desk.pools.rows.filter((p) => p.protocolClass === 'http').map((p) => ({ value: p.key })));
  const paths = $derived(f === undefined ? ['/'] : ((ps) => (ps.length === 0 ? ['/'] : ps))([...new Set(fromTokens(f.pathPrefix))]));
  const hostErr = $derived(f === undefined ? undefined : routeHostsError(f.hosts));
  const pathErr = $derived(f === undefined ? undefined : routePathsError(f.pathPrefix));
  const pathWarn = $derived(f !== undefined && f.pathPrefix.includes('*') && pathErr === undefined);
  const prioErr = $derived(f === undefined ? undefined : priorityError(f.priority));
  const rwErr = $derived(f === undefined || !proxy ? undefined : rewriteError(f.rewritePrefix.trim(), paths));
  const shared = $derived(poolShareText(poolShareCount(
    [...itemsOf(desk.model, 'httpRoute'), ...itemsOf(desk.model, 'passthroughRoute')], proxy ? f?.pool : undefined, routeKey,
  )));
  const dirty = $derived(JSON.stringify(f) !== JSON.stringify(base));
  const lossy = start?.lossy === true;
  const invalid = $derived(lossy || hostErr !== undefined || pathErr !== undefined || prioErr !== undefined || rwErr !== undefined || (proxy && f?.pool === undefined));

  const save = (): void => {
    if (start === undefined || f === undefined || desk.editing) return;
    let body: Record<string, unknown>;
    try {
      body = httpRouteBody(routeKey, { ...start.state, ...f });
    } catch {
      return;
    }
    const sent = { ...f };
    saving = true;
    void desk.putResource('httpRoute', routeKey, body).then((ok) => {
      saving = false;
      if (ok) base = sent;
      after()(ok);
    });
  };
  const reset = (): void => { if (base !== undefined) f = { ...base }; };
</script>

{#if f !== undefined}
  <InlineEdit {dirty} {invalid} {pending} {saving} {detailHref} onsave={save} onrevert={reset}>
    {#if lossy}
      <Banner tone="warn">출발지 규칙의 동작에 이 폼에 없는 칸(요청 헤더 · 경로 바꾸기)이 있어요. 상세 페이지의 JSON으로 고쳐요.</Banner>
    {/if}
    <FormSection title="기본">
      <FormRow label="호스트" for="hri-host" error={hostErr} help="정확한 이름이나 *.example.com 형태로 입력해요.">
        <TextInput id="hri-host" bind:value={f.hosts} invalid={hostErr !== undefined} autocomplete="off" />
      </FormRow>
      <FormRow label="경로 접두사" for="hri-path" error={pathErr} help={pathWarn ? undefined : '쉼표나 공백으로 여러 개. 비우면 / 예요. *는 쓰지 않아요.'}>
        <TextInput id="hri-path" bind:value={f.pathPrefix} invalid={pathErr !== undefined} autocomplete="off" />
        {#if pathWarn}<div class="wn">▲ *는 일반 글자로 저장돼요. 접두사에는 쓰지 않아요.</div>{/if}
      </FormRow>
      <FormRow label="우선순위" for="hri-prio" error={prioErr} help={PRIORITY_HELP}>
        <TextInput id="hri-prio" bind:value={f.priority} invalid={prioErr !== undefined} inputmode="numeric" autocomplete="off" />
      </FormRow>
    </FormSection>
    {#if proxy}
      <FormSection title="동작">
        <FormRow label="풀">
          <Select label="풀" bind:value={f.pool} options={pools} placeholder="풀을 골라요" width="100%" />
          {#if shared !== undefined}<div class="wn">{shared}</div>{/if}
        </FormRow>
        <FormRow label="경로 바꾸기" for="hri-rw" error={rwErr} help={f.rewritePrefix.trim() === '' ? '비우면 경로를 그대로 보내요.' : '맞은 접두사를 이 값으로 바꿔요.'}>
          <TextInput id="hri-rw" bind:value={f.rewritePrefix} invalid={rwErr !== undefined} autocomplete="off" />
        </FormRow>
      </FormSection>
    {/if}
  </InlineEdit>
{/if}

<style>
  .wn { margin-top: 4px; font-size: 12px; color: var(--warn); }
</style>

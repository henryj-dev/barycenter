<script lang="ts">
  /**
   * 패스스루 라우트 분할 상세의 인라인 수정 — 콘솔 시안 `INL.routes` 중 패스스루에 있는 칸: SNI · 우선순위(「기본」),
   * 풀(「동작」, 풀로 보낼 때만). 패스스루는 경로가 없어 경로 접두사 · 경로 바꾸기가 없다.
   *
   * 처음 값은 마운트할 때 head 에서 한 번 읽는다. 저장은 설정 탭과 같은 길이다(`passthroughBody` → `desk.putResource`).
   * 합산이면 `ListSplit` 이 그 행의 지역 desk 를 문맥으로 준다(`InRegion`).
   */
  import { getContext } from 'svelte';
  import { itemOf, itemsOf } from '@web/resources';
  import { FormRow, FormSection, Select, TextInput } from '#lib/ui';
  import { after } from '#lib/after';
  import InlineEdit from '#lib/detail/InlineEdit.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { fromTokens } from '#lib/forms/source-rules';
  import { PRIORITY_HELP, passthroughBody, passthroughStateOf, poolShareCount, poolShareText, priorityError } from '#lib/forms/route-edit';

  let { routeKey, detailHref, pending }: { routeKey: string; detailHref: string; pending: boolean } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  // svelte-ignore state_referenced_locally
  const item = itemOf(desk.model, 'passthroughRoute', routeKey);
  const start = item === undefined ? undefined : passthroughStateOf(item);
  type Inl = { snis: string; priority: string; pool: string | undefined };
  let base = $state<Inl | undefined>(start === undefined ? undefined : { snis: start.snis, priority: start.priority, pool: start.pool });
  let f = $state<Inl | undefined>(base === undefined ? undefined : { ...base });
  let saving = $state(false);

  const proxy = start?.action === 'proxy';
  const pools = $derived(desk.pools.rows.filter((p) => p.protocolClass === 'tcp').map((p) => ({ value: p.key })));
  const sniErr = $derived(f !== undefined && fromTokens(f.snis).length === 0 ? 'SNI를 입력해요.' : undefined);
  const prioErr = $derived(f === undefined ? undefined : priorityError(f.priority));
  const shared = $derived(poolShareText(poolShareCount(
    [...itemsOf(desk.model, 'httpRoute'), ...itemsOf(desk.model, 'passthroughRoute')], proxy ? f?.pool : undefined, routeKey,
  )));
  const dirty = $derived(JSON.stringify(f) !== JSON.stringify(base));
  const invalid = $derived(sniErr !== undefined || prioErr !== undefined || (proxy && f?.pool === undefined));

  const save = (): void => {
    if (start === undefined || f === undefined || desk.editing) return;
    let body: Record<string, unknown>;
    try {
      body = passthroughBody(routeKey, { ...start, ...f });
    } catch {
      return;
    }
    const sent = { ...f };
    saving = true;
    void desk.putResource('passthroughRoute', routeKey, body).then((ok) => {
      saving = false;
      if (ok) base = sent;
      after()(ok);
    });
  };
  const reset = (): void => { if (base !== undefined) f = { ...base }; };
</script>

{#if f !== undefined}
  <InlineEdit {dirty} {invalid} {pending} {saving} {detailHref} onsave={save} onrevert={reset}>
    <FormSection title="기본">
      <FormRow label="SNI" for="pri-sni" error={sniErr}>
        <TextInput id="pri-sni" bind:value={f.snis} invalid={sniErr !== undefined} autocomplete="off" />
      </FormRow>
      <FormRow label="우선순위" for="pri-prio" error={prioErr} help={PRIORITY_HELP}>
        <TextInput id="pri-prio" bind:value={f.priority} invalid={prioErr !== undefined} inputmode="numeric" autocomplete="off" />
      </FormRow>
    </FormSection>
    {#if proxy}
      <FormSection title="동작">
        <FormRow label="풀">
          <Select label="풀" bind:value={f.pool} options={pools} placeholder="풀을 골라요" width="100%" />
          {#if shared !== undefined}<div class="wn">{shared}</div>{/if}
        </FormRow>
      </FormSection>
    {/if}
  </InlineEdit>
{/if}

<style>
  .wn { margin-top: 4px; font-size: 12px; color: var(--warn); }
</style>

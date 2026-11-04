<script lang="ts">
  /**
   * 풀 분할 상세의 인라인 수정 — 콘솔 시안 `isecs`(`INL.pools`: algo · hc).
   *   · 기본 — 알고리즘. hash 를 고르면 hash 키 칸이 따라 나온다(시안은 인라인에 없어서 저장할 수 없는 오류가 된다 — 고칠 칸을 둔다).
   *   · 헬스체크 — UDP 풀만 「정의 · 검사 안 함」(읽기). 다른 풀의 헬스체크는 칸이 많아서 설정 탭이다(시안도 `hc` 키는 UDP 만).
   * 저장은 설정 탭과 같다 — head 의 그 풀 위에 `algorithm` · `hashKey` 만 덮어 `putResource`(commit).
   */
  import { getContext } from 'svelte';
  import { itemOf } from '@web/resources';
  import { FormRow, FormSection, Select, TextInput } from '#lib/ui';
  import { after } from '#lib/after';
  import InlineEdit from '#lib/detail/InlineEdit.svelte';
  import { ALGOS, hashKeyError, type Algo } from './pool-fields';
  import type { createDesk } from '#lib/desk.svelte.ts';

  let { key, detailHref, pending }: { key: string; detailHref: string; pending: boolean } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  // svelte-ignore state_referenced_locally
  const pool = itemOf(desk.model, 'pool', key);
  const cls = String(pool?.['protocolClass'] ?? '');
  const a0 = pool?.['algorithm'];
  const init = { algo: (ALGOS.some((x) => x.value === a0) ? a0 : 'round_robin') as Algo, hash: typeof pool?.['hashKey'] === 'string' ? pool['hashKey'] : '' };
  let algo = $state<Algo>(init.algo);
  let hash = $state(init.hash);
  let saving = $state(false);
  const hashErr = $derived(algo === 'hash' ? hashKeyError(hash, cls) : undefined);
  const dirty = $derived(algo !== init.algo || (algo === 'hash' && hash !== init.hash));
  const save = (): void => {
    if (pool === undefined) return;
    const { key: _k, ...body } = pool as Record<string, unknown>;
    body['algorithm'] = algo;
    if (algo === 'hash') body['hashKey'] = hash.trim();
    else delete body['hashKey'];
    saving = true;
    void desk.putResource('pool', key, body).then((ok) => { saving = false; after()(ok); });
  };
  const revert = (): void => { algo = init.algo; hash = init.hash; };
</script>

{#if pool !== undefined}
  <InlineEdit {dirty} invalid={hashErr !== undefined} {pending} {saving} {detailHref} onsave={save} onrevert={revert}>
    <FormSection title="기본">
      <FormRow label="알고리즘"><Select label="알고리즘" bind:value={algo} options={ALGOS} width="100%" /></FormRow>
      {#if algo === 'hash'}
        <FormRow label="hash 키" for="pi-hash" error={hashErr} help="예: $remote_addr"><TextInput id="pi-hash" bind:value={hash} invalid={hashErr !== undefined} autocomplete="off" /></FormRow>
      {/if}
    </FormSection>
    {#if cls === 'udp'}
      <FormSection title="헬스체크">
        <FormRow label="정의" help="UDP 풀은 검사하지 않아서 헬스가 관측 없음으로 나와요."><TextInput value="검사 안 함" disabled /></FormRow>
      </FormSection>
    {/if}
  </InlineEdit>
{/if}

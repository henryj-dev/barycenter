<script lang="ts">
  /**
   * 주소 집합 설정 탭 — 콘솔 시안 `fieldsFor('sets', v, false, 'form')` 의 「기본」: 이름 · 대역 목록(대역 행).
   *
   * 공개 목록에서 받은 집합(`source: cloudflare`)은 손으로 고치지 않는다(시안 `dis: ro`, 「Cloudflare 공개 목록에서 받아와요.
   * 직접 수정할 수 없어요.」). 다시 받는 것은 CLI `bary address-set create --name <이름> --cloudflare` 다(같은 이름이면 덮는다) —
   * 시안의 「목록 다시 받기」 버튼은 API 가 없어서 그 안내 한 줄을 둔다. 모양은 만들기 폼과 같은 `putAddressSetPatch` 가 만든다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { putAddressSetPatch } from '@web/edit';
  import { itemOf, resourcePath } from '@web/resources';
  import { Banner, FormRow, FormSection, TextInput } from '#lib/ui';
  import { after } from '#lib/after';
  import SourceRows from '#lib/forms/SourceRows.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import SettingsFrame from './SettingsFrame.svelte';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, 'addressSet', key));
  const ro = $derived(item?.['source'] === 'cloudflare');

  let cidrs = $state('');
  let init = $state('');
  let bad = $state(false);
  let problem = $state<string | undefined>();
  let loaded = $state<string | undefined>();
  let gen = $state(0);

  $effect(() => {
    if (item === undefined || loaded === key) return;
    init = Array.isArray(item['cidrs']) ? (item['cidrs'] as string[]).join('\n') : '';
    cidrs = init;
    gen += 1;
    loaded = key;
  });

  const err = $derived(bad ? '잘못된 대역이 있어요. 표시된 행을 고쳐요.' : cidrs.trim() === '' ? '대역을 하나 이상 입력해요.' : undefined);
  const dirty = $derived(!ro && cidrs.split('\n').map((l) => l.trim()).join('\n') !== init);
  const save = (): void => {
    problem = undefined;
    try {
      const [op] = putAddressSetPatch(key, { cidrs });
      if (op !== undefined) void desk.putResource('addressSet', op.key, op.body).then(after(resourcePath('addressSet', op.key)));
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
  };
</script>

{#if item !== undefined}
  <SettingsFrame kind="addressSet" {dirty} invalid={!ro && err !== undefined} onsave={save} onrevert={() => { loaded = undefined; }}>
    <FormSection title="기본">
      <FormRow label="이름"><TextInput value={key} disabled /></FormRow>
      <FormRow label="대역 목록" error={ro ? undefined : err} help={ro ? 'Cloudflare 공개 목록에서 받아와요. 직접 수정할 수 없어요.' : 'CIDR이나 IP를 한 행에 하나씩 입력해요.'}>
        {#key gen}<SourceRows label="대역 목록" mode="ranges" bind:value={cidrs} bind:invalid={bad} disabled={ro} />{/key}
      </FormRow>
    </FormSection>
    {#if ro}
      <Banner tone="info">목록을 다시 받으려면 CLI 에서 <code>bary address-set create --name {key} --cloudflare</code> 를 실행해요. 같은 이름이면 덮어써요.</Banner>
    {/if}
    {#if problem !== undefined}<Banner tone="danger">{problem}</Banner>{/if}
  </SettingsFrame>
{/if}

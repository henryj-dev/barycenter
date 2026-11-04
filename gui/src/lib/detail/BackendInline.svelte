<script lang="ts">
  /**
   * 백엔드 분할 상세의 인라인 수정 — 콘솔 시안 `isecs`(`INL.backends`: host · port · weight · drain), 구획 「기본」.
   * 위에 「트래픽을 받지 않는 이유」(시안 `reasonsD` — 보기 · 수정 모두 머리 아래에 있다).
   *
   * 저장은 둘로 갈린다(실제 동작):
   *   · 호스트 · 포트 · 가중치 — head 의 그 백엔드 위에 덮어 `putResource`(commit, 적용 대기로 간다)
   *   · 드레인 — 설정이 아니다. 바로 건다(`desk.drain` · `undrain`, 설계 §4.3). commit 하지 않는다.
   * 가중치는 1 이상이다(해독기 · nginx). 시안의 「0이면 트래픽을 받지 않아요」 대신 드레인을 쓰라고 말한다.
   */
  import { getContext } from 'svelte';
  import { itemOf } from '@web/resources';
  import { FormRow, FormSection, Switch, TextInput, toast } from '#lib/ui';
  import { after } from '#lib/after';
  import { portError, weightError } from '#lib/forms/checks';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import InlineEdit from './InlineEdit.svelte';
  import BackendReasons from './BackendReasons.svelte';
  import { backendDraining } from './facts';

  let { key, detailHref, pending }: { key: string; detailHref: string; pending: boolean } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  // svelte-ignore state_referenced_locally
  const item = itemOf(desk.model, 'backend', key);
  // svelte-ignore state_referenced_locally
  const init = { host: String(item?.['host'] ?? ''), port: String(item?.['port'] ?? ''), weight: String(item?.['weight'] ?? '1'), drain: backendDraining(desk, key) };
  let host = $state(init.host);
  let port = $state(init.port);
  let weight = $state(init.weight);
  let drain = $state(init.drain);
  let saving = $state(false);

  const errors = $derived({
    host: host.trim() === '' ? '주소를 입력해요.' : undefined,
    port: port.trim() === '' ? '포트는 1–65535 사이여야 해요.' : portError(port),
    weight: weight.trim() === '' ? '1 이상의 정수를 입력해요.' : weightError(weight),
  });
  const invalid = $derived(Object.values(errors).some((e) => e !== undefined));
  const changed = $derived(host !== init.host || port !== init.port || weight !== init.weight);
  const dirty = $derived(changed || drain !== init.drain);

  const save = async (): Promise<void> => {
    if (item === undefined) return;
    saving = true;
    try {
      if (drain !== init.drain) {
        const ok = await (drain ? desk.drain(key) : desk.undrain(key));
        if (ok && !changed) toast.ok(drain ? '드레인했어요' : '드레인을 풀었어요', '설정이 아니라 바로 걸려요.');
      }
      if (changed) {
        const { key: _k, ...rest } = item;
        after()(await desk.putResource('backend', key, { ...rest, host: host.trim(), port: Number(port), weight: Number(weight) }));
      }
    } finally {
      saving = false;
    }
  };
  const revert = (): void => { host = init.host; port = init.port; weight = init.weight; drain = init.drain; };
</script>

{#if item !== undefined}
  <div class="why"><BackendReasons backend={key} /></div>
  <InlineEdit {dirty} {invalid} {pending} {saving} {detailHref} onsave={() => { void save(); }} onrevert={revert}>
    <FormSection title="기본">
      <FormRow label="호스트" for="bi-host" error={errors.host}><TextInput id="bi-host" bind:value={host} invalid={errors.host !== undefined} autocomplete="off" /></FormRow>
      <FormRow label="포트" for="bi-port" error={errors.port}><TextInput id="bi-port" bind:value={port} invalid={errors.port !== undefined} inputmode="numeric" /></FormRow>
      <FormRow label="가중치" for="bi-weight" error={errors.weight} help="1 이상이에요. 트래픽을 끊으려면 드레인을 써요.">
        <TextInput id="bi-weight" bind:value={weight} invalid={errors.weight !== undefined} inputmode="numeric" />
      </FormRow>
      <FormRow label="드레인" help="켜면 새 연결을 받지 않아요. 기존 연결은 끝내요. 저장하면 바로 걸려요(적용 대기로 가지 않아요).">
        <Switch bind:checked={drain}>{drain ? '켜짐' : '꺼짐'}</Switch>
      </FormRow>
    </FormSection>
  </InlineEdit>
{/if}

<style>
  /* 시안 `reasonsD`: margin 12px 16px 0. */
  .why { margin: 12px 16px 0; }
</style>

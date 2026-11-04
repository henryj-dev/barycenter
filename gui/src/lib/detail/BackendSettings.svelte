<script lang="ts">
  /**
   * 백엔드 설정 탭 — 콘솔 시안 `fieldsFor('backends', v, false, 'form')` 의 「기본」: 이름 · 풀 · 호스트 · 포트 · 가중치 · 드레인.
   *
   * `put` 은 통째로 갈아 끼운다. 그래서 head 의 그 백엔드를 바탕으로 이 칸만 덮는다 — 폼에 없는 칸
   * (`softMaxConns` · `isBackup`)은 그대로 싣는다. 드레인은 설정이 아니다(실제 동작) — 저장하면 바로 건다(`desk.drain` · `undrain`).
   * 가중치는 1 이상이다(해독기 · nginx). 트래픽을 끊는 자리는 드레인이다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { itemOf, resourcePath } from '@web/resources';
  import { FormRow, FormSection, Select, Switch, TextInput, toast } from '#lib/ui';
  import { after } from '#lib/after';
  import { portError, weightError } from '#lib/forms/checks';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import SettingsFrame from './SettingsFrame.svelte';
  import { backendDraining } from './facts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, 'backend', key));
  const pools = $derived(desk.pools.rows.map((p) => ({ value: p.key })));

  let pool = $state('');
  let host = $state('');
  let port = $state('');
  let weight = $state('');
  let drain = $state(false);
  let init = $state({ pool: '', host: '', port: '', weight: '', drain: false });
  let loaded = $state<string | undefined>();

  // head 값으로 한 번 채운다. 그 뒤 스트림이 모델을 바꿔도 입력 중인 값을 덮지 않는다.
  $effect(() => {
    if (item === undefined || loaded === key) return;
    init = { pool: String(item['pool'] ?? ''), host: String(item['host'] ?? ''), port: String(item['port'] ?? ''), weight: String(item['weight'] ?? '1'), drain: backendDraining(desk, key) };
    ({ pool, host, port, weight, drain } = init);
    loaded = key;
  });

  const errors = $derived({
    host: host.trim() === '' ? '주소를 입력해요.' : undefined,
    port: port.trim() === '' ? '포트는 1–65535 사이여야 해요.' : portError(port),
    weight: weight.trim() === '' ? '1 이상의 정수를 입력해요.' : weightError(weight),
  });
  const invalid = $derived(pool === '' || Object.values(errors).some((e) => e !== undefined));
  const changed = $derived(pool !== init.pool || host !== init.host || port !== init.port || weight !== init.weight);
  const dirty = $derived(changed || drain !== init.drain);
  const save = async (): Promise<void> => {
    if (item === undefined) return;
    if (drain !== init.drain) {
      const ok = await (drain ? desk.drain(key) : desk.undrain(key));
      if (ok) { init = { ...init, drain }; if (!changed) toast.ok(drain ? '드레인했어요' : '드레인을 풀었어요', '설정이 아니라 바로 걸려요.'); }
    }
    if (changed) {
      const { key: _k, ...rest } = item;
      after(resourcePath('backend', key))(await desk.putResource('backend', key, { ...rest, pool, host: host.trim(), port: Number(port), weight: Number(weight) }));
    }
  };
</script>

{#if item !== undefined}
  <SettingsFrame kind="backend" {dirty} {invalid} onsave={() => { void save(); }} onrevert={() => { loaded = undefined; }}>
    <FormSection title="기본">
      <FormRow label="이름"><TextInput value={key} disabled /></FormRow>
      <FormRow label="풀" help={item !== undefined && pool !== init.pool ? '▲ 다른 풀로 옮겨요. 지금 풀에서는 빠져요.' : undefined}>
        <Select label="풀" bind:value={pool} options={pools} placeholder="풀을 골라요" width="100%" />
      </FormRow>
      <FormRow label="호스트" for="bs-host" error={errors.host}><TextInput id="bs-host" bind:value={host} invalid={errors.host !== undefined} autocomplete="off" /></FormRow>
      <FormRow label="포트" for="bs-port" error={errors.port}><TextInput id="bs-port" bind:value={port} invalid={errors.port !== undefined} inputmode="numeric" /></FormRow>
      <FormRow label="가중치" for="bs-weight" error={errors.weight} help="1 이상이에요. 트래픽을 끊으려면 드레인을 써요.">
        <TextInput id="bs-weight" bind:value={weight} invalid={errors.weight !== undefined} inputmode="numeric" />
      </FormRow>
      <FormRow label="드레인" help="켜면 새 연결을 받지 않아요. 기존 연결은 끝내요. 저장하면 바로 걸려요(적용 대기로 가지 않아요).">
        <Switch bind:checked={drain}>{drain ? '켜짐' : '꺼짐'}</Switch>
      </FormRow>
    </FormSection>
  </SettingsFrame>
{/if}

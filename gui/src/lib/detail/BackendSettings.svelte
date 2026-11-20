<script lang="ts">
  /**
   * 백엔드 설정 탭 — 콘솔 시안 `fieldsFor('backends', v, false, 'form')` 의 「기본」: 이름 · 풀 · 호스트 · 포트 · 가중치 · 드레인.
   *
   * `put` 은 통째로 갈아 끼운다. 그래서 head 의 그 백엔드를 바탕으로 이 칸만 덮는다 — 폼에 없는 칸은 그대로 싣는다.
   * 「고급」 은 동시 연결 기준(`softMaxConns`) · 예비 백엔드(`isBackup`)다. 해시 계열 풀에서는 예비를 못 켠다.
   * 드레인은 설정이 아니다(실제 동작) — 저장하면 바로 건다(`desk.drain` · `undrain`).
   * 가중치는 1 이상이다(해독기 · nginx). 트래픽을 끊는 자리는 드레인이다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { itemOf, resourcePath } from '@web/resources';
  import { FormRow, FormSection, Select, Switch, TextInput, toast } from '#lib/ui';
  import { after } from '#lib/after';
  import { portError, softMaxError, weightError } from '#lib/forms/checks';
  import { BACKUP_FORBIDDEN_ALGORITHMS } from '@web/edit';
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
  let softMax = $state('');
  let backup = $state(false);
  let init = $state({ pool: '', host: '', port: '', weight: '', drain: false, softMax: '', backup: false });
  const algorithm = $derived(desk.pools.rows.find((p) => p.key === pool)?.algorithm ?? '');
  const backupBlocked = $derived(BACKUP_FORBIDDEN_ALGORITHMS.includes(algorithm));
  let loaded = $state<string | undefined>();

  // head 값으로 한 번 채운다. 그 뒤 스트림이 모델을 바꿔도 입력 중인 값을 덮지 않는다.
  $effect(() => {
    if (item === undefined || loaded === key) return;
    init = { pool: String(item['pool'] ?? ''), host: String(item['host'] ?? ''), port: String(item['port'] ?? ''), weight: String(item['weight'] ?? '1'), drain: backendDraining(desk, key),
      softMax: typeof item['softMaxConns'] === 'number' ? String(item['softMaxConns']) : '', backup: item['isBackup'] === true };
    ({ pool, host, port, weight, drain, softMax, backup } = init);
    loaded = key;
  });

  const errors = $derived({
    host: host.trim() === '' ? '주소를 입력해요.' : undefined,
    port: port.trim() === '' ? '포트는 1–65535 사이여야 해요.' : portError(port),
    weight: weight.trim() === '' ? '1 이상의 정수를 입력해요.' : weightError(weight),
    softMax: softMaxError(softMax),
    backup: backup && backupBlocked ? `${algorithm} 풀은 예비 백엔드를 못 가져요.` : undefined,
  });
  const invalid = $derived(pool === '' || Object.values(errors).some((e) => e !== undefined));
  const changed = $derived(pool !== init.pool || host !== init.host || port !== init.port || weight !== init.weight
    || softMax.trim() !== init.softMax || backup !== init.backup);
  const dirty = $derived(changed || drain !== init.drain);
  const save = async (): Promise<void> => {
    if (item === undefined) return;
    if (drain !== init.drain) {
      const ok = await (drain ? desk.drain(key) : desk.undrain(key));
      if (ok) { init = { ...init, drain }; if (!changed) toast.ok(drain ? '드레인했어요' : '드레인을 풀었어요', '설정이 아니라 바로 걸려요.'); }
    }
    if (changed) {
      // 지운 칸은 빠진다 — `isBackup: false` 는 안 싣는다(안 정한 것과 같다).
      const { key: _k, softMaxConns: _s, isBackup: _b, ...rest } = item;
      after(resourcePath('backend', key))(await desk.putResource('backend', key, {
        ...rest, pool, host: host.trim(), port: Number(port), weight: Number(weight),
        ...(softMax.trim() === '' ? {} : { softMaxConns: Number(softMax) }),
        ...(backup ? { isBackup: true } : {}),
      }));
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
    <FormSection title="고급">
      <FormRow label="동시 연결 기준" for="bs-soft" error={errors.softMax}
        help="진행 중인 요청이 이 수를 넘으면 다른 백엔드를 먼저 골라요. 모두 넘으면 기준을 무시해요. 비우면 기준이 없어요.">
        <TextInput id="bs-soft" bind:value={softMax} invalid={errors.softMax !== undefined} inputmode="numeric" placeholder="100" width="160px" unit="개" />
      </FormRow>
      <FormRow label="예비 백엔드" error={errors.backup}
        help={backupBlocked ? `${algorithm} 풀은 예비 백엔드를 못 가져요. 키가 고른 백엔드가 예비면 갈 곳이 없어요.` : '켜면 다른 백엔드가 모두 내려갔을 때만 트래픽을 받아요.'}>
        <Switch bind:checked={backup} disabled={backupBlocked && !backup}>{backup ? '켜짐' : '꺼짐'}</Switch>
      </FormRow>
    </FormSection>
  </SettingsFrame>
{/if}

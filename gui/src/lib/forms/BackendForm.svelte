<script lang="ts">
  /**
   * 백엔드 넣기 — 콘솔 시안 `fieldsFor('backends', v, true, 'drawer')` 「기본」: 이름 · 풀 · 호스트 · 포트 · 가중치.
   * `pool` 을 주면(풀 상세의 `?pool=`) 그 풀로 시작한다.
   * 시안의 「드레인」 칸은 만들 때 없다 — 드레인은 설정이 아니라 있는 백엔드에 바로 거는 것이다(만든 뒤 목록 · 상세에서 건다).
   * 가중치는 1 이상이다(해독기 · nginx). 트래픽을 끊는 자리는 드레인이다.
   * 「고급」: 동시 연결 기준(`softMaxConns`) · 예비 백엔드(`isBackup`). 해시 계열 풀에서는 예비를 못 켠다.
   */
  import { getContext } from 'svelte';
  import { FormRow, FormSection, Select, Switch, TextInput } from '#lib/ui';
  import { BACKUP_FORBIDDEN_ALGORITHMS } from '@web/edit';
  import { resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import { KEY_HELP, filled, keyError, portError, softMaxError, weightError } from './checks';

  let { pool: initial }: { pool?: string } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const pools = $derived(desk.pools.rows.map((p) => ({ value: p.key })));

  // svelte-ignore state_referenced_locally
  let pool = $state<string | undefined>(initial);
  let key = $state('');
  let host = $state('');
  let port = $state('');
  let weight = $state('1');
  let softMax = $state('');
  let backup = $state(false);
  const algorithm = $derived(desk.pools.rows.find((p) => p.key === pool)?.algorithm ?? '');
  const backupBlocked = $derived(BACKUP_FORBIDDEN_ALGORITHMS.includes(algorithm));

  const ready = $derived(pool !== undefined && filled(key, keyError) && filled(host) && filled(port, portError) && filled(weight, weightError)
    && softMaxError(softMax) === undefined && !(backup && backupBlocked));
  const submit = (): void => {
    if (pool === undefined) return;
    const p = pool;
    void desk.insertBackend(key.trim(), {
      pool: p, host: host.trim(), port: Number(port), weight: Number(weight),
      ...(softMax.trim() === '' ? {} : { softMaxConns: Number(softMax) }),
      ...(backup ? { isBackup: true } : {}),
    }).then(after(resourcePath('backend', key.trim())));
  };
</script>

<CreateForm {ready} onsubmit={submit} cancelHref="/traffic/backend">
  <FormSection title="기본">
    <FormRow label="이름" for="be-key" error={keyError(key)} help={KEY_HELP}>
      <TextInput id="be-key" bind:value={key} invalid={keyError(key) !== undefined} autocomplete="off" />
    </FormRow>
    <FormRow label="풀" help={pools.length === 0 ? '풀이 없어요. 풀 만들기에서 풀과 첫 백엔드를 같이 열어요.' : undefined}>
      <Select label="풀" bind:value={pool} options={pools} placeholder="풀을 골라요" width="100%" disabled={pools.length === 0} />
    </FormRow>
    <FormRow label="호스트" for="be-host">
      <TextInput id="be-host" bind:value={host} autocomplete="off" />
    </FormRow>
    <FormRow label="포트" for="be-port" error={portError(port)}>
      <TextInput id="be-port" bind:value={port} invalid={portError(port) !== undefined} inputmode="numeric" />
    </FormRow>
    <FormRow label="가중치" for="be-weight" error={weightError(weight)} help="1 이상이에요. 트래픽을 끊으려면 드레인을 써요.">
      <TextInput id="be-weight" bind:value={weight} invalid={weightError(weight) !== undefined} inputmode="numeric" />
    </FormRow>
  </FormSection>
  <FormSection title="고급">
    <FormRow label="동시 연결 기준" for="be-soft" error={softMaxError(softMax)}
      help="진행 중인 요청이 이 수를 넘으면 다른 백엔드를 먼저 골라요. 모두 넘으면 기준을 무시해요. 비우면 기준이 없어요.">
      <TextInput id="be-soft" bind:value={softMax} invalid={softMaxError(softMax) !== undefined} inputmode="numeric" placeholder="100" width="160px" unit="개" />
    </FormRow>
    <FormRow label="예비 백엔드" error={backup && backupBlocked ? `${algorithm} 풀은 예비 백엔드를 못 가져요.` : undefined}
      help={backupBlocked ? `${algorithm} 풀은 예비 백엔드를 못 가져요. 키가 고른 백엔드가 예비면 갈 곳이 없어요.` : '켜면 다른 백엔드가 모두 내려갔을 때만 트래픽을 받아요.'}>
      <Switch bind:checked={backup} disabled={backupBlocked && !backup}>{backup ? '켜짐' : '꺼짐'}</Switch>
    </FormRow>
  </FormSection>
</CreateForm>

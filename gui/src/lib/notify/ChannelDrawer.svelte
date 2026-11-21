<script lang="ts">
  /**
   * 알림 통로 만들기 · 고치기 (036). 저장하면 곧바로 쓰인다 — 커밋 · 적용이 없다(설정 리비전이 아니다).
   *
   * 비밀 칸은 **비워 두면 있던 값을 그대로 둔다.** 서버는 넣은 비밀을 다시 보여 주지 않으므로 칸은 언제나 비어서 열린다.
   * 종류는 만든 뒤 못 바꾼다(비밀의 뜻이 바뀐다) — 고칠 때는 종류를 글로만 보인다.
   */
  import { Button, Checkbox, Drawer, FieldMessage, Form, FormRow, FormSection, ListInput, RadioGroup, Select, Switch, TextInput } from '#lib/ui';
  import {
    CHANNEL_NAME, EVENT_LABEL, KIND_LABEL, MAIL_ADDRESS, SEVERITY_LABEL,
    type Channel, type ChannelBody, type ChannelKind, type Severity,
  } from './api';

  let { channel, kinds, mailAvailable, busy = false, error, onsave, onclose }: {
    /** 고칠 통로. 없으면 새로 만든다. */
    channel?: Channel;
    /** 고를 수 있는 사건 종류(서버가 준다). */
    kinds: readonly string[];
    mailAvailable: boolean;
    busy?: boolean;
    error?: string;
    onsave: (name: string, body: ChannelBody) => void;
    onclose: () => void;
  } = $props();

  const editing = channel !== undefined;
  let name = $state(channel?.name ?? '');
  let kind = $state<ChannelKind>(channel?.kind ?? 'webhook');
  let enabled = $state(channel?.enabled ?? true);
  let url = $state(channel?.settings.url ?? '');
  let to = $state((channel?.settings.to ?? []).join('\n'));
  let secret = $state('');
  let minSeverity = $state<Severity>(channel?.settings.minSeverity ?? 'info');
  let allKinds = $state(channel?.settings.kinds === undefined);
  let picked = $state<string[]>(channel?.settings.kinds ?? [...kinds]);

  const toList = $derived(to.split('\n').map((s) => s.trim()).filter((s) => s !== ''));
  const nameError = $derived(editing || name === '' || CHANNEL_NAME.test(name) ? undefined
    : '소문자 · 숫자로 시작하고 소문자 · 숫자 · _ · - 만 써요(63 자까지).');
  const urlError = $derived(kind !== 'webhook' || url === '' || /^https:\/\//.test(url) ? undefined : 'https 주소만 써요.');
  const secretError = $derived.by(() => {
    if (secret === '') return undefined;
    if (kind === 'webhook' && secret.length < 16) return '서명 비밀은 16 자 이상이에요. openssl rand -hex 32 로 만들어요.';
    if (kind === 'slack' && !/^https:\/\//.test(secret)) return 'Slack 웹훅 URL 은 https 로 시작해요.';
    return undefined;
  });
  const toError = $derived(kind !== 'mail' ? undefined
    : toList.length === 0 ? '받는 주소를 하나 이상 넣어요.'
    : toList.length > 20 ? '받는 주소는 20 개까지예요.' : undefined);
  const kindsError = $derived(!allKinds && picked.length === 0 ? '받을 사건을 하나 이상 골라요.' : undefined);
  const needsSecret = $derived(kind !== 'mail' && !(editing && channel?.secretSet === true));
  const ready = $derived(name !== '' && nameError === undefined && urlError === undefined && secretError === undefined
    && toError === undefined && kindsError === undefined
    && (kind !== 'webhook' || url !== '') && (!needsSecret || secret !== ''));

  const body = (): ChannelBody => ({
    kind, enabled, minSeverity,
    ...(kind === 'webhook' ? { url } : {}),
    ...(kind === 'mail' ? { to: toList } : {}),
    ...(allKinds ? {} : { kinds: picked }),
    ...(secret === '' ? {} : { secret }),
  });

  const toggle = (k: string, on: boolean): void => {
    picked = on ? [...new Set([...picked, k])] : picked.filter((x) => x !== k);
  };
  const KIND_OPTIONS = (['webhook', 'slack', 'mail'] as const).map((k) => ({ value: k, label: KIND_LABEL[k] }));
  const SEVERITY_OPTIONS = (['info', 'warning', 'critical'] as const).map((s) => ({ value: s, label: SEVERITY_LABEL[s] }));
</script>

<Drawer title={editing ? `알림 통로 고치기: ${channel?.name}` : '알림 통로 만들기'}
  sub="저장하면 곧바로 써요. 커밋 · 적용은 없어요." width={560} {onclose}>
  <Form>
    <FormSection title="기본">
      <FormRow label="이름" for="nc-name" required error={nameError} help={editing ? '이름은 바꾸지 않아요.' : '예: ops-slack'}>
        <TextInput id="nc-name" bind:value={name} disabled={editing} autocomplete="off" />
      </FormRow>
      <FormRow label="종류" required help={editing ? '종류는 바꾸지 않아요. 바꾸려면 지우고 새로 만들어요.' : undefined}>
        {#if editing}<span>{KIND_LABEL[kind]}</span>{:else}<RadioGroup bind:value={kind} options={KIND_OPTIONS} label="통로 종류" />{/if}
      </FormRow>
      <FormRow label="켜짐"><Switch bind:checked={enabled}>{enabled ? '켜짐' : '꺼짐'}</Switch></FormRow>
    </FormSection>

    <FormSection title="대상">
      {#if kind === 'webhook'}
        <FormRow label="웹훅 URL" for="nc-url" required error={urlError} help="https 주소예요. 리다이렉트는 따라가지 않아요.">
          <TextInput id="nc-url" bind:value={url} placeholder="https://hooks.example.com/barycenter" />
        </FormRow>
        <FormRow label="서명 비밀" for="nc-secret" required={needsSecret} error={secretError}
          help={channel?.secretSet === true ? '넣어 둔 비밀이 있어요. 비워 두면 그대로 둬요. 넣으면 바꿔요.' : 'HMAC-SHA256 서명에 써요. 다시 보이지 않아요.'}>
          <TextInput id="nc-secret" type="password" bind:value={secret} autocomplete="new-password" />
        </FormRow>
      {:else if kind === 'slack'}
        <FormRow label="Slack 웹훅 URL" for="nc-secret" required={needsSecret} error={secretError}
          help={channel?.secretSet === true ? '넣어 둔 URL 이 있어요. 비워 두면 그대로 둬요. 넣으면 바꿔요.' : 'incoming webhook URL 자체가 비밀이에요. 다시 보이지 않아요.'}>
          <TextInput id="nc-secret" type="password" bind:value={secret} autocomplete="off" />
        </FormRow>
      {:else}
        <FormRow label="받는 주소" required error={toError} help="한 줄에 하나씩, 20 개까지예요.">
          <ListInput bind:value={to} label="받는 주소" minRows={3} check={(l) => (MAIL_ADDRESS.test(l) ? undefined : '메일 주소 모양이 아니에요.')} />
        </FormRow>
        {#if !mailAvailable}
          <FieldMessage tone="warn">이 지역에는 메일 전송 설정(BARY_MAIL_*)이 없어요. 저장은 되지만 보내지 못해요.</FieldMessage>
        {/if}
      {/if}
    </FormSection>

    <FormSection title="받을 사건">
      <FormRow label="최소 심각도">
        <Select bind:value={minSeverity} options={SEVERITY_OPTIONS} label="최소 심각도" mono={false} width="160px" />
      </FormRow>
      <FormRow label="사건 종류" error={kindsError}>
        <div class="kinds">
          <Checkbox bind:checked={allKinds}>전부 받아요</Checkbox>
          {#if !allKinds}
            {#each kinds as k (k)}
              <Checkbox checked={picked.includes(k)} onchange={(v) => toggle(k, v)}>{EVENT_LABEL[k] ?? k}</Checkbox>
            {/each}
          {/if}
        </div>
      </FormRow>
    </FormSection>
    {#if error !== undefined}<FieldMessage tone="error">{error}</FieldMessage>{/if}
  </Form>
  {#snippet footer()}
    <Button onclick={onclose}>취소</Button>
    <Button variant="primary" disabled={!ready} loading={busy} onclick={() => onsave(name, body())}>{editing ? '저장' : '만들기'}</Button>
  {/snippet}
</Drawer>

<style>
  .kinds { display: flex; flex-direction: column; gap: 6px; }
</style>

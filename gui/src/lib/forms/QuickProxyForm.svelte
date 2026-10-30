<script lang="ts">
  /**
   * 빠른 프록시 만들기 — URL 하나로 풀 · 백엔드 · 리스너(또는 기존 리스너의 라우트)를 한 번에 (시안: 번호 붙은 구획
   * + 「만들 리소스」 요약). 펴는 규칙은 CLI `bary proxy create` 와 같은 `proxyFromUrlPatch` 다. 저장은 커밋까지다.
   */
  import { getContext } from 'svelte';
  import { parseSourceAllow, proxyFromUrlPatch, type ProxyFromUrlInput } from '@web/edit';
  import { Card, FieldMessage, FormRow, FormSection, RadioGroup, Select, TextInput } from '#lib/ui';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import SourceAllowSection from './SourceAllowSection.svelte';
  import { bindHelp, keyError, portError, words } from './checks';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const httpListeners = $derived(desk.listeners.rows
    .filter((l) => l.mark !== 'leave' && (l.protocol === 'http' || l.protocol === 'https'))
    .map((l) => ({ value: l.key, hint: l.protocol })));
  const certs = $derived(desk.certs.rows.filter((c) => c.hasMaterial).map((c) => ({ value: c.key })));
  const policies = $derived(desk.policies.map((p) => ({ value: p })));

  let name = $state('');
  let url = $state('');
  let target = $state<'new' | 'existing'>('new');
  let protocol = $state<'http' | 'https'>('http');
  let bind = $state('0.0.0.0');
  let port = $state('80');
  let listener = $state<string | undefined>();
  let hosts = $state('');
  let path = $state('');
  let policy = $state<string | undefined>();
  let certificate = $state<string | undefined>();
  let allow = $state('');
  let problem = $state<string | undefined>();

  const input = $derived.by((): ProxyFromUrlInput => {
    const hostList = words(hosts);
    return {
      name: name.trim(),
      url: url.trim(),
      ...(target === 'new'
        ? {
            listen: { bind: bind.trim(), port: Number(port) },
            protocol,
            ...(protocol === 'https' ? { tls: { policy: policy ?? '', certificate: certificate ?? '' } } : {}),
          }
        : { listener: listener ?? '' }),
      ...(hostList.length > 0 ? { hosts: hostList } : {}),
      ...(path.trim() === '' ? {} : { pathPrefix: path.trim() }),
    };
  });
  /** 무엇이 만들어지나 — 저장 전에 보인다. 틀린 입력이면 그 말을 보인다. */
  const preview = $derived.by((): { ops: { kind: string; key: string }[]; error?: string } => {
    if (name.trim() === '' || url.trim() === '') return { ops: [], error: '이름과 대상 URL 을 넣으면 만들 리소스가 여기 보여요.' };
    try {
      const sa = target === 'new' ? parseSourceAllow(allow) : undefined;
      return { ops: proxyFromUrlPatch({ ...input, ...(sa === undefined ? {} : { sourceAllow: sa }) }).map((o) => ({ kind: o.kind, key: o.key })) };
    } catch (e) {
      return { ops: [], error: e instanceof Error ? e.message : String(e) };
    }
  });
  const ready = $derived(preview.error === undefined && keyError(name) === undefined && (target === 'existing' || portError(port) === undefined));
  const save = (): void => {
    problem = undefined;
    try {
      const sa = target === 'new' ? parseSourceAllow(allow) : undefined;
      void desk.proxyFromUrl({ ...input, ...(sa === undefined ? {} : { sourceAllow: sa }) }).then(after);
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
    }
  };
  $effect(() => { port = protocol === 'https' ? '443' : '80'; });
</script>

<CreateForm {ready} {problem} onsubmit={save} cancelHref="/traffic/listener">
  <FormSection title="1. 대상">
    <FormRow label="이름" for="qp-name" required error={keyError(name)} help="풀 · 리스너 · 라우트의 이름이 돼요.">
      <TextInput id="qp-name" bind:value={name} invalid={keyError(name) !== undefined} autocomplete="off" placeholder="app" />
    </FormRow>
    <FormRow label="대상 URL" for="qp-url" required help="이 주소로 보내요. 예: http://10.0.0.5:8080/">
      <TextInput id="qp-url" bind:value={url} autocomplete="off" placeholder="http://10.0.0.5:8080/" />
    </FormRow>
  </FormSection>

  <FormSection title="2. 리스너">
    <FormRow label="리스너" help={target === 'existing' ? '기존 리스너에는 라우트만 붙여요. 호스트가 필요해요.' : undefined}>
      <RadioGroup
        label="리스너" bind:value={target}
        options={[{ value: 'new', label: '새 리스너' }, { value: 'existing', label: '기존 리스너', disabled: httpListeners.length === 0 }]}
      />
    </FormRow>
    {#if target === 'new'}
      <FormRow label="프로토콜" required>
        <Select label="프로토콜" bind:value={protocol} options={[{ value: 'http', label: 'HTTP' }, { value: 'https', label: 'HTTPS' }]} mono={false} />
      </FormRow>
      <FormRow label="바인드 주소" for="qp-bind" required help={bindHelp(bind)}><TextInput id="qp-bind" bind:value={bind} /></FormRow>
      <FormRow label="포트" for="qp-port" required error={portError(port)}>
        <TextInput id="qp-port" bind:value={port} invalid={portError(port) !== undefined} inputmode="numeric" width="120px" />
      </FormRow>
      {#if protocol === 'https'}
        <FormRow label="TLS 정책" required help={policies.length === 0 ? 'TLS 정책이 없어요. 정책을 먼저 만들어요.' : undefined}>
          <Select label="TLS 정책" bind:value={policy} options={policies} placeholder="정책을 골라요" width="100%" disabled={policies.length === 0} />
        </FormRow>
        <FormRow label="인증서" required help={certs.length === 0 ? '자료가 있는 인증서가 없어요. 인증서를 먼저 넣어요.' : undefined}>
          <Select label="인증서" bind:value={certificate} options={certs} placeholder="인증서를 골라요" width="100%" disabled={certs.length === 0} />
        </FormRow>
      {/if}
    {:else}
      <FormRow label="기존 리스너" required>
        <Select label="기존 리스너" bind:value={listener} options={httpListeners} placeholder="리스너를 골라요" width="100%" />
      </FormRow>
    {/if}
  </FormSection>

  <FormSection title="3. 호스트와 경로" hint={target === 'new' ? '선택' : undefined}>
    <FormRow label="호스트" for="qp-hosts" help="쉼표나 공백으로 여러 개를 넣어요. 넣으면 라우트를 하나 만들어요.">
      <TextInput id="qp-hosts" bind:value={hosts} autocomplete="off" placeholder="app.example.com" />
    </FormRow>
    <FormRow label="경로 접두사" for="qp-path" help="이 접두사로 시작하는 요청과 맞아요.">
      <TextInput id="qp-path" bind:value={path} autocomplete="off" placeholder="/" />
    </FormRow>
  </FormSection>

  {#if target === 'new'}<SourceAllowSection bind:value={allow} {port} http title="4. 출발지 제한 (선택)" />{/if}

  <Card title="만들 리소스">
    {#if preview.error !== undefined}
      <FieldMessage>{preview.error}</FieldMessage>
    {:else}
      {#each preview.ops as o (o.kind + o.key)}
        <div class="op"><span class="plus" aria-hidden="true">＋</span><span class="kind">{o.kind}</span><code>{o.key}</code></div>
      {/each}
    {/if}
  </Card>
</CreateForm>

<style>
  .op { display: flex; gap: 8px; align-items: center; font: var(--t-small); }
  .plus { color: var(--ok); }
  .kind { color: var(--tx2); min-width: 120px; }
  code { font-family: var(--mono); color: var(--tx); }
</style>

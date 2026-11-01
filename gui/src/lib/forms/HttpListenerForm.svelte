<script lang="ts">
  /**
   * HTTP · HTTPS 리스너 만들기 (시안 구획: 기본 · 동작 · 접근 제한 · 고급 옵션).
   * **둘이 한 폼이다** — `tls` 면 TLS 정책과 기본 인증서 칸이 더 생긴다. 나머지가 갈리면 안 된다.
   */
  import { getContext } from 'svelte';
  import type { ListenerOptionFlags } from '@web/edit';
  import { FormRow, FormSection, Select } from '#lib/ui';
  import { resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import ListenerBasics from './ListenerBasics.svelte';
  import ListenerHostsSection from './ListenerHostsSection.svelte';
  import ListenerOptions from './ListenerOptions.svelte';
  import SourceAllowSection from './SourceAllowSection.svelte';
  import HttpRedirectField from './HttpRedirectField.svelte';
  import { filled, hostLine, keyError, portError } from './checks';
  import { parseListenerHosts } from '@web/edit';

  let { tls = false }: { tls?: boolean } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');

  const pools = $derived(desk.pools.rows.filter((p) => p.protocolClass === 'http'));
  const REJECT = '';
  /** 빈 값 = 「거절」. 설정 탭(ListenerForm)과 같은 선택지다. */
  const choices = $derived([
    { value: REJECT, label: '거절', hint: '라우트에 맞지 않으면 끊어요' },
    ...pools.map((p) => ({ value: p.key, label: `풀 ${p.key}` })),
  ]);
  const policies = $derived(desk.policies.map((p) => ({ value: p })));
  const certs = $derived(desk.certs.rows.filter((c) => c.hasMaterial).map((c) => ({ value: c.key })));

  let key = $state('');
  let bind = $state('0.0.0.0');
  // svelte-ignore state_referenced_locally
  let port = $state(tls ? '443' : '80');
  /** 아직 안 골랐으면 undefined. 기본 동작은 사람이 고른다 — 거절과 풀 모두 흔하다. */
  let action = $state<string | undefined>();
  const pool = $derived(action === undefined || action === REJECT ? undefined : action);
  let policy = $state<string | undefined>();
  let certificate = $state<string | undefined>();
  let opts = $state<ListenerOptionFlags>({});
  let allow = $state('');
  let hosts = $state('');
  // HTTPS 만. 새로 만들 때는 켜 둔다 — 평문으로 온 사람을 HTTPS 로 보내는 것이 흔한 기본이다.
  let redirectOn = $state(true);
  let redirectPort = $state('80');
  const redirectOk = $derived(!tls || !redirectOn || (filled(redirectPort, portError) && redirectPort.trim() !== port.trim()));
  const hostList = $derived(parseListenerHosts(hosts));
  const hostsOk = $derived((hostList ?? []).every((h) => hostLine(h) === undefined));

  const ready = $derived(
    filled(key, keyError) && filled(bind) && filled(port, portError) && action !== undefined && hostsOk && redirectOk
    && (!tls || (policy !== undefined && certificate !== undefined)),
  );
  const submit = (): void => {
    if (action === undefined) return;
    const k = key.trim();
    const b = bind.trim();
    const n = Number(port);
    if (tls) {
      if (policy === undefined || certificate === undefined) return;
      void desk.insertHttpsListener(k, { bind: b, port: n, ...(pool === undefined ? {} : { pool }), policy, certificate, ...(hostList === undefined ? {} : { hosts: hostList }), ...(redirectOn ? { httpRedirect: { port: Number(redirectPort) } } : {}) }, opts, allow).then(after(resourcePath('listener', k)));
    } else {
      void desk.insertHttpListener(k, { bind: b, port: n, ...(pool === undefined ? {} : { pool }), ...(hostList === undefined ? {} : { hosts: hostList }) }, opts, allow).then(after(resourcePath('listener', k)));
    }
  };
</script>

<CreateForm {ready} onsubmit={submit} cancelHref="/traffic/listener">
  <ListenerBasics protocol={tls ? 'HTTPS' : 'HTTP'} bind:key bind:bind bind:port />
  <ListenerHostsSection bind:value={hosts} />

  <FormSection title="동작">
    <FormRow label="기본 동작" required help={pools.length === 0 ? '라우트에 맞지 않는 요청을 끊어요. 풀로 보내려면 HTTP 풀을 먼저 만들어요.' : '라우트에 맞지 않는 요청을 끊거나, 고른 풀로 보내요.'}>
      <Select label="기본 동작" bind:value={action} options={choices} placeholder="동작을 골라요" width="100%" />
    </FormRow>
    {#if tls}
      <FormRow label="TLS 정책" required help={policies.length === 0 ? 'TLS 정책이 없어요. 정책을 먼저 만들어요.' : undefined}>
        <Select label="TLS 정책" bind:value={policy} options={policies} placeholder="정책을 골라요" width="100%" disabled={policies.length === 0} />
      </FormRow>
      <FormRow label="기본 인증서" required help={certs.length === 0 ? '자료가 있는 인증서가 없어요. 인증서를 먼저 넣어요.' : 'SNI 바인딩에 맞지 않는 호스트에 이 인증서를 내요.'}>
        <Select label="기본 인증서" bind:value={certificate} options={certs} placeholder="인증서를 골라요" width="100%" disabled={certs.length === 0} />
      </FormRow>
    {/if}
  </FormSection>

  {#if tls}<HttpRedirectField bind:on={redirectOn} bind:port={redirectPort} httpsPort={port} />{/if}

  <SourceAllowSection bind:value={allow} {port} http />
  <ListenerOptions bind:value={opts} />
</CreateForm>

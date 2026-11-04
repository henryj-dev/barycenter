<script lang="ts">
  /**
   * HTTP · HTTPS 리스너 만들기 — 콘솔 시안 `fieldsFor('listeners', v, true, 'drawer')`, 구획 순서도 시안 그대로:
   * 기본(이름 · 바인드 주소 · 포트 · 활성화 · 호스트) · 동작(기본 동작 · 기본 풀 · [HTTPS] TLS 정책 · 기본 인증서 · HTTP/2 ·
   * HTTP로 온 요청을 HTTPS로 보내기 · HTTP 포트) · 접근 제한 · 타임아웃과 본문 · 레이트리밋 · 요청 헤더 규칙 · 응답 헤더 규칙 · priority 정책.
   * **둘이 한 폼이다** — `tls` 면 TLS 칸이 더 생긴다. 나머지가 갈리면 안 된다.
   * 시안의 「원본 IP」 는 만들기 patch 가 받지 않아서 만든 뒤 설정 탭에서 정한다.
   */
  import { getContext } from 'svelte';
  import { parseListenerHosts, parseListenerOptions, parseSourceAllow, putHttpListenerPatch, putHttpsListenerPatch, type ListenerOptionFlags } from '@web/edit';
  import { FormRow, FormSection, ListInput, Select, Switch } from '#lib/ui';
  import { itemOf, resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import CreateForm from './CreateForm.svelte';
  import ListenerBasics from './ListenerBasics.svelte';
  import ListenerOptions from './ListenerOptions.svelte';
  import SourceAllowSection from './SourceAllowSection.svelte';
  import HttpRedirectField from './HttpRedirectField.svelte';
  import { filled, hostLine, keyError, portError } from './checks';
  import { plainSwitches, switchedBody } from './listener-create';

  let { tls = false }: { tls?: boolean } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');

  const pools = $derived(desk.pools.rows.filter((p) => p.protocolClass === 'http').map((p) => ({ value: p.key })));
  /** 시안 「기본 동작」 — 풀로 보내기 · 거절. */
  const BEHAVIORS = [{ value: 'pool', label: '풀로 보내기' }, { value: 'reject', label: '거절' }];
  /** 시안 「modern (TLS 1.2+)」. */
  const policies = $derived(desk.policies.map((p) => {
    const min = itemOf(desk.model, 'tlsPolicy', p)?.['minVersion'];
    return { value: p, label: typeof min === 'string' ? `${p} (${min.replace(/^TLSv?/, 'TLS ')}+)` : p };
  }));
  const certs = $derived(desk.certs.rows.filter((c) => c.hasMaterial).map((c) => ({ value: c.key })));

  let key = $state('');
  let bind = $state('0.0.0.0');
  // svelte-ignore state_referenced_locally
  let port = $state(tls ? '443' : '80');
  let enabled = $state(true);
  let behavior = $state<'pool' | 'reject'>('pool');
  let poolPick = $state<string | undefined>();
  const pool = $derived(behavior === 'reject' ? undefined : poolPick);
  let policy = $state<string | undefined>();
  let certificate = $state<string | undefined>();
  let http2 = $state(true);
  let opts = $state<ListenerOptionFlags>({});
  let optsOk = $state(true);
  let allow = $state('');
  let allowBad = $state(false);
  let hosts = $state('');
  // HTTPS 만. 새로 만들 때는 켜 둔다 — 평문으로 온 사람을 HTTPS 로 보내는 것이 흔한 기본이다.
  let redirectOn = $state(true);
  let redirectPort = $state('80');
  const redirectOk = $derived(!tls || !redirectOn || (filled(redirectPort, portError) && redirectPort.trim() !== port.trim()));
  const hostList = $derived(parseListenerHosts(hosts));
  const hostsOk = $derived((hostList ?? []).every((h) => hostLine(h) === undefined));

  const ready = $derived(
    filled(key, keyError) && filled(bind) && filled(port, portError) && (behavior === 'reject' || pool !== undefined) && hostsOk && redirectOk && optsOk && !allowBad
    && (!tls || (policy !== undefined && certificate !== undefined)),
  );
  const submit = (): void => {
    const k = key.trim();
    const b = bind.trim();
    const n = Number(port);
    const sw = { enabled, http2: tls ? http2 : undefined };
    const done = after(resourcePath('listener', k));
    if (tls) {
      if (policy === undefined || certificate === undefined) return;
      const body = { bind: b, port: n, ...(pool === undefined ? {} : { pool }), policy, certificate, ...(hostList === undefined ? {} : { hosts: hostList }), ...(redirectOn ? { httpRedirect: { port: Number(redirectPort) } } : {}) };
      if (plainSwitches(sw)) { void desk.insertHttpsListener(k, body, opts, allow).then(done); return; }
      const sa = parseSourceAllow(allow);
      const op = switchedBody(putHttpsListenerPatch(k, { ...body, ...parseListenerOptions(opts), ...(sa === undefined ? {} : { sourceAllow: sa }) }), sw);
      void desk.putResource('listener', op.key, op.body).then(done);
    } else {
      const body = { bind: b, port: n, ...(pool === undefined ? {} : { pool }), ...(hostList === undefined ? {} : { hosts: hostList }) };
      if (plainSwitches(sw)) { void desk.insertHttpListener(k, body, opts, allow).then(done); return; }
      const sa = parseSourceAllow(allow);
      const op = switchedBody(putHttpListenerPatch(k, { ...body, ...parseListenerOptions(opts), ...(sa === undefined ? {} : { sourceAllow: sa }) }), sw);
      void desk.putResource('listener', op.key, op.body).then(done);
    }
  };
</script>

<CreateForm {ready} onsubmit={submit} cancelHref="/traffic/listener">
  <ListenerBasics protocol={tls ? 'HTTPS' : 'HTTP'} bind:key bind:bind bind:port bind:enabled>
    <FormRow label="호스트" help="비우면 모든 호스트를 받아요. 한 줄에 하나씩 입력해요.">
      <ListInput label="호스트" bind:value={hosts} check={hostLine} minRows={3} />
    </FormRow>
  </ListenerBasics>

  <FormSection title="동작">
    <FormRow label="기본 동작"><Select label="기본 동작" bind:value={behavior} options={BEHAVIORS} mono={false} width="100%" /></FormRow>
    {#if behavior === 'pool'}
      <FormRow label="기본 풀" help={pools.length === 0 ? 'HTTP 풀이 없어요. 풀을 먼저 만들어요.' : undefined}>
        <Select label="기본 풀" bind:value={poolPick} options={pools} placeholder="풀을 골라요" width="100%" disabled={pools.length === 0} />
      </FormRow>
    {/if}
    {#if tls}
      <FormRow label="TLS 정책" help={policies.length === 0 ? 'TLS 정책이 없어요. 정책을 먼저 만들어요.' : undefined}>
        <Select label="TLS 정책" bind:value={policy} options={policies} placeholder="정책을 골라요" width="100%" disabled={policies.length === 0} />
      </FormRow>
      <FormRow label="기본 인증서" help={certs.length === 0 ? '자료가 있는 인증서가 없어요. 인증서를 먼저 넣어요.' : undefined}>
        <Select label="기본 인증서" bind:value={certificate} options={certs} placeholder="인증서를 골라요" width="100%" disabled={certs.length === 0} />
      </FormRow>
      <FormRow label="HTTP/2"><Switch bind:checked={http2}>{http2 ? '켜짐' : '꺼짐'}</Switch></FormRow>
      <HttpRedirectField bind:on={redirectOn} bind:port={redirectPort} httpsPort={port} bare />
    {/if}
  </FormSection>

  <SourceAllowSection bind:value={allow} bind:invalid={allowBad} {port} http />
  <ListenerOptions bind:value={opts} bind:ok={optsOk} folded={false} />
</CreateForm>

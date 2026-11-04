<script lang="ts">
  /**
   * 리스너 설정 폼 — 리스너 상세의 설정 탭(`/traffic/listener/<key>/settings`, 2026-10-30).
   *
   * 고치는 칸: 바인드 · 포트 · 켜짐 · 출발지 제한 · 기본 동작 · 원본 IP(시안 · `realIpFromHeader` /
   * `acceptProxyProtocol`). 나머지 칸(헤더 규칙·레이트리밋·TLS 결박 …)은 head 의 값을 그대로 싣는다 —
   * `editListenerPatch`. 원본 IP 는 그 body 위에 덮어 `putResource` 로 올린다(같은 commit 길이다).
   * 저장은 commit 이고, 적용은 적용 대기 화면에서 한다. 출발지 제한 구획은 만들기 폼과 같은 것을 쓴다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { editListenerPatch, parseListenerHosts, parseSourceAllow, type ListenerEdit } from '@web/edit';
  import { Banner, Button, Form, FormRow, FormSection, Select, Switch, TextInput } from '#lib/ui';
  import { resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import SourceAllowSection from '#lib/forms/SourceAllowSection.svelte';
  import ListenerHostsSection from '#lib/forms/ListenerHostsSection.svelte';
  import HttpRedirectField from '#lib/forms/HttpRedirectField.svelte';
  import { filled, hostLine, portError, sourceAllowLine } from '#lib/forms/checks';
  import BindField from '#lib/forms/BindField.svelte';
  import Writable from '#lib/global/Writable.svelte';
  import RealIpSection, { realIpOf, type RealIpHeader, type RealIpSource } from './RealIpSection.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const model = $derived(desk.listenerModels.find((l) => l['key'] === key));
  const protocol = $derived(typeof model?.['protocol'] === 'string' ? model['protocol'] : '');
  const isHttp = $derived(protocol === 'http' || protocol === 'https');
  const hasPool = $derived(isHttp || protocol === 'tcp' || protocol === 'udp');
  const poolClass = $derived(isHttp ? 'http' : protocol);
  /** 빈 값 = HTTP 계열의 「거절」. */
  const choices = $derived([
    ...(isHttp ? [{ value: '', label: '거절', hint: '라우트에 맞지 않으면 끊어요' }] : []),
    ...desk.pools.rows.filter((p) => p.protocolClass === poolClass).map((p) => ({ value: p.key, label: `풀 ${p.key}` })),
  ]);

  let bind = $state('');
  let port = $state('');
  let enabled = $state(true);
  let allow = $state('');
  let hosts = $state('');
  let action = $state('');
  let redirectOn = $state(false);
  let redirectPort = $state('80');
  let ipSource = $state<RealIpSource>('none');
  let ipHeader = $state<RealIpHeader>('CF-Connecting-IP');
  let ipTrusted = $state('');
  let problem = $state<string | undefined>();
  let loaded = $state<string | undefined>();

  // head 값으로 한 번 채운다. 그 뒤 SSE 로 모델이 바뀌어도 입력 중인 값을 덮지 않는다.
  $effect(() => {
    if (model === undefined || loaded === key) return;
    bind = String(model['bind'] ?? '');
    port = String(model['port'] ?? '');
    enabled = model['enabled'] !== false;
    allow = Array.isArray(model['sourceAllow']) ? (model['sourceAllow'] as string[]).join('\n') : '';
    hosts = Array.isArray(model['hosts']) ? (model['hosts'] as string[]).join('\n') : '';
    const rd = model['httpRedirect'] as { port?: unknown } | undefined;
    redirectOn = rd !== undefined;
    redirectPort = rd?.port === undefined ? '80' : String(rd.port);
    const http = model['http'] as { defaultAction?: unknown } | undefined;
    const da = isHttp ? http?.defaultAction : model['defaultPool'] === undefined ? undefined : { pool: model['defaultPool'] };
    action = typeof da === 'object' && da !== null ? String((da as { pool: unknown }).pool) : '';
    const ip = realIpOf(model);
    ipSource = ip.source;
    ipHeader = ip.header;
    ipTrusted = ip.trusted;
    loaded = key;
  });

  const hostList = $derived(parseListenerHosts(hosts) ?? []);
  const hostsOk = $derived(hostList.every((h) => hostLine(h) === undefined));
  const redirectOk = $derived(protocol !== 'https' || !redirectOn || (filled(redirectPort, portError) && redirectPort.trim() !== port.trim()));
  /** UDP 는 PROXY 수신이 없다. 헤더는 http 계열만. tcp · 패스스루의 PROXY 수신은 출발지 제한과 함께 못 쓴다. */
  const hasRealIp = $derived(protocol !== '' && protocol !== 'udp');
  const realIpOk = $derived(!hasRealIp || ipSource === 'none' || (
    ipTrusted.trim() !== '' && ipTrusted.split(/[\s,]+/).every((l) => l.trim() === '' || sourceAllowLine(l.trim()) === undefined)
    && (ipSource !== 'header' || isHttp)
    && (isHttp || ipSource !== 'proxy' || allow.trim() === '')
  ));
  const ready = $derived(filled(bind) && filled(port, portError) && (!hasPool || isHttp || action !== '') && hostsOk && redirectOk && realIpOk);
  const save = (): void => {
    if (!ready || desk.editing) return;
    problem = undefined;
    let edit: ListenerEdit;
    try {
      edit = {
        bind: bind.trim(),
        port: Number(port),
        enabled,
        sourceAllow: parseSourceAllow(allow),
        ...(hasPool ? { defaultAction: action === '' ? 'reject' as const : { pool: action } } : {}),
        // http · https 만 호스트를 가진다. 빈 목록이면 호스트를 지운다 — 그 포트의 기본 리스너가 된다.
        ...(isHttp ? { hosts: hostList } : {}),
        // https 만. 끄면 리다이렉트를 지운다.
        ...(protocol === 'https' ? { httpRedirect: redirectOn ? { port: Number(redirectPort) } : null } : {}),
      };
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
      return;
    }
    if (model === undefined) return;
    let body: Record<string, unknown>;
    try {
      const [op] = editListenerPatch(model, edit);
      if (op === undefined) return;
      body = op.body;
      // 원본 IP — 출처는 하나만 싣는다. 「없음」 이면 둘 다 지운다.
      delete body['realIpFromHeader'];
      delete body['acceptProxyProtocol'];
      if (hasRealIp && ipSource !== 'none') {
        const trustedCidrs = parseSourceAllow(ipTrusted) ?? [];
        body[ipSource === 'header' ? 'realIpFromHeader' : 'acceptProxyProtocol'] = ipSource === 'header' ? { header: ipHeader, trustedCidrs } : { trustedCidrs };
      }
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
      return;
    }
    void desk.putResource('listener', key, body).then(after(resourcePath('listener', key)));
  };
  const reset = (): void => { loaded = undefined; };
</script>

{#if model !== undefined}
  <Writable target>
    <Form note="저장하면 커밋해요. 트래픽은 적용 대기에서 적용해야 바뀌어요." onsubmit={save}>
      <FormSection title="기본">
        <FormRow label="프로토콜" help="프로토콜은 바꿀 수 없어요."><TextInput value={protocol} disabled /></FormRow>
        <BindField id="le-bind" bind:bind />
        <FormRow label="포트" for="le-port" required error={portError(port)}>
          <TextInput id="le-port" bind:value={port} invalid={portError(port) !== undefined} inputmode="numeric" width="120px" />
        </FormRow>
        <FormRow label="활성화" help="끄면 소켓을 열지 않아요."><Switch bind:checked={enabled}>켜짐</Switch></FormRow>
      </FormSection>
      {#if isHttp}<ListenerHostsSection bind:value={hosts} />{/if}
      {#if protocol === 'https'}<HttpRedirectField bind:on={redirectOn} bind:port={redirectPort} httpsPort={port} />{/if}
      {#if hasPool}
        <FormSection title="동작">
          <FormRow label="기본 동작" required>
            <Select label="기본 동작" bind:value={action} options={choices} placeholder="풀을 골라요" width="100%" />
          </FormRow>
        </FormSection>
      {/if}
      <SourceAllowSection bind:value={allow} {port} http={isHttp} />
      {#if hasRealIp}<RealIpSection bind:source={ipSource} bind:header={ipHeader} bind:trusted={ipTrusted} http={isHttp} allowUsed={allow.trim() !== ''} />{/if}
      {#if problem !== undefined}<Banner tone="danger">{problem}</Banner>{/if}
      {#snippet actions()}
        <Button variant="primary" type="submit" loading={desk.editing} disabled={!ready}>{desk.editing ? '저장 중' : '저장'}</Button>
        <Button onclick={reset} disabled={desk.editing}>되돌리기</Button>
        <Button variant="text" href={`/traffic/listener/${encodeURIComponent(key)}`}>취소</Button>
      {/snippet}
    </Form>
  </Writable>
{/if}

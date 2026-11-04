<script lang="ts">
  /**
   * 리스너 설정 폼 — 리스너 상세의 설정 탭(`/traffic/listener/<key>/settings`). 시안 「수정」 은 이 탭이다(`dpEdit`).
   *
   * 구획 · 칸 · 순서는 콘솔 시안 `fieldsFor('listeners', v, false, 'form')` 그대로:
   *   기본(이름 · 바인드 주소 · 포트 · 활성화 · 호스트) · 동작 · 접근 제한 · 원본 IP · 타임아웃과 본문 · 레이트리밋 ·
   *   요청 헤더 규칙 · 응답 헤더 규칙 · priority 정책. 동작은 프로토콜마다 다르다:
   *   http · https   기본 동작(풀로 보내기 · 거절) · 기본 풀. https 는 TLS 정책 · 기본 인증서 · HTTP/2 · HTTP로 온 요청을 HTTPS로 보내기
   *   tcp · udp      기본 풀. udp 는 프리셋
   *   패스스루       SNI 매칭 없음 폴백 · SNI 없음 폴백 · preread 타임아웃(모델이 폴백마다 풀을 따로 둔다)
   * 모델에 있는 칸만 낸다(`decodeListener` 가 받는 칸).
   *
   * 바탕은 `editListenerPatch` 다 — head 의 그 리스너 위에 바인드 · 포트 · 켜짐 · 출발지 제한 · 기본 동작 · 호스트 ·
   * 리다이렉트를 덮는다. 그 body 위에 이 폼의 나머지 칸(TLS · HTTP/2 · 옵션 · 폴백 · 프리셋 · 원본 IP)을 덮어
   * `putResource` 로 올린다(같은 commit 길이다). 폼이 모르는 칸은 그대로 남는다 — 아래 접은 JSON 수정이 그것까지 고친다.
   * 옵션의 단위 해석은 `parseListenerOptions` 한 자리다(CLI 와 같다).
   * 「바뀐 값이 있나」 는 폼이 만들 body 와 처음 body 를 견준다. 저장은 commit 이고, 적용은 적용 대기 화면에서 한다.
   */
  import { getContext, tick } from 'svelte';
  import { page } from '$app/state';
  import { editListenerPatch, parseListenerHosts, parseListenerOptions, parseSourceAllow, type ListenerEdit, type ListenerOptionFlags, type UdpPreset } from '@web/edit';
  import { Banner, FormRow, FormSection, Select, Switch, TextInput } from '#lib/ui';
  import { itemOf, resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import SourceAllowSection from '#lib/forms/SourceAllowSection.svelte';
  import ListenerHostsSection from '#lib/forms/ListenerHostsSection.svelte';
  import ListenerOptions from '#lib/forms/ListenerOptions.svelte';
  import HttpRedirectField from '#lib/forms/HttpRedirectField.svelte';
  import { LISTENER_ERR, filled, hostLine, portError } from '#lib/forms/checks';
  import BindField from '#lib/forms/BindField.svelte';
  import SettingsFrame, { sameBody } from '#lib/detail/SettingsFrame.svelte';
  import RealIpSection, { realIpOf, type RealIpHeader, type RealIpSource } from './RealIpSection.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  type Obj = Record<string, unknown>;
  const obj = (v: unknown): Obj | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Obj : undefined);
  /** 폴백 값 → 풀 이름. `'reject'` 와 없음은 빈 값(끊는다)이다. */
  const poolOf = (v: unknown): string => (typeof obj(v)?.['pool'] === 'string' ? String(obj(v)!['pool']) : '');

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const model = $derived(desk.listenerModels.find((l) => l['key'] === key));
  const protocol = $derived(typeof model?.['protocol'] === 'string' ? model['protocol'] : '');
  const isHttp = $derived(protocol === 'http' || protocol === 'https');
  const isHttps = $derived(protocol === 'https');
  const isPass = $derived(protocol === 'tls_passthrough');
  const hasPool = $derived(isHttp || protocol === 'tcp' || protocol === 'udp');
  const poolClass = $derived(isHttp ? 'http' : protocol);
  /** 지금 값이 목록에 없으면(지워진 풀 · 자료 없는 인증서) 그대로 보여 준다 — 조용히 바꾸지 않는다. */
  const keep = (opts: { value: string; label?: string; hint?: string }[], v: string, hint: string) =>
    (v === '' || opts.some((o) => o.value === v) ? opts : [...opts, { value: v, hint }]);
  const pools = $derived(desk.pools.rows.filter((p) => p.protocolClass === poolClass).map((p) => ({ value: p.key })));
  /** 시안 「기본 동작」 선택지 — 풀로 보내기 · 거절. */
  const BEHAVIORS = [{ value: 'pool', label: '풀로 보내기' }, { value: 'reject', label: '거절' }];
  /** 패스스루 폴백 — 빈 값 = 연결 거절. */
  const fallbacks = $derived([
    { value: '', label: '연결 거절' },
    ...desk.pools.rows.filter((p) => p.protocolClass === 'tcp').map((p) => ({ value: p.key, label: `풀 ${p.key}` })),
  ]);
  const PRESETS: { value: UdpPreset; label: string }[] = [
    { value: 'dns', label: 'dns' }, { value: 'wireguard', label: 'wireguard' },
    { value: 'game_generic', label: 'game' }, { value: 'custom', label: 'custom' },
  ];

  let bind = $state('');
  let port = $state('');
  let enabled = $state(true);
  let allow = $state('');
  let allowBad = $state(false);
  let hosts = $state('');
  let behavior = $state<'pool' | 'reject'>('pool');
  let action = $state('');
  let redirectOn = $state(false);
  let redirectPort = $state('80');
  let policy = $state('');
  let certificate = $state('');
  let http2 = $state(true);
  let sniPool = $state('');
  let noSniPool = $state('');
  let preread = $state('');
  let preset = $state<UdpPreset>('custom');
  let opts = $state<ListenerOptionFlags>({});
  let optsOk = $state(true);
  let ipSource = $state<RealIpSource>('none');
  let ipHeader = $state<RealIpHeader>('CF-Connecting-IP');
  let ipTrusted = $state('');
  let ipBad = $state(false);
  let problem = $state<string | undefined>();
  let loaded = $state<string | undefined>();
  /** 칸은 처음 한 번 head 값으로 채운다 — 되돌리기는 이것을 올려 다시 채운다. */
  let gen = $state(0);
  /** 처음 채운 뒤 폼이 만든 body — 「바뀐 값이 있나」 의 기준. */
  let baseline = $state<Record<string, unknown> | undefined>();

  /** TLS 정책 선택지 — 시안 「modern (TLS 1.2+)」. */
  const policies = $derived(keep(desk.policies.map((p) => {
    const min = itemOf(desk.model, 'tlsPolicy', p)?.['minVersion'];
    return { value: p, label: typeof min === 'string' ? `${p} (${min.replace(/^TLSv?/, 'TLS ')}+)` : p };
  }), policy, '목록에 없어요'));
  const certs = $derived(keep(desk.certs.rows.filter((c) => c.hasMaterial).map((c) => ({ value: c.key })), certificate, '자료 없음'));

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
    behavior = isHttp && action === '' ? 'reject' : 'pool';
    const tls = obj(model['tls']);
    policy = typeof tls?.['policy'] === 'string' ? tls['policy'] : '';
    certificate = typeof tls?.['defaultCertificate'] === 'string' ? tls['defaultCertificate'] : '';
    // 안 적으면 켠다(§4.9).
    http2 = model['http2'] !== false;
    sniPool = poolOf(model['onUnmatchedSni']);
    noSniPool = poolOf(model['onNoSni']);
    preread = typeof model['prereadTimeoutS'] === 'number' ? String(model['prereadTimeoutS']) : '';
    const p = obj(model['udp'])?.['preset'];
    preset = PRESETS.some((x) => x.value === p) ? p as UdpPreset : 'custom';
    opts = {};
    const ip = realIpOf(model);
    ipSource = ip.source;
    ipHeader = ip.header;
    ipTrusted = ip.trusted;
    gen += 1;
    loaded = key;
    baseline = undefined;
    // 옵션 칸(ListenerOptions)이 head 값으로 `opts` 를 채운 다음의 body 가 기준이다.
    void tick().then(() => { const b = build(); baseline = typeof b === 'string' ? undefined : b; });
  });

  const hostList = $derived(parseListenerHosts(hosts) ?? []);
  const hostsOk = $derived(hostList.every((h) => hostLine(h) === undefined));
  const redirectOk = $derived(protocol !== 'https' || !redirectOn || (filled(redirectPort, portError) && redirectPort.trim() !== port.trim()));
  /** 해독기와 같은 범위 — 1–3600 초. 비우면 nginx 기본값이다. */
  const prereadError = (v: string): string | undefined => {
    const t = v.trim();
    if (t === '') return undefined;
    const n = Number(t);
    return Number.isInteger(n) && n >= 1 && n <= 3600 ? undefined : '1–3600 사이의 정수(초)예요.';
  };
  /** UDP 는 PROXY 수신이 없다. 헤더는 http 계열만. tcp · 패스스루의 PROXY 수신은 출발지 제한과 함께 못 쓴다. */
  const hasRealIp = $derived(protocol !== '' && protocol !== 'udp');
  const proxySrc = $derived(!isHttp && ipSource === 'proxy');
  const errors = $derived({
    bind: bind.trim() === '' ? LISTENER_ERR.host : undefined,
    port: port.trim() === '' ? LISTENER_ERR.port : portError(port),
  });
  const ready = $derived(
    errors.bind === undefined && errors.port === undefined && (!hasPool || (behavior === 'reject' && isHttp) || action !== '') && hostsOk && redirectOk
    && (!hasRealIp || !ipBad) && !allowBad
    && (!isHttps || (policy !== '' && certificate !== ''))
    && (!isPass || prereadError(preread) === undefined)
    && (!isHttp || optsOk),
  );

  /** 폼 → 올릴 body. 틀리면 그 까닭(글). */
  const build = (): Record<string, unknown> | string => {
    if (model === undefined) return '리스너가 head 에 없어요.';
    try {
      const reject = isHttp && behavior === 'reject';
      const edit: ListenerEdit = {
        bind: bind.trim(),
        port: Number(port),
        enabled,
        sourceAllow: parseSourceAllow(allow),
        ...(hasPool && (reject || action !== '') ? { defaultAction: reject ? 'reject' as const : { pool: action } } : {}),
        // http · https 만 호스트를 가진다. 빈 목록이면 호스트를 지운다 — 그 포트의 기본 리스너가 된다.
        ...(isHttp ? { hosts: hostList } : {}),
        // https 만. 끄면 리다이렉트를 지운다.
        ...(isHttps ? { httpRedirect: redirectOn ? { port: Number(redirectPort) } : null } : {}),
      };
      const [op] = editListenerPatch(model, edit);
      if (op === undefined) return '고칠 것이 없어요.';
      const body = op.body;

      if (isHttp) {
        // 옵션 — 폼이 그 칸의 주인이다. 지운 칸은 빠진다. zone 크기(`zoneKb`)는 폼에 없으니 남긴다.
        const parsed = parseListenerOptions(opts);
        const { limits: _l, headers: _h, rateLimit: oldRate, strictPriority: _s, ...http } = obj(body['http']) ?? {};
        const zoneKb = obj(oldRate)?.['zoneKb'];
        body['http'] = {
          ...http, ...parsed,
          ...(parsed.rateLimit !== undefined && typeof zoneKb === 'number' ? { rateLimit: { ...parsed.rateLimit, zoneKb } } : {}),
        };
      }
      if (isHttps) {
        body['tls'] = { ...(obj(model['tls']) ?? {}), policy, defaultCertificate: certificate };
        // 바꾼 때만 손댄다. 끄면 `false` 를 적고, 켜면 키를 지운다(기본이 켠다 — 엔진이 못 하면 조용히 넘어간다, §4.9).
        if (http2 !== (model['http2'] !== false)) {
          if (http2) delete body['http2'];
          else body['http2'] = false;
        }
      }
      if (isPass) {
        // 빈 값 = 끊는다. 원래 'reject' 를 적어 뒀으면 그대로 두고, 없었으면 없는 채로 둔다 — 렌더 바이트를 안 바꾼다.
        for (const [field, pool] of [['onUnmatchedSni', sniPool], ['onNoSni', noSniPool]] as const) {
          if (pool !== '') body[field] = { pool };
          else if (model[field] !== 'reject') delete body[field];
        }
        if (preread.trim() === '') delete body['prereadTimeoutS'];
        else body['prereadTimeoutS'] = Number(preread);
      }
      if (protocol === 'udp') body['udp'] = { ...(obj(model['udp']) ?? {}), preset };

      // 원본 IP — 출처는 하나만 싣는다. 「없음」 이면 둘 다 지운다.
      delete body['realIpFromHeader'];
      delete body['acceptProxyProtocol'];
      if (hasRealIp && ipSource !== 'none') {
        const trustedCidrs = parseSourceAllow(ipTrusted) ?? [];
        body[ipSource === 'header' ? 'realIpFromHeader' : 'acceptProxyProtocol'] = ipSource === 'header' ? { header: ipHeader, trustedCidrs } : { trustedCidrs };
      }
      return body;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const draft = $derived(loaded === key ? build() : undefined);
  const dirty = $derived(draft !== undefined && (typeof draft === 'string' || baseline === undefined || !sameBody(draft, baseline)));
  const save = (): void => {
    if (!ready || desk.editing) return;
    problem = undefined;
    const body = build();
    if (typeof body === 'string') { problem = body; return; }
    void desk.putResource('listener', key, body).then(after(resourcePath('listener', key)));
  };
  const reset = (): void => { loaded = undefined; };
</script>

{#if model !== undefined}
  <SettingsFrame kind="listener" {dirty} invalid={!ready} onsave={save} onrevert={reset}>
    <FormSection title="기본">
      <FormRow label="이름"><TextInput value={key} disabled /></FormRow>
      <BindField id="le-bind" bind:bind />
      <FormRow label="포트" for="le-port" error={errors.port}>
        <TextInput id="le-port" bind:value={port} invalid={errors.port !== undefined} inputmode="numeric" />
      </FormRow>
      <FormRow label="활성화"><Switch bind:checked={enabled}>{enabled ? '켜짐' : '꺼짐'}</Switch></FormRow>
      {#if isHttp}<ListenerHostsSection bind:value={hosts} bare />{/if}
    </FormSection>

    <FormSection title="동작">
      {#if isHttp}
        <FormRow label="기본 동작"><Select label="기본 동작" bind:value={behavior} options={BEHAVIORS} mono={false} width="100%"
          onchange={(v) => { if (v === 'pool' && action === '') action = pools[0]?.value ?? ''; }} /></FormRow>
        {#if behavior === 'pool'}
          <FormRow label="기본 풀"><Select label="기본 풀" bind:value={action} options={keep(pools, action, '목록에 없어요')} placeholder="풀을 골라요" width="100%" /></FormRow>
        {/if}
      {:else if hasPool}
        <FormRow label="기본 풀"><Select label="기본 풀" bind:value={action} options={keep(pools, action, '목록에 없어요')} placeholder="풀을 골라요" width="100%" /></FormRow>
      {/if}
      {#if isHttps}
        <FormRow label="TLS 정책"><Select label="TLS 정책" bind:value={policy} options={policies} placeholder="정책을 골라요" width="100%" /></FormRow>
        <FormRow label="기본 인증서"><Select label="기본 인증서" bind:value={certificate} options={certs} placeholder="인증서를 골라요" width="100%" /></FormRow>
        <FormRow label="HTTP/2"><Switch bind:checked={http2}>{http2 ? '켜짐' : '꺼짐'}</Switch></FormRow>
        <HttpRedirectField bind:on={redirectOn} bind:port={redirectPort} httpsPort={port} bare />
      {/if}
      {#if protocol === 'udp'}
        <FormRow label="프리셋"><Select label="프리셋" bind:value={preset} options={PRESETS} mono={false} /></FormRow>
      {/if}
      {#if isPass}
        <FormRow label="SNI 매칭 없음 폴백"><Select label="SNI 매칭 없음 폴백" bind:value={sniPool} options={keep(fallbacks, sniPool, '목록에 없어요')} mono={false} width="100%" /></FormRow>
        <FormRow label="SNI 없음 폴백"><Select label="SNI 없음 폴백" bind:value={noSniPool} options={keep(fallbacks, noSniPool, '목록에 없어요')} mono={false} width="100%" /></FormRow>
        <FormRow label="preread 타임아웃" for="le-preread" error={prereadError(preread)} help="ClientHello 를 기다리는 시간(초)이에요. 비우면 nginx 기본값이에요.">
          <TextInput id="le-preread" bind:value={preread} invalid={prereadError(preread) !== undefined} inputmode="numeric" placeholder="30" unit="s" />
        </FormRow>
      {/if}
    </FormSection>

    <!-- 대역 행은 마운트할 때 값을 읽는다 — head 값으로 채운 뒤(gen) 다시 만든다. -->
    {#key gen}<SourceAllowSection bind:value={allow} bind:invalid={allowBad} {port} http={isHttp} noSrc={proxySrc} conflict={proxySrc && allow.trim() !== ''} />{/key}
    {#if hasRealIp}{#key gen}<RealIpSection bind:source={ipSource} bind:header={ipHeader} bind:trusted={ipTrusted} bind:invalid={ipBad} http={isHttp} />{/key}{/if}
    {#if isHttp && loaded === key}
      {#key gen}<ListenerOptions bind:value={opts} bind:ok={optsOk} seed={model['http']} folded={false} />{/key}
    {/if}
    {#if problem !== undefined}<Banner tone="danger">{problem}</Banner>{/if}
  </SettingsFrame>
{/if}

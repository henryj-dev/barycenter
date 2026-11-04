<script lang="ts">
  /**
   * 풀 설정 탭 — 콘솔 시안 `fieldsFor('pools', v, false, 'form')` 그대로 한 폼이다:
   *   기본(이름 · 프로토콜 계열 · 알고리즘 · hash 키) · 헬스체크(방식 · 경로 · Host 헤더 · 기대 상태 코드 · 기대 본문 · 주기 ·
   *   타임아웃 · rise · fall) · ▸ 헬스체크 더 보기(포트 · 프로브 주소) · 업스트림 TLS(켜기 · SNI · 인증서 검증 · CA 번들) · 전송(PROXY 송신).
   * UDP 풀은 헬스체크 대신 「정의 · 검사 안 함」(읽기)이다.
   *
   * 저장은 한 번이다 — head 의 그 풀 위에 헬스체크(`poolBodyWithHealth`) · 업스트림 TLS(`poolBodyWithUpstreamTls`) ·
   * 알고리즘 · hash 키 · PROXY 송신을 차례로 덮어 `putResource`(commit). 폼에 없는 칸은 그대로 남는다.
   * 헬스체크 방식의 「기본」 은 시안에 없지만 있던 선택이다 — 안 적으면 풀이 정하던 기본(HTTP 풀은 HTTP GET /, 나머지는 TCP 연결)이다.
   * 프로토콜 계열은 바꿀 수 없다(리스너와 같은 계열의 풀만 고른다) — 칸이 잠긴다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { Banner, Button, Expander, FormRow, FormSection, Select, Switch, TextInput } from '#lib/ui';
  import { itemOf, resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import { HEALTH_DEFAULT, healthFormOf, healthIssue, poolBodyWithHealth, type HealthMode } from '@web/health-check';
  import { UPSTREAM_TLS_OFF, caBundleChoices, poolBodyWithUpstreamTls, upstreamTlsFormOf, upstreamTlsIssue } from '@web/upstream-tls';
  import SettingsFrame, { sameBody } from '#lib/detail/SettingsFrame.svelte';
  import { ALGOS, hashKeyError, type Algo } from './pool-fields';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const pool = $derived(itemOf(desk.model, 'pool', key));
  const cls = $derived(String(pool?.['protocolClass'] ?? ''));

  let algo = $state<Algo>('round_robin');
  let hash = $state('');
  let sendProxy = $state(false);
  let f = $state({ ...HEALTH_DEFAULT });
  let tls = $state({ ...UPSTREAM_TLS_OFF });
  let more = $state(false);
  let loaded = $state<string | undefined>();
  let problem = $state<string | undefined>();

  const fill = (p: Readonly<Record<string, unknown>>): void => {
    const a = p['algorithm'];
    algo = ALGOS.some((x) => x.value === a) ? a as Algo : 'round_robin';
    hash = typeof p['hashKey'] === 'string' ? p['hashKey'] : '';
    sendProxy = p['sendProxyProtocol'] === 'v1';
    f = healthFormOf(p);
    tls = upstreamTlsFormOf(p);
  };
  // head 값으로 한 번 채운다. 그 뒤 모델이 바뀌어도 입력 중인 값을 덮지 않는다.
  $effect(() => {
    if (pool === undefined || loaded === key) return;
    fill(pool);
    loaded = key;
  });

  /** 시안 「방식」 선택지 + 있던 「기본」. */
  const MODES = $derived<{ value: HealthMode; label: string }[]>([
    { value: 'default', label: cls === 'http' ? '기본 (HTTP GET / · 2xx)' : '기본 (TCP 연결)' },
    { value: 'http', label: 'HTTP' },
    { value: 'tcp', label: 'TCP 연결' },
    { value: 'none', label: '안 해요' },
  ]);
  const certs = $derived(caBundleChoices((desk.model['certificates'] ?? []) as Record<string, unknown>[]));
  const caOptions = $derived([{ value: '', label: '없음' }, ...certs.map((k) => ({ value: k, label: k })),
    ...(tls.caBundle !== '' && !certs.includes(tls.caBundle) ? [{ value: tls.caBundle, label: tls.caBundle, hint: '자료 없음' }] : [])]);
  $effect(() => { if (tls.caBundle === '' && tls.verify) tls.verify = false; });

  const hashErr = $derived(algo === 'hash' ? hashKeyError(hash, cls) : undefined);
  const hcIssue = $derived(cls === 'udp' ? undefined : healthIssue(f));
  const tlsIssue = $derived(upstreamTlsIssue(cls, tls));
  const proxyErr = $derived(sendProxy && cls !== 'tcp' ? 'PROXY 송신은 TCP 풀에만 있어요.' : undefined);
  const probes = $derived(f.mode !== 'none');

  /** 폼 → 올릴 body. 틀리면 그 까닭(글). */
  const build = (): Record<string, unknown> | string => {
    if (pool === undefined) return '풀이 head 에 없어요.';
    try {
      const withHc = cls === 'udp' ? (({ key: _k, ...rest }) => rest)(pool as Record<string, unknown>) : poolBodyWithHealth(pool, f);
      const body = poolBodyWithUpstreamTls({ ...withHc, protocolClass: cls }, tls);
      body['algorithm'] = algo;
      if (algo === 'hash') body['hashKey'] = hash.trim();
      else delete body['hashKey'];
      if (sendProxy) body['sendProxyProtocol'] = 'v1';
      else delete body['sendProxyProtocol'];
      return body;
    } catch (e) {
      return e instanceof Error ? e.message : String(e);
    }
  };
  const base = $derived(pool === undefined ? undefined : (({ key: _k, ...rest }) => rest)(pool as Record<string, unknown>));
  const draft = $derived(loaded === key ? build() : undefined);
  const dirty = $derived(draft !== undefined && (typeof draft === 'string' || !sameBody(draft, base)));
  const invalid = $derived(hashErr !== undefined || hcIssue !== undefined || tlsIssue !== undefined || proxyErr !== undefined || typeof draft === 'string');
  const save = (): void => {
    problem = undefined;
    const body = build();
    if (typeof body === 'string') { problem = body; return; }
    void desk.putResource('pool', key, body).then(after(resourcePath('pool', key)));
  };
  /** 시안 「되돌리기」 링크(헬스체크 방식 아래) — 헬스체크 칸만 저장된 값으로. */
  const resetHc = (): void => { if (pool !== undefined) f = healthFormOf(pool); };
</script>

{#if pool !== undefined}
  <SettingsFrame kind="pool" {dirty} {invalid} onsave={save} onrevert={() => { loaded = undefined; }}>
    <FormSection title="기본">
      <FormRow label="이름"><TextInput value={key} disabled /></FormRow>
      <FormRow label="프로토콜 계열"><Select label="프로토콜 계열" value={cls.toUpperCase()} options={[{ value: cls.toUpperCase() }]} mono={false} width="100%" disabled /></FormRow>
      <FormRow label="알고리즘"><Select label="알고리즘" bind:value={algo} options={ALGOS} width="100%" /></FormRow>
      {#if algo === 'hash'}
        <FormRow label="hash 키" for="ps-hash" error={hashErr} help="예: $remote_addr"><TextInput id="ps-hash" bind:value={hash} invalid={hashErr !== undefined} autocomplete="off" /></FormRow>
      {/if}
    </FormSection>

    {#if cls === 'udp'}
      <FormSection title="헬스체크">
        <FormRow label="정의" help="UDP 풀은 검사하지 않아서 헬스가 관측 없음으로 나와요."><TextInput value="검사 안 함" disabled /></FormRow>
      </FormSection>
    {:else}
      <FormSection title="헬스체크">
        <FormRow label="방식" error={hcIssue} help={tls.on && !tls.verify ? '인증서를 검증하지 않는 TLS 풀은 기본이 TCP 연결 검사예요.' : undefined}>
          <Select label="방식" bind:value={f.mode} options={MODES} mono={false} width="100%" />
          <span class="lnk"><Button variant="text" size="xs" onclick={resetHc}>되돌리기</Button></span>
        </FormRow>
        {#if f.mode === 'http'}
          <FormRow label="경로" for="hc-path" help="비우면 / 예요. 예: /healthz · /status"><TextInput id="hc-path" bind:value={f.path} autocomplete="off" /></FormRow>
          <FormRow label="Host 헤더" for="hc-host" help="이름으로 사이트를 고르는 백엔드는 이게 있어야 답해요. 비우면 찌르는 주소예요."><TextInput id="hc-host" bind:value={f.hostHeader} autocomplete="off" /></FormRow>
          <FormRow label="기대 상태 코드" for="hc-status" help="쉼표로 여러 개. 비우면 2xx 예요. 예: 200, 204, 301"><TextInput id="hc-status" bind:value={f.expectStatus} autocomplete="off" /></FormRow>
          <FormRow label="기대 본문" for="hc-body" help="본문이 이것과 같아야 살았다고 봐요. 비우면 본문을 안 봐요."><TextInput id="hc-body" bind:value={f.expectBody} autocomplete="off" /></FormRow>
        {/if}
        {#if probes}
          <FormRow label="주기" for="hc-int" help="초 단위예요. 비우면 데몬 기본값이에요."><TextInput id="hc-int" bind:value={f.intervalS} autocomplete="off" inputmode="numeric" /></FormRow>
          <FormRow label="타임아웃" for="hc-to" help="주기보다 길 수 없어요."><TextInput id="hc-to" bind:value={f.timeoutS} autocomplete="off" inputmode="numeric" /></FormRow>
          <FormRow label="rise" for="hc-rise" help="몇 번 연속 성공하면 살았다고 보나."><TextInput id="hc-rise" bind:value={f.rise} autocomplete="off" inputmode="numeric" /></FormRow>
          <FormRow label="fall" for="hc-fall" help="몇 번 연속 실패하면 죽었다고 보나."><TextInput id="hc-fall" bind:value={f.fall} autocomplete="off" inputmode="numeric" /></FormRow>
        {/if}
      </FormSection>
      {#if probes}
        <section class="fold">
          <Expander block bind:open={more}>헬스체크 더 보기</Expander>
          {#if more}
            <FormSection>
              <FormRow label="포트" for="hc-port" help="비우면 백엔드 포트예요."><TextInput id="hc-port" bind:value={f.port} autocomplete="off" inputmode="numeric" /></FormRow>
              <FormRow label="프로브 주소" for="hc-addr" help="사이드카 프로브용. 비우면 백엔드 주소예요."><TextInput id="hc-addr" bind:value={f.hostOverride} autocomplete="off" /></FormRow>
            </FormSection>
          {/if}
        </section>
      {/if}
    {/if}

    <FormSection title="업스트림 TLS">
      <FormRow label="업스트림 TLS" help={cls === 'udp' ? 'UDP 풀은 백엔드로 TLS 를 못 써요.' : undefined}><Switch bind:checked={tls.on} disabled={cls === 'udp' && !tls.on}>{tls.on ? '켜짐' : '꺼짐'}</Switch></FormRow>
      {#if tls.on}
        <FormRow label="SNI" for="ps-sni"><TextInput id="ps-sni" bind:value={tls.sni} autocomplete="off" /></FormRow>
        <FormRow label="인증서 검증" error={tlsIssue} help={tls.caBundle === '' ? 'CA 번들을 고르면 켤 수 있어요.' : undefined}><Switch bind:checked={tls.verify} disabled={tls.caBundle === ''}>{tls.verify ? '켜짐' : '꺼짐'}</Switch></FormRow>
        <FormRow label="CA 번들"><Select label="CA 번들" bind:value={tls.caBundle} options={caOptions} width="100%" /></FormRow>
      {/if}
    </FormSection>

    <FormSection title="전송">
      <FormRow label="PROXY 송신" error={proxyErr}><Switch bind:checked={sendProxy} disabled={cls !== 'tcp' && !sendProxy}>{sendProxy ? '켜짐' : '꺼짐'}</Switch></FormRow>
    </FormSection>
    {#if problem !== undefined}<Banner tone="danger">{problem}</Banner>{/if}
  </SettingsFrame>
{/if}

<style>
  /* 시안 `linkL` — 칸 아래 강조색 글자 단추(「되돌리기」). */
  .lnk { display: block; margin-top: 4px; }
  .lnk :global(.btn) { padding: 0; height: auto; font-size: 12px; }
  .fold { display: flex; flex-direction: column; }
</style>

<script lang="ts">
  /**
   * 풀 설정 탭의 「기본」 · 「전송」 (#126 후속, 시안). 전에는 알고리즘 · hash 키 · PROXY 송신을 JSON 으로만 고쳤다.
   *
   * 이 폼은 `algorithm` · `hashKey` · `sendProxyProtocol` 만 바꾸고 나머지(헬스체크 · 업스트림 TLS)는 그대로 둔다.
   * 규칙은 검증기와 같다 — hash 키는 hash 알고리즘에만 있고(다른 알고리즘이면 지운다), stream 풀은 `remote_addr` 만 쓴다.
   * PROXY 송신은 TCP 풀에만 있다(§4.7). 최종 판정은 서버다(`invalid_hash_key` · `option_not_supported`).
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { Banner, Button, Form, FormRow, FormSection, Select, Switch, TextInput } from '#lib/ui';
  import { itemOf, resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import { filled } from '#lib/forms/checks';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  type Algo = 'round_robin' | 'least_conn' | 'source_ip_hash' | 'hash';
  const ALGOS: { value: Algo; label: string; hint?: string }[] = [
    { value: 'round_robin', label: 'round_robin' },
    { value: 'least_conn', label: 'least_conn' },
    { value: 'source_ip_hash', label: 'ip_hash', hint: '출발지 IP' },
    { value: 'hash', label: 'hash', hint: '키를 정해요' },
  ];

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const pool = $derived(itemOf(desk.model, 'pool', key));
  const protocolClass = $derived(String(pool?.['protocolClass'] ?? ''));

  let algorithm = $state<Algo>('round_robin');
  let hashKey = $state('remote_addr');
  let sendProxy = $state(false);
  let loaded = $state<string | undefined>();
  let problem = $state<string | undefined>();

  // head 값으로 한 번 채운다. 그 뒤 모델이 바뀌어도 입력 중인 값을 덮지 않는다(다른 풀 폼과 같다).
  $effect(() => {
    if (pool === undefined || loaded === key) return;
    const a = pool['algorithm'];
    algorithm = ALGOS.some((x) => x.value === a) ? a as Algo : 'round_robin';
    hashKey = typeof pool['hashKey'] === 'string' ? pool['hashKey'] : 'remote_addr';
    sendProxy = pool['sendProxyProtocol'] === 'v1';
    loaded = key;
  });

  const stream = $derived(protocolClass !== 'http');
  /** 검증기(`parseHashKey`)와 같은 꼴만 미리 본다. */
  const hashError = (v: string): string | undefined => {
    const t = v.trim();
    if (t === '' || t === 'remote_addr') return undefined;
    if (stream) return `${protocolClass.toUpperCase()} 풀은 remote_addr 만 쓸 수 있어요.`;
    if (t === 'request_uri' || /^header\([A-Za-z0-9-]+\)$/.test(t) || /^cookie\([A-Za-z0-9_]+\)$/.test(t)) return undefined;
    return 'remote_addr · request_uri · header(이름) · cookie(이름) 중 하나예요.';
  };
  const proxyOk = $derived(!sendProxy || protocolClass === 'tcp');
  const ready = $derived(pool !== undefined && (algorithm !== 'hash' || filled(hashKey, hashError)) && proxyOk);
  const save = (): void => {
    if (!ready || pool === undefined || desk.editing) return;
    problem = undefined;
    const { key: _k, ...body } = pool as Record<string, unknown>;
    body['algorithm'] = algorithm;
    if (algorithm === 'hash') body['hashKey'] = hashKey.trim();
    else delete body['hashKey'];
    if (sendProxy) body['sendProxyProtocol'] = 'v1';
    else delete body['sendProxyProtocol'];
    // 저장하면 상세로 간다(다른 풀 폼과 같다) — 머물면 아래 JSON 칸이 옛 값을 들고 있다가 이 변경을 되돌린다.
    void desk.putResource('pool', key, body).then(after(resourcePath('pool', key)));
  };
  const reset = (): void => { loaded = undefined; };
</script>

{#if pool !== undefined}
  <Writable>
    <Form note="저장하면 커밋해요. 트래픽은 적용 대기에서 적용해야 바뀌어요." onsubmit={save}>
      <FormSection title="기본">
        <FormRow label="이름" help="이름은 바꿀 수 없어요."><TextInput value={key} disabled /></FormRow>
        <FormRow label="프로토콜 계열" help="계열은 바꿀 수 없어요. 리스너와 같은 계열의 풀만 고를 수 있어요.">
          <TextInput value={protocolClass.toUpperCase()} disabled width="120px" />
        </FormRow>
        <FormRow label="알고리즘" required help={algorithm === 'hash' || algorithm === 'source_ip_hash' ? '해시 풀에는 백업 백엔드를 둘 수 없어요.' : undefined}>
          <Select label="알고리즘" bind:value={algorithm} options={ALGOS} />
        </FormRow>
        {#if algorithm === 'hash'}
          <FormRow label="hash 키" for="pb-hash" required error={hashError(hashKey)}
            help={stream ? 'TCP · UDP 풀은 remote_addr 만 써요.' : 'nginx 변수 이름이에요. 예: remote_addr · request_uri · header(X-User) · cookie(session)'}>
            <TextInput id="pb-hash" bind:value={hashKey} invalid={hashError(hashKey) !== undefined} autocomplete="off" />
          </FormRow>
        {/if}
      </FormSection>
      <FormSection title="전송">
        <FormRow label="PROXY 송신" error={proxyOk ? undefined : 'PROXY 송신은 TCP 풀에만 있어요.'}
          help={protocolClass === 'tcp' ? '켜면 백엔드에 연결할 때 PROXY protocol v1 헤더를 붙여 원래 출발지 주소를 넘겨요. 백엔드가 PROXY protocol 을 받아야 해요.' : 'PROXY 송신은 TCP 풀에만 있어요.'}>
          <Switch bind:checked={sendProxy} disabled={protocolClass !== 'tcp' && !sendProxy}>켜짐</Switch>
        </FormRow>
      </FormSection>
      {#if problem !== undefined}<Banner tone="danger">{problem}</Banner>{/if}
      {#snippet actions()}
        <Button variant="primary" type="submit" loading={desk.editing} disabled={!ready}>{desk.editing ? '저장 중' : '저장'}</Button>
        <Button onclick={reset} disabled={desk.editing}>되돌리기</Button>
      {/snippet}
    </Form>
  </Writable>
{/if}

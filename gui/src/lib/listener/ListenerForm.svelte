<script lang="ts">
  /**
   * 리스너 설정 폼 — 리스너 상세의 설정 탭(`/traffic/listener/<key>/settings`, 2026-10-30).
   *
   * 고치는 칸: 바인드 · 포트 · 켜짐 · 출발지 제한 · 기본 동작. 나머지 칸(헤더 규칙·레이트리밋·TLS
   * 결박 …)은 head 의 값을 그대로 싣는다 — `editListenerPatch`. 저장은 commit 이고, 적용은
   * 적용 대기 화면에서 한다. 출발지 제한 구획은 만들기 폼과 같은 것을 쓴다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { parseSourceAllow, type ListenerEdit } from '@web/edit';
  import { Banner, Button, Form, FormRow, FormSection, Select, Switch, TextInput } from '#lib/ui';
  import { resourcePath } from '@web/resources';
  import { after } from '#lib/after';
  import SourceAllowSection from '#lib/forms/SourceAllowSection.svelte';
  import { bindHelp, filled, portError } from '#lib/forms/checks';
  import Writable from '#lib/global/Writable.svelte';
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
  let action = $state('');
  let problem = $state<string | undefined>();
  let loaded = $state<string | undefined>();

  // head 값으로 한 번 채운다. 그 뒤 SSE 로 모델이 바뀌어도 입력 중인 값을 덮지 않는다.
  $effect(() => {
    if (model === undefined || loaded === key) return;
    bind = String(model['bind'] ?? '');
    port = String(model['port'] ?? '');
    enabled = model['enabled'] !== false;
    allow = Array.isArray(model['sourceAllow']) ? (model['sourceAllow'] as string[]).join('\n') : '';
    const http = model['http'] as { defaultAction?: unknown } | undefined;
    const da = isHttp ? http?.defaultAction : model['defaultPool'] === undefined ? undefined : { pool: model['defaultPool'] };
    action = typeof da === 'object' && da !== null ? String((da as { pool: unknown }).pool) : '';
    loaded = key;
  });

  const ready = $derived(filled(bind) && filled(port, portError) && (!hasPool || isHttp || action !== ''));
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
      };
    } catch (e) {
      problem = e instanceof Error ? e.message : String(e);
      return;
    }
    void desk.updateListener(key, edit).then(after(resourcePath('listener', key)));
  };
  const reset = (): void => { loaded = undefined; };
</script>

{#if model !== undefined}
  <Writable>
    <Form note="저장하면 커밋해요. 트래픽은 적용 대기에서 적용해야 바뀌어요." onsubmit={save}>
      <FormSection title="기본">
        <FormRow label="프로토콜" help="프로토콜은 바꿀 수 없어요."><TextInput value={protocol} disabled /></FormRow>
        <FormRow label="바인드 주소" for="le-bind" required help={bindHelp(bind)}><TextInput id="le-bind" bind:value={bind} /></FormRow>
        <FormRow label="포트" for="le-port" required error={portError(port)}>
          <TextInput id="le-port" bind:value={port} invalid={portError(port) !== undefined} inputmode="numeric" width="120px" />
        </FormRow>
        <FormRow label="활성화" help="끄면 소켓을 열지 않아요."><Switch bind:checked={enabled}>켜짐</Switch></FormRow>
      </FormSection>
      {#if hasPool}
        <FormSection title="동작">
          <FormRow label="기본 동작" required>
            <Select label="기본 동작" bind:value={action} options={choices} placeholder="풀을 골라요" width="100%" />
          </FormRow>
        </FormSection>
      {/if}
      <SourceAllowSection bind:value={allow} {port} http={isHttp} />
      {#if problem !== undefined}<Banner tone="danger">{problem}</Banner>{/if}
      {#snippet actions()}
        <Button variant="primary" type="submit" loading={desk.editing} disabled={!ready}>{desk.editing ? '저장 중' : '저장'}</Button>
        <Button onclick={reset} disabled={desk.editing}>되돌리기</Button>
        <Button variant="text" href={`/traffic/listener/${encodeURIComponent(key)}`}>취소</Button>
      {/snippet}
    </Form>
  </Writable>
{/if}

<script lang="ts">
  /**
   * 백엔드 설정 폼 — 시안의 「기본」 구획: 이름 · 풀 · 호스트 · 포트 · 가중치.
   *
   * `put` 은 통째로 갈아 끼운다. 그래서 head 의 그 백엔드를 바탕으로 이 칸만 덮는다 — 폼에 없는 칸
   * (`softMaxConns` · `isBackup`)은 그대로 싣는다. 드레인은 설정이 아니다 — 개요의 헬스 카드에서 바로 건다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { itemOf, resourcePath } from '@web/resources';
  import { Button, Form, FormRow, FormSection, Select, TextInput } from '#lib/ui';
  import { after } from '#lib/after';
  import { filled, portError, weightError } from '#lib/forms/checks';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, 'backend', key));
  const pools = $derived(desk.pools.rows.map((p) => ({ value: p.key, hint: p.protocolClass })));

  let pool = $state<string | undefined>();
  let host = $state('');
  let port = $state('');
  let weight = $state('');
  let loaded = $state<string | undefined>();

  // head 값으로 한 번 채운다. 그 뒤 스트림이 모델을 바꿔도 입력 중인 값을 덮지 않는다.
  $effect(() => {
    if (item === undefined || loaded === key) return;
    pool = typeof item['pool'] === 'string' ? item['pool'] : undefined;
    host = String(item['host'] ?? '');
    port = String(item['port'] ?? '');
    weight = String(item['weight'] ?? '1');
    loaded = key;
  });

  const ready = $derived(pool !== undefined && filled(host) && filled(port, portError) && filled(weight, weightError));
  const moved = $derived(item !== undefined && pool !== undefined && pool !== item['pool']);
  const save = (): void => {
    if (!ready || desk.editing || item === undefined || pool === undefined) return;
    const { key: _k, ...rest } = item;
    void desk.putResource('backend', key, { ...rest, pool, host: host.trim(), port: Number(port), weight: Number(weight) })
      .then(after(resourcePath('backend', key)));
  };
  const reset = (): void => { loaded = undefined; };
</script>

{#if item !== undefined}
  <Writable target>
    <Form note="저장하면 커밋해요. 트래픽은 적용 대기에서 적용해야 바뀌어요." onsubmit={save}>
      <FormSection title="기본">
        <FormRow label="이름" help="이름은 바꿀 수 없어요."><TextInput value={key} disabled /></FormRow>
        <FormRow label="풀" required help={moved ? '▲ 다른 풀로 옮겨요. 지금 풀에서는 빠져요.' : undefined}>
          <Select label="풀" bind:value={pool} options={pools} placeholder="풀을 골라요" width="100%" />
        </FormRow>
        <FormRow label="호스트" for="bs-host" required>
          <TextInput id="bs-host" bind:value={host} autocomplete="off" />
        </FormRow>
        <FormRow label="포트" for="bs-port" required error={portError(port)}>
          <TextInput id="bs-port" bind:value={port} invalid={portError(port) !== undefined} inputmode="numeric" width="120px" />
        </FormRow>
        <FormRow label="가중치" for="bs-weight" required error={weightError(weight)} help="클수록 요청을 더 받아요.">
          <TextInput id="bs-weight" bind:value={weight} invalid={weightError(weight) !== undefined} inputmode="numeric" width="120px" />
        </FormRow>
      </FormSection>
      {#snippet actions()}
        <Button variant="primary" type="submit" loading={desk.editing} disabled={!ready}>{desk.editing ? '저장 중' : '저장'}</Button>
        <Button onclick={reset} disabled={desk.editing}>되돌리기</Button>
      {/snippet}
    </Form>
  </Writable>
{/if}

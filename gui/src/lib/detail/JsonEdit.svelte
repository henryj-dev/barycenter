<script lang="ts">
  /**
   * 설정 수정 — **JSON 으로 통째로** (리스너 말고 모든 리소스, 2026-10-30).
   *
   * 리소스마다 폼을 따로 짜기 전까지 쓰는 정직한 길이다. head 의 값을 그대로 펴 두고, 고친
   * 것을 `put` 으로 올린다. 모양·참조 검사는 저장소가 한다 — 틀리면 그 말을 셸 배너가 보인다.
   * JSON 자체가 틀린 것만 여기서 잡는다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { RESOURCES, itemOf, type ResourceKind, resourcePath } from '@web/resources';
  import { Button, Form, FormRow, FormSection, TextArea } from '#lib/ui';
  import { after } from '#lib/after';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  let { kind }: { kind: ResourceKind } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, kind, key));
  let text = $state('');
  let loaded = $state<string | undefined>();

  // head 값으로 한 번 채운다. 그 뒤 스트림이 모델을 바꿔도 고치던 글을 덮지 않는다.
  $effect(() => {
    if (item === undefined || loaded === key) return;
    const { key: _k, ...body } = item as Record<string, unknown>;
    text = JSON.stringify(body, null, 2);
    loaded = key;
  });

  /** 저장 전에 보는 것 — JSON 인가, 객체인가. 맞으면 undefined. */
  const problem = $derived.by((): string | undefined => {
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch (e) {
      return `JSON 이 아니에요: ${e instanceof Error ? e.message : String(e)}`;
    }
    return typeof body !== 'object' || body === null || Array.isArray(body) ? '객체여야 해요 — { … }' : undefined;
  });
  const save = (): void => {
    if (problem !== undefined || desk.editing) return;
    void desk.putResource(kind, key, JSON.parse(text) as Record<string, unknown>).then(after(resourcePath(kind, key)));
  };
  const reset = (): void => { loaded = undefined; };
</script>

<Writable>
  <Form note="저장하면 커밋해요. 트래픽은 적용 대기에서 적용해야 바뀌어요." onsubmit={save}>
    <FormSection title="정의" hint="key 를 뺀 JSON">
      <FormRow label={RESOURCES[kind].label} for="je-text" error={problem} help="모양이 틀리면 저장소가 거절하고 그 이유를 위에 띄워요.">
        <TextArea id="je-text" bind:value={text} invalid={problem !== undefined} rows={18} />
      </FormRow>
    </FormSection>
    {#snippet actions()}
      <Button variant="primary" type="submit" loading={desk.editing} disabled={problem !== undefined}>{desk.editing ? '저장 중' : '저장'}</Button>
      <Button onclick={reset} disabled={desk.editing}>되돌리기</Button>
    {/snippet}
  </Form>
</Writable>

<script lang="ts">
  /**
   * HTTP 라우트를 URL 로 다시 만든다 (시안: 「URL로 다시 만들기」).
   *
   * 라우트의 리스너·호스트·경로는 그대로 두고 대상을 새 URL 로 바꾼다. 이름이 같은 풀과
   * `<이름>-1` 백엔드를 만들거나 덮는다 — 펴는 규칙은 빠른 프록시와 같다(`proxyFromUrlPatch`).
   * 덮는 것이 있으면 미리 말하고, 확인 표시를 해야 저장한다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { proxyFromUrlPatch } from '@web/edit';
  import { itemOf } from '@web/resources';
  import { Badge, Button, Card, Checkbox, DescriptionList, FieldMessage, Form, FormRow, FormSection, TextInput } from '#lib/ui';
  import { after } from '#lib/after';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const route = $derived(itemOf(desk.model, 'httpRoute', key));
  let url = $state('');
  let confirmed = $state(false);
  const input = $derived(route === undefined ? undefined : {
    name: key,
    url: url.trim(),
    listener: String(route['listener']),
    hosts: Array.isArray(route['hosts']) ? route['hosts'] as string[] : [],
    ...(typeof route['pathPrefix'] === 'string' ? { pathPrefix: route['pathPrefix'] } : {}),
  });
  const preview = $derived.by((): { ops: { kind: string; key: string }[]; error?: string } => {
    if (input === undefined || input.url === '') return { ops: [], error: '새 URL 을 넣으면 만들 리소스가 여기 보여요.' };
    try {
      return { ops: proxyFromUrlPatch(input).map((o) => ({ kind: o.kind, key: o.key })) };
    } catch (e) {
      return { ops: [], error: e instanceof Error ? e.message : String(e) };
    }
  });
  /** 이 라우트 자신은 대상만 바뀐다. 다른 것은 있으면 덮고, 없으면 만든다. */
  const fate = (o: { kind: string; key: string }): 'self' | 'over' | 'new' =>
    (o.kind === 'httpRoute' && o.key === key ? 'self'
      : (o.kind === 'pool' || o.kind === 'backend') && itemOf(desk.model, o.kind, o.key) !== undefined ? 'over' : 'new');
  const ready = $derived(confirmed && preview.error === undefined && !desk.editing);
</script>

{#if route !== undefined && input !== undefined}
  <Writable>
    <Form note="저장하면 커밋해요. 트래픽은 적용 대기에서 적용해야 바뀌어요." onsubmit={() => { if (ready) void desk.proxyFromUrl(input).then(after); }}>
      <Card title="그대로 두는 것">
        <DescriptionList items={[
          { label: '리스너', value: String(route['listener']), mono: true },
          { label: '호스트', value: input.hosts.join(', ') || '(없음)', mono: true },
          { label: '경로', value: input.pathPrefix ?? '/', mono: true },
        ]} />
      </Card>
      <FormSection title="새 대상">
        <FormRow label="대상 URL" for="rb-url" required help="대상만 바뀌어요.">
          <TextInput id="rb-url" bind:value={url} autocomplete="off" placeholder="http://10.0.0.5:8080/" />
        </FormRow>
      </FormSection>
      <Card title="만들거나 덮을 리소스">
        {#if preview.error !== undefined}
          <FieldMessage>{preview.error}</FieldMessage>
        {:else}
          {#each preview.ops as o (o.kind + o.key)}
            <div class="op">
              <span class="kind">{o.kind}</span><code>{o.key}</code>
              {#if fate(o) === 'self'}<Badge tone="info" icon={null}>대상을 바꿔요</Badge>
              {:else if fate(o) === 'over'}<Badge tone="warn">이미 있어요 — 덮어요</Badge>
              {:else}<Badge tone="ok" icon="＋">새로 만들어요</Badge>{/if}
            </div>
          {/each}
        {/if}
      </Card>
      <Checkbox bind:checked={confirmed}>위 영향을 확인했어요</Checkbox>
      {#snippet actions()}
        <Button variant="primary" type="submit" loading={desk.editing} disabled={!ready}>확인</Button>
      {/snippet}
    </Form>
  </Writable>
{/if}

<style>
  .op { display: flex; gap: 10px; align-items: center; padding: 3px 0; font: var(--t-small); }
  .kind { color: var(--tx2); min-width: 120px; }
  code { font-family: var(--mono); color: var(--tx); }
</style>

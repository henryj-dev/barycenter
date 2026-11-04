<script lang="ts">
  /**
   * HTTP 라우트를 URL 로 다시 만든다 (시안: 「URL로 다시 만들기」).
   *
   * 라우트의 리스너·호스트·경로는 그대로 두고 대상을 새 URL 로 바꾼다. 이름이 같은 풀과
   * `<이름>-1` 백엔드를 만들거나 덮는다 — 펴는 규칙은 빠른 프록시와 같다(`proxyFromUrlPatch`).
   * 덮는 것이 있으면 미리 말하고, 확인 표시를 해야 저장한다.
   *
   * 시안처럼 **예시 요청이 어디로 가나**를 미리 보인다 — 맞은 경로 접두사를 URL 경로로 갈아 새 대상에 붙인다(`rewritePrefix`).
   * 끝의 `/` 가 경로 접두사와 URL 경로에서 다르면 경로가 붙거나 겹친다 — patch 빌더가 거절하는 것을 칸 아래에서 먼저 말한다.
   * 다시 만들면 라우트 몸통을 새로 짓는다(`proxyFromUrlPatch`) — 출발지 규칙 · 우선순위 · WebSocket · 요청 헤더가 있으면
   * 사라진다는 것을 미리 말한다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { proxyFromUrlPatch } from '@web/edit';
  import { itemOf, resourcePath } from '@web/resources';
  import { Badge, Banner, Button, Card, Checkbox, DescriptionList, FieldMessage, Form, FormRow, FormSection, TextInput } from '#lib/ui';
  import { exampleRequest, matchPrefix, rewritePath, slashMismatch } from '#lib/forms/rewrite';
  import { after } from '#lib/after';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const route = $derived(itemOf(desk.model, 'httpRoute', key));
  let url = $state('');
  let confirmed = $state(false);
  let exPath = $state('');
  const input = $derived(route === undefined ? undefined : {
    name: key,
    url: url.trim(),
    listener: String(route['listener']),
    hosts: Array.isArray(route['hosts']) ? route['hosts'] as string[] : [],
    ...(typeof route['pathPrefix'] === 'string' ? { pathPrefix: route['pathPrefix'] } : {}),
    // 경로가 여럿인 라우트도 그대로 둔다 (2026-11-02) — 빠뜨리면 다시 만들 때 `/` 하나가 된다.
    ...(Array.isArray(route['pathPrefixes']) ? { pathPrefixes: route['pathPrefixes'] as string[] } : {}),
  });
  const preview = $derived.by((): { ops: { kind: string; key: string }[]; error?: string } => {
    if (input === undefined || input.url === '') return { ops: [], error: '새 URL 을 넣으면 만들 리소스가 여기 보여요.' };
    try {
      return { ops: proxyFromUrlPatch(input).map((o) => ({ kind: o.kind, key: o.key })) };
    } catch (e) {
      return { ops: [], error: e instanceof Error ? e.message : String(e) };
    }
  });
  const paths = $derived(input === undefined ? ['/'] : input.pathPrefixes ?? [input.pathPrefix ?? '/']);
  /** URL 을 읽을 수 있으면 출처(`https://host[:port]`)와 경로. 못 읽으면 `undefined` — 오류는 미리보기가 말한다. */
  const target = $derived.by((): { origin: string; path: string } | undefined => {
    try {
      const u = new URL(url.trim());
      return u.protocol === 'http:' || u.protocol === 'https:' ? { origin: u.origin, path: u.pathname === '' ? '/' : u.pathname } : undefined;
    } catch { return undefined; }
  });
  const slashErr = $derived(target !== undefined && paths.some((p) => slashMismatch(p, target.path))
    ? '끝의 /가 URL 경로와 같아야 해요. 다르면 경로가 붙거나 겹쳐요.' : undefined);
  const req = $derived(exPath.trim() === '' ? exampleRequest(paths) : exPath.trim());
  const hit = $derived(matchPrefix(paths, req));
  // `/` → `/` 는 바꾸지 않는다(patch 빌더와 같다).
  const outUrl = $derived(target === undefined || hit === undefined ? undefined
    : target.origin + (rewritePath(hit, target.path === '/' && paths.every((p) => p === '/') ? '' : target.path, req) ?? ''));
  /** 다시 만들면 사라지는 것 — 라우트 몸통을 새로 짓는다. */
  const lost = $derived.by((): string[] => {
    if (route === undefined) return [];
    const a = (typeof route['action'] === 'object' && route['action'] !== null ? route['action'] : {}) as Record<string, unknown>;
    const rules = Array.isArray(route['sourceRules']) ? route['sourceRules'].length : 0;
    const heads = Array.isArray(a['requestHeaders']) ? a['requestHeaders'].length : 0;
    return [
      ...(rules > 0 ? [`출발지 규칙 ${rules}개`] : []),
      ...(Number(route['priority'] ?? 0) !== 0 ? [`우선순위 ${String(route['priority'])}`] : []),
      ...(a['websocket'] === true ? ['WebSocket'] : []),
      ...(heads > 0 ? [`요청 헤더 ${heads}개(Host 하나로 바뀌어요)`] : []),
    ];
  });

  /** 이 라우트 자신은 대상만 바뀐다. 다른 것은 있으면 덮고, 없으면 만든다. */
  const fate = (o: { kind: string; key: string }): 'self' | 'over' | 'new' =>
    (o.kind === 'httpRoute' && o.key === key ? 'self'
      : (o.kind === 'pool' || o.kind === 'backend') && itemOf(desk.model, o.kind, o.key) !== undefined ? 'over' : 'new');
  const ready = $derived(confirmed && preview.error === undefined && slashErr === undefined && !desk.editing);
</script>

{#if route !== undefined && input !== undefined}
  <Writable target>
    <Form note="저장하면 커밋해요. 트래픽은 적용 대기에서 적용해야 바뀌어요." onsubmit={() => { if (ready) void desk.proxyFromUrl(input).then(after(resourcePath('httpRoute', key))); }}>
      <Card title="그대로 두는 것">
        <DescriptionList items={[
          { label: '리스너', value: String(route['listener']), mono: true },
          { label: '호스트', value: input.hosts.join(', ') || '(없음)', mono: true },
          { label: '경로', value: input.pathPrefixes?.join(', ') ?? input.pathPrefix ?? '/', mono: true },
        ]} />
      </Card>
      <FormSection title="새 대상">
        <FormRow label="대상 URL" for="rb-url" required error={slashErr} help="대상만 바뀌어요. URL 경로가 맞은 경로 접두사를 대신해요.">
          <TextInput id="rb-url" bind:value={url} invalid={slashErr !== undefined} autocomplete="off" placeholder="http://10.0.0.5:8080/" />
        </FormRow>
        <FormRow label="예시 요청" for="rb-ex" help={target === undefined ? 'URL 을 넣으면 이 요청이 어디로 가는지 보여요.'
          : outUrl === undefined ? '이 경로는 접두사와 맞지 않아요. 라우트에 걸리지 않아요.'
            : `접두사 ${hit}를 ${target.path}로 바꿔 보내요.`}>
          <div class="pv">
            <TextInput id="rb-ex" bind:value={exPath} autocomplete="off" placeholder={exampleRequest(paths)} />
            <span class="arrow" aria-hidden="true">→</span>
            <code class="out" class:miss={target !== undefined && outUrl === undefined} aria-label="백엔드로 가는 URL">{outUrl ?? '—'}</code>
          </div>
        </FormRow>
      </FormSection>
      {#if lost.length > 0}
        <Banner tone="warn">다시 만들면 라우트를 새로 지어서 이것이 사라져요: {lost.join(' · ')}. 필요하면 만든 뒤 설정에서 다시 넣어요.</Banner>
      {/if}
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
  .pv { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .pv :global(input) { flex: 1 1 200px; min-width: 0; }
  .arrow { color: var(--tx3); }
  .out { overflow-wrap: anywhere; }
  .out.miss { color: var(--warn); }
  code { font-family: var(--mono); color: var(--tx); }
</style>

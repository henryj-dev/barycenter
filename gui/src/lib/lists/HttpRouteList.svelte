<script lang="ts">
  /**
   * HTTP 라우트 목록 — 시안 `page === 'routes'`. 라우트 하나가 한 줄이다. 경로가 여럿이면 첫 경로 + 「+N」 배지이고,
   * 마우스를 올리면 전체가 보인다. 출발지 규칙 · 이 라우트의 요청 헤더는 수 배지다.
   *
   * 「평가 순서」 는 **엔진이 실제로 평가하는 순서**다(`desk.routes.order` — 매치 클래스 → 우선순위 → 경로 길이). 호스트 ·
   * 경로가 여럿인 라우트는 엔진이 여러 번 보므로 가장 먼저 보는 자리를 적는다. 줄도 그 순서로 늘어놓는다.
   * 더 높은 클래스의 라우트가 먼저 잡는 라우트(`priority_inversion`)는 「#n · 가려짐」 경고 배지이고, 마우스를 올리면 이유다.
   * 가림 · 오류는 위에 배너로도 먼저 말한다.
   * 행을 누르면 아래에 분할 상세가 열린다(`ListSplit`) — 풀로 보내는 라우트는 「URL로 다시 만들기」 도 있다(시안).
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { itemsOf, resourcePath } from '@web/resources';
  import { Badge, Banner, Button, DataTable, type Column, type MenuItem } from '#lib/ui';
  import { usePageActions } from '#lib/shell/page-actions.svelte.ts';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import WriteNote from '#lib/global/WriteNote.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import ListSplit from '#lib/detail/ListSplit.svelte';
  import DeleteConfirm from './DeleteConfirm.svelte';
  import PendingMark from './PendingMark.svelte';
  import RouteSegments from './RouteSegments.svelte';
  import { routeOrder } from './route-order';

  type Act = { kind: string; pool?: string; websocket?: boolean; to?: string; status?: number; rewritePrefix?: string; requestHeaders?: unknown[] };
  type Row = {
    key: string; listener: string; hosts: string; paths: string[]; priority: number; act: Act;
    rules: number; headers: number; ord: number | undefined; shadow: string | undefined;
  };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  // 쓸 수 없으면(지역을 안 골랐다 · 팔로워 · 고른 지역과 연락 없음) 만들기 · 수정 · 삭제를 안 보인다.
  const ro = $derived(scope?.blocked === true);
  let del = $state<{ kind: 'httpRoute'; key: string } | undefined>();
  let selected = $state<string[]>([]);

  const meta = $derived(routeOrder(desk.routes));

  const rows = $derived<Row[]>(itemsOf(desk.model, 'httpRoute').map((r) => {
    const key = String(r['key']);
    const act = (typeof r['action'] === 'object' && r['action'] !== null ? r['action'] : { kind: '' }) as Act;
    const paths = Array.isArray(r['pathPrefixes']) && r['pathPrefixes'].length > 0 ? (r['pathPrefixes'] as unknown[]).map(String)
      : [typeof r['pathPrefix'] === 'string' ? r['pathPrefix'] : '/'];
    return {
      key, listener: String(r['listener'] ?? ''), act, paths,
      hosts: Array.isArray(r['hosts']) ? (r['hosts'] as unknown[]).map(String).join(', ') : '',
      priority: Number(r['priority'] ?? 0),
      rules: Array.isArray(r['sourceRules']) ? r['sourceRules'].length : 0,
      headers: Array.isArray(act.requestHeaders) ? act.requestHeaders.length : 0,
      ord: meta.ord.get(key), shadow: meta.shadow.get(key),
    };
  }).sort((a, b) => (a.ord ?? Infinity) - (b.ord ?? Infinity) || a.key.localeCompare(b.key)));

  // 시안: 프록시 · redirect 는 글자, reject 만 ✕ 배지다.
  const actText = (a: Act): string => (a.kind === 'proxy' ? `프록시 → ${a.pool ?? ''}${a.websocket === true ? ' · WebSocket' : ''}`
    : a.kind === 'redirect' ? `redirect → ${a.to ?? ''} · ${a.status ?? ''}` : `reject ${a.status ?? ''}`.trim());
  const isProxy = (key: string): boolean => rows.find((r) => r.key === key)?.act.kind === 'proxy';

  const columns: Column<Row>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'listener', label: '리스너', mono: true, sort: (r) => r.listener },
    { key: 'hosts', label: '호스트', mono: true, sort: (r) => r.hosts },
    { key: 'paths', label: '경로 접두사', mono: true, sort: (r) => r.paths.join(' ') },
    { key: 'priority', label: '우선순위', mono: true, align: 'right', sort: (r) => r.priority },
    { key: 'action', label: '동작', mono: true, sort: (r) => actText(r.act) },
    { key: 'rules', label: '출발지 규칙', sort: (r) => r.rules },
    { key: 'headers', label: '요청 헤더', sort: (r) => r.headers },
    { key: 'ord', label: '평가 순서', mono: true, align: 'right', sort: (r) => r.ord ?? Infinity },
  ];
  const menu = (r: Row): MenuItem[] => [
    { label: '상세 페이지 열기', href: resourcePath('httpRoute', r.key) },
    ...(ro ? [] : [
      { label: '수정', href: resourcePath('httpRoute', r.key, 'settings') },
      ...(r.act.kind === 'proxy' ? [{ label: 'URL로 다시 만들기', href: resourcePath('httpRoute', r.key, 'rebuild') }] : []),
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'httpRoute', key: r.key }; } },
    ]),
  ];
  usePageActions(() => (ro ? undefined : create));
</script>

{#snippet create()}
  <Button href="/traffic/route/http/new/group">＋ 경로별 묶음</Button>
  <Button variant="primary" href="/traffic/route/http/new">＋ 만들기</Button>
{/snippet}

<RouteSegments current="http" />
{#each desk.routes.errors as e (e.kind + e.message)}<Banner tone="danger">{e.message}</Banner>{/each}
{#each desk.routes.warnings as w (w.kind + w.message)}<Banner tone="warn">{w.message}</Banner>{/each}
{#snippet rebuild(key: string)}
  {#if !ro && isProxy(key)}<Button size="sm" href={resourcePath('httpRoute', key, 'rebuild')}>URL로 다시 만들기</Button>{/if}
{/snippet}

{#snippet table()}
<WriteNote spaced />
<DataTable label="HTTP 라우트 — 엔진이 보는 순서" {rows} rowKey={(r) => r.key} {columns} loading={!desk.live} bind:selected
  search={{ placeholder: '이름·호스트·경로·리스너로 찾기', match: (r, q) => `${r.key} ${r.hosts} ${r.paths.join(' ')} ${r.listener}`.toLowerCase().includes(q) }}
  emptyTitle="HTTP 라우트가 없어요" emptyBody="호스트와 경로로 요청을 풀이나 동작에 보내요."
  onopen={(r) => { void goto(resourcePath('httpRoute', r.key)); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}<a href={resourcePath('httpRoute', r.key)}>{r.key}</a><PendingMark kind="httpRoute" key={r.key} />
    {:else if c.key === 'listener'}<a class="sub" href={resourcePath('listener', r.listener)}>{r.listener}</a>
    {:else if c.key === 'paths'}
      <span title={r.paths.length > 1 ? r.paths.join('\n') : undefined}>{r.paths[0]}{#if r.paths.length > 1}<span class="more"><Badge tone="neutral" icon={null}>+{r.paths.length - 1}</Badge></span>{/if}</span>
    {:else if c.key === 'action'}
      {#if r.act.kind === 'reject'}<Badge tone="danger" icon="✕">{actText(r.act)}</Badge>
      {:else if r.act.kind === 'redirect'}{actText(r.act)}
      {:else}{actText(r.act)}{#if r.act.rewritePrefix !== undefined}<span class="sub"> · 경로 → {r.act.rewritePrefix}</span>{/if}{/if}
    {:else if c.key === 'rules'}
      {#if r.rules > 0}<Badge tone="info" icon="↳">출발지 규칙 {r.rules}</Badge>{:else}<span class="none">—</span>{/if}
    {:else if c.key === 'headers'}
      {#if r.headers > 0}<Badge tone="info" icon="＋">헤더 {r.headers}</Badge>{:else}<span class="none">—</span>{/if}
    {:else if c.key === 'ord'}
      {#if r.shadow !== undefined}<Badge tone="warn" title={r.shadow}>#{r.ord ?? '—'} · 가려짐</Badge>
      {:else}#{r.ord ?? '—'}{/if}
    {:else}{String(r[c.key as keyof Row])}{/if}
  {/snippet}
</DataTable>
{/snippet}

<ListSplit kind="httpRoute" bind:selected {table} actions={rebuild} />
<p class="note">평가 순서는 엔진이 맞춰 보는 순서예요. 정확 일치 → 와일드카드 → 정규식 순서이고, 같은 클래스 안에서만 우선순위가 뜻이 있어요.</p>
<DeleteConfirm bind:target={del} />

<style>
  .sub { color: var(--tx2); }
  .none { color: var(--tx3); }
  .more { margin-left: 6px; }
  .note { margin: 0; color: var(--tx3); font: var(--t-cap); }
</style>

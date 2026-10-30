<script lang="ts">
  /**
   * HTTP 라우트 목록 — 시안 §5.3. **엔진이 실제로 평가하는 순서**대로 늘어놓는다(# 열). 호스트가 여럿인
   * 라우트는 호스트마다 한 줄이다 — 엔진이 그렇게 본다. 가림 · 오류는 위에 배너로 먼저 말한다.
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { resourcePath } from '@web/resources';
  import { Badge, Banner, Button, DataTable, type Column, type MenuItem } from '#lib/ui';
  import { usePageActions } from '#lib/shell/page-actions.svelte.ts';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import DeleteConfirm from './DeleteConfirm.svelte';
  import RouteSegments from './RouteSegments.svelte';

  type Row = { id: string; n: number; key: string; listener: string; host: string; path: string; cls: string; priority: number; action: string };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const ro = $derived(scope?.readOnly === true);
  let del = $state<{ kind: 'httpRoute'; key: string } | undefined>();

  const rows = $derived<Row[]>(desk.routes.order.map((r, i) => ({
    id: `${r.key}|${r.host}|${r.pathPrefix}`, n: i + 1, key: r.key, listener: r.listener, host: r.host,
    path: r.pathPrefix, cls: r.matchClass, priority: r.priority, action: r.action,
  })));
  const columns: Column<Row>[] = [
    { key: 'n', label: '#', mono: true, align: 'right', width: '48px', sort: (r) => r.n },
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'listener', label: '리스너', mono: true, sort: (r) => r.listener },
    { key: 'host', label: '호스트 · 경로', mono: true, sort: (r) => `${r.host}${r.path}` },
    { key: 'cls', label: '매치 클래스', mono: true, muted: true, sort: (r) => r.cls },
    { key: 'priority', label: '우선순위', mono: true, align: 'right', sort: (r) => r.priority },
    { key: 'action', label: '동작', mono: true, sort: (r) => r.action },
  ];
  const menu = (r: Row): MenuItem[] => [
    { label: '상세를 봐요', href: resourcePath('httpRoute', r.key) },
    ...(ro ? [] : [
      { label: '수정해요', href: resourcePath('httpRoute', r.key, 'settings') },
      { label: 'URL로 다시 만들어요', href: resourcePath('httpRoute', r.key, 'rebuild') },
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'httpRoute', key: r.key }; } },
    ]),
  ];
  usePageActions(() => (ro ? undefined : create));
</script>

{#snippet create()}<Button variant="primary" href="/traffic/route/http/new">＋ 생성</Button>{/snippet}

<RouteSegments current="http" />
{#each desk.routes.errors as e (e.kind + e.message)}<Banner tone="danger">{e.message}</Banner>{/each}
{#each desk.routes.warnings as w (w.kind + w.message)}<Banner tone="warn">{w.message}</Banner>{/each}
<DataTable label="HTTP 라우트 — 엔진이 보는 순서" {rows} rowKey={(r) => r.id} {columns} loading={!desk.live}
  search={{ placeholder: '이름·호스트·리스너로 찾기', match: (r, q) => `${r.key} ${r.host}${r.path} ${r.listener}`.toLowerCase().includes(q) }}
  emptyTitle="HTTP 라우트가 없어요" emptyBody="호스트와 경로로 요청을 풀이나 동작에 보내요."
  onopen={(r) => { void goto(resourcePath('httpRoute', r.key)); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}<a href={resourcePath('httpRoute', r.key)}>{r.key}</a>
    {:else if c.key === 'listener'}<a class="sub" href={resourcePath('listener', r.listener)}>{r.listener}</a>
    {:else if c.key === 'host'}{r.host}<span class="sub">{r.path}</span>
    {:else if c.key === 'action'}
      {#if r.action.startsWith('reject')}<Badge tone="danger" icon="⊘">{r.action}</Badge>
      {:else if r.action.startsWith('redirect')}<Badge tone="info" icon="↪">{r.action}</Badge>
      {:else}{r.action}{/if}
    {:else}{String(r[c.key as keyof Row])}{/if}
  {/snippet}
</DataTable>
<p class="note">위에서 아래로 엔진이 맞춰 봐요. 정확 일치 → 와일드카드 → 정규식 순서이고, 같은 클래스 안에서만 우선순위가 뜻이 있어요.</p>
<DeleteConfirm bind:target={del} />

<style>
  .sub { color: var(--tx2); }
  .note { margin: 0; color: var(--tx3); font: var(--t-cap); }
</style>

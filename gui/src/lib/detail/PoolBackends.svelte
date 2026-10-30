<script lang="ts">
  /** 풀의 소속 백엔드 — 주소 · 가중치 · 헬스 · 트래픽 수신. 드레인은 백엔드 목록이나 상세에서 한다. */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import { itemsOf, resourcePath } from '@web/resources';
  import { reasonLabels } from '@web/pools-view';
  import { Badge, Button, DataTable, type Column } from '#lib/ui';
  import Writable from '#lib/global/Writable.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';

  type Row = { key: string; target: string; weight: string; health: string; why?: string };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const rows = $derived<Row[]>(itemsOf(desk.model, 'backend').filter((b) => b['pool'] === key).map((b) => {
    const k = String(b['key']);
    const t = desk.traffic.get(k);
    return {
      key: k,
      target: `${String(b['host'])}:${String(b['port'])}`,
      weight: String(b['weight'] ?? ''),
      health: desk.health.find((h) => h.backendKey === k)?.state ?? 'unknown',
      ...(t?.receivingTraffic === false ? { why: reasonLabels(t.reasons).join(' · ') } : {}),
    };
  }));
  const columns: Column<Row>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'target', label: '주소', mono: true, text: (r) => r.target, sort: (r) => r.target },
    { key: 'weight', label: '가중치', mono: true, align: 'right', text: (r) => r.weight, width: '80px' },
    { key: 'health', label: '헬스', sort: (r) => r.health },
    { key: 'why', label: '트래픽', text: (r) => r.why ?? '받는 중' },
  ];
  const addHref = $derived(`/traffic/backend/new?pool=${encodeURIComponent(key)}`);
</script>

{#snippet cell(r: Row, c: Column<Row>)}
  {#if c.key === 'key'}<a class="lnk" href={resourcePath('backend', r.key)}>{r.key}</a>
  {:else if c.key === 'health'}
    {#if r.health === 'healthy'}<Badge tone="ok">정상</Badge>{:else if r.health === 'unhealthy'}<Badge tone="danger">비정상</Badge>{:else}<Badge>관측 없음</Badge>{/if}
  {:else if c.key === 'why'}
    {#if r.why !== undefined}<Badge tone="warn">{r.why}</Badge>{:else}받는 중{/if}
  {:else}{c.text?.(r) ?? ''}{/if}
{/snippet}

{#snippet toolbar()}
  <Writable><Button size="sm" href={addHref}>＋ 이 풀에 백엔드 넣기</Button></Writable>
{/snippet}

{#snippet emptyAction()}
  <Writable><Button variant="primary" href={addHref}>백엔드를 넣어요</Button></Writable>
{/snippet}

<DataTable
  {rows} rowKey={(r) => r.key} {columns} {cell} {toolbar} {emptyAction} label="소속 백엔드"
  onopen={(r) => { void goto(resourcePath('backend', r.key)); }}
  emptyTitle="백엔드가 없어요" emptyBody="이 풀로 가는 요청은 실패해요." minHeight="0"
/>

<style>
  .lnk { color: var(--accent); font-family: var(--mono); text-decoration: none; }
  .lnk:hover { text-decoration: underline; }
</style>

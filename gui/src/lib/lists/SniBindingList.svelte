<script lang="ts">
  /** SNI 바인딩 목록 — 시안 §5.3. 이름 · 리스너 · 호스트 · 인증서. 없는 인증서를 가리키면 표시한다. */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { itemOf, itemsOf, resourcePath } from '@web/resources';
  import { Badge, Button, DataTable, type Column, type MenuItem } from '#lib/ui';
  import { usePageActions } from '#lib/shell/page-actions.svelte.ts';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import DeleteConfirm from './DeleteConfirm.svelte';

  type Row = { key: string; listener: string; hosts: string; cert: string; certMissing: boolean };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const ro = $derived(scope?.readOnly === true);
  let del = $state<{ kind: 'sniBinding'; key: string } | undefined>();

  const rows = $derived<Row[]>(itemsOf(desk.model, 'sniBinding').map((b) => ({
    key: String(b['key']), listener: String(b['listener']),
    hosts: Array.isArray(b['hosts']) ? (b['hosts'] as string[]).join(', ') : '',
    cert: String(b['certificate']), certMissing: itemOf(desk.model, 'certificate', String(b['certificate'])) === undefined,
  })));
  const columns: Column<Row>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'listener', label: '리스너', mono: true, sort: (r) => r.listener },
    { key: 'hosts', label: '호스트', mono: true, sort: (r) => r.hosts },
    { key: 'cert', label: '인증서', mono: true, sort: (r) => r.cert },
  ];
  const menu = (r: Row): MenuItem[] => [
    { label: '상세를 봐요', href: resourcePath('sniBinding', r.key) },
    ...(ro ? [] : [
      { label: '수정해요', href: resourcePath('sniBinding', r.key, 'settings') },
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'sniBinding', key: r.key }; } },
    ]),
  ];
  usePageActions(() => (ro ? undefined : create));
</script>

{#snippet create()}<Button variant="primary" href="/tls/sni/new">＋ SNI 바인딩 만들기</Button>{/snippet}

<DataTable label="SNI 바인딩 목록" {rows} rowKey={(r) => r.key} {columns} loading={!desk.live}
  search={{ placeholder: '이름·호스트로 찾기', match: (r, q) => `${r.key} ${r.hosts} ${r.cert}`.toLowerCase().includes(q) }}
  emptyTitle="SNI 바인딩이 없어요" emptyBody="HTTPS 호스트는 바인딩이 있어야 plan 이 돼요."
  onopen={(r) => { void goto(resourcePath('sniBinding', r.key)); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}<a href={resourcePath('sniBinding', r.key)}>{r.key}</a>
    {:else if c.key === 'listener'}<a class="sub" href={resourcePath('listener', r.listener)}>{r.listener}</a>
    {:else if c.key === 'cert'}{#if r.certMissing}<Badge tone="danger">{r.cert} — 없음</Badge>{:else}<a class="sub" href={resourcePath('certificate', r.cert)}>{r.cert}</a>{/if}
    {:else}{String(r[c.key as keyof Row])}{/if}
  {/snippet}
</DataTable>
<DeleteConfirm bind:target={del} />

<style>.sub { color: var(--tx2); }</style>

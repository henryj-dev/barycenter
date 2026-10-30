<script lang="ts">
  /** TLS 정책 목록 — 이름 · 최소 · 최대 버전 · 암호군 · HSTS · SNI-Host 불일치 · 사용처. */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { itemsOf, relationsOf, resourcePath } from '@web/resources';
  import { Badge, Button, DataTable, type Column, type MenuItem } from '#lib/ui';
  import { usePageActions } from '#lib/shell/page-actions.svelte.ts';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import DeleteConfirm from './DeleteConfirm.svelte';

  type Row = { key: string; min: string; max: string; cipher: string; hsts: boolean; mismatch: string; used: number };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const ro = $derived(scope?.readOnly === true);
  let del = $state<{ kind: 'tlsPolicy'; key: string } | undefined>();

  const rows = $derived<Row[]>(itemsOf(desk.model, 'tlsPolicy').map((p) => {
    const key = String(p['key']);
    const cp = p['cipherPolicy'];
    return {
      key, min: String(p['minVersion'] ?? ''), max: typeof p['maxVersion'] === 'string' ? p['maxVersion'] : '—',
      cipher: typeof cp === 'string' ? cp : cp === undefined ? '기본' : JSON.stringify(cp),
      hsts: p['hsts'] !== undefined, mismatch: typeof p['sniHostMismatch'] === 'string' ? p['sniHostMismatch'] : '기본',
      used: relationsOf(desk.model, { kind: 'tlsPolicy', key }).usedBy.length,
    };
  }));
  const columns: Column<Row>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'min', label: '최소 버전', mono: true, sort: (r) => r.min },
    { key: 'max', label: '최대 버전', mono: true, muted: true, sort: (r) => r.max },
    { key: 'cipher', label: '암호군', mono: true, muted: true, sort: (r) => r.cipher },
    { key: 'hsts', label: 'HSTS', sort: (r) => (r.hsts ? 1 : 0) },
    { key: 'mismatch', label: 'SNI-Host 불일치', mono: true, muted: true, hidden: true },
    { key: 'used', label: '사용처', align: 'right', mono: true, sort: (r) => r.used },
  ];
  const menu = (r: Row): MenuItem[] => [
    { label: '상세를 봐요', href: resourcePath('tlsPolicy', r.key) },
    ...(ro ? [] : [
      { label: '수정해요', href: resourcePath('tlsPolicy', r.key, 'settings') },
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'tlsPolicy', key: r.key }; } },
    ]),
  ];
  usePageActions(() => (ro ? undefined : create));
</script>

{#snippet create()}<Button variant="primary" href="/tls/policy/new">＋ TLS 정책 만들기</Button>{/snippet}

<DataTable label="TLS 정책 목록" {rows} rowKey={(r) => r.key} {columns} loading={!desk.live}
  emptyTitle="TLS 정책이 없어요" emptyBody="HTTPS 리스너를 열려면 하나가 필요해요."
  onopen={(r) => { void goto(resourcePath('tlsPolicy', r.key)); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}<a href={resourcePath('tlsPolicy', r.key)}>{r.key}</a>
    {:else if c.key === 'min'}TLS {r.min}
    {:else if c.key === 'hsts'}{#if r.hsts}<Badge tone="ok" icon="●">켜짐</Badge>{:else}<span class="sub">꺼짐</span>{/if}
    {:else if c.key === 'used'}{r.used}
    {:else}{String(r[c.key as keyof Row])}{/if}
  {/snippet}
</DataTable>
<DeleteConfirm bind:target={del} />

<style>.sub { color: var(--tx3); }</style>

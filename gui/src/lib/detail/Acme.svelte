<script lang="ts">
  /**
   * 인증서의 ACME — 발급 의도(계정 · 도메인)와 주문 상태.
   * 주문은 스케줄러가 연다. 실패하면 이유(`lastError`)와 시도 횟수를 보인다 — 「왜 아직 안 됐나」 를 물을 자리다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { itemOf } from '@web/resources';
  import { Badge, DataTable, DescriptionList, FieldMessage, type Column, type Tone } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';

  type Order = { id: string; state: string; domains: string[]; attempts: number; lastError: string | null };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const item = $derived(itemOf(desk.model, 'certificate', key));
  const acme = $derived(item?.['acme'] as { account?: string; domains?: string[] } | undefined);
  const hasMaterial = $derived(typeof item?.['materialRef'] === 'string');
  const orders = $derived<Order[]>(desk.acmeOrders.filter((o) => o['certificate'] === key).map((o) => ({
    id: String(o['id']),
    state: String(o['state']),
    domains: Array.isArray(o['domains']) ? (o['domains'] as string[]) : [],
    attempts: typeof o['attempts'] === 'number' ? o['attempts'] : 0,
    lastError: typeof o['lastError'] === 'string' ? o['lastError'] : null,
  })));
  const STATE: Record<string, { tone: Tone; text: string }> = {
    pending: { tone: 'pending', text: '대기' },
    validating: { tone: 'info', text: '검증 중' },
    ready: { tone: 'info', text: '발급 직전' },
    issued: { tone: 'ok', text: '발급됨' },
    failed: { tone: 'danger', text: '실패' },
    abandoned: { tone: 'neutral', text: '그만둠' },
  };
  const columns: Column<Order>[] = [
    { key: 'state', label: '상태', width: '120px', sort: (r) => r.state },
    { key: 'domains', label: '도메인', mono: true, text: (r) => r.domains.join(', ') },
    { key: 'attempts', label: '시도', mono: true, align: 'right', width: '70px', text: (r) => String(r.attempts) },
    { key: 'err', label: '마지막 오류' },
    { key: 'id', label: '주문', mono: true, muted: true, hideable: true, hidden: true, text: (r) => r.id },
  ];
</script>

{#snippet cell(r: Order, c: Column<Order>)}
  {#if c.key === 'state'}
    {@const s = STATE[r.state] ?? { tone: 'neutral' as Tone, text: r.state }}<Badge tone={s.tone}>{s.text}</Badge>
  {:else if c.key === 'err'}
    {#if r.lastError !== null}<span class="err">{r.lastError}</span>{:else}—{/if}
  {:else}{c.text?.(r) ?? ''}{/if}
{/snippet}

{#if acme === undefined}
  <FieldMessage>ACME 로 발급하는 인증서가 아니에요. 자료를 직접 넣었어요.</FieldMessage>
{:else}
  <DescriptionList labelWidth="120px" items={[
    { label: '계정', value: acme.account ?? '—', mono: true },
    { label: '도메인', value: (acme.domains ?? []).join(', '), mono: true },
    { label: '자료', value: hasMaterial ? '발급됨 — 리스너 · SNI 에 걸 수 있어요' : '아직 없음 — 첫 발급을 기다려요', tone: hasMaterial ? 'ok' : 'warn' },
    { label: '자동 갱신', value: '켜짐 — 만료 전에 스케줄러가 다시 받아요' },
  ]} />
  <div class="orders">
    <DataTable rows={orders} rowKey={(r) => r.id} {columns} {cell} label="ACME 주문"
      emptyTitle="주문이 아직 없어요" emptyBody="적용하면 스케줄러가 주문을 열어요. 계정의 CA 등록도 그때 해요." minHeight="0" />
  </div>
{/if}

<style>
  .orders { margin-top: 12px; }
  .err { color: var(--danger); font: var(--t-cap); overflow-wrap: anywhere; }
</style>

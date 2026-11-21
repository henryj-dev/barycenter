<script lang="ts">
  /**
   * TLS › ACME 계정 (2026-11-21) — `GET /api/v1/acme/accounts`. 읽기만 한다.
   *
   * 계정마다: 이름 · CA(운영 / 스테이징) · 디렉터리 주소 · 연락처 · CA 등록 여부 · 이 계정을 쓰는 인증서.
   * 계정 키는 서버가 만들어 시크릿 저장소에 둔다 — 화면은 키를 보지 않는다. CA 등록은 첫 주문 때 데몬이 한다.
   * 계정은 인증서 만들기의 「＋ 새 계정」 에서 만든다. 고치기 · 지우기 창구는 아직 없다.
   */
  import { getContext } from 'svelte';
  import { itemsOf, resourcePath } from '@web/resources';
  import { DataTable, FieldMessage, type Column } from '#lib/ui';
  import { b, m, x } from '#lib/ui/cells.ts';
  import { isStaging } from '#lib/forms/AcmeAccountField.svelte';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { AcmeAccountRow, createDesk } from '#lib/desk.svelte.ts';
  import PickRegion from '#lib/ops/PickRegion.svelte';

  type Row = AcmeAccountRow & { usedBy: string[] };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const aggregate = $derived(scope?.mode === 'global' && scope.region === undefined);

  let accounts = $state<AcmeAccountRow[] | undefined>();
  let failed = $state(false);
  const load = async (): Promise<void> => {
    const r = await desk.acmeAccounts();
    failed = r === undefined;
    accounts = r;
  };
  $effect(() => {
    void desk.head;
    if (!desk.live || aggregate) return;
    void load();
  });
  const rows = $derived<Row[]>((accounts ?? []).map((a) => ({
    ...a,
    usedBy: itemsOf(desk.model, 'certificate')
      .filter((c) => (c['acme'] as { account?: string } | undefined)?.account === a.key)
      .map((c) => String(c['key'])),
  })));
  const columns: Column<Row>[] = [
    { key: 'key', label: '이름', mono: true, text: (r) => r.key, sort: (r) => r.key, hideable: false },
    { key: 'ca', label: 'CA', value: (r) => (isStaging(r.directoryUrl) ? b('warn', '▲', '스테이징 — 브라우저가 안 믿어요') : b('ok', '●', '운영')), sort: (r) => (isStaging(r.directoryUrl) ? 1 : 0) },
    { key: 'dir', label: '디렉터리', value: (r) => m(r.directoryUrl), hideable: true, hidden: true },
    { key: 'contact', label: '연락처', value: (r) => x(r.contact.map((c) => c.replace(/^mailto:/, '')).join(', ') || '—') },
    { key: 'registered', label: 'CA 등록', value: (r) => (r.registered ? b('ok', '●', '등록됨') : b('pending', '◐', '첫 주문 때 등록해요')), sort: (r) => (r.registered ? 1 : 0) },
    { key: 'used', label: '쓰는 인증서', text: (r) => String(r.usedBy.length), sort: (r) => r.usedBy.length },
  ];
</script>

{#snippet cell(r: Row, c: Column<Row>)}
  {#if c.key === 'used'}
    {#each r.usedBy as k, i (k)}{i > 0 ? ', ' : ''}<a class="mono" href={resourcePath('certificate', k)}>{k}</a>{:else}—{/each}
  {:else}{c.text?.(r) ?? ''}{/if}
{/snippet}

{#if aggregate}
  <PickRegion what="ACME 계정" />
{:else}
  <div class="aa">
    <FieldMessage>계정은 인증서를 만들 때 「＋ 새 계정」 으로 만들어요. 계정 키는 서버의 시크릿 저장소에 있어요 — 여기에 보이지 않아요.</FieldMessage>
    <DataTable {rows} rowKey={(r) => r.id} {columns} {cell} label="ACME 계정"
      loading={accounts === undefined && !failed} error={failed ? 'ACME 계정을 읽지 못했어요.' : undefined} onretry={() => { void load(); }}
      emptyTitle="ACME 계정이 없어요" emptyBody="ACME 로 인증서를 만들면 계정도 함께 만들어요." fill />
  </div>
{/if}

<style>
  .aa { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 12px; }
  .mono { font-family: var(--mono); color: var(--accent); }
</style>

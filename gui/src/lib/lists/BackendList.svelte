<script lang="ts">
  /**
   * 백엔드 목록 — 시안 §4 · §5.3. 이름 · 풀 · 호스트:포트 · 가중치 · 헬스 · 트래픽 수신 · 드레인 · 마지막 관측.
   * 여러 개를 골라 드레인 · 드레인 해제를 한 번에 한다. 드레인은 설정(commit)이 아니다 — 바로 걸린다.
   * 하나를 고르면 아래에 분할 상세가 열린다 — 「트래픽을 받지 않는 이유」 가 거기 있다(시안).
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { itemsOf, resourcePath } from '@web/resources';
  import { trafficMarkOf } from '@web/pools-view';
  import { Badge, Button, DataTable, toast, type Column, type FilterChip, type MenuItem } from '#lib/ui';
  import { usePageActions } from '#lib/shell/page-actions.svelte.ts';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import ListSplit from '#lib/detail/ListSplit.svelte';
  import { HEALTH_MARK, ago, backendHealth, type HealthKind } from '#lib/detail/facts';
  import DeleteConfirm from './DeleteConfirm.svelte';

  type Row = { key: string; pool: string; addr: string; weight: number; health: HealthKind; receiving: boolean | undefined; draining: boolean; why: string[]; seen?: string };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const ro = $derived(scope?.readOnly === true);
  let del = $state<{ kind: 'backend'; key: string } | undefined>();
  let selected = $state<string[]>([]);

  const rows = $derived<Row[]>(itemsOf(desk.model, 'backend').map((b) => {
    const key = String(b['key']);
    const t = desk.traffic.get(key);
    const seen = ago(t?.observedAt);
    return {
      key, pool: String(b['pool']), addr: `${String(b['host'])}:${String(b['port'])}`,
      weight: typeof b['weight'] === 'number' ? b['weight'] : 1,
      health: backendHealth(desk, key),
      receiving: t?.receivingTraffic, draining: t?.reasons.includes('draining') === true,
      // 이유 코드는 사람 말로 바꾼다(제안 #9) — 드레인은 배지가 따로 말하므로 뺀다.
      why: trafficMarkOf(t === undefined ? undefined : { ...t, reasons: t.reasons.filter((x) => x !== 'draining') })?.reasons ?? [],
      ...(seen === undefined ? {} : { seen }),
    };
  }));
  const columns: Column<Row>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'pool', label: '풀', mono: true, sort: (r) => r.pool },
    { key: 'addr', label: '호스트:포트', mono: true, sort: (r) => r.addr },
    { key: 'weight', label: '가중치', mono: true, align: 'right', sort: (r) => r.weight },
    { key: 'health', label: '헬스', sort: (r) => r.health },
    { key: 'receiving', label: '트래픽 수신', sort: (r) => (r.receiving === true ? 1 : 0) },
    { key: 'draining', label: '드레인', sort: (r) => (r.draining ? 1 : 0) },
    { key: 'seen', label: '마지막 관측', muted: true, sort: (r) => r.seen ?? '' },
  ];
  const chips: FilterChip<Row>[] = [
    { key: 'ok', label: '정상', tone: 'ok', match: (r) => r.health === 'healthy' },
    { key: 'bad', label: '비정상', tone: 'danger', match: (r) => r.health === 'unhealthy' },
    { key: 'checking', label: '확인 중', tone: 'info', match: (r) => r.health === 'checking' },
    { key: 'drain', label: '드레인 중', tone: 'drain', match: (r) => r.draining },
    { key: 'none', label: '관측 없음', tone: 'neutral', match: (r) => r.health === 'none' },
  ];
  const drainAll = async (keys: string[], on: boolean): Promise<void> => {
    let n = 0;
    for (const k of keys) if (await (on ? desk.drain(k) : desk.undrain(k))) n++;
    if (n > 0) toast.ok(on ? '드레인했어요' : '드레인을 풀었어요', `${n}개 — 설정이 아니라 바로 걸려요.`);
    selected = [];
  };
  const menu = (r: Row): MenuItem[] => [
    ...(ro ? [] : [
      { label: r.draining ? '드레인 해제' : '드레인', onselect: () => { void drainAll([r.key], !r.draining); } },
    ]),
    { label: '상세 페이지 열기', href: resourcePath('backend', r.key) },
    ...(ro ? [] : [
      { label: '수정', href: resourcePath('backend', r.key, 'settings') },
      { label: '풀에서 빼기…', danger: true, onselect: () => { del = { kind: 'backend', key: r.key }; } },
    ]),
  ];
  usePageActions(() => (ro ? undefined : create));
</script>

{#snippet create()}<Button variant="primary" href="/traffic/backend/new">＋ 생성</Button>{/snippet}

{#snippet table()}
<DataTable label="백엔드 목록" {rows} rowKey={(r) => r.key} {columns} {chips} selectable={!ro} bind:selected pageSize={50}
  loading={!desk.live} search={{ placeholder: '이름·풀·주소로 찾기', match: (r, q) => `${r.key} ${r.pool} ${r.addr}`.toLowerCase().includes(q) }}
  emptyTitle="등록된 백엔드가 없어요" emptyBody="백엔드를 더하면 풀이 트래픽을 받아요."
  onopen={(r) => { void goto(resourcePath('backend', r.key)); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}<a href={resourcePath('backend', r.key)}>{r.key}</a>
    {:else if c.key === 'pool'}<a class="sub" href={resourcePath('pool', r.pool)}>{r.pool}</a>
    {:else if c.key === 'health'}
      {@const m = HEALTH_MARK[r.health]}<Badge tone={m.tone} icon={m.icon}>{m.text}</Badge>
    {:else if c.key === 'receiving'}
      {#if r.receiving === undefined}<span class="muted">모름</span>
      {:else if r.receiving}<Badge tone="ok" icon="●">수신 중</Badge>
      {:else}<span title={r.why.join(' · ')}><Badge tone="neutral" icon="○">수신 안 함</Badge>{#if r.why.length > 0}<span class="warn"> {r.why.join(' · ')}</span>{/if}</span>{/if}
    {:else if c.key === 'draining'}{#if r.draining}<Badge tone="drain" icon="⇣">드레인 중</Badge>{:else}<span class="muted">—</span>{/if}
    {:else if c.key === 'seen'}{r.seen ?? '—'}
    {:else if c.key === 'weight'}{r.weight}
    {:else}{String(r[c.key as keyof Row])}{/if}
  {/snippet}
  {#snippet bulk(keys)}
    <Button size="sm" onclick={() => { void drainAll(keys, true); }}>드레인</Button>
    <Button size="sm" onclick={() => { void drainAll(keys, false); }}>드레인 해제</Button>
  {/snippet}
</DataTable>
{/snippet}

<ListSplit kind="backend" bind:selected {table} />
<DeleteConfirm bind:target={del} />

<style>
  .sub { color: var(--tx2); }
  .muted { color: var(--tx3); }
  .warn { color: var(--warn); }
</style>

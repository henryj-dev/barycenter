<script lang="ts">
  /**
   * 운영 › 백엔드 출처 (2026-11-21) — 출처(`discovery`)가 있는 모든 풀을 한 표로. `GET /api/v1/discovery`.
   *
   * 풀마다: 출처 · 질의 · 상태 · 받은 백엔드 수 · 출처 목록을 쓰는지(정적 사용 중인지) · 마지막 갱신 · 오류.
   * 상태는 이 화면이 붙은 데몬의 러너 것이다(데몬마다 따로 묻는다). 풀을 누르면 풀 상세(「출처에서 받은 백엔드」)로 간다.
   * 15초마다 다시 읽는다. 전체 합산이면 지역을 고르라고 한다.
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { DISCOVERY_SOURCES } from '@web/discovery';
  import { resourcePath } from '@web/resources';
  import { DataTable, FieldMessage, type Column, type FilterChip } from '#lib/ui';
  import { b, m, x } from '#lib/ui/cells.ts';
  import { whenText } from '#lib/ops/audit';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { DiscoveryAll, DiscoveryPoolView, createDesk } from '#lib/desk.svelte.ts';
  import PickRegion from './PickRegion.svelte';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const aggregate = $derived(scope?.mode === 'global' && scope.region === undefined);

  let all = $state<DiscoveryAll | undefined>();
  let failed = $state(false);
  const load = async (): Promise<void> => {
    const r = await desk.discoveryAll();
    failed = r === undefined;
    if (r !== undefined) all = r;
  };
  $effect(() => {
    void desk.head;
    if (!desk.live || aggregate) return;
    void load();
    const t = setInterval(() => { void load(); }, 15_000);
    return () => { clearInterval(t); };
  });

  const STATE: Record<DiscoveryPoolView['state'], { tone: 'ok' | 'pending' | 'danger' | 'warn'; icon: string; text: string }> = {
    ok: { tone: 'ok', icon: '●', text: '받는 중' },
    pending: { tone: 'pending', icon: '◐', text: '아직 답이 없어요' },
    error: { tone: 'danger', icon: '✕', text: '오류' },
    unconfigured: { tone: 'warn', icon: '▲', text: '이 데몬에 출처 설정이 없어요' },
  };
  const label = (s: string): string => DISCOVERY_SOURCES.find((d) => d.value === s)?.label ?? s;
  const columns: Column<DiscoveryPoolView>[] = [
    { key: 'pool', label: '풀', mono: true, text: (r) => r.pool, sort: (r) => r.pool, hideable: false },
    { key: 'source', label: '출처', value: (r) => x(label(r.source)), sort: (r) => r.source },
    { key: 'query', label: '질의', value: (r) => m(r.query), sort: (r) => r.query },
    { key: 'state', label: '상태', value: (r) => { const s = STATE[r.state]; return b(s.tone, s.icon, s.text); }, sort: (r) => r.state },
    { key: 'endpoints', label: '받은 백엔드', align: 'right', value: (r) => m(r.endpoints.length), sort: (r) => r.endpoints.length },
    { key: 'advertised', label: '쓰는 목록', value: (r) => (r.advertised ? b('ok', '●', '출처 목록') : b('neutral', '○', '정적 사용 중')), sort: (r) => (r.advertised ? 1 : 0) },
    { key: 'last', label: '마지막 갱신', value: (r) => x(whenText(r.lastSuccessAt)), sort: (r) => r.lastSuccessAt ?? '' },
    { key: 'error', label: '오류', value: (r) => (r.error === undefined ? x('—') : x(`${r.error.detail} (${r.error.reason})`)), hideable: true },
  ];
  const chips: FilterChip<DiscoveryPoolView>[] = [
    { key: 'error', label: '오류', tone: 'danger', match: (r) => r.state === 'error' },
    { key: 'static', label: '정적 사용 중', tone: 'neutral', match: (r) => !r.advertised },
  ];
</script>

{#snippet cell(r: DiscoveryPoolView, c: Column<DiscoveryPoolView>)}
  {#if c.key === 'pool'}<a class="mono" href={resourcePath('pool', r.pool, 'resources')}>{r.pool}</a>{/if}
{/snippet}

{#if aggregate}
  <PickRegion what="백엔드 출처" />
{:else}
  <div class="dl">
    {#if all !== undefined && !all.enabled}
      <FieldMessage tone="warn">이 데몬은 출처를 묻지 않아요{all.reason === undefined ? '' : ` — ${all.reason}`}. 풀은 정적 백엔드를 써요.</FieldMessage>
    {:else if all?.intervalMs !== undefined}
      <FieldMessage>데몬이 {Math.round(all.intervalMs / 1000)}초마다 출처를 물어요. 지금 물으려면 풀 상세의 「지금 다시 찾기」 를 눌러요.</FieldMessage>
    {/if}
    <DataTable rows={all?.pools ?? []} rowKey={(r) => r.pool} {columns} {cell} {chips} label="백엔드 출처"
      search={{ placeholder: '풀 · 질의로 찾기', match: (r, q) => `${r.pool} ${r.query}`.toLowerCase().includes(q.toLowerCase()) }}
      onopen={(r) => { void goto(resourcePath('pool', r.pool, 'resources')); }}
      loading={all === undefined && !failed} error={failed && all === undefined ? '백엔드 출처를 읽지 못했어요.' : undefined} onretry={() => { void load(); }}
      emptyTitle="출처를 쓰는 풀이 없어요" emptyBody="풀 설정의 「백엔드 출처」 에서 DNS SRV · Consul · Kubernetes · 파일을 고를 수 있어요." fill />
  </div>
{/if}

<style>
  .dl { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 12px; }
  .mono { font-family: var(--mono); color: var(--accent); }
</style>

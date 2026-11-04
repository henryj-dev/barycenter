<script lang="ts">
  /**
   * 리스너 목록 — 시안 §5.3. 이름 · 프로토콜 · 바인드:포트 · 호스트 · 기본 풀 / 동작 · 라우트 수 · 출발지 제한 · 상태 · 활성화.
   * 상태는 적용 대기를 반영한다 — 커밋했지만 적용 안 한 리스너는 「적용하면 열림」, 지울 리스너는 「적용하면 닫힘」.
   * 행을 누르면 아래에 분할 상세가 열린다(시안).
   */
  import { getContext } from 'svelte';
  import { goto } from '$app/navigation';
  import { itemOf, itemsOf, resourcePath } from '@web/resources';
  import type { ListenerMark } from '@web/listeners-view';
  import { after } from '#lib/after';
  import { Badge, Button, DataTable, type Column, type FilterChip, type MenuItem } from '#lib/ui';
  import { usePageActions } from '#lib/shell/page-actions.svelte.ts';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import WriteNote from '#lib/global/WriteNote.svelte';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import ListSplit from '#lib/detail/ListSplit.svelte';
  import { LISTENER_MARK, sourceAllowSummary } from '#lib/detail/facts';
  import DeleteConfirm from './DeleteConfirm.svelte';
  import { listState } from './list-state';

  type Row = {
    id: string; key: string; protocol: string; bind: string; mark: ListenerMark;
    enabled: boolean; allow: { text: string; ranges: number; on: boolean }; action: string; routes: number;
    /** server_name (ADR-VHOST). http · https 만. 비면 그 포트의 기본 리스너다. */
    hosts: string;
    /** HTTPS 가 함께 여는 평문 리다이렉트 포트. */
    redirect?: number;
  };
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  // 쓸 수 없으면(지역을 안 골랐다 · 팔로워 · 고른 지역과 연락 없음) 만들기 · 수정 · 삭제를 안 보인다.
  const ro = $derived(scope?.blocked === true);
  let del = $state<{ kind: 'listener'; key: string } | undefined>();
  let selected = $state<string[]>([]);

  const actionOf = (m: Record<string, unknown> | undefined): string => {
    if (m === undefined) return '—';
    const http = m['http'] as { defaultAction?: unknown } | undefined;
    const da = http?.defaultAction;
    if (m['protocol'] === 'http' || m['protocol'] === 'https') {
      return typeof da === 'object' && da !== null ? String((da as { pool: string }).pool) : '거절';
    }
    if (typeof m['defaultPool'] === 'string') return m['defaultPool'];
    return 'SNI 라우트';
  };
  const rows = $derived<Row[]>(desk.listeners.rows.map((r) => {
    const m = itemOf(desk.model, 'listener', r.key);
    const routeKind = r.protocol === 'tls_passthrough' ? 'passthroughRoute' : 'httpRoute';
    return {
      id: r.key, key: r.key, protocol: r.protocol, bind: `${r.bind}:${r.port}`,
      mark: r.mark, enabled: r.enabled, allow: sourceAllowSummary(desk.model, r.sourceAllow), action: actionOf(m),
      routes: itemsOf(desk.model, routeKind).filter((x) => x['listener'] === r.key).length,
      hosts: r.protocol !== 'http' && r.protocol !== 'https' ? '—'
        : Array.isArray(m?.['hosts']) ? (m['hosts'] as string[]).join(', ') : '기본',
      ...(r.redirect === undefined ? {} : { redirect: r.redirect.port }),
    };
  }));
  const columns: Column<Row>[] = [
    { key: 'key', label: '이름', mono: true, sort: (r) => r.key },
    { key: 'protocol', label: '프로토콜', sort: (r) => r.protocol },
    { key: 'bind', label: '바인드:포트', mono: true, sort: (r) => r.bind },
    { key: 'hosts', label: '호스트', mono: true, text: (r) => r.hosts, sort: (r) => r.hosts },
    { key: 'action', label: '기본 풀 / 동작', mono: true, sort: (r) => r.action },
    { key: 'routes', label: '라우트', align: 'right', mono: true, sort: (r) => r.routes },
    { key: 'allow', label: '출발지 제한', text: (r) => r.allow.text, sort: (r) => r.allow.ranges },
    { key: 'mark', label: '상태', sort: (r) => r.mark },
    { key: 'enabled', label: '활성화', sort: (r) => (r.enabled ? 1 : 0) },
  ];
  const chips: FilterChip<Row>[] = [
    { key: 'stay', label: '서빙 중', tone: 'ok', match: (r) => r.mark === 'stay' },
    { key: 'join', label: LISTENER_MARK.join.text, tone: 'pending', match: (r) => r.mark === 'join' },
    { key: 'off', label: '꺼짐', tone: 'neutral', match: (r) => !r.enabled },
  ];
  const toggle = (key: string): void => {
    const m = itemOf(desk.model, 'listener', key);
    if (m === undefined) return;
    const { key: _k, ...body } = m;
    void desk.putResource('listener', key, { ...body, enabled: m['enabled'] === false }).then(after());
  };
  const menu = (r: Row): MenuItem[] => [
    { label: '상세 페이지 열기', href: resourcePath('listener', r.key) },
    ...(ro ? [] : [
      { label: '수정', href: resourcePath('listener', r.key, 'settings') },
      { label: r.enabled ? '비활성화' : '활성화', onselect: () => toggle(r.key) },
      { label: '삭제…', danger: true, onselect: () => { del = { kind: 'listener', key: r.key }; } },
    ]),
  ];
  usePageActions(() => (ro ? undefined : create));
</script>

{#snippet create()}
  <Button href="/traffic/listener/new/quick">빠른 프록시 만들기</Button>
  <Button variant="primary" href="/traffic/listener/new">＋ 만들기</Button>
{/snippet}

{#snippet table()}
<WriteNote spaced />
<DataTable label="리스너 목록" {rows} rowKey={(r) => r.id} {columns} {chips} {...listState(desk)} bind:selected
  search={{ placeholder: '이름·주소로 찾기', match: (r, q) => `${r.key} ${r.bind} ${r.protocol} ${r.action} ${r.hosts} ${r.redirect ?? ''}`.toLowerCase().includes(q) }}
  emptyTitle="리스너가 없어요" emptyBody="포트를 열면 트래픽을 받아요. 패스스루는 인증서를 제시하지 않아요."
  onopen={(r) => { void goto(resourcePath('listener', r.key)); }} rowMenu={menu}>
  {#snippet cell(r, c)}
    {#if c.key === 'key'}
      <a href={resourcePath('listener', r.key)}>{r.key}</a>
    {:else if c.key === 'protocol'}{r.protocol.toUpperCase().replace('TLS_PASSTHROUGH', 'TLS 패스스루')}
    {:else if c.key === 'bind'}{r.bind}{#if r.redirect !== undefined}<span class="muted" title="HTTP 로 오면 HTTPS 로 301"> · HTTP :{r.redirect} → HTTPS</span>{/if}
    {:else if c.key === 'hosts'}{#if r.hosts === '기본'}<span class="muted">기본</span>{:else}{r.hosts}{/if}
    {:else if c.key === 'routes'}{r.routes}
    {:else if c.key === 'allow'}{#if r.allow.on}<Badge tone="warn" icon="⊘">{r.allow.text}</Badge>{:else}<span class="muted">제한 없음</span>{/if}
    {:else if c.key === 'mark'}
      {@const lm = LISTENER_MARK[r.mark]}<Badge tone={lm.tone} icon={lm.icon}>{lm.text}</Badge>
    {:else if c.key === 'enabled'}{#if r.enabled}<span class="on">● 켜짐</span>{:else}<span class="muted">○ 꺼짐</span>{/if}
    {:else}{#if r.action === '거절'}<span class="muted">거절</span>{:else}{r.action}{/if}{/if}
  {/snippet}
</DataTable>
{/snippet}

<ListSplit kind="listener" bind:selected {table} />
<DeleteConfirm bind:target={del} />

<style>
  .muted { color: var(--tx3); }
  .on { color: var(--tx2); }
</style>

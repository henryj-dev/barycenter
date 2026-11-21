<script lang="ts">
  /**
   * 운영 › 소켓 (2026-11-21) — 설정이 차지하는 소켓(전송 · 주소 · 포트)과 그것을 쓰는 리스너. `GET /api/v1/sockets`.
   *
   * 진짜 충돌은 검증기가 커밋 전에 막는다(`socket_conflict`). 이 화면은 헷갈리기 쉬운 둘을 짚는다(`socketViews`):
   * 「같이 씀」(켜진 리스너 여럿이 한 소켓을 이름으로 나눔) · 「와일드카드와 겹침」(0.0.0.0 · :: 와 특정 주소가 같은 포트).
   * head 기준이다 — 적용 전이면 엔진은 아직 옛 소켓을 연다. 전체 합산이면 지역을 고르라고 한다.
   */
  import { getContext } from 'svelte';
  import { resourcePath } from '@web/resources';
  import { socketViews, type SocketView } from '@web/sockets-view';
  import { DataTable, FieldMessage, type Column, type FilterChip } from '#lib/ui';
  import { b, m, x } from '#lib/ui/cells.ts';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import PickRegion from './PickRegion.svelte';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const aggregate = $derived(scope?.mode === 'global' && scope.region === undefined);

  let rows = $state<SocketView[] | undefined>();
  let failed = $state(false);
  const load = async (): Promise<void> => {
    const r = await desk.sockets();
    failed = r === undefined;
    rows = r === undefined ? undefined : socketViews(r);
  };
  $effect(() => {
    void desk.head;
    if (!desk.live || aggregate) return;
    void load();
  });

  const columns: Column<SocketView>[] = [
    { key: 'socket', label: '소켓', value: (r) => m(r.socket), sort: (r) => `${r.transport}${String(r.port).padStart(5, '0')}${r.bind}`, hideable: false },
    { key: 'listener', label: '리스너', mono: true, text: (r) => r.listener, sort: (r) => r.listener },
    { key: 'protocol', label: '프로토콜', value: (r) => m(r.protocol), sort: true },
    { key: 'enabled', label: '켜짐', value: (r) => (r.enabled ? b('ok', '●', '켜짐') : b('neutral', '○', '꺼짐 — 소켓을 열지 않아요')), sort: (r) => (r.enabled ? 1 : 0) },
    {
      key: 'shared', label: '나눠 씀', sort: (r) => r.sharedWith,
      value: (r) => (r.sharedWith > 1 ? b('info', '⇄', `같이 씀 · ${r.sharedWith}`, '호스트 리스너가 이 소켓을 나눠 써요. Host · SNI 로 갈라요.') : x('—')),
    },
    {
      key: 'overlap', label: '겹침', sort: (r) => (r.wildcardOverlap ? 1 : 0),
      value: (r) => (r.wildcardOverlap ? b('warn', '▲', '와일드카드와 겹침', '같은 포트에 0.0.0.0 · :: 리스너와 특정 주소 리스너가 함께 있어요. 그 주소로 온 연결은 특정 주소 쪽이 받아요.') : x('—')),
    },
  ];
  const chips: FilterChip<SocketView>[] = [
    { key: 'on', label: '켜진 것', tone: 'ok', match: (r) => r.enabled },
    { key: 'shared', label: '같이 씀', tone: 'info', match: (r) => r.sharedWith > 1 },
    { key: 'overlap', label: '와일드카드와 겹침', tone: 'warn', match: (r) => r.wildcardOverlap },
  ];
</script>

{#snippet cell(r: SocketView, c: Column<SocketView>)}
  {#if c.key === 'listener'}<a class="mono" href={resourcePath('listener', r.owner)}>{r.listener}</a>{/if}
{/snippet}

{#if aggregate}
  <PickRegion what="소켓" />
{:else}
  <div class="sk">
    <FieldMessage>head 설정 기준이에요. 적용 전이면 엔진은 아직 옛 소켓을 열고 있어요.</FieldMessage>
    <DataTable rows={rows ?? []} rowKey={(r) => `${r.socket}|${r.listener}`} {columns} {cell} {chips} label="소켓"
      search={{ placeholder: '리스너 · 주소 · 포트로 찾기', match: (r, q) => `${r.socket} ${r.listener}`.toLowerCase().includes(q.toLowerCase()) }}
      loading={rows === undefined && !failed} error={failed ? '소켓 목록을 읽지 못했어요.' : undefined} onretry={() => { void load(); }}
      emptyTitle="차지한 소켓이 없어요" emptyBody="리스너를 만들면 여기에 보여요." fill />
  </div>
{/if}

<style>
  .sk { flex: 1; min-height: 0; display: flex; flex-direction: column; gap: 12px; }
  .mono { font-family: var(--mono); color: var(--accent); }
</style>

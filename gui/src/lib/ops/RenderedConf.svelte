<script lang="ts">
  /**
   * 렌더된 설정 — 리비전이 만드는 nginx.conf (시안 「렌더된 설정」 · §8 코드 뷰어: 줄 번호 · 문법 색 · 검색 n/m).
   *
   * 기본은 head 다(desk 가 든 값). 머리 줄에서 리비전을 고르면 `GET /config/rendered?revision=` 로 그 리비전을 렌더해 본다.
   * 전역이면 지역도 고른다 — 그 지역의 중계 경로(`/api/v1/regions/<지역>/…`)로 읽기만 한다. 보는 지역(셸)은 안 바꾼다.
   * 전체 합산(지역을 안 골랐다, §2.5)이면 셸의 desk 가 어디에도 안 붙어 있다 — 닿는 첫 지역을 먼저 보이고, 지역은 여기서 고른다.
   */
  import { getContext } from 'svelte';
  import { viewOfRendered, type RenderedView } from '@web/rendered-view';
  import { Badge, CodeViewer, FieldMessage, Select, Skeleton } from '#lib/ui';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { getJson, loadRegions, regionPath } from './fetch';

  type Rev = { revision: string; createdAt?: string; createdBy?: string; rollbackOf?: string | null };
  const HEAD = 'head';
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const global = $derived(scope?.mode === 'global');

  /** 전체 합산 — 셸의 desk 는 안 붙어 있다. head 도 desk 에서 읽지 않는다. */
  const aggregate = $derived(scope?.aggregate === true);
  /** 전역에서 고른 지역 — 처음은 셸이 보는 지역이다(합산이면 닿는 첫 지역). */
  let regionPick = $state<string | undefined>();
  let regionNames = $state<string[]>([]);
  let regionsRead = $state(false);
  $effect(() => {
    if (!global) return;
    void loadRegions(desk.token).then((rs) => { regionNames = (rs ?? []).filter((r) => r.reachable && r.auth === undefined).map((r) => r.name); regionsRead = true; });
  });
  const region = $derived(regionPick ?? scope?.region?.name ?? (aggregate ? regionNames[0] : undefined));
  /** 셸이 보는 곳과 같은가 — 같고 head 면 desk 의 값을 그대로 쓴다(새로 묻지 않는다). 합산이면 아니다. */
  const own = $derived(!global || (!aggregate && region === scope?.region?.name));
  /** 읽을 곳이 있다 — 셸의 desk 가 붙었거나, 합산에서 지역이 정해졌다. */
  const ready = $derived(desk.live || (aggregate && region !== undefined));
  const at = (path: string): string => (global ? regionPath(region, path) : path);

  let rev = $state<string>(HEAD);
  let revs = $state<Rev[] | undefined>();
  $effect(() => {
    void desk.head;
    if (!ready) return;
    const path = at('/api/v1/config/revisions?limit=100');
    void getJson(path, desk.token).then((r) => { revs = Array.isArray(r) ? (r as Rev[]) : []; });
  });
  const revOptions = $derived([
    { value: HEAD, label: 'head', hint: '커밋된 가장 새 리비전' },
    ...(revs ?? []).map((r) => ({
      value: r.revision, label: `r${r.revision}`,
      hint: [r.createdBy, r.createdAt === undefined ? undefined : new Date(r.createdAt).toLocaleString()].filter(Boolean).join(' · '),
    })),
  ]);
  const regionOptions = $derived(regionNames.map((n) => ({ value: n, label: n })));

  let picked = $state<RenderedView | undefined>();
  let failed = $state(false);
  let loading = $state(false);
  let seq = 0;
  $effect(() => {
    if (!ready) return;
    if (own && rev === HEAD) { seq++; picked = undefined; failed = false; loading = false; return; }
    const q = rev === HEAD ? '' : `?revision=${encodeURIComponent(rev)}`;
    const path = at(`/api/v1/config/rendered${q}`);
    loading = true;
    const n = ++seq;
    void getJson(path, desk.token).then((r) => {
      if (n !== seq) return; // 그 사이 다른 리비전 · 지역을 골랐다 — 늦게 온 답으로 덮지 않는다.
      loading = false;
      failed = r === undefined;
      picked = r === undefined ? undefined : viewOfRendered(r);
    });
  });
  const v = $derived(own && rev === HEAD ? desk.rendered : picked);
  const headRev = $derived(own ? desk.head : undefined);
</script>

{#if aggregate && regionNames.length === 0 && regionsRead}
  <FieldMessage tone="error">설정을 읽을 지역이 없어요. 지역 화면에서 연결 상태를 봐요.</FieldMessage>
{:else if !ready}
  <Skeleton height="320px" label="연결하는 중" />
{:else}
  <div class="rc">
    {#if failed}
      <FieldMessage tone="error">이 리비전의 설정을 못 읽었어요. 다른 리비전을 골라요.</FieldMessage>
    {/if}
    <CodeViewer code={v?.conf ?? ''} maxHeight="calc(100vh - 240px)">
      {#snippet head()}
        <span class="meta">
          <code>nginx.conf</code>
          <span class="dim" aria-hidden="true">·</span>
          <Select label="리비전" width="150px" bind:value={rev} options={revOptions} />
          {#if global}
            <Select label="지역" width="170px" value={region} options={regionOptions} placeholder="지역" onchange={(x) => { regionPick = x; rev = HEAD; }} />
          {/if}
          {#if v?.revision !== undefined}<code class="dim">r{v.revision}{v.revision === headRev ? ' (head)' : ''}</code>{/if}
          {#if v?.digest !== undefined}<code class="dim" title={v.digest}>{v.digest.slice(0, 19)}…</code>{/if}
          {#each v?.planes ?? [] as p (p)}<Badge icon={null}>{p}</Badge>{/each}
          {#if loading}<span class="dim">읽는 중…</span>{/if}
        </span>
      {/snippet}
    </CodeViewer>
    {#if v !== undefined && v.conf === '' && !loading}
      <FieldMessage>산출물이 없어요. 모델이 비면 conf 도 비어요.</FieldMessage>
    {/if}
  </div>
{/if}

<style>
  .rc { display: flex; flex-direction: column; gap: 12px; }
  .meta { display: inline-flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  code { font-family: var(--mono); font-size: 12px; color: var(--tx); }
  .dim { color: var(--tx3); }
</style>

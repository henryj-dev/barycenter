<script lang="ts">
  /**
   * 운영 › 액세스 로그 (2026-11-22) — 이 노드의 엔진이 적은 최근 요청. `GET /api/v1/access-log`.
   *
   * 기능 목록 101–106: 요청 목록 · 거르기(상태 계열 · 대상 · 검색어) · 한 줄 펼쳐 보기(`?id=`) · 실시간 따라 보기 ·
   * 리소스 화면에서 대상으로 거른 채 열기(`?listener=` · `?route=` · `?pool=` · `?backend=`) · 내보내기(CSV · NDJSON).
   *
   * 줄은 노드 메모리에만 있다 — 데몬이나 엔진이 다시 뜨면 비고, 오래된 줄은 밀려난다. 전체 합산이면 지역을 고르라고 한다.
   * 읽기 규칙(문구 · 색 · 쿼리)은 `@web/access-log-view` 가 정한다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { resourcePath } from '@web/resources';
  import {
    accessSearch, bytesText, detailItems, durationText, pathText, requestText, statusTone, targetOf,
    STATUS_CLASSES, TARGET_LABEL, type AccessEntry, type AccessLogBody,
  } from '@web/access-log-view';
  import { Badge, Button, Chip, DescriptionList, FieldMessage, Skeleton, Switch, TextInput } from '#lib/ui';
  import type { Scope } from '#lib/global/scope.svelte.ts';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import PickRegion from './PickRegion.svelte';

  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const scope = getContext<Scope | undefined>('scope');
  const aggregate = $derived(scope?.mode === 'global' && scope.region === undefined);

  /** 화면에 두는 줄의 상한. 실시간으로 오래 켜 두어도 화면이 무거워지지 않게 한다. */
  const VIEW_MAX = 2000;
  const PAGE = 100;

  const target = $derived(targetOf(page.url.searchParams));
  const wantId = $derived(page.url.searchParams.get('id') ?? undefined);

  let on = $state<Record<string, boolean>>({ '2xx': false, '3xx': false, '4xx': false, '5xx': false });
  let typed = $state('');
  let q = $state('');
  let live = $state(false);
  let body = $state<AccessLogBody | undefined>();
  let failed = $state(false);
  let entries = $state<AccessEntry[]>([]);
  let cursor = $state(0);
  let more = $state(false);
  let loadingMore = $state(false);
  let picked = $state<AccessEntry | null | undefined>();
  let exporting = $state<'' | 'csv' | 'ndjson'>('');
  let exportFailed = $state(false);

  const classes = $derived(STATUS_CLASSES.filter((c) => on[c]));
  const query = $derived({ classes, ...(target === undefined ? {} : { target }), q });

  // 검색어는 치는 동안 묻지 않는다 — 멈추고 0.3 초 뒤에 건다.
  $effect(() => {
    const v = typed;
    const t = setTimeout(() => { q = v; }, 300);
    return () => clearTimeout(t);
  });

  const load = async (): Promise<void> => {
    const r = await desk.accessLog(accessSearch(query, { limit: PAGE }));
    failed = r === undefined;
    body = r;
    if (r?.state === 'ok') {
      entries = r.entries;
      cursor = r.cursor;
      more = r.more;
    } else {
      entries = [];
      more = false;
    }
  };
  $effect(() => {
    void query;
    if (!desk.live || aggregate) return;
    void load();
  });

  const older = async (): Promise<void> => {
    const last = entries[entries.length - 1];
    if (last === undefined) return;
    loadingMore = true;
    const r = await desk.accessLog(accessSearch(query, { limit: PAGE, before: last.cursor }));
    loadingMore = false;
    if (r?.state !== 'ok') return;
    entries = [...entries, ...r.entries].slice(0, VIEW_MAX);
    more = r.more && entries.length < VIEW_MAX;
  };

  /** 실시간 — 2 초마다 마지막 cursor 뒤에 온 줄을 위에 붙인다. */
  $effect(() => {
    if (!live || aggregate || body?.state !== 'ok') return;
    const tick = async (): Promise<void> => {
      const r = await desk.accessLog(accessSearch(query, { after: cursor, limit: 500 }));
      if (r?.state !== 'ok') return;
      cursor = Math.max(cursor, r.cursor);
      if (r.entries.length > 0) entries = [...r.entries, ...entries].slice(0, VIEW_MAX);
    };
    const t = setInterval(() => { void tick(); }, 2000);
    return () => clearInterval(t);
  });

  // `?id=` — 목록에 없으면 하나를 따로 읽는다(이미 밀려났으면 그렇다고 말한다).
  $effect(() => {
    const id = wantId;
    if (id === undefined || aggregate || !desk.live) { picked = undefined; return; }
    if (entries.some((e) => e.id === id)) { picked = undefined; return; }
    void desk.accessEntry(id).then((e) => { picked = e; });
  });

  const download = async (format: 'csv' | 'ndjson'): Promise<void> => {
    exporting = format;
    exportFailed = false;
    const blob = await desk.accessExport(accessSearch(query, { format }));
    exporting = '';
    if (blob === undefined) { exportFailed = true; return; }
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `access-log-${new Date().toISOString().replace(/[:.]/g, '-')}.${format}`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const clock = (iso: string): string => {
    const d = new Date(iso);
    const p = (n: number, w = 2): string => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  };
</script>

{#snippet row(e: AccessEntry, open: boolean)}
  <details class="g" {open}>
    <summary class="row">
      <span class="mk" aria-hidden="true"></span>
      <span class="time" title={new Date(e.at).toLocaleString()}>{clock(e.at)}</span>
      <span><Badge tone={statusTone(e.status)} icon={null}>{e.status}</Badge></span>
      <span class="req" title={requestText(e)}>{requestText(e)}</span>
      <span class="to" title={pathText(e)}>{pathText(e)}</span>
      <span class="num">{durationText(e.durationMs)}</span>
      <span class="num">{bytesText(e.bytesOut)}</span>
      <span class="cl">{e.client ?? '—'}</span>
    </summary>
    <div class="detail">
      <DescriptionList items={detailItems(e)} labelWidth="130px" />
      <p class="links">
        {#if e.listener !== null}<a href={resourcePath('listener', e.listener)}>리스너 열기</a>{/if}
        {#if e.route !== null}<a href={resourcePath(e.route.kind, e.route.key)}>라우트 열기</a>{/if}
        {#if e.pool !== null}<a href={resourcePath('pool', e.pool)}>풀 열기</a>{/if}
        {#if e.backend !== null}<a href={resourcePath('backend', e.backend)}>백엔드 열기</a>{/if}
        <a href="/ops/access-log?id={encodeURIComponent(e.id)}">이 줄의 주소</a>
      </p>
    </div>
  </details>
{/snippet}

{#if aggregate}
  <PickRegion what="액세스 로그" />
{:else if !desk.live || (body === undefined && !failed)}
  <Skeleton height="240px" label="액세스 로그를 읽는 중" />
{:else}
  <section class="list" aria-label="액세스 로그">
    <div class="bar">
      <TextInput bind:value={typed} mono={false} width="240px" placeholder="경로 · 호스트 · 클라이언트 · 요청 ID" aria-label="찾기" />
      {#each STATUS_CLASSES as c (c)}
        <Chip bind:pressed={on[c]} tone={statusTone(Number(c[0]) * 100)}>{c}</Chip>
      {/each}
      {#if target !== undefined}
        <span class="tgt">{TARGET_LABEL[target.kind]} <code>{target.key}</code> <a href="/ops/access-log" aria-label="대상 거르기 풀기">✕</a></span>
      {/if}
      <span class="grow"></span>
      <Switch bind:checked={live} disabled={body?.state !== 'ok'}>실시간</Switch>
      <Button size="sm" variant="secondary" loading={exporting === 'csv'} disabled={body?.state !== 'ok'} onclick={() => { void download('csv'); }}>CSV 받기</Button>
      <Button size="sm" variant="secondary" loading={exporting === 'ndjson'} disabled={body?.state !== 'ok'} onclick={() => { void download('ndjson'); }}>NDJSON 받기</Button>
    </div>
    {#if exportFailed}<div class="msg"><FieldMessage tone="error">파일을 받지 못했어요. 다시 눌러요.</FieldMessage></div>{/if}
    {#if failed}
      <div class="empty"><FieldMessage tone="error">액세스 로그를 읽지 못했어요.</FieldMessage> <Button size="sm" variant="secondary" onclick={() => { void load(); }}>다시 읽기</Button></div>
    {:else if body !== undefined && body.state !== 'ok'}
      <div class="empty">
        {#if body.state === 'unsupported'}이 엔진은 액세스 로그를 적지 않아요. OpenResty(Lua)에서만 적어요.
        {:else}<FieldMessage tone="error">엔진에서 액세스 로그를 읽지 못했어요: {body.reason}</FieldMessage>{/if}
      </div>
    {:else}
      <div class="row head" aria-hidden="true">
        <span></span><span>시각</span><span>상태</span><span>요청</span><span>어디로</span><span>시간</span><span>보낸 크기</span><span>클라이언트</span>
      </div>
      {#if picked !== undefined && wantId !== undefined}
        {#if picked === null}
          <div class="msg"><FieldMessage tone="warn">줄 <code>{wantId}</code> 은(는) 이 노드에 없어요. 이미 밀려났거나 다른 노드가 받았어요.</FieldMessage></div>
        {:else}
          <div class="pick">{@render row(picked, true)}</div>
        {/if}
      {/if}
      {#if entries.length === 0}
        <div class="empty">{q !== '' || classes.length > 0 || target !== undefined ? '거르기에 맞는 요청이 없어요. 조건을 바꿔요.' : '아직 받은 요청이 없어요.'}</div>
      {/if}
      {#each entries as e (e.id)}
        {@render row(e, e.id === wantId)}
      {/each}
      {#if more}
        <div class="more"><Button size="sm" variant="secondary" loading={loadingMore} onclick={() => { void older(); }}>더 오래된 요청</Button></div>
      {/if}
    {/if}
  </section>
  {#if body?.state === 'ok'}
    <p class="note">
      이 노드({body.node ?? '이 서버'})의 메모리에 최근 {body.window.kept.toLocaleString()}줄이 있어요. 오래된 줄은 밀려나고, 다시 시작하면 비어요.
      쿼리 문자열 · 쿠키 · 본문은 적지 않아요.
      {#if body.dropped > 0} 요청이 몰려 {body.dropped.toLocaleString()}줄을 읽기 전에 놓쳤어요.{/if}
    </p>
  {/if}
{/if}

<style>
  .list { display: flex; flex: 1; min-height: 0; flex-direction: column; border: 1px solid var(--bd); border-radius: var(--r-lg); background: var(--bg-panel); overflow: auto; }
  .bar { flex: none; display: flex; gap: 8px; align-items: center; flex-wrap: wrap; padding: 8px 12px; border-bottom: 1px solid var(--bd); }
  .grow { flex: 1; }
  .tgt { font-size: 12px; color: var(--tx2); display: inline-flex; gap: 6px; align-items: center; padding: 2px 8px; border: 1px solid var(--bd); border-radius: var(--r-sm, 6px); }
  .tgt a { color: var(--tx3); text-decoration: none; }
  .row {
    display: grid; grid-template-columns: 20px 104px 56px minmax(0, 1.4fr) minmax(0, 1fr) 64px 72px 128px; gap: 12px;
    padding: 0 16px; height: var(--row-h); align-items: center; font-size: 13px; color: var(--tx);
  }
  .head { position: sticky; top: 0; z-index: 5; height: 32px; background: var(--bg-hover); border-bottom: 1px solid var(--bd); font-size: 12px; font-weight: 600; color: var(--tx2); }
  .g { border-bottom: 1px solid var(--bd); }
  .pick { border-bottom: 2px solid var(--accent); }
  summary { cursor: pointer; list-style: none; }
  summary::-webkit-details-marker { display: none; }
  summary:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; }
  .mk { color: var(--tx2); }
  .mk::before { content: '▸'; }
  .g[open] .mk::before { content: '▾'; }
  .time, .num, .cl, .to { font-family: var(--mono); font-size: 12px; color: var(--tx2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .num { text-align: right; }
  .req { font-family: var(--mono); font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .detail { padding: 10px 16px 14px 48px; background: var(--bg-page); display: flex; flex-direction: column; gap: 8px; }
  .links { margin: 0; display: flex; gap: 14px; flex-wrap: wrap; font-size: 12px; }
  .links a { color: var(--accent); text-decoration: none; }
  .links a:hover { text-decoration: underline; }
  code { font-family: var(--mono); }
  .empty { padding: 24px; text-align: center; color: var(--tx3); font-size: 13px; display: flex; gap: 10px; justify-content: center; align-items: center; flex-wrap: wrap; }
  .msg { padding: 8px 16px; }
  .more { padding: 12px; display: flex; justify-content: center; }
  .note { margin: 0; font-size: 12px; color: var(--tx3); }
  @media (max-width: 900px) {
    .row { grid-template-columns: 20px 92px 52px minmax(0, 1fr) 60px; }
    .row > :nth-child(5), .row > :nth-child(7), .row > :nth-child(8) { display: none; }
    .detail { padding-left: 16px; }
  }
</style>

<script lang="ts">
  /**
   * 트래픽 경로 탭 — 들어온 요청이 라우트 → 풀 → 백엔드로 어떻게 가는가 (`trafficOf`).
   *
   * **라우트**는 시안 `pathData('routes')` 의 그림이다 — 왼쪽에 리스너, 줄마다 「라우트 #n → (규칙 n →) 결과」.
   * 출발지 규칙마다 한 줄이고, 마지막 줄이 「그 밖의 출발지 → 기본 동작」 이다(엔진이 보는 순서와 같다). 풀 노드에는 그 동작이
   * WebSocket 을 넘기면 배지를 단다. 경로가 여럿이고 경로 바꾸기가 있으면 라우트 노드가 경로마다 결과를 말한다.
   * #n 과 가려짐은 목록의 「평가 순서」 와 같은 값이다(`routeOrder`).
   *
   * 리스너 · 풀은 한 경로가 카드 하나다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { RESOURCES, itemOf, resourcePath, trafficOf, type ResourceKind, type Target } from '@web/resources';
  import { Badge, Card, FieldMessage } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { routeOrder } from '#lib/lists/route-order';

  let { kind }: { kind: ResourceKind } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const healthOf = (b: string): string => desk.health.find((h) => h.backendKey === b)?.state ?? 'unknown';
  const lines = $derived(trafficOf(desk.model, { kind, key }, healthOf));

  // ── 라우트 그림 ───────────────────────────────────────────────────────────
  type Obj = Record<string, unknown>;
  const obj = (v: unknown): Obj | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Obj : undefined);
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

  const isRoute = $derived(kind === 'httpRoute' || kind === 'passthroughRoute');
  const route = $derived(isRoute ? itemOf(desk.model, kind, key) : undefined);
  const listener = $derived(route === undefined ? undefined : itemOf(desk.model, 'listener', String(route['listener'])));
  const meta = $derived(routeOrder(desk.routes));
  const pass = $derived(kind === 'passthroughRoute');
  const paths = $derived(route === undefined || pass ? [] : strs(route['pathPrefixes']).length > 0 ? strs(route['pathPrefixes'])
    : [typeof route['pathPrefix'] === 'string' ? route['pathPrefix'] : '/']);
  const rewrite = $derived(((a) => (typeof a?.['rewritePrefix'] === 'string' ? a['rewritePrefix'] : undefined))(obj(route?.['action'])));
  const hosts = $derived(route === undefined ? '' : (strs(route['hosts']).length > 0 ? strs(route['hosts']) : strs(route['snis'])).join(', ') || '*');
  /** 라우트 노드의 아랫줄 — 호스트 · 경로, 경로 바꾸기가 있으면 경로마다 결과. */
  const routeSub = $derived(pass ? hosts
    : rewrite === undefined ? `${hosts} ${paths.join(', ')}`
      : `${hosts} ${paths.map((p) => `${p} → ${rewrite}`).join(' · ')}`);
  const rules = $derived(route === undefined ? [] : (Array.isArray(route['sourceRules']) ? route['sourceRules'] as unknown[] : []).map((r) => obj(r) ?? {}));
  const listenerSub = $derived(listener === undefined ? '' : `${String(listener['protocol'] ?? '')} ${String(listener['bind'] ?? '')}:${String(listener['port'] ?? '')}`);

  type Lane = { step?: { cap: string; head: string; sub: string; dashed?: boolean }; target: Target; websocket: boolean };
  /** `trafficOf` 의 라우트 줄은 규칙 순서대로, 마지막이 기본 동작이다 — 그 순서에 규칙의 사실을 붙인다. */
  const lanes = $derived<Lane[]>(lines.map((line, i): Lane => {
    const rule = rules[i];
    const ws = obj(rule === undefined ? route?.['action'] : rule['action'])?.['websocket'] === true;
    if (rule !== undefined) {
      return {
        step: { cap: `규칙 ${i + 1}`, head: strs(rule['from']).join(', '), sub: rule['address'] === 'connection' ? '연결 주소' : '방문자 주소' },
        target: line.target, websocket: ws,
      };
    }
    return { ...(rules.length > 0 ? { step: { cap: '그 밖의 출발지', head: '기본 동작', sub: '', dashed: true } } : {}), target: line.target, websocket: ws };
  }));
</script>

{#snippet backendList(t: Target)}
  {#if t.kind === 'pool' && !t.missing && t.backends.length > 0}
    <div class="node items">
      <span class="cap">백엔드 · {t.backends.length}개</span>
      {#each t.backends as b (b.key)}
        <div class="be">
          <a class="lnk" href={resourcePath('backend', b.key)}>{b.key}</a>
          <code class="muted">{b.target} · w{b.weight}</code>
          {#if b.health === 'healthy'}<Badge tone="ok">정상</Badge>{:else if b.health === 'unhealthy'}<Badge tone="danger">비정상</Badge>{:else}<Badge>관측 없음</Badge>{/if}
        </div>
      {/each}
    </div>
  {/if}
{/snippet}

{#snippet targetNodes(t: Target, websocket: boolean)}
  {#if t.kind === 'pool'}
    <div class="node">
      <span class="cap">풀</span>
      {#if t.missing}<span class="head">{t.pool}</span><Badge tone="danger">head 에 없어요</Badge>
      {:else}<a class="head lnk" href={resourcePath('pool', t.pool)}>{t.pool}</a>{/if}
      {#if websocket}<Badge tone="info" icon="⇄">WebSocket</Badge>{/if}
      {#if !t.missing && t.backends.length === 0}<Badge tone="warn">백엔드가 없어요</Badge>{/if}
    </div>
    {#if !t.missing && t.backends.length > 0}<span class="arrow" aria-hidden="true">→</span>{@render backendList(t)}{/if}
  {:else if t.kind === 'redirect'}
    <div class="node"><span class="cap">결과</span><span class="head">redirect {t.status}</span><span class="sub">{t.to}</span><Badge tone="info" icon="↪">이동</Badge></div>
  {:else}
    <div class="node">
      <span class="cap">결과</span><span class="head">{t.status === undefined ? '연결을 끊어요' : `reject ${t.status}`}</span>
      <Badge tone="danger">거절</Badge>
    </div>
  {/if}
{/snippet}

{#if isRoute && route !== undefined}
  <p class="help">이 라우트와 맞은 요청이 지나는 경로예요.{#if rules.length > 0} 출발지 규칙을 위에서부터 보고, 맞는 것이 없으면 기본 동작이에요.{/if}</p>
  <div class="graph">
    <div class="node left">
      <span class="cap">리스너</span>
      <a class="head lnk" href={resourcePath('listener', String(route['listener']))}>{String(route['listener'])}</a>
      {#if listenerSub.trim() !== ':'}<span class="sub">{listenerSub}</span>{/if}
    </div>
    <div class="lanes">
      {#each lanes as lane, i (i)}
        <div class="lane">
          <span class="arrow" aria-hidden="true">→</span>
          <div class="node">
            <span class="cap">{pass ? 'SNI 라우트' : `라우트 #${meta.ord.get(key) ?? '—'}`}</span>
            <span class="head">{key}</span>
            <span class="sub">{routeSub}</span>
            {#if meta.shadow.has(key)}<Badge tone="warn" title={meta.shadow.get(key)}>가려짐</Badge>{/if}
          </div>
          {#if lane.step !== undefined}
            <span class="arrow" aria-hidden="true">→</span>
            <div class="node" class:dashed={lane.step.dashed === true}>
              <span class="cap">{lane.step.cap}</span><span class="head">{lane.step.head}</span>
              {#if lane.step.sub !== ''}<span class="sub">{lane.step.sub}</span>{/if}
            </div>
          {/if}
          <span class="arrow" aria-hidden="true">→</span>
          {@render targetNodes(lane.target, lane.websocket)}
        </div>
      {/each}
    </div>
  </div>
  {#if !pass}<FieldMessage>#n 은 엔진이 실제로 보는 순서예요. 정본은 <a class="lnk" href="/traffic/route/http">HTTP 라우트</a> 목록의 평가 순서예요.</FieldMessage>{/if}
{:else if lines.length === 0}
  <FieldMessage>이 리소스로 들어오는 트래픽 경로가 없어요.</FieldMessage>
{:else}
  <div class="paths">
    {#each lines as line, i (i)}
      <Card>
        <div class="row">
          <code class="match">{line.match}</code>
          {#if line.route !== undefined && line.route.key !== key}
            <span class="muted">{RESOURCES[line.route.kind].label}</span>
            <a class="lnk" href={resourcePath(line.route.kind, line.route.key)}>{line.route.key}</a>
          {/if}
          <span class="arrow" aria-hidden="true">→</span>
          {#if line.target.kind === 'pool'}
            {#if line.target.missing}
              <Badge tone="danger">풀 {line.target.pool} — head 에 없어요</Badge>
            {:else}
              <a class="lnk" href={resourcePath('pool', line.target.pool)}>풀 {line.target.pool}</a>
              {#if line.target.backends.length === 0}<Badge tone="warn">백엔드가 없어요</Badge>{/if}
            {/if}
          {:else if line.target.kind === 'redirect'}
            <code>redirect {line.target.status} → {line.target.to}</code>
          {:else}
            <Badge tone="danger">거절{line.target.status === undefined ? ' — 연결을 끊어요' : ` ${line.target.status}`}</Badge>
          {/if}
        </div>
        {#if line.target.kind === 'pool' && !line.target.missing && line.target.backends.length > 0}
          <div class="backends">
            {#each line.target.backends as b (b.key)}
              <div class="be">
                <a class="lnk" href={resourcePath('backend', b.key)}>{b.key}</a>
                <code class="muted">{b.target} · w{b.weight}</code>
                {#if b.health === 'healthy'}<Badge tone="ok">정상</Badge>{:else if b.health === 'unhealthy'}<Badge tone="danger">비정상</Badge>{:else}<Badge>관측 없음</Badge>{/if}
              </div>
            {/each}
          </div>
        {/if}
      </Card>
    {/each}
    <FieldMessage>라우트는 우선순위 순서예요. 엔진이 실제로 보는 순서(매치 클래스)는 <a class="lnk" href="/traffic/route/http">HTTP 라우트</a> 목록이 정본이에요.</FieldMessage>
  </div>
{/if}

<style>
  .paths { display: flex; flex-direction: column; gap: 8px; max-width: 960px; }
  .row { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font: var(--t-body); }
  .match { min-width: 160px; }
  code { font-family: var(--mono); font-size: 13px; color: var(--tx); }
  .muted { color: var(--tx3); }
  .arrow { color: var(--tx3); flex: none; }
  .backends { margin: 10px 0 0 16px; padding-left: 12px; border-left: 2px solid var(--bd); display: flex; flex-direction: column; gap: 6px; }
  .be { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font: var(--t-small); }
  .lnk { color: var(--accent); font-family: var(--mono); text-decoration: none; }
  .lnk:hover { text-decoration: underline; }

  /* 라우트 그림 — 시안 pathData: 왼쪽 리스너, 오른쪽에 줄(lane)들. */
  .help { margin: 0 0 12px; font: var(--t-small); color: var(--tx2); }
  .graph { display: grid; grid-template-columns: minmax(150px, 210px) minmax(0, 1fr); gap: 0 8px; align-items: start; margin-bottom: 8px; }
  .lanes { display: flex; flex-direction: column; gap: 8px; min-width: 0; }
  .lane { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
  .node {
    display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; max-width: 100%;
    padding: 8px 10px; border: 1px solid var(--bd-strong); border-radius: var(--r-md); background: var(--bg-input);
  }
  .node.dashed { border-style: dashed; }
  .node.items { gap: 6px; }
  .cap { font: var(--t-cap); color: var(--tx3); }
  .head { font-family: var(--mono); font-size: 13px; color: var(--tx); overflow-wrap: anywhere; }
  .sub { font: var(--t-cap); color: var(--tx2); overflow-wrap: anywhere; }
  @media (max-width: 720px) { .graph { grid-template-columns: minmax(0, 1fr); gap: 8px; } }
</style>

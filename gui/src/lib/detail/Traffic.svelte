<script lang="ts">
  /**
   * 트래픽 경로 탭 — 들어온 요청이 라우트 → 풀 → 백엔드로 어떻게 가는가 (`trafficOf`). 시안 `pathData`.
   *
   * **라우트**는 시안 `pathData('routes')` 의 그림이다 — 왼쪽에 리스너, 줄마다 「라우트 #n → (규칙 n →) 결과」.
   * 출발지 규칙마다 한 줄이고, 마지막 줄이 「그 밖의 출발지 → 기본 동작」 이다(엔진이 보는 순서와 같다). 풀 노드에는 그 동작이
   * WebSocket 을 넘기면 배지를 단다. 경로가 여럿이고 경로 바꾸기가 있으면 라우트 노드가 경로마다 결과를 말한다.
   *
   * **리스너**는 시안 `pathData('listeners')` 다 — 왼쪽에 리스너, 라우트를 **엔진이 보는 순서**대로 한 줄씩(「라우트 #n」),
   * 마지막에 점선 「라우트에 맞지 않는 요청 → 기본 동작」(패스스루는 SNI 폴백 둘, TCP · UDP 는 「모든 연결」).
   *
   * **풀**은 오른쪽에 풀(백엔드와 함께), 줄마다 「리스너 → 기본 동작 / 라우트 #n」 — 어디서 이 풀로 오나.
   *
   * #n 과 가려짐은 목록의 「평가 순서」 와 같은 값이다(`routeOrder`). 패스스루 라우트는 SNI 목록의 순서다.
   * 풀 노드의 아랫줄은 「알고리즘 · 헬스체크」, 백엔드는 헬스 판정(`backendHealth` — 찌르는 풀의 모름은 「확인 중」)이나
   * 드레인과 트래픽 수신을 단다 — 목록 · 상세와 같은 말이다(`facts.ts`).
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { itemOf, itemsOf, resourcePath, trafficOf, type Item, type ResourceKind, type Target } from '@web/resources';
  import { Badge, FieldMessage } from '#lib/ui';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { routeOrder } from '#lib/lists/route-order';
  import { DRAIN_MARK, HEALTH_MARK, backendDraining, backendHealth, healthCheckText } from './facts';

  let { kind }: { kind: ResourceKind } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const healthOf = (b: string): string => desk.health.find((h) => h.backendKey === b)?.state ?? 'unknown';
  const lines = $derived(trafficOf(desk.model, { kind, key }, healthOf));

  type Obj = Record<string, unknown>;
  const obj = (v: unknown): Obj | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Obj : undefined);
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  const meta = $derived(routeOrder(desk.routes));

  /** 라우트 노드의 아랫줄 — 호스트 · 경로, 경로 바꾸기가 있으면 경로마다 결과. */
  const routeSubOf = (r: Item, pass: boolean): string => {
    const hosts = (strs(r['hosts']).length > 0 ? strs(r['hosts']) : strs(r['snis'])).join(', ') || '*';
    if (pass) return hosts;
    const paths = strs(r['pathPrefixes']).length > 0 ? strs(r['pathPrefixes']) : [typeof r['pathPrefix'] === 'string' ? r['pathPrefix'] : '/'];
    const a = obj(r['action']);
    const rewrite = typeof a?.['rewritePrefix'] === 'string' ? a['rewritePrefix'] : undefined;
    return rewrite === undefined ? `${hosts} ${paths.join(', ')}` : `${hosts} ${paths.map((p) => `${p} → ${rewrite}`).join(' · ')}`;
  };
  const listenerSubOf = (l: Item | undefined): string =>
    (l === undefined ? '' : `${String(l['protocol'] ?? '')} ${String(l['bind'] ?? '')}:${String(l['port'] ?? '')}`);
  /** 「라우트 #n」 — http 는 엔진 순서(`routeOrder`), 패스스루는 SNI 목록 순서. */
  const passOrd = (k: string): number => desk.routes.passthrough.findIndex((p) => p.key === k) + 1;
  const ordOf = (rk: 'httpRoute' | 'passthroughRoute', k: string): number =>
    (rk === 'httpRoute' ? meta.ord.get(k) ?? Number.MAX_SAFE_INTEGER : passOrd(k) || Number.MAX_SAFE_INTEGER);
  const routeKindOf = (l: Item | undefined): 'httpRoute' | 'passthroughRoute' | undefined =>
    (l?.['protocol'] === 'http' || l?.['protocol'] === 'https' ? 'httpRoute' : l?.['protocol'] === 'tls_passthrough' ? 'passthroughRoute' : undefined);
  /** 리스너의 기본 줄(라우트가 없는 줄)의 이름 — `trafficOf` 가 내는 순서와 같다. */
  const defaultCaps = (l: Item | undefined): string[] =>
    (routeKindOf(l) === 'httpRoute' ? ['라우트에 맞지 않는 요청'] : routeKindOf(l) === 'passthroughRoute' ? ['SNI가 맞지 않는 연결', 'SNI가 없는 연결'] : ['모든 연결']);

  type Step = { cap: string; head: string; sub?: string; href?: string; dashed?: boolean; shadow?: string };
  type Lane = { steps: Step[]; target?: Target; websocket: boolean };
  const routeStep = (rk: 'httpRoute' | 'passthroughRoute', r: Item, extra = ''): Step => {
    const k = String(r['key']);
    const pass = rk === 'passthroughRoute';
    const rules = Array.isArray(r['sourceRules']) ? (r['sourceRules'] as unknown[]).length : 0;
    const shadow = pass ? undefined : meta.shadow.get(k);
    return {
      cap: pass ? 'SNI 라우트' : `라우트 #${meta.ord.get(k) ?? '—'}`, head: k, href: resourcePath(rk, k),
      sub: `${routeSubOf(r, pass)}${rules > 0 ? ` · 출발지 규칙 ${rules}` : ''}${extra}`,
      ...(shadow === undefined ? {} : { shadow }),
    };
  };
  const routesOf = (l: Item | undefined): { rk: 'httpRoute' | 'passthroughRoute'; r: Item }[] => {
    const rk = routeKindOf(l);
    if (rk === undefined || l === undefined) return [];
    return itemsOf(desk.model, rk).filter((r) => r['listener'] === l['key'])
      .map((r) => ({ rk, r }))
      .sort((a, b) => ordOf(rk, String(a.r['key'])) - ordOf(rk, String(b.r['key'])) || String(a.r['key']).localeCompare(String(b.r['key'])));
  };

  // ── 라우트 그림 ───────────────────────────────────────────────────────────
  const isRoute = $derived(kind === 'httpRoute' || kind === 'passthroughRoute');
  const route = $derived(isRoute ? itemOf(desk.model, kind, key) : undefined);
  const listener = $derived(route === undefined ? undefined : itemOf(desk.model, 'listener', String(route['listener'])));
  const pass = $derived(kind === 'passthroughRoute');
  const routeSub = $derived(route === undefined ? '' : routeSubOf(route, pass));
  const rules = $derived(route === undefined ? [] : (Array.isArray(route['sourceRules']) ? route['sourceRules'] as unknown[] : []).map((r) => obj(r) ?? {}));
  const listenerSub = $derived(listenerSubOf(listener));

  type RouteLane = { step?: { cap: string; head: string; sub: string; dashed?: boolean }; target: Target; websocket: boolean };
  /** `trafficOf` 의 라우트 줄은 규칙 순서대로, 마지막이 기본 동작이다 — 그 순서에 규칙의 사실을 붙인다. */
  const lanes = $derived<RouteLane[]>(!isRoute ? [] : lines.map((line, i): RouteLane => {
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

  // ── 리스너 그림 ───────────────────────────────────────────────────────────
  const self = $derived(kind === 'listener' ? itemOf(desk.model, 'listener', key) : undefined);
  const listenerLanes = $derived.by<Lane[]>(() => {
    if (self === undefined) return [];
    const out: Lane[] = routesOf(self).map(({ rk, r }) => {
      const rl = trafficOf(desk.model, { kind: rk, key: String(r['key']) }, healthOf);
      return { steps: [routeStep(rk, r)], ...(rl[rl.length - 1] === undefined ? {} : { target: rl[rl.length - 1]!.target }), websocket: obj(r['action'])?.['websocket'] === true };
    });
    const caps = defaultCaps(self);
    lines.filter((l) => l.route === undefined).forEach((l, i) => {
      out.push({
        steps: [{ cap: caps[i] ?? l.match, head: '기본 동작', sub: l.target.kind === 'pool' ? '기본 풀로 보내기' : '거절', dashed: true }],
        target: l.target, websocket: false,
      });
    });
    return out;
  });

  // ── 풀 그림 ───────────────────────────────────────────────────────────────
  const poolItem = $derived(kind === 'pool' ? itemOf(desk.model, 'pool', key) : undefined);
  const toThis = (t: Target | undefined): boolean => t?.kind === 'pool' && t.pool === key;
  const poolLanes = $derived.by<Lane[]>(() => {
    if (poolItem === undefined) return [];
    const defaults: Lane[] = [];
    const routed: { ord: number; lane: Lane }[] = [];
    for (const l of itemsOf(desk.model, 'listener')) {
      const lk = String(l['key']);
      const ls: Step = { cap: '리스너', head: lk, sub: listenerSubOf(l), href: resourcePath('listener', lk) };
      const caps = defaultCaps(l);
      trafficOf(desk.model, { kind: 'listener', key: lk }, healthOf).filter((x) => x.route === undefined).forEach((x, i) => {
        if (toThis(x.target)) defaults.push({ steps: [ls, { cap: '기본 동작', head: '기본 풀', sub: caps[i] ?? x.match, dashed: true }], websocket: false });
      });
      for (const { rk, r } of routesOf(l)) {
        const rl = trafficOf(desk.model, { kind: rk, key: String(r['key']) }, healthOf);
        const viaDefault = toThis(rl[rl.length - 1]?.target);
        const viaRules = rl.slice(0, -1).filter((x) => toThis(x.target)).length;
        if (!viaDefault && viaRules === 0) continue;
        const extra = viaDefault ? '' : ' · 출발지 규칙으로만';
        routed.push({ ord: ordOf(rk, String(r['key'])), lane: { steps: [ls, routeStep(rk, r, extra)], websocket: false } });
      }
    }
    return [...defaults, ...routed.sort((a, b) => a.ord - b.ord).map((x) => x.lane)];
  });
  /** 오른쪽 풀 — 들어오는 경로가 없어도 그린다. 백엔드는 `trafficOf` 와 같은 모양으로 모은다. */
  const poolSelf = $derived<Target | undefined>(poolItem === undefined ? undefined : {
    kind: 'pool', pool: key, missing: false,
    backends: itemsOf(desk.model, 'backend').filter((b) => b['pool'] === key).map((b) => ({
      key: String(b['key']), target: `${String(b['host'])}:${String(b['port'])}`,
      weight: typeof b['weight'] === 'number' ? b['weight'] : 1, health: healthOf(String(b['key'])),
    })),
  });

  const poolSub = (pool: string): string => {
    const p = itemOf(desk.model, 'pool', pool);
    return p === undefined ? '' : `${String(p['algorithm'] ?? '')} · ${healthCheckText(p)}`;
  };
  const backendMark = (b: string) => (backendDraining(desk, b) ? DRAIN_MARK : HEALTH_MARK[backendHealth(desk, b)]);
  const receiving = (b: string): boolean | undefined => desk.traffic.get(b)?.receivingTraffic;
</script>

{#snippet backendItems(t: Target)}
  {#if t.kind === 'pool' && !t.missing}
    {#each t.backends as b (b.key)}
      {@const m = backendMark(b.key)}
      {@const rx = receiving(b.key)}
      <div class="be">
        <a class="lnk" href={resourcePath('backend', b.key)}>{b.key}</a>
        <code class="muted">{b.target} · w{b.weight}</code>
        <Badge tone={m.tone} icon={m.icon}>{m.text}</Badge>
        {#if rx !== undefined}<span class="rx" class:off={!rx}>{rx ? '수신 중' : '수신 안 함'}</span>{/if}
      </div>
    {/each}
  {/if}
{/snippet}

{#snippet backendList(t: Target)}
  {#if t.kind === 'pool' && !t.missing && t.backends.length > 0}
    <div class="node items">
      <span class="cap">백엔드 · {t.backends.length}개</span>
      {@render backendItems(t)}
    </div>
  {/if}
{/snippet}

{#snippet targetNodes(t: Target, websocket: boolean)}
  {#if t.kind === 'pool'}
    <div class="node">
      <span class="cap">풀</span>
      {#if t.missing}<span class="head">{t.pool}</span><Badge tone="danger">head 에 없어요</Badge>
      {:else}<a class="head lnk" href={resourcePath('pool', t.pool)}>{t.pool}</a><span class="sub">{poolSub(t.pool)}</span>{/if}
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

{#snippet stepNode(s: Step)}
  <div class="node" class:dashed={s.dashed === true}>
    <span class="cap">{s.cap}</span>
    {#if s.href !== undefined}<a class="head lnk" href={s.href}>{s.head}</a>{:else}<span class="head">{s.head}</span>{/if}
    {#if s.sub !== undefined && s.sub.trim() !== '' && s.sub.trim() !== ':'}<span class="sub">{s.sub}</span>{/if}
    {#if s.shadow !== undefined}<Badge tone="warn" icon="▲" title={s.shadow}>가려짐</Badge>{/if}
  </div>
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
{:else if kind === 'listener' && self !== undefined}
  <p class="help">리스너에서 백엔드까지 요청이 지나는 경로예요. 라우트는 평가 순서대로 나열해요.</p>
  <div class="graph">
    {@render stepNode({ cap: '리스너', head: key, sub: listenerSubOf(self) })}
    <div class="lanes">
      {#each listenerLanes as lane, i (i)}
        <div class="lane">
          {#each lane.steps as s, j (j)}<span class="arrow" aria-hidden="true">→</span>{@render stepNode(s)}{/each}
          {#if lane.target !== undefined}<span class="arrow" aria-hidden="true">→</span>{@render targetNodes(lane.target, lane.websocket)}{/if}
        </div>
      {/each}
    </div>
  </div>
  {#if routeKindOf(self) === 'httpRoute'}<FieldMessage>#n 은 엔진이 실제로 보는 순서예요. 정본은 <a class="lnk" href="/traffic/route/http">HTTP 라우트</a> 목록의 평가 순서예요.</FieldMessage>{/if}
{:else if kind === 'pool' && poolItem !== undefined}
  <p class="help">이 풀로 들어오는 경로예요. 리스너와 라우트를 나열해요.</p>
  <div class="graph right">
    <div class="lanes">
      {#if poolLanes.length === 0}<FieldMessage>이 풀로 들어오는 트래픽 경로가 없어요. 리스너의 기본 동작이나 라우트가 이 풀을 가리켜야 해요.</FieldMessage>{/if}
      {#each poolLanes as lane, i (i)}
        <div class="lane">
          {#each lane.steps as s, j (j)}{#if j > 0}<span class="arrow" aria-hidden="true">→</span>{/if}{@render stepNode(s)}{/each}
          <span class="arrow" aria-hidden="true">→</span>
        </div>
      {/each}
    </div>
    {#if poolSelf !== undefined && poolSelf.kind === 'pool'}
      <div class="node items">
        <span class="cap">풀</span>
        <span class="head">{key}</span>
        <span class="sub">{poolSub(key)}</span>
        {#if poolSelf.backends.length === 0}<Badge tone="warn">백엔드가 없어요</Badge>{/if}
        {@render backendItems(poolSelf)}
      </div>
    {/if}
  </div>
  {#if poolLanes.length > 0}<FieldMessage>#n 은 엔진이 실제로 보는 순서예요. 정본은 <a class="lnk" href="/traffic/route/http">HTTP 라우트</a> 목록의 평가 순서예요.</FieldMessage>{/if}
{:else}
  <FieldMessage>이 리소스로 들어오는 트래픽 경로가 없어요.</FieldMessage>
{/if}

<style>
  code { font-family: var(--mono); font-size: 13px; color: var(--tx); }
  .muted { color: var(--tx3); }
  .arrow { color: var(--tx3); flex: none; }
  .be { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; font: var(--t-small); }
  .rx { font: var(--t-cap); color: var(--ok); }
  .rx.off { color: var(--tx3); }
  .lnk { color: var(--accent); font-family: var(--mono); text-decoration: none; }
  .lnk:hover { text-decoration: underline; }

  /* 시안 pathData: 리스너 · 라우트는 왼쪽에 리스너, 풀은 오른쪽에 풀. 그 사이에 줄(lane)들. */
  .help { margin: 0 0 12px; font: var(--t-small); color: var(--tx2); }
  .graph { display: grid; grid-template-columns: minmax(150px, 210px) minmax(0, 1fr); gap: 0 8px; align-items: start; margin-bottom: 8px; }
  .graph.right { grid-template-columns: minmax(0, 1fr) minmax(210px, 300px); }
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
  @media (max-width: 720px) { .graph, .graph.right { grid-template-columns: minmax(0, 1fr); gap: 8px; } }
</style>

<script lang="ts">
  /**
   * 리스너 · 풀의 트래픽 경로 탭 — 콘솔 시안 `pathData('listeners' | 'pools')` 그대로(그림은 `PathGraph`).
   *
   * **리스너** — 왼쪽에 리스너, 라우트를 **엔진이 보는 순서**대로 한 줄씩(「라우트 #n」 → 풀 → 백엔드 · N개, 또는 결과),
   * 마지막에 점선 「라우트에 맞지 않는 요청 → 기본 동작」(패스스루는 SNI 폴백 둘, TCP · UDP 는 「모든 연결」).
   * **풀** — 오른쪽에 풀(백엔드와 함께), 줄마다 「리스너 → 기본 동작(기본 풀)」 또는 「리스너 → 라우트 #n」.
   *
   * 값은 `trafficOf`(head 모델)와 목록 · 상세가 쓰는 판정(`facts.ts`)에서 읽는다. #n 과 가려짐은 HTTP 라우트 목록의
   * 「평가 순서」 와 같은 값이다(`routeOrder` — 엔진 순서). 패스스루 라우트는 SNI 목록 순서다.
   */
  import { getContext } from 'svelte';
  import { page } from '$app/state';
  import { itemOf, itemsOf, resourcePath, trafficOf, type Item, type Target } from '@web/resources';
  import type { createDesk } from '#lib/desk.svelte.ts';
  import { routeOrder } from '#lib/lists/route-order';
  import { PROTOCOL_TEXT } from '#lib/lists/traffic-cells';
  import PathGraph, { type PathData, type PathNode } from './PathGraph.svelte';
  import { DRAIN_MARK, HEALTH_MARK, backendDraining, backendHealth, hcText } from './facts';

  let { kind }: { kind: 'listener' | 'pool' } = $props();
  const desk = getContext<ReturnType<typeof createDesk>>('desk');
  const key = $derived(page.params['key'] ?? '');
  const healthOf = (b: string): string => desk.health.find((h) => h.backendKey === b)?.state ?? 'unknown';
  const meta = $derived(routeOrder(desk.routes));

  type Obj = Record<string, unknown>;
  const obj = (v: unknown): Obj | undefined => (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Obj : undefined);
  const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);
  type RouteKind = 'httpRoute' | 'passthroughRoute';

  const listenerSub = (l: Item | undefined): string =>
    (l === undefined ? '' : `${PROTOCOL_TEXT[String(l['protocol'])] ?? String(l['protocol'] ?? '')} ${String(l['bind'] ?? '')}:${String(l['port'] ?? '')}`);
  const routeKindOf = (l: Item | undefined): RouteKind | undefined =>
    (l?.['protocol'] === 'http' || l?.['protocol'] === 'https' ? 'httpRoute' : l?.['protocol'] === 'tls_passthrough' ? 'passthroughRoute' : undefined);
  const passOrd = (k: string): number => desk.routes.passthrough.findIndex((p) => p.key === k) + 1;
  const ordOf = (rk: RouteKind, k: string): number =>
    (rk === 'httpRoute' ? meta.ord.get(k) ?? Number.MAX_SAFE_INTEGER : passOrd(k) || Number.MAX_SAFE_INTEGER);
  const routesOf = (l: Item | undefined): { rk: RouteKind; r: Item }[] => {
    const rk = routeKindOf(l);
    if (rk === undefined || l === undefined) return [];
    return itemsOf(desk.model, rk).filter((r) => r['listener'] === l['key']).map((r) => ({ rk, r }))
      .sort((a, b) => ordOf(rk, String(a.r['key'])) - ordOf(rk, String(b.r['key'])) || String(a.r['key']).localeCompare(String(b.r['key'])));
  };
  /** 기본 줄의 이름 — `trafficOf` 가 내는 순서와 같다(시안 「라우트에 맞지 않는 요청」 · 「SNI가 맞지 않는 연결」 · 「모든 연결」). */
  const defaultCaps = (l: Item | undefined): string[] =>
    (routeKindOf(l) === 'httpRoute' ? ['라우트에 맞지 않는 요청'] : routeKindOf(l) === 'passthroughRoute' ? ['SNI가 맞지 않는 연결', 'SNI가 없는 연결'] : ['모든 연결']);
  const hostsOf = (r: Item): string => (strs(r['hosts']).length > 0 ? strs(r['hosts']) : strs(r['snis'])).join(', ') || '*';
  const pathsOf = (r: Item): string[] => (strs(r['pathPrefixes']).length > 0 ? strs(r['pathPrefixes']) : [typeof r['pathPrefix'] === 'string' ? r['pathPrefix'] : '/']);

  /** 라우트 노드 — 시안 `N('라우트 #' + ord, name, sub(host + 경로 + → rewrite + · 출발지 규칙 n), 가려짐 배지)`. */
  const routeNode = (rk: RouteKind, r: Item, withRules: boolean, extra = ''): PathNode => {
    const k = String(r['key']);
    const pass = rk === 'passthroughRoute';
    const rewrite = obj(r['action'])?.['rewritePrefix'];
    const rules = Array.isArray(r['sourceRules']) ? (r['sourceRules'] as unknown[]).length : 0;
    const shadow = pass ? undefined : meta.shadow.get(k);
    return {
      cap: pass ? 'SNI 라우트' : `라우트 #${meta.ord.get(k) ?? '—'}`, head: k, href: resourcePath(rk, k),
      sub: `${hostsOf(r)}${pass ? '' : ` ${pathsOf(r).join(', ')}`}${typeof rewrite === 'string' ? ` → ${rewrite}` : ''}${withRules && rules > 0 ? ` · 출발지 규칙 ${rules}` : ''}${extra}`,
      ...(shadow === undefined ? {} : { badge: { tone: 'warn' as const, icon: '▲', text: '가려짐', title: shadow } }),
    };
  };
  const backendItem = (b: string): NonNullable<PathNode['items']>[number] => {
    const m = backendDraining(desk, b) ? DRAIN_MARK : HEALTH_MARK[backendHealth(desk, b)];
    const rx = desk.traffic.get(b)?.receivingTraffic;
    return { n: b, tone: m.tone, icon: m.icon, text: m.text, recv: rx === undefined ? '' : rx ? '수신 중' : '수신 안 함', href: resourcePath('backend', b) };
  };
  const poolSub = (pool: string): string => {
    const p = itemOf(desk.model, 'pool', pool);
    return p === undefined ? '' : `${String(p['algorithm'] ?? '')} · ${hcText(p)}`;
  };
  /** 시안 `poolNodes` · 결과 노드 — 풀이면 [풀, 백엔드 · N개], 리다이렉트 · 거절이면 [결과]. */
  const targetNodes = (t: Target | undefined): PathNode[] => {
    if (t === undefined) return [];
    if (t.kind === 'pool') {
      if (t.missing) return [{ cap: '풀', head: t.pool, badge: { tone: 'danger', icon: '✕', text: 'head 에 없어요' } }];
      return [
        { cap: '풀', head: t.pool, sub: poolSub(t.pool), href: resourcePath('pool', t.pool) },
        { cap: `백엔드 · ${t.backends.length}개`, items: t.backends.map((b) => backendItem(b.key)) },
      ];
    }
    if (t.kind === 'redirect') return [{ cap: '결과', head: `redirect ${t.status}`, sub: t.to, badge: { tone: 'info', icon: '↻', text: '이동' } }];
    return [{ cap: '결과', head: t.status === undefined ? '거절' : `reject ${t.status}`, ...(t.status === undefined ? {} : { sub: '요청 거절' }), badge: { tone: 'danger', icon: '✕', text: '거절' } }];
  };

  const listenerData = $derived.by((): PathData | undefined => {
    const self = itemOf(desk.model, 'listener', key);
    if (self === undefined) return undefined;
    const lanes: { nodes: PathNode[] }[] = routesOf(self).map(({ rk, r }) => {
      const rl = trafficOf(desk.model, { kind: rk, key: String(r['key']) }, healthOf);
      return { nodes: [routeNode(rk, r, true), ...targetNodes(rl[rl.length - 1]?.target)] };
    });
    const caps = defaultCaps(self);
    trafficOf(desk.model, { kind: 'listener', key }, healthOf).filter((l) => l.route === undefined).forEach((l, i) => {
      const reject = l.target.kind !== 'pool';
      lanes.push({ nodes: [
        { cap: caps[i] ?? l.match, head: '기본 동작', sub: reject ? '거절' : '기본 풀로 보내기', dashed: true },
        ...(reject ? [{ cap: '결과', head: '거절', badge: { tone: 'danger' as const, icon: '✕', text: '거절' } }] : targetNodes(l.target)),
      ] });
    });
    return {
      help: '리스너에서 백엔드까지 요청이 지나는 경로예요. 라우트는 평가 순서대로 나열해요.', cols: 3, grid: 'minmax(150px,210px) minmax(0,1fr)',
      left: { cap: '리스너', head: key, sub: listenerSub(self), arrow: false }, lanes,
    };
  });

  const poolData = $derived.by((): PathData | undefined => {
    if (itemOf(desk.model, 'pool', key) === undefined) return undefined;
    const toThis = (t: Target | undefined): boolean => t?.kind === 'pool' && t.pool === key;
    const defaults: { nodes: PathNode[] }[] = [];
    const routed: { ord: number; nodes: PathNode[] }[] = [];
    for (const l of itemsOf(desk.model, 'listener')) {
      const lk = String(l['key']);
      const caps = defaultCaps(l);
      trafficOf(desk.model, { kind: 'listener', key: lk }, healthOf).filter((x) => x.route === undefined).forEach((x, i) => {
        if (!toThis(x.target)) return;
        defaults.push({ nodes: [
          { cap: '리스너', head: lk, sub: listenerSub(l), arrow: false, href: resourcePath('listener', lk) },
          { cap: '기본 동작', head: '기본 풀', sub: caps[i] ?? x.match, dashed: true },
        ] });
      });
      for (const { rk, r } of routesOf(l)) {
        const rl = trafficOf(desk.model, { kind: rk, key: String(r['key']) }, healthOf);
        const viaDefault = toThis(rl[rl.length - 1]?.target);
        const viaRules = rl.slice(0, -1).some((x) => toThis(x.target));
        if (!viaDefault && !viaRules) continue;
        routed.push({ ord: ordOf(rk, String(r['key'])), nodes: [
          { cap: '리스너', head: lk, arrow: false, href: resourcePath('listener', lk) },
          routeNode(rk, r, false, viaDefault ? '' : ' · 출발지 규칙으로만'),
        ] });
      }
    }
    const backends = itemsOf(desk.model, 'backend').filter((b) => b['pool'] === key).map((b) => backendItem(String(b['key'])));
    return {
      help: '이 풀로 들어오는 경로예요. 리스너와 라우트를 나열해요.', cols: 2, grid: 'minmax(0,1fr) minmax(210px,300px)',
      right: { cap: '풀', head: key, sub: poolSub(key), items: backends, arrow: false },
      lanes: [...defaults, ...routed.sort((a, b) => a.ord - b.ord)],
    };
  });
  const data = $derived(kind === 'listener' ? listenerData : poolData);
</script>

{#if data !== undefined}<PathGraph {data} />{/if}

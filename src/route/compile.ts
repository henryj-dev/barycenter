/**
 * 라우트 컴파일러 — DESIGN.md §7.5 (축소 계약)
 *
 * 엔진 근거 (tests/engine):
 *   E20.1 — map / server_name 은 **정확일치가 와일드카드보다 항상 먼저**다. 등장 순서 무관.
 *   E20.3 — 정규식끼리는 등장 순서를 따른다.
 *
 * 따라서 사용자 `priority` 는 **같은 매치 클래스 안에서만** 의미가 있다. v0 은 이 사실을
 * 숨기지 않는다: 클래스를 가로지르는 우선순위 역전은 저장은 되되 plan 이 경고하고,
 * GUI 는 컴파일된 최종 순서를 보여준다. 전역 숫자 우선순위를 엔진 위에 재현하는 것은
 * `strict_priority` 옵트인(S10 통과 전제)으로 미뤘다.
 */
import { parseHostPattern, type HostPattern } from '../validate/strings.js';

export type MatchClass = 'exact_host' | 'wildcard_host' | 'regex_host';

export type RouteInput = {
  key: string;
  host: string;
  priority: number;
  pathPrefix?: string;
};

export type CompiledRoute = {
  key: string;
  matchClass: MatchClass;
  pattern: HostPattern;
  priority: number;
  pathPrefix: string;
};

export type CompileWarning = {
  kind: 'priority_inversion' | 'path_priority_ignored';
  routes: string[];
  message: string;
};

export type CompileError = {
  kind: 'invalid_host' | 'duplicate_match';
  route: string;
  message: string;
};

export type CompileResult = {
  order: CompiledRoute[];
  warnings: CompileWarning[];
  errors: CompileError[];
};

/** 엔진이 먼저 보는 순서. 사용자 priority 는 이 값을 이길 수 없다. */
const CLASS_RANK: Record<MatchClass, number> = {
  exact_host: 3,
  wildcard_host: 2,
  regex_host: 1,
};

const patternKey = (p: HostPattern): string =>
  p.kind === 'exact' ? `=${p.host}` : `*${p.suffix}`;

const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

export function compileHostRoutes(routes: RouteInput[]): CompileResult {
  const errors: CompileError[] = [];
  const compiled: CompiledRoute[] = [];

  for (const r of routes) {
    const parsed = parseHostPattern(r.host);
    if (!parsed.ok) {
      errors.push({ kind: 'invalid_host', route: r.key, message: parsed.message });
      continue;
    }
    compiled.push({
      key: r.key,
      matchClass: parsed.value.kind === 'exact' ? 'exact_host' : 'wildcard_host',
      pattern: parsed.value,
      priority: r.priority,
      pathPrefix: r.pathPrefix ?? '/',
    });
  }

  // 같은 (host, path_prefix) 는 nginx 에서 duplicate location / conflicting map 이라
  // 산출물이 `nginx -t` 를 통과하지 못한다. 경고가 아니라 오류다.
  const seen = new Map<string, string>();
  for (const c of [...compiled].sort((a, b) => cmp(a.key, b.key))) {
    const k = `${patternKey(c.pattern)}|${c.pathPrefix}`;
    const first = seen.get(k);
    if (first === undefined) seen.set(k, c.key);
    else {
      errors.push({
        kind: 'duplicate_match',
        route: c.key,
        message: `'${first}' 와 매치 조건이 같다 (${k}). nginx 가 중복 location 으로 거부한다.`,
      });
    }
  }

  // 오류가 있으면 순서를 내지 않는다 — 반쯤 컴파일된 순서는 거짓말이다.
  if (errors.length > 0) return { order: [], warnings: [], errors };

  // 호스트별 대표 priority. 같은 호스트의 라우트는 한 server 블록에 모이므로
  // 서로의 순서는 priority 가 아니라 **longest-prefix** 가 정한다 (E31).
  const hostPriority = new Map<string, number>();
  for (const c of compiled) {
    const k = patternKey(c.pattern);
    hostPriority.set(k, Math.max(hostPriority.get(k) ?? -Infinity, c.priority));
  }

  const order = [...compiled].sort(
    (a, b) =>
      CLASS_RANK[b.matchClass] - CLASS_RANK[a.matchClass] ||
      hostPriority.get(patternKey(b.pattern))! - hostPriority.get(patternKey(a.pattern))! ||
      b.pathPrefix.length - a.pathPrefix.length ||
      cmp(a.key, b.key),
  );

  return { order, warnings: analyze(order), errors };
}

function analyze(order: CompiledRoute[]): CompileWarning[] {
  const warnings: CompileWarning[] = [];

  // 1) 클래스 간 우선순위 역전 — 사용자가 기대한 순서와 엔진의 순서가 다르다.
  for (const hi of order) {
    for (const lo of order) {
      if (CLASS_RANK[hi.matchClass] <= CLASS_RANK[lo.matchClass]) continue;
      if (hi.priority >= lo.priority) continue;
      warnings.push({
        kind: 'priority_inversion',
        routes: [hi.key, lo.key],
        message:
          `'${hi.key}'(${hi.matchClass}, priority ${hi.priority}) 가 ` +
          `'${lo.key}'(${lo.matchClass}, priority ${lo.priority}) 보다 먼저 매칭된다. ` +
          `매치 클래스가 priority 를 이긴다.`,
      });
    }
  }

  // 2) 같은 호스트 안에서 priority 가 path 길이와 반대 방향이면 그 priority 는 무시된다.
  //    E31 로 실측: nginx location 은 선언 순서도 우리 priority 도 아닌 longest-prefix 다.
  //    조용히 다르게 동작하는 대신 경고한다.
  for (let i = 0; i < order.length; i += 1) {
    for (let j = i + 1; j < order.length; j += 1) {
      const a = order[i]!;
      const b = order[j]!;
      if (patternKey(a.pattern) !== patternKey(b.pattern)) continue;
      if (a.pathPrefix.length === b.pathPrefix.length) continue;
      // order 는 이미 longest-prefix 순이다. a 가 먼저인데 priority 가 더 낮다면
      // 사용자가 지정한 순서와 실제 동작이 어긋난다.
      if (a.priority < b.priority) {
        warnings.push({
          kind: 'path_priority_ignored',
          routes: [b.key, a.key].sort(cmp),
          message:
            `'${a.key}'(${a.pathPrefix}, priority ${a.priority}) 가 ` +
            `'${b.key}'(${b.pathPrefix}, priority ${b.priority}) 보다 먼저 매칭된다. ` +
            `같은 호스트 안에서는 priority 가 아니라 path 길이가 순서를 정한다.`,
        });
      }
    }
  }

  return warnings;
}

// ─────────────────────────────────────────────── strict_priority (S10) ──────
//
// §7.5-4 — *"이 모드는 충돌 그래프의 연결 요소 전체(정확일치 포함)를 anchored
// 정규식으로 내려 등장 순서로 정렬한다."*
//
// ── 왜 연결 요소 전체인가
//
// nginx 는 **정확일치 → 와일드카드 → 정규식** 순으로 본다(E20.1). 그 안에서 정규식만
// 등장 순서를 따른다(E20.3). 그러니 사용자의 priority 를 그대로 재현하려면 **겨루는
// 것들이 전부 정규식이어야** 한다 — 하나라도 정확일치로 남으면 그것이 무조건 먼저다.
//
// 한 쌍만 내리면 안 되는 이유가 그것이다. `a.example.com`(exact) 과 `*.example.com`
// (wildcard) 을 내렸는데 그 둘과 겨루는 셋째가 남아 있으면, 그 셋째는 여전히 앞
// 클래스라 두 정규식보다 **먼저** 평가된다. 그래서 **연결 요소 통째로** 내린다.
//
// ── 비용
//
// 정규식은 순차 평가다(§7.4). 내려간 호스트 수만큼 매 요청이 정규식을 훑는다 — 그래서
// 이 모드는 옵트인이고 §12.0 의 S10 이 "라우트 500개 p99 영향 < 5%" 를 요구한다.
// **필요한 것만 내린다**: 역전이 없는 연결 요소는 그대로 둔다.

/** 두 호스트 패턴이 **같은 호스트를 매치할 수 있는가**. */
export function patternsConflict(a: HostPattern, b: HostPattern): boolean {
  if (a.kind === 'exact' && b.kind === 'exact') return a.host === b.host;
  if (a.kind === 'wildcard' && b.kind === 'wildcard') return a.suffix === b.suffix;
  const host = a.kind === 'exact' ? a.host : (b as { kind: 'exact'; host: string }).host;
  const suffix = a.kind === 'wildcard' ? a.suffix : (b as { kind: 'wildcard'; suffix: string }).suffix;
  // 와일드카드는 **한 라벨**만 삼킨다 — nginx 자체는 다중 라벨을 삼키지만(E22.2) 우리는
  // 앵커 정규식(`~^[^.]+\.suffix$`)으로 좁혀 두었다. 여기서 그 계약과 같은 판정을 한다.
  if (!host.endsWith(`.${suffix}`)) return false;
  return !host.slice(0, host.length - suffix.length - 1).includes('.');
}

export type StrictPriorityPlan = {
  /** 정규식으로 내릴 호스트 패턴 키. */
  lowered: Set<string>;
  /** 내려간 것들의 **등장 순서**. 앞에 올수록 먼저 매치된다. */
  order: string[];
};

/**
 * `strict_priority` 계획을 세운다.
 *
 * 입력은 **호스트별 대표 priority** 다 — 같은 호스트의 라우트들은 한 server 블록에
 * 모이고 그 안의 순서는 longest-prefix 가 정하므로(E31), 호스트 사이의 겨룸만 여기서
 * 다룬다.
 *
 * 역전이 **하나도 없는** 연결 요소는 안 내린다. 내려 봐야 순서가 같고, 정규식은
 * 공짜가 아니다.
 */
export function planStrictPriority(
  hosts: readonly { key: string; pattern: HostPattern; priority: number }[],
): StrictPriorityPlan {
  // 연결 요소. 호스트 수는 수백 단위라 union-find 없이 훑는다.
  const adj: number[][] = hosts.map(() => []);
  for (let i = 0; i < hosts.length; i += 1) {
    for (let j = i + 1; j < hosts.length; j += 1) {
      if (!patternsConflict(hosts[i]!.pattern, hosts[j]!.pattern)) continue;
      adj[i]!.push(j);
      adj[j]!.push(i);
    }
  }

  const rankOf = (p: HostPattern): number =>
    CLASS_RANK[p.kind === 'exact' ? 'exact_host' : 'wildcard_host'];

  const seenIdx = new Set<number>();
  const lowered = new Set<string>();
  const loweredIdx: number[] = [];
  for (let s = 0; s < hosts.length; s += 1) {
    if (seenIdx.has(s)) continue;
    const comp: number[] = [];
    const stack = [s];
    seenIdx.add(s);
    while (stack.length > 0) {
      const cur = stack.pop()!;
      comp.push(cur);
      for (const nb of adj[cur]!) {
        if (seenIdx.has(nb)) continue;
        seenIdx.add(nb);
        stack.push(nb);
      }
    }
    // 이 요소 안에 **클래스가 priority 를 이기는 쌍**이 있는가.
    const inverted = comp.some((i) => comp.some((j) => {
      const a = hosts[i]!;
      const b = hosts[j]!;
      return rankOf(a.pattern) > rankOf(b.pattern) && a.priority < b.priority;
    }));
    if (!inverted) continue;
    for (const i of comp) {
      lowered.add(patternKey(hosts[i]!.pattern));
      loweredIdx.push(i);
    }
  }

  // 등장 순서 = priority 내림차순, 동점은 키로 갈라 **결정적**으로 만든다.
  loweredIdx.sort((x, y) =>
    hosts[y]!.priority - hosts[x]!.priority || cmp(hosts[x]!.key, hosts[y]!.key));
  return { lowered, order: loweredIdx.map((i) => patternKey(hosts[i]!.pattern)) };
}

/** 렌더가 쓰는 것과 **같은 키**. 두 벌을 두면 반드시 갈라진다. */
export const hostPatternKey = patternKey;

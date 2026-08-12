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

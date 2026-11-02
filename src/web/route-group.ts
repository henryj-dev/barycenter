/**
 * **경로별 묶음 → 라우트들** (2026-11-02).
 *
 * 사람은 한 호스트의 규칙을 이렇게 적고 싶다 — 「`/` 는 Cloudflare 에서 오면 444, `/count.js` · `/count` 는 풀로」:
 *
 *   경로 /                  출발지 @cloudflare   동작 reject 444
 *   경로 /count.js, /count  출발지 @cloudflare   동작 풀로 보내기
 *
 * 모델에는 이 모양이 따로 없다. 같은 뜻의 라우트 여럿으로 펼친다 — 모델 · 검증기 · 렌더러를 새로 짓지 않는다.
 *
 *   · **경로 묶음마다 라우트 하나.** 같은 경로 목록을 적은 줄끼리 한 라우트다.
 *   · 출발지가 있는 줄 → 그 라우트의 출발지 규칙(적은 순서대로). 출발지가 없는 줄 → 그 라우트의 기본 동작.
 *   · 기본 동작이 없으면 **리스너의 기본 동작**을 따른다 — 위 예에서 Cloudflare 밖(내부)은 풀로 간다. 저장할 때의 값을
 *     옮겨 적는다. 나중에 리스너 기본 동작을 바꾸면 이 라우트는 안 따라간다(화면이 말한다).
 *   · 한 경로가 서로 다른 묶음에 있으면 거절한다 — 같은 (호스트, 경로) 의 라우트가 둘이 되고, 검증기가 어차피 막는다.
 *     기본 동작을 두 번 적은 묶음도 거절한다.
 *   · 이름: 첫 묶음이 `이름`, 다음부터 `이름-p2`, `이름-p3` …
 */
import {
  putHttpRedirectPatch, putHttpRejectPatch, putHttpRoutePatch,
  type PutHttpRedirectOp, type PutHttpRejectOp, type PutHttpRouteOp,
  type RedirectStatus, type RejectStatus, type SourceRuleInput,
} from './edit.js';

export type GroupAction = SourceRuleInput['action'];

/** 묶음의 한 줄 — 경로 · 출발지(없으면 「그 밖」) · 동작. */
export type GroupLine = {
  /** 비면 `/` 다. */
  paths: string[];
  /** 비면 출발지를 안 가린다 — 그 경로의 기본 동작이다. */
  from: string[];
  address?: 'visitor' | 'connection';
  action: GroupAction;
};

export type RouteGroupInput = {
  key: string;
  listener: string;
  hosts: string[];
  lines: GroupLine[];
  /** 리스너의 기본 동작 — 기본 동작을 안 적은 묶음이 따른다. 없으면 그런 묶음을 거절한다. */
  fallback?: GroupAction;
};

/** 리스너 `http.defaultAction` → 묶음이 따를 동작. 리스너의 `reject` 는 444 로 끊는다. 모르는 모양이면 `undefined`. */
export function fallbackOfListener(defaultAction: unknown): GroupAction | undefined {
  if (defaultAction === 'reject') return { kind: 'reject', status: 444 };
  if (defaultAction !== null && typeof defaultAction === 'object' && typeof (defaultAction as { pool?: unknown }).pool === 'string') {
    return { kind: 'proxy', pool: (defaultAction as { pool: string }).pool, websocket: false };
  }
  return undefined;
}

const clean = (xs: readonly string[]): string[] => [...new Set(xs.map((x) => x.trim()).filter((x) => x !== ''))];

export function routeGroupPatch(input: RouteGroupInput): (PutHttpRouteOp | PutHttpRedirectOp | PutHttpRejectOp)[] {
  if (input.key.trim() === '') throw new Error('이름이 비어 있다');
  if (input.lines.length === 0) throw new Error('줄이 하나도 없다');

  // 경로 목록이 같은 줄끼리 묶는다. 순서는 처음 나온 순서다.
  const groups: { paths: string[]; lines: GroupLine[] }[] = [];
  const owner = new Map<string, number>();
  for (const line of input.lines) {
    const paths = clean(line.paths.length === 0 ? ['/'] : line.paths);
    const sig = [...paths].sort().join('\n');
    let gi = groups.findIndex((g) => [...g.paths].sort().join('\n') === sig);
    if (gi < 0) {
      for (const p of paths) {
        const other = owner.get(p);
        if (other !== undefined) {
          throw new Error(`경로 ${p} 가 서로 다른 묶음에 있다 — 같은 경로는 경로 목록을 똑같이 적어 한 묶음으로 모은다`);
        }
      }
      groups.push({ paths, lines: [] });
      gi = groups.length - 1;
      for (const p of paths) owner.set(p, gi);
    }
    groups[gi]!.lines.push({ ...line, paths, from: clean(line.from) });
  }

  return groups.flatMap((g, i): (PutHttpRouteOp | PutHttpRedirectOp | PutHttpRejectOp)[] => {
    const key = i === 0 ? input.key.trim() : `${input.key.trim()}-p${i + 1}`;
    const defaults = g.lines.filter((l) => l.from.length === 0);
    if (defaults.length > 1) throw new Error(`경로 ${g.paths.join(', ')} 에 출발지 없는 줄이 둘이다 — 그 경로의 기본 동작은 하나다`);
    const action = defaults[0]?.action ?? input.fallback;
    if (action === undefined) {
      throw new Error(`경로 ${g.paths.join(', ')} 의 기본 동작을 정할 수 없다 — 출발지 없는 줄을 하나 더한다`);
    }
    const sourceRules = g.lines.filter((l) => l.from.length > 0).map((l): SourceRuleInput => ({
      from: l.from, action: l.action, ...(l.address === 'connection' ? { address: 'connection' as const } : {}),
    }));
    const common = {
      key, listener: input.listener, hosts: input.hosts, pathPrefixes: g.paths,
      ...(sourceRules.length === 0 ? {} : { sourceRules }),
    };
    switch (action.kind) {
      case 'proxy': return putHttpRoutePatch({ ...common, pool: action.pool, websocket: action.websocket });
      case 'redirect': return putHttpRedirectPatch({ ...common, to: action.to, status: action.status as RedirectStatus });
      case 'reject': return putHttpRejectPatch({ ...common, status: action.status as RejectStatus });
    }
  });
}

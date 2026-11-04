/**
 * 라우트 폼의 칸 검사 · head 값 ↔ 폼 값 (#126 3단계 후속, 시안 `fieldsFor('routes')`).
 *
 * 만들기와 수정(설정 탭)이 같은 폼을 쓴다. 수정은 head 의 라우트를 폼 값으로 펴고(`httpRouteStateOf`), 저장할 때 만들기와
 * 같은 patch 빌더로 몸통을 다시 짓는다(`httpRouteBody`) — 모양 규칙이 한 자리다. 폼이 그리지 못하는 칸(출발지 규칙 동작의
 * 요청 헤더 · 경로 바꾸기)이 있으면 `lossy` 다 — 저장하면 그 칸이 사라지므로 폼은 저장을 막고 JSON 수정으로 보낸다.
 *
 * 칸 판정은 **서버가 쓰는 것을 그대로** 가져온다 — 호스트는 `parseHostPattern`(라우트 컴파일 `compileHostRoutes` 가 쓴다),
 * 경로는 `validatePathPrefix`(저장소가 쓴다). 두 벌로 두지 않는다. 노드 내장이 없는 모듈이라 브라우저에서도 돈다.
 * 시안의 `//` 규칙은 서버에 없으므로 두지 않는다. 문구는 해요체다 — patch 빌더의 해라체 오류를 사람에게 보이지 않으려고
 * 먼저 본다.
 *
 * `@web` 별칭 없이 상대 경로로 가져온다 — 루트 vitest · tsc 가 이 파일을 그대로 읽는다(`tests/unit/gui-route-form.test.ts`).
 */
import {
  putHttpRedirectPatch, putHttpRejectPatch, putHttpRoutePatch, putPassthroughRejectPatch, putPassthroughRoutePatch,
  type HeaderRuleInput, type RedirectStatus, type RejectStatus, type SourceRuleInput,
} from '../../../../src/web/edit.js';
import { parseHostPattern, validatePathPrefix } from '../../../../src/validate/strings.js';
import { fromTokens } from './source-rules';

// ── 칸 검사 ──────────────────────────────────────────────────────────────

export const HOST_REQUIRED = '호스트를 입력해요.';

/** 라우트 호스트 칸(쉼표 · 공백으로 여럿). 비면 `HOST_REQUIRED`. 맞으면 undefined. */
export const routeHostsError = (text: string): string | undefined => {
  const hs = fromTokens(text);
  if (hs.length === 0) return HOST_REQUIRED;
  return hs.every((h) => parseHostPattern(h).ok) ? undefined
    : '호스트는 정확한 이름이나 *.example.com 형태만 써요. 모든 호스트는 리스너의 기본 동작으로 정해요.';
};

/** 경로 접두사 칸(쉼표 · 공백으로 여럿). 비면 `/` 라 오류가 아니다. 앞 낱말의 오류를 먼저 말한다. */
export const routePathsError = (text: string): string | undefined => {
  const seen = new Set<string>();
  for (const p of fromTokens(text)) {
    if (!p.startsWith('/')) return `${p} · 경로는 /로 시작해요.`;
    if (!validatePathPrefix(p).ok) return `${p} · 경로에 쓸 수 없는 글자가 있어요. 영문, 숫자와 - . _ ~ ! $ & ' ( ) * + ; = : @ / % 만 써요.`;
    if (seen.has(p)) return `같은 경로를 두 번 적었어요: ${p}`;
    seen.add(p);
  }
  return undefined;
};

export const PRIORITY_HELP = '큰 값을 먼저 평가해요.';

/** 우선순위 — 해독기와 같은 범위(0–1000000 의 정수). 맞으면 undefined. */
export const priorityError = (v: string): string | undefined => {
  const t = v.trim();
  if (!/^\d+$/.test(t)) return '0 이상의 정수를 입력해요.';
  return Number(t) <= 1_000_000 ? undefined : '우선순위는 1000000까지예요.';
};

/**
 * 이 풀을 함께 쓰는 **다른** 라우트 수(시안 `shared`) — HTTP · 패스스루 라우트의 기본 동작이 이 풀인 것. 출발지 규칙의
 * 풀은 세지 않는다(시안과 같다).
 */
export const poolShareCount = (
  routes: readonly Record<string, unknown>[], pool: string | undefined, self?: string,
): number => (pool === undefined ? 0 : routes.filter((r) => {
  const a = r['action'] as { kind?: unknown; pool?: unknown } | undefined;
  return r['key'] !== self && a?.kind === 'proxy' && a.pool === pool;
}).length);

/** 시안 문구 — 「이 풀을 라우트 N개가 함께 써요. 풀을 바꾸면 모두 바뀌어요.」 N 은 이 라우트를 더한 수다. */
export const poolShareText = (others: number): string | undefined =>
  (others === 0 ? undefined : `이 풀을 라우트 ${others + 1}개가 함께 써요. 풀을 바꾸면 모두 바뀌어요.`);

// ── 출발지 규칙 행 ─────────────────────────────────────────────────────────

/** 폼의 규칙 한 줄(`SourceRulesField`). 저장할 때 `ruleInputsOf` 가 `SourceRuleInput` 으로 바꾼다. */
export type RuleRow = {
  from: string;
  /** 방문자 주소(realip 뒤) 또는 연결 주소(realip 전) — 2026-11-02. */
  address: 'visitor' | 'connection';
  kind: 'proxy' | 'redirect' | 'reject';
  pool: string | undefined;
  websocket: boolean;
  to: string;
  redirectStatus: string;
  rejectStatus: string;
};

/** 폼 줄 → 저장할 규칙. 대역이 빈 줄은 버린다(`sourceRulesOf` 가 한 번 더 거른다). */
export const ruleInputsOf = (rows: readonly RuleRow[]): SourceRuleInput[] => rows.flatMap((r): SourceRuleInput[] => {
  const from = fromTokens(r.from);
  if (from.length === 0) return [];
  const addr = r.address === 'connection' ? { address: 'connection' as const } : {};
  if (r.kind === 'proxy') return [{ from, ...addr, action: { kind: 'proxy', pool: r.pool ?? '', websocket: r.websocket } }];
  if (r.kind === 'redirect') return [{ from, ...addr, action: { kind: 'redirect', to: r.to.trim(), status: Number(r.redirectStatus) as RedirectStatus } }];
  return [{ from, ...addr, action: { kind: 'reject', status: Number(r.rejectStatus) as RejectStatus } }];
});

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** head 의 `sourceRules` → 폼 줄. 폼에 없는 칸(규칙 동작의 요청 헤더 · 경로 바꾸기)이 있으면 `lossy`. */
export const ruleRowsOf = (rules: unknown): { rows: RuleRow[]; lossy: boolean } => {
  let lossy = false;
  const rows = (Array.isArray(rules) ? rules : []).filter(isObj).map((r): RuleRow => {
    const a = isObj(r['action']) ? r['action'] : {};
    if (a['requestHeaders'] !== undefined || a['rewritePrefix'] !== undefined) lossy = true;
    const kind = a['kind'] === 'redirect' || a['kind'] === 'reject' ? a['kind'] : 'proxy';
    return {
      from: strs(r['from']).join(', '),
      address: r['address'] === 'connection' ? 'connection' : 'visitor',
      kind,
      pool: kind === 'proxy' && typeof a['pool'] === 'string' ? a['pool'] : undefined,
      websocket: a['websocket'] === true,
      to: kind === 'redirect' ? String(a['to'] ?? '') : '',
      redirectStatus: kind === 'redirect' ? String(a['status'] ?? '302') : '302',
      rejectStatus: kind === 'reject' ? String(a['status'] ?? '403') : '403',
    };
  });
  return { rows, lossy };
};

// ── HTTP 라우트 ────────────────────────────────────────────────────────────

export type HttpAction = 'proxy' | 'redirect' | 'reject';

/** HTTP 라우트 폼의 값. 글 칸은 사람이 적은 그대로다. */
export type HttpRouteState = {
  listener: string | undefined;
  hosts: string;
  pathPrefix: string;
  priority: string;
  action: HttpAction;
  pool: string | undefined;
  websocket: boolean;
  rewritePrefix: string;
  /** `KeyValueEditor` 의 행(`KvRow`) — 동작 칸은 없다. */
  headers: { op?: string; name: string; value: string }[];
  to: string;
  redirectStatus: string;
  rejectStatus: string;
  rules: RuleRow[];
};

/** head 의 HTTP 라우트 → 폼 값. 폼이 그리지 못하는 칸이 있으면 `lossy`. */
export const httpRouteStateOf = (item: Obj): { state: HttpRouteState; lossy: boolean } => {
  const a = isObj(item['action']) ? item['action'] : {};
  const action: HttpAction = a['kind'] === 'redirect' || a['kind'] === 'reject' ? a['kind'] : 'proxy';
  const paths = Array.isArray(item['pathPrefixes']) ? strs(item['pathPrefixes'])
    : typeof item['pathPrefix'] === 'string' ? [item['pathPrefix']] : [];
  const rules = ruleRowsOf(item['sourceRules']);
  return {
    lossy: rules.lossy,
    state: {
      listener: typeof item['listener'] === 'string' ? item['listener'] : undefined,
      hosts: strs(item['hosts']).join(', '),
      pathPrefix: paths.join(', '),
      priority: String(item['priority'] ?? 0),
      action,
      pool: action === 'proxy' && typeof a['pool'] === 'string' ? a['pool'] : undefined,
      websocket: a['websocket'] === true,
      rewritePrefix: typeof a['rewritePrefix'] === 'string' ? a['rewritePrefix'] : '',
      headers: (Array.isArray(a['requestHeaders']) ? a['requestHeaders'] : []).filter(isObj)
        .map((h) => ({ name: String(h['name'] ?? ''), value: String(h['value'] ?? '') })),
      to: action === 'redirect' ? String(a['to'] ?? '') : '',
      redirectStatus: action === 'redirect' ? String(a['status'] ?? '302') : '302',
      rejectStatus: action === 'reject' ? String(a['status'] ?? '403') : '403',
      rules: rules.rows,
    },
  };
};

/** 폼 값의 요청 헤더 → 저장할 규칙. 이름이 빈 행은 버린다. */
export const headerInputsOf = (rows: readonly { name: string; value: string }[]): HeaderRuleInput[] =>
  rows.filter((h) => h.name.trim() !== '').map((h) => ({ name: h.name.trim(), value: h.value }));

/**
 * 폼 값 → 라우트 몸통(key 를 뺀 모델 모양). 만들기와 같은 patch 빌더를 쓴다 — 모양 규칙이 한 자리다.
 * 칸 검사를 먼저 통과한 값만 넣는다. 빌더가 그래도 거절하면 그 오류가 그대로 던져진다.
 */
export const httpRouteBody = (key: string, s: HttpRouteState): Obj => {
  const paths = fromTokens(s.pathPrefix);
  const sourceRules = ruleInputsOf(s.rules);
  const base = {
    key, listener: s.listener ?? '', hosts: fromTokens(s.hosts), priority: Number(s.priority.trim()),
    ...(paths.length === 0 ? {} : { pathPrefixes: paths }),
    ...(sourceRules.length === 0 ? {} : { sourceRules }),
  };
  if (s.action === 'proxy') {
    const requestHeaders = headerInputsOf(s.headers);
    return putHttpRoutePatch({
      ...base, pool: s.pool ?? '', websocket: s.websocket,
      ...(s.rewritePrefix.trim() === '' ? {} : { rewritePrefix: s.rewritePrefix.trim() }),
      ...(requestHeaders.length === 0 ? {} : { requestHeaders }),
    })[0]!.body;
  }
  if (s.action === 'redirect') {
    return putHttpRedirectPatch({ ...base, to: s.to.trim(), status: Number(s.redirectStatus) as RedirectStatus })[0]!.body;
  }
  return putHttpRejectPatch({ ...base, status: Number(s.rejectStatus) as RejectStatus })[0]!.body;
};

// ── 패스스루 라우트 ─────────────────────────────────────────────────────────

export type PassthroughState = {
  listener: string | undefined;
  snis: string;
  priority: string;
  action: 'proxy' | 'reject';
  pool: string | undefined;
};

export const passthroughStateOf = (item: Obj): PassthroughState => {
  const a = isObj(item['action']) ? item['action'] : {};
  const action = a['kind'] === 'reject' ? 'reject' : 'proxy';
  return {
    listener: typeof item['listener'] === 'string' ? item['listener'] : undefined,
    snis: strs(item['snis']).join(', '),
    priority: String(item['priority'] ?? 0),
    action,
    pool: action === 'proxy' && typeof a['pool'] === 'string' ? a['pool'] : undefined,
  };
};

export const passthroughBody = (key: string, s: PassthroughState): Obj => {
  const base = { key, listener: s.listener ?? '', snis: fromTokens(s.snis), priority: Number(s.priority.trim()) };
  return s.action === 'reject' ? putPassthroughRejectPatch(base)[0]!.body
    : putPassthroughRoutePatch({ ...base, pool: s.pool ?? '' })[0]!.body;
};

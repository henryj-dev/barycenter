/**
 * GUI 리소스 표 — 상세 화면의 주소·탭·참조·트래픽 경로 (2026-10-30, 경로 분리 #124).
 *
 * **리소스마다 같은 틀이다.** 목록 `<base>`, 만들기 `<base>/new`, 상세 `<base>/<key>` 아래에
 * 탭이 붙는다. 탭은 리소스마다 뜻이 있는 것만 둔다(디자인 시안: 개요 / 설정 / … / 기록).
 * 주소에는 key 를 쓴다 — API·CLI 와 같은 이름이고, 복구 뒤에도 안 바뀐다.
 *
 * 서버(`serve-gui`)는 이 표에서 나온 패턴에만 셸을 낸다. GUI 의 라우트 파일도 이 표와
 * 같아야 한다 — 테스트(v10-open)가 둘을 맞춰 본다.
 */

export type ResourceKind =
  | 'listener' | 'httpRoute' | 'passthroughRoute' | 'pool' | 'backend' | 'addressSet'
  | 'certificate' | 'tlsPolicy' | 'sniBinding';

/** 탭 이름. 빈 문자열은 개요(상세의 첫 화면)다. */
export type TabSlug = '' | 'settings' | 'traffic' | 'resources' | 'history';

/** 탭이 아닌 상세 아래 화면 — 시안의 드로어. 라우트의 「URL로 다시 만들기」. */
export type DetailExtra = 'rebuild';

export type ResourceSpec = {
  kind: ResourceKind;
  /** 화면에 쓰는 이름. */
  label: string;
  /** 목록 주소. 상세는 `<base>/<key>`. */
  base: string;
  /** 모델의 컬렉션 이름 (`/api/v1/config/history` 의 kind 는 `kind` 그대로다). */
  collection: string;
  tabs: readonly { slug: TabSlug; label: string }[];
  /**
   * 설정 탭에서 고칠 수 있는가(시안: 「수정」 은 설정 탭으로 간다). 아니면 설정 탭은 보기만 한다.
   * 인증서는 자료를 다시 넣는 것이 수정이다 — 만들기 화면에서 한다.
   */
  editable: boolean;
  /** 탭 말고 상세 아래에 있는 화면. */
  extras: readonly DetailExtra[];
  /** `<base>/new` 가 있는가. */
  creatable: boolean;
};

const OVERVIEW = { slug: '', label: '개요' } as const;
const SETTINGS = { slug: 'settings', label: '설정' } as const;
const TRAFFIC = { slug: 'traffic', label: '트래픽 경로' } as const;
const RESOURCES_TAB = { slug: 'resources', label: '연결된 리소스' } as const;
const HISTORY = { slug: 'history', label: '기록' } as const;
/** 시안의 두 묶음 — 트래픽이 지나가는 리소스(리스너·라우트·풀)만 트래픽 경로 탭이 있다. */
const FLOW_TABS = [OVERVIEW, SETTINGS, TRAFFIC, RESOURCES_TAB, HISTORY] as const;
const PLAIN_TABS = [OVERVIEW, SETTINGS, RESOURCES_TAB, HISTORY] as const;

export const RESOURCES: Readonly<Record<ResourceKind, ResourceSpec>> = {
  listener: {
    kind: 'listener', label: '리스너', base: '/traffic/listener', collection: 'listeners',
    tabs: FLOW_TABS, editable: true, extras: [], creatable: true,
  },
  httpRoute: {
    kind: 'httpRoute', label: 'HTTP 라우트', base: '/traffic/route/http', collection: 'httpRoutes',
    tabs: FLOW_TABS, editable: true, extras: ['rebuild'], creatable: true,
  },
  passthroughRoute: {
    kind: 'passthroughRoute', label: '패스스루 라우트', base: '/traffic/route/passthrough', collection: 'passthroughRoutes',
    tabs: FLOW_TABS, editable: true, extras: [], creatable: true,
  },
  pool: {
    kind: 'pool', label: '풀', base: '/traffic/pool', collection: 'pools',
    tabs: FLOW_TABS, editable: true, extras: [], creatable: true,
  },
  backend: {
    kind: 'backend', label: '백엔드', base: '/traffic/backend', collection: 'backends',
    tabs: PLAIN_TABS, editable: true, extras: [], creatable: true,
  },
  addressSet: {
    kind: 'addressSet', label: '주소 집합', base: '/traffic/address-set', collection: 'addressSets',
    tabs: PLAIN_TABS, editable: true, extras: [], creatable: true,
  },
  certificate: {
    kind: 'certificate', label: '인증서', base: '/tls/certificate', collection: 'certificates',
    tabs: PLAIN_TABS, editable: false, extras: [], creatable: true,
  },
  tlsPolicy: {
    kind: 'tlsPolicy', label: 'TLS 정책', base: '/tls/policy', collection: 'tlsPolicies',
    tabs: PLAIN_TABS, editable: true, extras: [], creatable: true,
  },
  sniBinding: {
    kind: 'sniBinding', label: 'SNI 바인딩', base: '/tls/sni', collection: 'sniBindings',
    tabs: PLAIN_TABS, editable: true, extras: [], creatable: true,
  },
};

export const RESOURCE_KINDS = Object.keys(RESOURCES) as ResourceKind[];

/** 상세 주소. `tab` 이 없으면 개요. */
export function resourcePath(kind: ResourceKind, key: string, tab: TabSlug | DetailExtra = ''): string {
  const base = `${RESOURCES[kind].base}/${encodeURIComponent(key)}`;
  return tab === '' ? base : `${base}/${tab}`;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * 셸로 서빙할 상세 주소의 패턴. `new` 는 key 가 아니다(만들기 화면이 미리 만들어져 있다) —
 * 그래서 이름이 `new` 인 리소스는 상세 주소를 못 쓴다. 대신 목록에서 그렇다고 말한다.
 */
export function detailPattern(spec: ResourceSpec): RegExp {
  const tails = [...spec.tabs.map((t) => t.slug).filter((s) => s !== ''), ...spec.extras];
  const tail = tails.length === 0 ? '' : `(?:/(?:${tails.join('|')}))?`;
  return new RegExp(`^${escape(spec.base)}/(?!new(?:/|$))[^/]+${tail}$`);
}

// ── 모델 조각 ───────────────────────────────────────────────────────────────

export type Item = Readonly<Record<string, unknown>>;

/** GUI 가 들고 있는 head 모델 — 컬렉션마다 받은 그대로의 배열. */
export type ModelLike = Partial<Record<string, readonly Item[]>>;

export function itemsOf(model: ModelLike, kind: ResourceKind): readonly Item[] {
  return model[RESOURCES[kind].collection] ?? [];
}

export function itemOf(model: ModelLike, kind: ResourceKind, key: string): Item | undefined {
  return itemsOf(model, kind).find((i) => i['key'] === key);
}

const obj = (v: unknown): Record<string, unknown> | undefined =>
  (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v !== '' ? v : undefined);
const poolOf = (v: unknown): string | undefined => str(obj(v)?.['pool']);

// ── 참조 ────────────────────────────────────────────────────────────────────

export type Ref = { kind: ResourceKind; key: string };
export type Edge = { from: Ref; to: Ref; via: string };

/**
 * 모델 안의 **모든 참조**. 「연결된 리소스」 탭이 나가는 쪽(이것이 쓰는 것)과 들어오는 쪽
 * (이것을 쓰는 것)을 이 목록 하나에서 거른다. 검증기의 참조 규칙과 같은 필드를 본다.
 */
export function edgesOf(model: ModelLike): Edge[] {
  const out: Edge[] = [];
  const add = (from: Ref, kind: ResourceKind, key: string | undefined, via: string): void => {
    if (key !== undefined) out.push({ from, to: { kind, key }, via });
  };
  const sets = (from: Ref, list: unknown, via: string): void => {
    if (!Array.isArray(list)) return;
    for (const s of list) {
      if (typeof s === 'string' && s.startsWith('@')) add(from, 'addressSet', s.slice(1), via);
    }
  };
  for (const l of itemsOf(model, 'listener')) {
    const from: Ref = { kind: 'listener', key: String(l['key']) };
    add(from, 'pool', poolOf(obj(l['http'])?.['defaultAction']), '기본 동작');
    add(from, 'pool', str(l['defaultPool']), '기본 풀');
    add(from, 'pool', poolOf(l['onUnmatchedSni']), 'SNI 매칭 없음');
    add(from, 'pool', poolOf(l['onNoSni']), 'SNI 없음');
    add(from, 'tlsPolicy', str(obj(l['tls'])?.['policy']), 'TLS 정책');
    add(from, 'certificate', str(obj(l['tls'])?.['defaultCertificate']), '기본 인증서');
    sets(from, l['sourceAllow'], '출발지 제한');
    sets(from, obj(l['acceptProxyProtocol'])?.['trustedCidrs'], 'PROXY 수신');
    sets(from, obj(l['realIpFromHeader'])?.['trustedCidrs'], '원본 IP 헤더');
  }
  for (const kind of ['httpRoute', 'passthroughRoute'] as const) {
    for (const r of itemsOf(model, kind)) {
      const from: Ref = { kind, key: String(r['key']) };
      add(from, 'listener', str(r['listener']), '리스너');
      add(from, 'pool', poolOf(r['action']), '프록시');
    }
  }
  for (const b of itemsOf(model, 'backend')) {
    add({ kind: 'backend', key: String(b['key']) }, 'pool', str(b['pool']), '풀');
  }
  for (const p of itemsOf(model, 'pool')) {
    add({ kind: 'pool', key: String(p['key']) }, 'certificate', str(obj(p['upstreamTls'])?.['caBundle']), '업스트림 CA');
  }
  for (const s of itemsOf(model, 'sniBinding')) {
    const from: Ref = { kind: 'sniBinding', key: String(s['key']) };
    add(from, 'listener', str(s['listener']), '리스너');
    add(from, 'certificate', str(s['certificate']), '인증서');
  }
  return out;
}

const same = (a: Ref, b: Ref): boolean => a.kind === b.kind && a.key === b.key;

/** 「연결된 리소스」 — 이것이 쓰는 것과 이것을 쓰는 것. 없는 대상은 `missing` 으로 표시한다. */
export function relationsOf(model: ModelLike, ref: Ref): {
  uses: (Edge & { missing: boolean })[];
  usedBy: Edge[];
} {
  const edges = edgesOf(model);
  return {
    uses: edges.filter((e) => same(e.from, ref))
      .map((e) => ({ ...e, missing: itemOf(model, e.to.kind, e.to.key) === undefined })),
    usedBy: edges.filter((e) => same(e.to, ref)),
  };
}

// ── 트래픽 경로 ─────────────────────────────────────────────────────────────

export type BackendHop = { key: string; target: string; weight: number; health: string };
export type Target =
  | { kind: 'pool'; pool: string; backends: BackendHop[]; missing: boolean }
  | { kind: 'redirect'; to: string; status: number }
  | { kind: 'reject'; status?: number };

export type TrafficLine = {
  /** 무엇이 이 줄을 고르는가 — 기본 동작, 라우트 key, SNI 결과 … */
  match: string;
  route?: Ref;
  /** 풀의 트래픽 경로에서 — 이 줄이 어느 리스너에서 오나. */
  listener?: string;
  target: Target;
};

export type HealthOf = (backendKey: string) => string;

const targetOfPool = (model: ModelLike, pool: string, health: HealthOf): Target => ({
  kind: 'pool',
  pool,
  missing: itemOf(model, 'pool', pool) === undefined,
  backends: itemsOf(model, 'backend').filter((b) => b['pool'] === pool).map((b) => ({
    key: String(b['key']),
    target: `${String(b['host'])}:${String(b['port'])}`,
    weight: typeof b['weight'] === 'number' ? b['weight'] : 1,
    health: health(String(b['key'])),
  })),
});

const targetOfAction = (model: ModelLike, action: unknown, health: HealthOf): Target => {
  const a = obj(action);
  if (a?.['kind'] === 'proxy' && typeof a['pool'] === 'string') return targetOfPool(model, a['pool'], health);
  if (a?.['kind'] === 'redirect') return { kind: 'redirect', to: String(a['to']), status: Number(a['status']) };
  return { kind: 'reject', ...(typeof a?.['status'] === 'number' ? { status: a['status'] } : {}) };
};

const outcomeTarget = (model: ModelLike, v: unknown, health: HealthOf): Target => {
  const pool = poolOf(v);
  return pool === undefined ? { kind: 'reject' } : targetOfPool(model, pool, health);
};

const routeMatch = (r: Item): string => {
  const hosts = Array.isArray(r['hosts']) ? r['hosts'] as string[] : Array.isArray(r['snis']) ? r['snis'] as string[] : [];
  // 경로가 여럿이면 `{a,b}` 로 묶는다 — 한 줄에 라우트 하나다.
  const many = Array.isArray(r['pathPrefixes']) ? (r['pathPrefixes'] as unknown[]).filter((p): p is string => typeof p === 'string') : [];
  const path = many.length > 1 ? `{${many.join(',')}}` : many.length === 1 ? many[0]! : typeof r['pathPrefix'] === 'string' ? r['pathPrefix'] : '';
  return `${hosts.join(', ') || '*'}${path}`;
};

/**
 * **이 리소스로 들어온 요청이 어디로 가나.** 리스너는 라우트를 우선순위 순서로 먼저 싣고,
 * 그다음 기본 동작을 싣는다. 라우트는 자기 한 줄이다. 엔진의 실제 평가 순서(매치 클래스)는
 * 라우트 화면의 「엔진이 보는 순서」 가 정본이다 — 여기서는 우선순위만 쓴다.
 */
export function trafficOf(model: ModelLike, ref: Ref, health: HealthOf): TrafficLine[] {
  if (ref.kind === 'httpRoute' || ref.kind === 'passthroughRoute') {
    const r = itemOf(model, ref.kind, ref.key);
    if (r === undefined) return [];
    return [{ match: routeMatch(r), route: ref, target: targetOfAction(model, r['action'], health) }];
  }
  if (ref.kind === 'pool') {
    // 풀은 「어디서 이 풀로 오나」 다 — 모든 리스너의 경로 중 이 풀로 가는 줄. 앞에 리스너 이름을 붙인다.
    return itemsOf(model, 'listener').flatMap((li) => trafficOf(model, { kind: 'listener', key: String(li['key']) }, health)
      .filter((line) => line.target.kind === 'pool' && line.target.pool === ref.key)
      .map((line) => ({ ...line, match: `${String(li['key'])} · ${line.match}`, listener: String(li['key']) })));
  }
  if (ref.kind !== 'listener') return [];
  const l = itemOf(model, 'listener', ref.key);
  if (l === undefined) return [];
  const routeKind = l['protocol'] === 'tls_passthrough' ? 'passthroughRoute' : 'httpRoute';
  const routes = itemsOf(model, routeKind).filter((r) => r['listener'] === ref.key)
    .slice().sort((a, b) => Number(b['priority'] ?? 0) - Number(a['priority'] ?? 0)
      || String(a['key']).localeCompare(String(b['key'])));
  const lines: TrafficLine[] = routes.map((r) => ({
    match: routeMatch(r),
    route: { kind: routeKind, key: String(r['key']) },
    target: targetOfAction(model, r['action'], health),
  }));
  const protocol = l['protocol'];
  if (protocol === 'http' || protocol === 'https') {
    lines.push({ match: '기본 동작 (맞는 라우트 없음)', target: outcomeTarget(model, obj(l['http'])?.['defaultAction'], health) });
  } else if (protocol === 'tcp' || protocol === 'udp') {
    const pool = str(l['defaultPool']);
    lines.push({ match: '모든 연결', target: pool === undefined ? { kind: 'reject' } : targetOfPool(model, pool, health) });
  } else if (protocol === 'tls_passthrough') {
    lines.push({ match: 'SNI 매칭 없음', target: outcomeTarget(model, l['onUnmatchedSni'], health) });
    lines.push({ match: 'SNI 없음', target: outcomeTarget(model, l['onNoSni'], health) });
  }
  return lines;
}

// ── 설정 펼치기 ─────────────────────────────────────────────────────────────

/**
 * 설정 탭 — 항목의 **모든 칸**을 `a.b[0].c` 경로로 편다. 리소스마다 화면을 따로 짜지 않아도
 * 모르는 칸 없이 다 보인다. `key` 는 제목에 있으므로 뺀다.
 */
export function flattenFields(item: Item): { path: string; value: string }[] {
  const out: { path: string; value: string }[] = [];
  const walk = (v: unknown, path: string): void => {
    if (Array.isArray(v)) {
      if (v.length === 0) out.push({ path, value: '[]' });
      else if (v.every((x) => typeof x !== 'object' || x === null)) out.push({ path, value: v.map(String).join(', ') });
      else v.forEach((x, i) => walk(x, `${path}[${i}]`));
    } else if (typeof v === 'object' && v !== null) {
      const entries = Object.entries(v);
      if (entries.length === 0) out.push({ path, value: '{}' });
      for (const [k, x] of entries) walk(x, path === '' ? k : `${path}.${k}`);
    } else {
      out.push({ path, value: String(v) });
    }
  };
  for (const [k, v] of Object.entries(item)) if (k !== 'key') walk(v, k);
  return out;
}

/** 기록 탭 — 두 판 사이에 바뀐 칸. 없던 칸은 before 가, 사라진 칸은 after 가 비어 있다. */
export function diffFields(before: Item | null, after: Item | null): { path: string; before?: string; after?: string }[] {
  const a = new Map((before === null ? [] : flattenFields(before)).map((f) => [f.path, f.value]));
  const b = new Map((after === null ? [] : flattenFields(after)).map((f) => [f.path, f.value]));
  const paths = [...new Set([...a.keys(), ...b.keys()])].sort();
  return paths.filter((p) => a.get(p) !== b.get(p)).map((p) => ({
    path: p,
    ...(a.has(p) ? { before: a.get(p)! } : {}),
    ...(b.has(p) ? { after: b.get(p)! } : {}),
  }));
}

/**
 * 개요 탭의 첫 줄들 — 리소스마다 사람이 먼저 보는 칸. 리스너는 `detailOfListener` 가 따로 한다.
 * 여기 없는 칸은 설정 탭이 다 보여 준다.
 */
export function summaryOf(kind: ResourceKind, item: Item): { label: string; value: string }[] {
  const lines: { label: string; value: string }[] = [];
  const add = (label: string, v: unknown): void => {
    if (v === undefined || v === null || v === '') return;
    lines.push({ label, value: Array.isArray(v) ? v.map(String).join(', ') : typeof v === 'object' ? JSON.stringify(v) : String(v) });
  };
  const action = obj(item['action']);
  const actionText = (): string | undefined => {
    if (action === undefined) return undefined;
    if (action['kind'] === 'proxy') return `프록시 → 풀 ${String(action['pool'])}`;
    if (action['kind'] === 'redirect') return `redirect ${String(action['status'])} → ${String(action['to'])}`;
    if (action['kind'] === 'reject') return `거절${action['status'] === undefined ? '' : ` ${String(action['status'])}`}`;
    return undefined;
  };
  switch (kind) {
    case 'httpRoute':
      add('리스너', item['listener']); add('호스트', item['hosts']); add('경로', item['pathPrefixes'] ?? item['pathPrefix'] ?? '/');
      add('우선순위', item['priority']); add('동작', actionText());
      break;
    case 'passthroughRoute':
      add('리스너', item['listener']); add('SNI', item['snis']); add('우선순위', item['priority']); add('동작', actionText());
      break;
    case 'pool':
      add('프로토콜 계열', item['protocolClass']); add('알고리즘', item['algorithm']); add('hash 키', item['hashKey']);
      add('헬스체크', item['healthCheck'] === undefined ? '없음' : '있음');
      add('업스트림 TLS', obj(item['upstreamTls'])?.['enabled'] === true ? '켜짐' : '꺼짐');
      break;
    case 'backend':
      add('풀', item['pool']); add('주소', `${String(item['host'])}:${String(item['port'])}`); add('가중치', item['weight']);
      add('백업', item['isBackup'] === true ? '예' : undefined);
      break;
    case 'addressSet':
      add('대역 수', Array.isArray(item['cidrs']) ? item['cidrs'].length : 0); add('출처', item['source'] ?? '손으로 적음');
      break;
    case 'certificate':
      add('발급', item['acme'] === undefined ? '자료 업로드' : 'ACME'); add('체인 digest', item['chainDigest']);
      break;
    case 'tlsPolicy':
      add('최소 버전', item['minVersion']); add('최대 버전', item['maxVersion']); add('SNI-Host 불일치', item['sniHostMismatch']);
      add('HSTS', item['hsts'] === undefined ? '꺼짐' : '켜짐');
      break;
    case 'sniBinding':
      add('리스너', item['listener']); add('호스트', item['hosts']); add('인증서', item['certificate']);
      break;
    case 'listener':
      break;
  }
  return lines;
}

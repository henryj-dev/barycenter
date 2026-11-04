/**
 * **변경 설명** — 기록 화면과 대시보드 「최근 변경」 의 「작업」 · 「대상」 칸(시안 `백엔드 demo-2 추가` · `pool web-pool`).
 *
 * 감사 줄은 changeset id 만 준다. 화면이 `GET /api/v1/changesets/:id` 의 patch 와 첫 리소스의 기록
 * (`GET /api/v1/config/history?kind&key`)을 읽어 여기에 넘긴다. 이 파일은 순수 함수만 둔다(룬 · Svelte 없음) —
 * 시험이 바로 부른다(`tests/unit/gui-ops-change-title.test.ts`). 별칭(`@web`)을 안 쓴다 — 저장소 루트 `tsc` 와 시험이 모른다.
 *
 * 설명을 못 만들면 undefined 다. 그러면 화면은 지금 글(「설정 변경」 · 「changeset <id>」)을 그대로 쓴다.
 */
import { RESOURCES, diffFields, type Item, type ResourceKind } from '../../../../src/web/resources';

export type ChangeOp = { op: 'put' | 'delete'; kind: string; key: string; body?: unknown };
export type ChangesetFacts = { baseRevision: string; committedRevision: string | undefined; patch: ChangeOp[] };
/** 첫 리소스가 changeset 의 바탕 리비전에 있었는가 · 그때 내용 · 바뀐 뒤 내용(모델 모양). */
export type FirstState = { existed: boolean; before?: Item | null; after?: Item | null };
export type ChangeTitle = { title: string; target: string };

const isKind = (k: string): k is ResourceKind => Object.hasOwn(RESOURCES, k);
const rec = (v: unknown): Record<string, unknown> | undefined =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined;
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : undefined);

/** `GET /api/v1/changesets/:id` 의 몸. 모양이 다르면 undefined. */
export function parseChangeset(body: unknown): ChangesetFacts | undefined {
  const b = rec(body);
  const base = str(b?.['base_revision']);
  if (b === undefined || base === undefined || !Array.isArray(b['patch'])) return undefined;
  const patch: ChangeOp[] = [];
  for (const x of b['patch']) {
    const o = rec(x);
    const op = o?.['op'];
    const kind = str(o?.['kind']);
    const key = str(o?.['key']);
    if ((op !== 'put' && op !== 'delete') || kind === undefined || key === undefined) return undefined;
    patch.push({ op, kind, key, ...(o!['body'] === undefined ? {} : { body: o!['body'] }) });
  }
  return { baseRevision: base, committedRevision: str(b['committed_revision']), patch };
}

/**
 * patch 의 리소스들 — 같은 리소스를 두 번 고쳤으면 하나로(마지막 op 가 남는다). 순서는 처음 나온 순서다.
 */
export function resourcesOf(patch: readonly ChangeOp[]): ChangeOp[] {
  const by = new Map<string, ChangeOp>();
  for (const op of patch) by.set(`${op.kind}\u0000${op.key}`, op);
  return [...by.values()];
}

/**
 * 첫 리소스의 기록(`config/history`, 새것부터)에서 바탕 리비전 때의 모습을 찾는다.
 *   - 이 changeset 이 커밋한 줄이 있으면 그 줄의 전 · 후를 쓴다(서버가 모델끼리 비교한 값).
 *   - 아니면 바탕 리비전 이하의 마지막 줄이 그때 모습이다(삭제면 없었다).
 *   - 그런 줄이 없으면 — 기록이 창 안에 다 들어왔을 때(맨 앞이 `earliest` 가 아니고 꽉 차지 않았을 때)만 「없었다」 다.
 *     아니면 모른다(undefined).
 */
export function stateAtBase(history: readonly unknown[], changesetId: string, cs: ChangesetFacts, limit = 50): FirstState | undefined {
  const rows = history.map(rec).filter((r): r is Record<string, unknown> => r !== undefined);
  const mine = rows.find((r) => r['changeset'] === changesetId
    || (cs.committedRevision !== undefined && str(r['revision']) === cs.committedRevision));
  if (mine !== undefined) {
    const change = mine['change'];
    if (change === 'earliest') return undefined;
    const before = (rec(mine['before']) ?? null) as Item | null;
    const after = (rec(mine['after']) ?? null) as Item | null;
    return { existed: change !== 'created', before, after };
  }
  const base = Number(cs.baseRevision);
  const at = rows.find((r) => Number(str(r['revision'])) <= base);
  if (at !== undefined) {
    if (at['change'] === 'deleted') return { existed: false, before: null };
    return { existed: true, before: (rec(at['after']) ?? null) as Item | null };
  }
  const complete = rows.length < limit && !rows.some((r) => r['change'] === 'earliest');
  return complete ? { existed: false, before: null } : undefined;
}

/** 시안의 영문 kind 표기(대상 칸). */
const SHORT: Record<ResourceKind, string> = {
  listener: 'listener', httpRoute: 'route', passthroughRoute: 'route', pool: 'pool', backend: 'backend',
  addressSet: 'address-set', certificate: 'cert', tlsPolicy: 'tls-policy', sniBinding: 'sni',
};
/** 새로 생긴 것 — 시안은 백엔드 · 라우트를 「추가」, 인증서처럼 혼자 서는 것은 「만들기」 라 쓴다. */
const ADDED = new Set<ResourceKind>(['backend', 'httpRoute', 'passthroughRoute']);
/** 인증서의 자료가 바뀌면 「갱신」 이다(시안 `인증서 api.example.com 갱신`). */
const MATERIAL = /^(materialRef|chainDigest|keyDigest)$/;

/** 대상 칸 — 백엔드는 속한 풀(시안 `pool web-pool`), 나머지는 자기. */
function targetOf(op: ChangeOp & { kind: ResourceKind }, first: FirstState | undefined): string {
  if (op.kind === 'backend') {
    const pool = str(rec(op.body)?.['pool']) ?? str(first?.after?.['pool']) ?? str(first?.before?.['pool']);
    if (pool !== undefined) return `pool ${pool}`;
  }
  return `${SHORT[op.kind]} ${op.key}`;
}

/**
 * patch(+첫 리소스가 있었는지) → 작업 · 대상.
 *
 *   - 삭제는 「<종류> <key> 삭제」, 없던 것은 「추가」 · 「만들기」.
 *   - 있던 것을 고쳤으면 「수정」. 칸 하나만 바뀌었으면 「<칸> <전> → <후>」 (enabled 는 「활성화」 · 「비활성화」).
 *   - 여러 리소스면 「<첫째> 외 N건」.
 * 첫 리소스를 고쳤는데 있었는지 모르면 undefined — 「추가」 인지 「수정」 인지 지어내지 않는다.
 */
/**
 * 칸 경로 → 사람 말 이름 · 단위(시안 「리스너 web-https 타임아웃 60s → 90s」). 마지막 이름으로 고르고, 출발지 규칙 안이면
 * 「출발지 규칙 」 을 앞에 붙인다. 표에 없는 칸은 undefined — 내부 이름을 보이지 않고 「수정」 이라 쓴다.
 */
const FIELD: Record<string, { l: string; u?: string }> = {
  connectTimeoutS: { l: '연결 타임아웃', u: 's' }, readTimeoutS: { l: '타임아웃', u: 's' }, sendTimeoutS: { l: '쓰기 타임아웃', u: 's' },
  connectTimeoutMs: { l: '연결 타임아웃', u: 'ms' }, readTimeoutMs: { l: '타임아웃', u: 'ms' }, sendTimeoutMs: { l: '쓰기 타임아웃', u: 'ms' },
  weight: { l: '가중치' }, port: { l: '포트' }, host: { l: '호스트' }, bind: { l: '바인드 주소' }, algorithm: { l: '알고리즘' },
  priority: { l: '우선순위' }, pool: { l: '풀' }, status: { l: '응답 코드' }, minVersion: { l: '최소 버전' }, maxVersion: { l: '최대 버전' },
  policy: { l: 'TLS 정책' }, certificate: { l: '인증서' }, listener: { l: '리스너' }, to: { l: 'URL' }, websocket: { l: 'WebSocket' },
  interval: { l: '헬스체크 주기' }, path: { l: '경로' },
};
export const fieldLabel = (path: string): { l: string; u?: string } | undefined => {
  const last = path.replace(/\[\d+\]/g, '').split('.').pop() ?? '';
  const f = FIELD[last];
  if (f === undefined) return undefined;
  return path.startsWith('sourceRules') ? { ...f, l: `출발지 규칙 ${f.l}` } : f;
};
const unitOf = (v: string | undefined, u: string | undefined): string => (v === undefined ? '없음' : u === undefined ? v : `${v}${u}`);

export function describeChange(patch: readonly ChangeOp[], first: FirstState | undefined): ChangeTitle | undefined {
  const all = resourcesOf(patch);
  const op = all[0];
  if (op === undefined || !isKind(op.kind)) return undefined;
  const kind = op.kind;
  const name = `${RESOURCES[kind].label} ${op.key}`;
  let title: string;
  if (op.op === 'delete') title = `${name} 삭제`;
  else if (first === undefined) return undefined;
  else if (!first.existed) title = `${name} ${ADDED.has(kind) ? '추가' : '만들기'}`;
  else {
    const after = first.after ?? (rec(op.body) as Item | undefined) ?? null;
    const diff = first.before === undefined ? [] : diffFields(first.before, after);
    const one = diff.length === 1 ? diff[0]! : undefined;
    if (kind === 'certificate' && diff.some((d) => MATERIAL.test(d.path))) title = `${name} 갱신`;
    else if (one?.path === 'enabled' && (one.after === 'false' || one.after === 'true')) title = `${name} ${one.after === 'false' ? '비활성화' : '활성화'}`;
    else if (one !== undefined) {
      const f = fieldLabel(one.path);
      title = f === undefined ? `${name} 수정` : `${name} ${f.l} ${unitOf(one.before, f.u)} → ${unitOf(one.after, f.u)}`;
    }
    else title = `${name} 수정`;
  }
  const more = all.length - 1;
  return { title: more > 0 ? `${title} 외 ${more}건` : title, target: targetOf({ ...op, kind }, first) };
}

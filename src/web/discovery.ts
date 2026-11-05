/**
 * 풀의 「백엔드 출처」 폼 (2026-11-05). GUI 풀 설정 · CLI `bary pool discovery` 가 같은 규칙을 쓴다.
 *
 * 모양 규칙(출처마다 query 의 모양 · 포트 범위)은 해독기가 진다. 여기서는 사람이 고칠 수 있게 먼저 말할 뿐이고,
 * 다른 규칙을 짓지 않는다 — 폼이 통과시킨 것을 해독기가 막으면 해독기의 말이 화면에 나온다.
 */
import { DISCOVERY_SOURCE_KINDS, type DiscoverySourceKind, type PoolDiscovery } from '../model/provisional.js';

/** 폼 칸. `source: 'static'` 은 칸이 없는 것(정적)이다. 문자열은 빈 문자열이 「없음」 이다. */
export type DiscoveryForm = {
  source: 'static' | DiscoverySourceKind;
  query: string;
  port: string;
  emptyMeans: 'keep' | 'empty';
};

export const DISCOVERY_STATIC: DiscoveryForm = { source: 'static', query: '', port: '', emptyMeans: 'keep' };

/** 화면 · CLI 도움말에 쓰는 이름과 query 의 예. */
export const DISCOVERY_SOURCES: readonly { value: DiscoverySourceKind; label: string; query: string; example: string }[] = [
  { value: 'dns-srv', label: 'DNS SRV', query: 'SRV 이름', example: '_http._tcp.api.internal' },
  { value: 'consul', label: 'Consul', query: '서비스 이름', example: 'api' },
  { value: 'kubernetes', label: 'Kubernetes', query: '네임스페이스/서비스', example: 'prod/api' },
  { value: 'file', label: '파일 (시험 · 수동)', query: '파일 이름', example: 'api.json' },
];

const obj = (v: unknown): Record<string, unknown> | undefined =>
  (typeof v === 'object' && v !== null && !Array.isArray(v) ? v as Record<string, unknown> : undefined);

/** 모델의 풀 하나 → 폼 칸. */
export function discoveryFormOf(pool: Readonly<Record<string, unknown>> | undefined): DiscoveryForm {
  const d = obj(pool?.['discovery']);
  const source = d?.['source'];
  if (d === undefined || typeof source !== 'string' || !(DISCOVERY_SOURCE_KINDS as readonly string[]).includes(source)) {
    return { ...DISCOVERY_STATIC };
  }
  return {
    source: source as DiscoverySourceKind,
    query: typeof d['query'] === 'string' ? d['query'] : '',
    port: typeof d['port'] === 'number' ? String(d['port']) : '',
    emptyMeans: d['emptyMeans'] === 'empty' ? 'empty' : 'keep',
  };
}

/** 폼이 저장을 막는 이유. 없으면 undefined. */
export function discoveryIssue(f: DiscoveryForm): string | undefined {
  if (f.source === 'static') return undefined;
  const q = f.query.trim();
  if (q === '') return `${DISCOVERY_SOURCES.find((s) => s.value === f.source)?.query ?? 'query'}을 입력해요.`;
  if (f.source === 'kubernetes' && !/^[^/]+\/[^/]+$/.test(q)) return '「네임스페이스/서비스」 모양으로 입력해요. 예: prod/api';
  if (f.source === 'file' && /[/\\]|^\./.test(q)) return '파일 이름만 입력해요. 디렉터리는 데몬 설정(BARY_DISCOVERY_FILE_DIR)이 정해요.';
  const p = f.port.trim();
  if (p !== '' && !(/^\d+$/.test(p) && Number(p) >= 1 && Number(p) <= 65535)) return '포트는 1~65535 사이 숫자예요.';
  return undefined;
}

/** 폼 칸 → 모델 칸. 정적이면 undefined. 틀리면 던진다(`discoveryIssue` 의 글). */
export function discoveryOf(f: DiscoveryForm): PoolDiscovery | undefined {
  if (f.source === 'static') return undefined;
  const issue = discoveryIssue(f);
  if (issue !== undefined) throw new Error(issue);
  const p = f.port.trim();
  return {
    source: f.source,
    query: f.query.trim(),
    ...(p === '' ? {} : { port: Number(p) }),
    // 기본(keep)은 안 싣는다 — 안 적은 것과 같은 뜻이다.
    ...(f.emptyMeans === 'empty' ? { emptyMeans: 'empty' as const } : {}),
  };
}

/**
 * 풀 정의를 통째로 다시 쓸 body — `discovery` 만 바꾸고 나머지 칸은 그대로 둔다. 정적으로 돌리면 칸을 지운다.
 * `key` 는 body 에 안 싣는다(put 의 key 가 따로 있다).
 */
export function poolBodyWithDiscovery(
  pool: Readonly<Record<string, unknown>>, f: DiscoveryForm,
): Record<string, unknown> {
  const { key: _key, discovery: _old, ...rest } = pool;
  const d = discoveryOf(f);
  return { ...rest, ...(d === undefined ? {} : { discovery: d }) };
}

/**
 * CLI 읽기 — DESIGN.md §5.2 · §5.6
 *
 * 있는 GET 만 연다. 모르는 이름은 호출하지 않는다.
 */
import { unwrap, type Http } from './flow.js';

const LISTS = new Set([
  'listeners',
  'pools',
  'backends',
  'routes',
  'certificates',
  'tls-policies',
  'sni-bindings',
  'address-sets',
  // 주소 집합 「마지막 갱신」 · 풀의 백엔드 출처 (2026-11-05).
  'address-sets/refresh-status',
  'discovery',
  // 클러스터 노드 (ADR-CLUSTER, #118).
  'cluster/nodes',
  // 이 설정이 점유하는 (전송, 주소, 포트) 전부 — 배포가 열어야 할 것 (§11.3).
  'sockets',
  // 저장소 상태 — DB 종류 · 보존 정책 · 마지막 청소 (2026-11-20).
  'system/storage',
  // 엔진 전역 설정 · ACME 계정 (2026-11-21).
  'engine',
  'acme/accounts',
  // 변경 초안(커밋 전 changeset) · 최근 전환 (2026-11-21).
  'changesets',
  'operations',
]);

export function getPath(what: string): string | undefined {
  if (what === '') return undefined;
  if (what === 'model' || what === 'rendered') return `/api/v1/config/${what}`;
  if (what === 'health' || what === 'health/backends') return '/api/v1/health/backends';
  // 왜 이 백엔드가 트래픽을 안 받나 — 한 번에 (제안 #9).
  if (what === 'backends/status') return '/api/v1/backends/status';
  if (LISTS.has(what)) return `/api/v1/${what}`;
  if (what === 'metrics') return '/metrics';
  // 알림 설정 · 보낸 기록 (036, 2026-11-20). 읽기만 — 고치기는 화면에서 한다(비밀을 명령줄에 싣지 않게). admin 토큰.
  if (what === 'notify') return '/api/v1/notify';
  if (what === 'notify/deliveries') return '/api/v1/notify/deliveries';
  // 액세스 로그 (2026-11-22). `access-log` 는 최근 줄, `access-log/<id>` 는 한 줄이다.
  if (what === 'access-log') return '/api/v1/access-log';
  const accessOne = /^access-log\/(.+)$/.exec(what);
  if (accessOne?.[1] !== undefined) return `/api/v1/access-log/${encodeURIComponent(accessOne[1])}`;
  // 트래픽 통계 (2026-11-20). `traffic` · `traffic/<종류>` · `traffic/<종류>/<이름>`.
  if (what === 'traffic') return '/api/v1/traffic';
  const trafficKind = /^traffic\/([A-Za-z]+)$/.exec(what);
  if (trafficKind?.[1] !== undefined) return `/api/v1/traffic?kind=${encodeURIComponent(trafficKind[1])}`;
  const trafficOne = /^traffic\/([A-Za-z]+)\/(.+)$/.exec(what);
  if (trafficOne?.[1] !== undefined && trafficOne[2] !== undefined) {
    return `/api/v1/traffic/${encodeURIComponent(trafficOne[1])}/${encodeURIComponent(trafficOne[2])}`;
  }
  // 클러스터 노드 하나의 최근 적용 기록 (#120).
  const nodeHist = /^cluster\/nodes\/([^/]+)\/history$/.exec(what);
  if (nodeHist?.[1] !== undefined) return `/api/v1/cluster/nodes/${encodeURIComponent(nodeHist[1])}/history`;
  const disc = /^pools\/([^/]+)\/discovery$/.exec(what);
  if (disc?.[1] !== undefined) return `/api/v1/pools/${encodeURIComponent(disc[1])}/discovery`;
  const pool = /^pools\/([^/]+)\/backends$/.exec(what);
  if (pool?.[1] !== undefined) return `/api/v1/pools/${encodeURIComponent(pool[1])}/backends`;
  // 판정이 바뀐 기록 (2026-11-20).
  const hist = /^(backends|pools)\/([^/]+)\/health-history$/.exec(what);
  if (hist?.[1] !== undefined && hist[2] !== undefined) return `/api/v1/${hist[1]}/${encodeURIComponent(hist[2])}/health-history`;
  const backend = /^backends\/([^/]+)\/status$/.exec(what);
  if (backend?.[1] !== undefined) return `/api/v1/backends/${encodeURIComponent(backend[1])}/status`;
  const op = /^operations\/([^/]+)$/.exec(what);
  if (op?.[1] !== undefined) return `/api/v1/operations/${encodeURIComponent(op[1])}`;
  const plan = /^plans\/([^/]+)$/.exec(what);
  if (plan?.[1] !== undefined) return `/api/v1/plans/${encodeURIComponent(plan[1])}`;
  if (what === 'acme/orders') return '/api/v1/acme/orders';
  const acmeChs = /^acme\/orders\/([^/]+)\/challenges$/.exec(what);
  if (acmeChs?.[1] !== undefined) {
    return `/api/v1/acme/orders/${encodeURIComponent(acmeChs[1])}/challenges`;
  }
  const acmeOrder = /^acme\/orders\/([^/]+)$/.exec(what);
  if (acmeOrder?.[1] !== undefined) {
    return `/api/v1/acme/orders/${encodeURIComponent(acmeOrder[1])}`;
  }
  const acmeCh = /^acme\/challenges\/([^/]+)$/.exec(what);
  if (acmeCh?.[1] !== undefined) {
    return `/api/v1/acme/challenges/${encodeURIComponent(acmeCh[1])}`;
  }
  return undefined;
}

export async function getResource(http: Http, what: string): Promise<unknown> {
  const path = getPath(what);
  if (path === undefined) throw new Error('없는 읽기다');
  return unwrap(await http('GET', path), what);
}

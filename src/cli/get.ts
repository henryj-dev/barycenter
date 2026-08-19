/**
 * CLI 읽기 — DESIGN.md §5.2 · §5.6
 *
 * 있는 GET 만 연다. 모르는 이름은 호출하지 않는다. ACME 주문 GET 은 API 가 없다.
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
]);

export function getPath(what: string): string | undefined {
  if (what === '') return undefined;
  if (what === 'model' || what === 'rendered') return `/api/v1/config/${what}`;
  if (what === 'health' || what === 'health/backends') return '/api/v1/health/backends';
  if (LISTS.has(what)) return `/api/v1/${what}`;
  const pool = /^pools\/([^/]+)\/backends$/.exec(what);
  if (pool?.[1] !== undefined) return `/api/v1/pools/${encodeURIComponent(pool[1])}/backends`;
  const backend = /^backends\/([^/]+)\/status$/.exec(what);
  if (backend?.[1] !== undefined) return `/api/v1/backends/${encodeURIComponent(backend[1])}/status`;
  return undefined;
}

export async function getResource(http: Http, what: string): Promise<unknown> {
  const path = getPath(what);
  if (path === undefined) throw new Error('없는 읽기다');
  return unwrap(await http('GET', path), what);
}

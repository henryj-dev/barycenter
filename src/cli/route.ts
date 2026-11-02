/**
 * CLI 라우트 쓰기 — DESIGN.md §5.6
 *
 * HTTP 호스트 → 풀 proxy, URL redirect, reject. 패스스루는 SNI → TCP 풀 또는 끊기.
 * websocket 은 HTTP proxy 에서만 켠다. 삭제는 --host 또는 --sni 로 가른다. apply 는 안 한다.
 */
import {
  deletePatch,
  putHttpRedirectPatch, putHttpRejectPatch, putHttpRoutePatch,
  putPassthroughRejectPatch, putPassthroughRoutePatch,
  type RedirectStatus, type RejectStatus, type SourceRuleInput, parseHeaderLines,
} from '../web/edit.js';

import { commitPatch, type Http } from './flow.js';

export type RouteCreateInput = {
  name: string;
  listener: string;
  hosts?: string;
  snis?: string;
  pool?: string;
  to?: string;
  status?: string;
  reject?: boolean;
  websocket?: boolean;
  pathPrefix?: string;
  /** 경로 여럿 (2026-11-02). `--path-prefix` 를 여러 번 적으면 여기로 온다. */
  pathPrefixes?: string[];
  /** 출발지 규칙 (2026-11-02). `--source-rule` 을 적은 순서대로 — `parseSourceRule` 이 끊는다. */
  sourceRules?: string[];
  /** proxy 에만. `이름: 값` 들 (#109). */
  requestHeaders?: string[];
  /** proxy 에만. 맞은 접두사를 이 값으로 바꾼다 (#109). */
  rewritePrefix?: string;
};

const redirectStatus = (v: string | undefined): RedirectStatus | undefined =>
  (v === '301' || v === '302' || v === '307' || v === '308' ? Number(v) as RedirectStatus : undefined);

const rejectStatus = (v: string | undefined): RejectStatus | undefined =>
  (v === '403' || v === '404' || v === '444' ? Number(v) as RejectStatus : undefined);

const csv = (v: string | undefined): string[] =>
  (v ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');

/**
 * `--source-rule` 한 줄 → 출발지 규칙 (2026-11-02). 모양: `[conn:]대역[,대역…]=동작`.
 *
 *   동작   `pool:<풀>[:ws]` · `redirect:<301|302|307|308>:<URL>` · `reject:<403|404|444>`
 *   conn:  연결 주소(realip 전)를 본다. 없으면 방문자 주소다.
 *
 * 예: `@cloudflare-ips-v4,@cloudflare-ips-v6=reject:444` · `conn:10.0.0.0/8=pool:internal`.
 * 대역의 모양 · 가려진 규칙은 서버가 본다(해독기 · 검증기) — 여기서는 끊기만 한다.
 */
export function parseSourceRule(line: string): SourceRuleInput {
  const fail = (why: string): never => {
    throw new Error(`--source-rule ${JSON.stringify(line)}: ${why} — 예: @cloudflare-ips-v4=reject:444 · conn:10.0.0.0/8=pool:internal`);
  };
  let rest = line.trim();
  const connection = rest.startsWith('conn:');
  if (connection) rest = rest.slice('conn:'.length);
  const eq = rest.indexOf('=');
  if (eq <= 0) fail("'대역=동작' 모양이 아니다");
  const from = rest.slice(0, eq).split(',').map((x) => x.trim()).filter((x) => x !== '');
  if (from.length === 0) fail('대역이 비어 있다');
  const act = rest.slice(eq + 1).trim();
  const kind = act.slice(0, act.indexOf(':') < 0 ? act.length : act.indexOf(':'));
  const arg = act.slice(kind.length + 1);
  let action: SourceRuleInput['action'];
  if (kind === 'pool') {
    const [pool, ws] = arg.split(':');
    if (pool === undefined || pool === '') fail('풀 이름이 비어 있다');
    if (ws !== undefined && ws !== 'ws') fail(`pool 뒤에는 :ws 만 온다 (받은 것: :${ws})`);
    action = { kind: 'proxy', pool: pool!, websocket: ws === 'ws' };
  } else if (kind === 'redirect') {
    const at = arg.indexOf(':');
    const status = redirectStatus(at < 0 ? undefined : arg.slice(0, at));
    const to = at < 0 ? '' : arg.slice(at + 1);
    if (status === undefined) fail('redirect 상태는 301|302|307|308 이다');
    if (to === '') fail('redirect 대상이 비어 있다');
    action = { kind: 'redirect', to, status: status! };
  } else if (kind === 'reject') {
    const status = rejectStatus(arg === '' ? '403' : arg);
    if (status === undefined) fail('reject 상태는 403|404|444 이다');
    action = { kind: 'reject', status: status! };
  } else {
    return fail(`모르는 동작 ${JSON.stringify(kind)} — pool · redirect · reject`);
  }
  return { from, action, ...(connection ? { address: 'connection' as const } : {}) };
}

export function routeCreatePatch(
  input: RouteCreateInput,
): ReturnType<typeof putHttpRoutePatch>
  | ReturnType<typeof putHttpRedirectPatch>
  | ReturnType<typeof putHttpRejectPatch>
  | ReturnType<typeof putPassthroughRoutePatch>
  | ReturnType<typeof putPassthroughRejectPatch>
  | undefined {
  if (input.name === '' || input.listener === '') return undefined;
  const snis = csv(input.snis);
  const hosts = csv(input.hosts);
  const to = input.to?.trim() ?? '';
  const pool = input.pool?.trim() ?? '';
  const path = [input.pathPrefix ?? '', ...(input.pathPrefixes ?? [])].map((p) => p.trim()).filter((p) => p !== '').join(' ');
  if (snis.length > 0) {
    // 패스스루는 TLS 를 안 푼다 — 출발지 규칙(HTTP 라우트의 것)이 없다.
    if (hosts.length > 0 || to !== '' || path !== '' || input.websocket === true || (input.sourceRules?.length ?? 0) > 0) return undefined;
    if (input.reject === true) {
      if (pool !== '') return undefined;
      return putPassthroughRejectPatch({
        key: input.name, listener: input.listener, snis,
      });
    }
    if (pool === '') return undefined;
    return putPassthroughRoutePatch({
      key: input.name, listener: input.listener, snis, pool,
    });
  }
  if (hosts.length === 0) return undefined;
  if (to !== '' && pool !== '') return undefined;
  // 하나면 `pathPrefix`, 여럿이면 `pathPrefixes` — 빌더가 고른다(`pathFieldsOf`). 출발지 규칙도 같이 싣는다.
  const prefix = {
    ...(input.pathPrefix === undefined ? {} : { pathPrefix: input.pathPrefix }),
    ...(input.pathPrefixes === undefined ? {} : { pathPrefixes: input.pathPrefixes }),
    ...(input.sourceRules === undefined || input.sourceRules.length === 0 ? {} : { sourceRules: input.sourceRules.map(parseSourceRule) }),
  };
  if (input.reject === true) {
    if (to !== '' || pool !== '' || input.websocket === true) return undefined;
    const status = rejectStatus(input.status ?? '403');
    if (status === undefined) return undefined;
    return putHttpRejectPatch({
      key: input.name,
      listener: input.listener,
      hosts,
      status,
      ...prefix,
    });
  }
  if (to !== '') {
    if (input.websocket === true) return undefined;
    const status = redirectStatus(input.status ?? '302');
    if (status === undefined) return undefined;
    return putHttpRedirectPatch({
      key: input.name,
      listener: input.listener,
      hosts,
      to,
      status,
      ...prefix,
    });
  }
  if (pool === '') return undefined;
  return putHttpRoutePatch({
    key: input.name,
    listener: input.listener,
    hosts,
    pool,
    ...prefix,
    ...(input.websocket === true ? { websocket: true } : {}),
    ...(input.requestHeaders === undefined ? {} : (() => {
      const h = parseHeaderLines(input.requestHeaders);
      return h === undefined ? {} : { requestHeaders: h };
    })()),
    ...(input.rewritePrefix === undefined ? {} : { rewritePrefix: input.rewritePrefix }),
  });
}

export async function routeCreate(
  http: Http,
  input: RouteCreateInput,
): Promise<{ revision: string; planId: string }> {
  const patch = routeCreatePatch(input);
  if (patch === undefined) {
    throw new Error('HTTP proxy·redirect·reject 또는 패스스루다. 빈 SNI·호스트·모르는 status 는 패치를 안 만든다');
  }
  return commitPatch(http, patch);
}

export type RouteDeleteInput = {
  name: string;
  host?: boolean;
  sni?: boolean;
};

export function routeDeletePatch(input: RouteDeleteInput): ReturnType<typeof deletePatch> | undefined {
  if (input.name === '') return undefined;
  if (input.host === true && input.sni === true) return undefined;
  if (input.host === true) return deletePatch('httpRoute', input.name);
  if (input.sni === true) return deletePatch('passthroughRoute', input.name);
  return undefined;
}

export async function routeDelete(
  http: Http,
  input: RouteDeleteInput,
): Promise<{ revision: string; planId: string }> {
  const patch = routeDeletePatch(input);
  if (patch === undefined) throw new Error('라우트 삭제는 --host 또는 --sni 하나다');
  return commitPatch(http, patch);
}

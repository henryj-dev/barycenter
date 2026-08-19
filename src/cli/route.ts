/**
 * CLI 라우트 쓰기 — DESIGN.md §5.6
 *
 * HTTP 호스트 → 풀 proxy, URL redirect, reject. 패스스루는 SNI → TCP 풀 또는 끊기.
 * websocket 은 HTTP proxy 에서만 켠다. apply 는 안 한다.
 */
import {
  putHttpRedirectPatch, putHttpRejectPatch, putHttpRoutePatch,
  putPassthroughRejectPatch, putPassthroughRoutePatch,
  type RedirectStatus, type RejectStatus,
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
};

const redirectStatus = (v: string | undefined): RedirectStatus | undefined =>
  (v === '301' || v === '302' || v === '307' || v === '308' ? Number(v) as RedirectStatus : undefined);

const rejectStatus = (v: string | undefined): RejectStatus | undefined =>
  (v === '403' || v === '404' || v === '444' ? Number(v) as RejectStatus : undefined);

const csv = (v: string | undefined): string[] =>
  (v ?? '').split(',').map((s) => s.trim()).filter((s) => s !== '');

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
  const path = input.pathPrefix?.trim() ?? '';
  if (snis.length > 0) {
    if (hosts.length > 0 || to !== '' || path !== '' || input.websocket === true) return undefined;
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
  const prefix = path === '' ? {} : { pathPrefix: path };
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

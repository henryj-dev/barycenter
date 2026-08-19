/**
 * CLI 라우트 쓰기 — DESIGN.md §5.6
 *
 * HTTP 호스트 → 풀 proxy, URL redirect, 또는 reject. websocket 은 기본이 끈다.
 * 패스스루는 아직이다. apply 는 안 한다.
 */
import {
  putHttpRedirectPatch, putHttpRejectPatch, putHttpRoutePatch,
  type RedirectStatus, type RejectStatus,
} from '../web/edit.js';

import { changesetNew, changesetPatch, changesetPlan, commitByPlan, type Http } from './flow.js';

export type RouteCreateInput = {
  name: string;
  listener: string;
  hosts: string;
  pool?: string;
  to?: string;
  status?: string;
  reject?: boolean;
  pathPrefix?: string;
};

const redirectStatus = (v: string | undefined): RedirectStatus | undefined =>
  (v === '301' || v === '302' || v === '307' || v === '308' ? Number(v) as RedirectStatus : undefined);

const rejectStatus = (v: string | undefined): RejectStatus | undefined =>
  (v === '403' || v === '404' || v === '444' ? Number(v) as RejectStatus : undefined);

export function routeCreatePatch(
  input: RouteCreateInput,
): ReturnType<typeof putHttpRoutePatch>
  | ReturnType<typeof putHttpRedirectPatch>
  | ReturnType<typeof putHttpRejectPatch>
  | undefined {
  const hosts = input.hosts.split(',').map((h) => h.trim()).filter((h) => h !== '');
  if (hosts.length === 0 || input.name === '' || input.listener === '') return undefined;
  const to = input.to?.trim() ?? '';
  const pool = input.pool?.trim() ?? '';
  if (to !== '' && pool !== '') return undefined;
  const prefix = input.pathPrefix === undefined || input.pathPrefix.trim() === ''
    ? {}
    : { pathPrefix: input.pathPrefix };
  if (input.reject === true) {
    if (to !== '' || pool !== '') return undefined;
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
  });
}

export async function routeCreate(
  http: Http,
  input: RouteCreateInput,
): Promise<{ revision: string; planId: string }> {
  const patch = routeCreatePatch(input);
  if (patch === undefined) {
    throw new Error('HTTP proxy·redirect·reject 다. 빈 호스트·대상·모르는 status 는 패치를 안 만든다');
  }
  const cs = await changesetNew(http);
  await changesetPatch(http, cs.id, patch);
  const plan = await changesetPlan(http, cs.id);
  const committed = await commitByPlan(http, plan.id);
  return { revision: committed.revision, planId: plan.id };
}

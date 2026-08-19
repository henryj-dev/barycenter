/**
 * CLI 라우트 쓰기 — DESIGN.md §5.6
 *
 * HTTP 호스트 → 풀 proxy. websocket 은 기본이 끈다.
 * redirect·reject·패스스루는 아직이다. apply 는 안 한다.
 */
import { putHttpRoutePatch } from '../web/edit.js';

import { changesetNew, changesetPatch, changesetPlan, commitByPlan, type Http } from './flow.js';

export type RouteCreateInput = {
  name: string;
  listener: string;
  hosts: string;
  pool: string;
  pathPrefix?: string;
};

export function routeCreatePatch(
  input: RouteCreateInput,
): ReturnType<typeof putHttpRoutePatch> | undefined {
  const hosts = input.hosts.split(',').map((h) => h.trim()).filter((h) => h !== '');
  if (hosts.length === 0) return undefined;
  if (input.name === '' || input.listener === '' || input.pool === '') return undefined;
  return putHttpRoutePatch({
    key: input.name,
    listener: input.listener,
    hosts,
    pool: input.pool,
    ...(input.pathPrefix === undefined || input.pathPrefix.trim() === ''
      ? {}
      : { pathPrefix: input.pathPrefix }),
  });
}

export async function routeCreate(
  http: Http,
  input: RouteCreateInput,
): Promise<{ revision: string; planId: string }> {
  const patch = routeCreatePatch(input);
  if (patch === undefined) throw new Error('HTTP proxy 만 연다. 빈 호스트는 패치를 안 만든다');
  const cs = await changesetNew(http);
  await changesetPatch(http, cs.id, patch);
  const plan = await changesetPlan(http, cs.id);
  const committed = await commitByPlan(http, plan.id);
  return { revision: committed.revision, planId: plan.id };
}

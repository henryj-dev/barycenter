/**
 * CLI 리소스 쓰기 — DESIGN.md §5.6
 *
 * HTTP 리스너 create 만. tcp·udp·https 는 아직이다. apply 는 안 한다.
 * 패치는 GUI 와 같은 `putHttpListenerPatch` 다.
 */
import { putHttpListenerPatch } from '../web/edit.js';

import { changesetNew, changesetPatch, changesetPlan, commitByPlan, type Http } from './flow.js';

export type ListenerCreateInput = {
  name: string;
  protocol: string;
  bind: string;
  port: number;
  pool: string;
};

export function listenerCreatePatch(input: ListenerCreateInput): ReturnType<typeof putHttpListenerPatch> | undefined {
  if (input.protocol !== 'http') return undefined;
  return putHttpListenerPatch(input.name, {
    bind: input.bind,
    port: input.port,
    pool: input.pool,
  });
}

export async function listenerCreate(
  http: Http,
  input: ListenerCreateInput,
): Promise<{ revision: string; planId: string }> {
  const patch = listenerCreatePatch(input);
  if (patch === undefined) throw new Error('http 만 연다. tcp·udp·https 는 아직이다');
  const cs = await changesetNew(http);
  await changesetPatch(http, cs.id, patch);
  const plan = await changesetPlan(http, cs.id);
  const committed = await commitByPlan(http, plan.id);
  return { revision: committed.revision, planId: plan.id };
}

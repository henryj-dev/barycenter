/**
 * CLI 리소스 쓰기 — DESIGN.md §5.6
 *
 * HTTP·TCP 리스너 create. udp·https 는 아직이다. apply 는 안 한다.
 * 패치는 GUI 와 같은 `putHttpListenerPatch` · `putTcpListenerPatch` 다.
 */
import { putHttpListenerPatch, putTcpListenerPatch } from '../web/edit.js';

import { changesetNew, changesetPatch, changesetPlan, commitByPlan, type Http } from './flow.js';

export type ListenerCreateInput = {
  name: string;
  protocol: string;
  bind: string;
  port: number;
  pool: string;
};

export function listenerCreatePatch(
  input: ListenerCreateInput,
): ReturnType<typeof putHttpListenerPatch> | ReturnType<typeof putTcpListenerPatch> | undefined {
  if (input.protocol === 'http') {
    return putHttpListenerPatch(input.name, {
      bind: input.bind,
      port: input.port,
      pool: input.pool,
    });
  }
  if (input.protocol === 'tcp') {
    return putTcpListenerPatch(input.name, {
      bind: input.bind,
      port: input.port,
      pool: input.pool,
    });
  }
  return undefined;
}

export async function listenerCreate(
  http: Http,
  input: ListenerCreateInput,
): Promise<{ revision: string; planId: string }> {
  const patch = listenerCreatePatch(input);
  if (patch === undefined) throw new Error('http·tcp 만 연다. udp·https 는 아직이다');
  const cs = await changesetNew(http);
  await changesetPatch(http, cs.id, patch);
  const plan = await changesetPlan(http, cs.id);
  const committed = await commitByPlan(http, plan.id);
  return { revision: committed.revision, planId: plan.id };
}

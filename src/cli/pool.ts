/**
 * CLI 풀 쓰기 — DESIGN.md §5.6
 *
 * 첫 백엔드와 같이 넣는다. 빈 풀만은 plan 이 막는다.
 * 이 커밋은 round_robin 만. hash·source_ip_hash 는 아직이다. apply 는 안 한다.
 */
import { putPoolWithBackendPatch, type ProtocolClass } from '../web/edit.js';

import { changesetNew, changesetPatch, changesetPlan, commitByPlan, type Http } from './flow.js';

export type PoolCreateInput = {
  name: string;
  protocolClass: string;
  algorithm?: string;
  backend: string;
  host: string;
  port: number;
};

const protocolClass = (v: string): ProtocolClass | undefined =>
  (v === 'http' || v === 'tcp' || v === 'udp' ? v : undefined);

export function poolCreatePatch(
  input: PoolCreateInput,
): ReturnType<typeof putPoolWithBackendPatch> | undefined {
  const klass = protocolClass(input.protocolClass);
  const algorithm = input.algorithm ?? 'round_robin';
  if (klass === undefined || algorithm !== 'round_robin') return undefined;
  return putPoolWithBackendPatch({
    pool: input.name,
    protocolClass: klass,
    backend: input.backend,
    host: input.host,
    port: input.port,
  });
}

export async function poolCreate(
  http: Http,
  input: PoolCreateInput,
): Promise<{ revision: string; planId: string }> {
  const patch = poolCreatePatch(input);
  if (patch === undefined) {
    throw new Error('round_robin 만 연다. hash·source_ip_hash 는 아직이다');
  }
  const cs = await changesetNew(http);
  await changesetPatch(http, cs.id, patch);
  const plan = await changesetPlan(http, cs.id);
  const committed = await commitByPlan(http, plan.id);
  return { revision: committed.revision, planId: plan.id };
}

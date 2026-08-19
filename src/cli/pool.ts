/**
 * CLI 풀 쓰기 — DESIGN.md §5.6
 *
 * 첫 백엔드와 같이 넣는다. 빈 풀만은 plan 이 막는다.
 * round_robin · hash · source_ip_hash. hashKey 는 검증기와 같은 화이트리스트다.
 * source_ip_hash 는 hashKey 를 안 붙인다. apply 는 안 한다.
 */
import { parseHashKey } from '../validate/strings.js';
import {
  putHashPoolWithBackendPatch, putPoolWithBackendPatch, putSourceIpHashPoolWithBackendPatch,
  type ProtocolClass,
} from '../web/edit.js';

import { changesetNew, changesetPatch, changesetPlan, commitByPlan, type Http } from './flow.js';

export type PoolCreateInput = {
  name: string;
  protocolClass: string;
  algorithm?: string;
  hashKey?: string;
  backend: string;
  host: string;
  port: number;
};

const protocolClass = (v: string): ProtocolClass | undefined =>
  (v === 'http' || v === 'tcp' || v === 'udp' ? v : undefined);

export function poolCreatePatch(
  input: PoolCreateInput,
): ReturnType<typeof putPoolWithBackendPatch>
  | ReturnType<typeof putHashPoolWithBackendPatch>
  | ReturnType<typeof putSourceIpHashPoolWithBackendPatch>
  | undefined {
  const klass = protocolClass(input.protocolClass);
  if (klass === undefined) return undefined;
  const algorithm = input.algorithm ?? 'round_robin';
  if (algorithm === 'round_robin') {
    return putPoolWithBackendPatch({
      pool: input.name,
      protocolClass: klass,
      backend: input.backend,
      host: input.host,
      port: input.port,
    });
  }
  if (algorithm === 'hash') {
    const hashKey = input.hashKey?.trim() ?? '';
    if (hashKey === '') return undefined;
    const parsed = parseHashKey(klass, hashKey);
    if (!parsed.ok) return undefined;
    return putHashPoolWithBackendPatch({
      pool: input.name,
      protocolClass: klass,
      hashKey,
      backend: input.backend,
      host: input.host,
      port: input.port,
    });
  }
  if (algorithm === 'source_ip_hash') {
    return putSourceIpHashPoolWithBackendPatch({
      pool: input.name,
      protocolClass: klass,
      backend: input.backend,
      host: input.host,
      port: input.port,
    });
  }
  return undefined;
}

export async function poolCreate(
  http: Http,
  input: PoolCreateInput,
): Promise<{ revision: string; planId: string }> {
  const patch = poolCreatePatch(input);
  if (patch === undefined) {
    throw new Error('round_robin·hash·source_ip_hash 만 연다. hash 는 --hash-key 화이트리스트다');
  }
  const cs = await changesetNew(http);
  await changesetPatch(http, cs.id, patch);
  const plan = await changesetPlan(http, cs.id);
  const committed = await commitByPlan(http, plan.id);
  return { revision: committed.revision, planId: plan.id };
}

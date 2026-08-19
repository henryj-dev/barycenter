/**
 * CLI 리소스 쓰기 — DESIGN.md §5.6
 *
 * HTTP·TCP·UDP·HTTPS·패스스루 리스너 create. apply 는 안 한다.
 * 패스스루는 tls 를 안 붙인다. unmatched SNI 풀은 선택이다.
 */
import {
  putHttpListenerPatch, putHttpsListenerPatch, putPassthroughListenerPatch,
  putTcpListenerPatch, putUdpListenerPatch, type UdpPreset,
} from '../web/edit.js';

import { changesetNew, changesetPatch, changesetPlan, commitByPlan, type Http } from './flow.js';

export type ListenerCreateInput = {
  name: string;
  protocol: string;
  bind: string;
  port: number;
  pool?: string;
  preset?: string;
  policy?: string;
  certificate?: string;
};

const udpPreset = (v: string | undefined): UdpPreset | undefined =>
  (v === 'dns' || v === 'wireguard' || v === 'game_generic' || v === 'custom' ? v : undefined);

export function listenerCreatePatch(
  input: ListenerCreateInput,
): ReturnType<typeof putHttpListenerPatch>
  | ReturnType<typeof putTcpListenerPatch>
  | ReturnType<typeof putUdpListenerPatch>
  | ReturnType<typeof putHttpsListenerPatch>
  | ReturnType<typeof putPassthroughListenerPatch>
  | undefined {
  if (input.protocol === 'http') {
    if (input.pool === undefined || input.pool === '') return undefined;
    return putHttpListenerPatch(input.name, {
      bind: input.bind,
      port: input.port,
      pool: input.pool,
    });
  }
  if (input.protocol === 'tcp') {
    if (input.pool === undefined || input.pool === '') return undefined;
    return putTcpListenerPatch(input.name, {
      bind: input.bind,
      port: input.port,
      pool: input.pool,
    });
  }
  if (input.protocol === 'udp') {
    const preset = udpPreset(input.preset);
    if (preset === undefined || input.pool === undefined || input.pool === '') return undefined;
    return putUdpListenerPatch(input.name, {
      bind: input.bind,
      port: input.port,
      pool: input.pool,
      preset,
    });
  }
  if (input.protocol === 'https') {
    if (input.policy === undefined || input.policy === ''
      || input.certificate === undefined || input.certificate === ''
      || input.pool === undefined || input.pool === '') {
      return undefined;
    }
    return putHttpsListenerPatch(input.name, {
      bind: input.bind,
      port: input.port,
      pool: input.pool,
      policy: input.policy,
      certificate: input.certificate,
    });
  }
  if (input.protocol === 'tls_passthrough') {
    return putPassthroughListenerPatch(
      input.name,
      input.pool === undefined || input.pool === ''
        ? { bind: input.bind, port: input.port }
        : { bind: input.bind, port: input.port, pool: input.pool },
    );
  }
  return undefined;
}

export async function listenerCreate(
  http: Http,
  input: ListenerCreateInput,
): Promise<{ revision: string; planId: string }> {
  const patch = listenerCreatePatch(input);
  if (patch === undefined) {
    throw new Error('http·tcp·udp·https·tls_passthrough 만 연다. https 는 --policy 와 --certificate 가 필요하다');
  }
  const cs = await changesetNew(http);
  await changesetPatch(http, cs.id, patch);
  const plan = await changesetPlan(http, cs.id);
  const committed = await commitByPlan(http, plan.id);
  return { revision: committed.revision, planId: plan.id };
}

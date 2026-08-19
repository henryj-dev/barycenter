/**
 * CLI 리소스 쓰기 — DESIGN.md §5.6
 *
 * HTTP·TCP·UDP·HTTPS 리스너 create. 패스스루는 아직이다. apply 는 안 한다.
 * HTTPS 는 tls.policy 와 tls.defaultCertificate 가 필수다. http2 는 안 적는다.
 */
import {
  putHttpListenerPatch, putHttpsListenerPatch, putTcpListenerPatch, putUdpListenerPatch,
  type UdpPreset,
} from '../web/edit.js';

import { changesetNew, changesetPatch, changesetPlan, commitByPlan, type Http } from './flow.js';

export type ListenerCreateInput = {
  name: string;
  protocol: string;
  bind: string;
  port: number;
  pool: string;
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
  | undefined {
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
  if (input.protocol === 'udp') {
    const preset = udpPreset(input.preset);
    if (preset === undefined) return undefined;
    return putUdpListenerPatch(input.name, {
      bind: input.bind,
      port: input.port,
      pool: input.pool,
      preset,
    });
  }
  if (input.protocol === 'https') {
    if (input.policy === undefined || input.policy === ''
      || input.certificate === undefined || input.certificate === '') {
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
  return undefined;
}

export async function listenerCreate(
  http: Http,
  input: ListenerCreateInput,
): Promise<{ revision: string; planId: string }> {
  const patch = listenerCreatePatch(input);
  if (patch === undefined) {
    throw new Error('http·tcp·udp·https 만 연다. https 는 --policy 와 --certificate 가 필요하다');
  }
  const cs = await changesetNew(http);
  await changesetPatch(http, cs.id, patch);
  const plan = await changesetPlan(http, cs.id);
  const committed = await commitByPlan(http, plan.id);
  return { revision: committed.revision, planId: plan.id };
}

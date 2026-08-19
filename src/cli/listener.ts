/**
 * CLI 리소스 쓰기 — DESIGN.md §5.6
 *
 * HTTP·TCP·UDP 리스너 create. https 는 아직이다. apply 는 안 한다.
 * UDP 는 named preset 이다. 모르는 preset 은 패치를 안 만든다.
 */
import {
  putHttpListenerPatch, putTcpListenerPatch, putUdpListenerPatch, type UdpPreset,
} from '../web/edit.js';

import { changesetNew, changesetPatch, changesetPlan, commitByPlan, type Http } from './flow.js';

export type ListenerCreateInput = {
  name: string;
  protocol: string;
  bind: string;
  port: number;
  pool: string;
  preset?: string;
};

const udpPreset = (v: string | undefined): UdpPreset | undefined =>
  (v === 'dns' || v === 'wireguard' || v === 'game_generic' || v === 'custom' ? v : undefined);

export function listenerCreatePatch(
  input: ListenerCreateInput,
): ReturnType<typeof putHttpListenerPatch>
  | ReturnType<typeof putTcpListenerPatch>
  | ReturnType<typeof putUdpListenerPatch>
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
  return undefined;
}

export async function listenerCreate(
  http: Http,
  input: ListenerCreateInput,
): Promise<{ revision: string; planId: string }> {
  const patch = listenerCreatePatch(input);
  if (patch === undefined) {
    throw new Error('http·tcp·udp 만 연다. udp 는 named preset 이 필요하다. https 는 아직이다');
  }
  const cs = await changesetNew(http);
  await changesetPatch(http, cs.id, patch);
  const plan = await changesetPlan(http, cs.id);
  const committed = await commitByPlan(http, plan.id);
  return { revision: committed.revision, planId: plan.id };
}

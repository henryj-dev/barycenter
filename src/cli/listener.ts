/**
 * CLI 리소스 쓰기 — DESIGN.md §5.6
 *
 * HTTP·TCP·UDP·HTTPS·패스스루 리스너 create·delete. apply 는 안 한다.
 * 패스스루는 tls 를 안 붙인다. unmatched SNI 풀과 no-SNI 풀(S9)은 선택이다.
 */
import {
  deletePatch,
  putHttpListenerPatch, putHttpsListenerPatch, putPassthroughListenerPatch,
  putTcpListenerPatch, putUdpListenerPatch, type UdpPreset,
  parseListenerOptions,
  type ListenerOptions, type ListenerOptionFlags,
} from '../web/edit.js';

// **플래그 파서는 `web/edit.ts` 에 산다.** GUI 도 같은 것을 쓰는데, GUI 번들은
// `cli/` 를 끌면 안 된다(§10 — 노드 내장이 값으로 닿는 폐포를 좁게 유지한다).
// 여기서 재수출해 CLI 소비자의 경로를 안 바꾼다.
export { parseListenerOptions, type ListenerOptionFlags };

import { changesetNew, changesetPatch, changesetPlan, commitByPlan, commitPatch, type Http } from './flow.js';

export type ListenerCreateInput = {
  name: string;
  protocol: string;
  bind: string;
  port: number;
  pool?: string;
  preset?: string;
  policy?: string;
  certificate?: string;
  /** 제안 6·7·8. http·https 에만 붙는다 — 모델이 그 자리를 거기에만 준다. */
  options?: ListenerOptions;
  /** 패스스루에만. TLS 인데 SNI 가 없을 때의 폴백 (S9). */
  noSniPool?: string;
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
      // 제안 6·7·8. `undefined` 면 `listenerOptionFields` 가 아무것도 안 만든다.
      ...(input.options ?? {}),
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
      ...(input.options ?? {}),
    });
  }
  if (input.protocol === 'tls_passthrough') {
    return putPassthroughListenerPatch(input.name, {
      bind: input.bind,
      port: input.port,
      ...(input.pool === undefined || input.pool === '' ? {} : { pool: input.pool }),
      ...(input.noSniPool === undefined || input.noSniPool === ''
        ? {} : { noSniPool: input.noSniPool }),
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
    throw new Error('http·tcp·udp·https·tls_passthrough 만 연다. https 는 --policy 와 --certificate 가 필요하다');
  }
  const cs = await changesetNew(http);
  await changesetPatch(http, cs.id, patch);
  const plan = await changesetPlan(http, cs.id);
  const committed = await commitByPlan(http, plan.id);
  return { revision: committed.revision, planId: plan.id };
}

export function listenerDeletePatch(key: string): ReturnType<typeof deletePatch> | undefined {
  if (key === '') return undefined;
  return deletePatch('listener', key);
}

export async function listenerDelete(
  http: Http,
  key: string,
): Promise<{ revision: string; planId: string }> {
  const patch = listenerDeletePatch(key);
  if (patch === undefined) throw new Error('리스너 키가 비어 있다');
  return commitPatch(http, patch);
}

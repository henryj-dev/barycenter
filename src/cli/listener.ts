/**
 * CLI 리소스 쓰기 — DESIGN.md §5.6
 *
 * HTTP·TCP·UDP·HTTPS·패스스루 리스너 create·update·delete. apply 는 안 한다.
 * 패스스루는 tls 를 안 붙인다. unmatched SNI 풀과 no-SNI 풀(S9)은 선택이다.
 */
import {
  deletePatch,
  putHttpListenerPatch, putHttpsListenerPatch, putPassthroughListenerPatch,
  putTcpListenerPatch, putUdpListenerPatch, type UdpPreset,
  parseListenerOptions,
  editListenerPatch, type PutListenerOp,
  type ListenerOptions, type ListenerOptionFlags,
} from '../web/edit.js';

// **플래그 파서는 `web/edit.ts` 에 산다.** GUI 도 같은 것을 쓰는데, GUI 번들은
// `cli/` 를 끌면 안 된다(§10 — 노드 내장이 값으로 닿는 폐포를 좁게 유지한다).
// 여기서 재수출해 CLI 소비자의 경로를 안 바꾼다.
export { parseListenerOptions, type ListenerOptionFlags };

import { changesetNew, changesetPatch, changesetPlan, commitByPlan, commitPatch, unwrap, type Http } from './flow.js';

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
  /** 모든 프로토콜. 연결할 수 있는 출발지 (2026-10-29). */
  sourceAllow?: string[];
  /**
   * http · https 만. 이 리스너가 받을 이름(nginx `server_name`, ADR-VHOST). 있으면 같은 소켓을 다른 호스트
   * 리스너와 나눠 쓴다. 정규화는 `parseListenerHosts` 가 한다(GUI 와 같다).
   */
  hosts?: string[];
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
  const hosts = input.hosts === undefined || input.hosts.length === 0 ? {} : { hosts: input.hosts };
  if (input.protocol === 'http') {
    if (input.pool === undefined || input.pool === '') return undefined;
    return putHttpListenerPatch(input.name, {
      bind: input.bind,
      port: input.port,
      ...(input.sourceAllow === undefined ? {} : { sourceAllow: input.sourceAllow }),
      pool: input.pool,
      ...hosts,
      // 제안 6·7·8. `undefined` 면 `listenerOptionFields` 가 아무것도 안 만든다.
      ...(input.options ?? {}),
    });
  }
  if (input.protocol === 'tcp') {
    if (input.pool === undefined || input.pool === '') return undefined;
    return putTcpListenerPatch(input.name, {
      bind: input.bind,
      port: input.port,
      ...(input.sourceAllow === undefined ? {} : { sourceAllow: input.sourceAllow }),
      pool: input.pool,
    });
  }
  if (input.protocol === 'udp') {
    const preset = udpPreset(input.preset);
    if (preset === undefined || input.pool === undefined || input.pool === '') return undefined;
    return putUdpListenerPatch(input.name, {
      bind: input.bind,
      port: input.port,
      ...(input.sourceAllow === undefined ? {} : { sourceAllow: input.sourceAllow }),
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
      ...(input.sourceAllow === undefined ? {} : { sourceAllow: input.sourceAllow }),
      pool: input.pool,
      policy: input.policy,
      certificate: input.certificate,
      ...hosts,
      ...(input.options ?? {}),
    });
  }
  if (input.protocol === 'tls_passthrough') {
    return putPassthroughListenerPatch(input.name, {
      bind: input.bind,
      port: input.port,
      ...(input.sourceAllow === undefined ? {} : { sourceAllow: input.sourceAllow }),
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
  if (input.hosts !== undefined && input.hosts.length > 0
    && input.protocol !== 'http' && input.protocol !== 'https') {
    throw new Error(`${input.protocol} 리스너에는 호스트가 없다 — 포트로만 가른다. --hosts 는 http · https 만 받는다`);
  }
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

/**
 * **리스너 고치기** — `bary listener update` (ADR-VHOST, 2026-10-31).
 *
 * 지금은 호스트만 고친다. 바탕은 head 의 그 리스너다(`GET /api/v1/listeners`) — 고칠 칸만 덮고 나머지
 * (헤더 규칙 · 레이트리밋 · TLS · 출발지 제한 …)는 그대로 싣는다. GUI 의 수정 화면과 같은 함수를 쓴다.
 *
 * `hosts`: 목록 = 그것으로 바꾼다, 빈 배열 = 지운다(그 소켓의 기본 리스너가 된다).
 */
export type ListenerUpdateInput = { name: string; hosts: string[] };

export function listenerUpdatePatch(
  current: Readonly<Record<string, unknown>>,
  input: ListenerUpdateInput,
): PutListenerOp[] {
  const bind = current['bind'];
  const port = current['port'];
  if (typeof bind !== 'string' || typeof port !== 'number') throw new Error(`리스너 '${input.name}' 의 바인드 · 포트를 못 읽었다`);
  const sourceAllow = current['sourceAllow'];
  return editListenerPatch(current, {
    bind,
    port,
    enabled: current['enabled'] !== false,
    // **그대로 싣는다.** `ListenerEdit` 은 sourceAllow 가 없으면 제한을 지운다.
    ...(Array.isArray(sourceAllow) ? { sourceAllow: sourceAllow as string[] } : {}),
    hosts: input.hosts,
  });
}

export async function listenerUpdate(
  http: Http,
  input: ListenerUpdateInput,
): Promise<{ revision: string; planId: string }> {
  if (input.name === '') throw new Error('리스너 키가 비어 있다');
  const list = unwrap(await http('GET', '/api/v1/listeners'), 'listeners');
  const current = Array.isArray(list)
    ? (list as Record<string, unknown>[]).find((l) => l['key'] === input.name)
    : undefined;
  if (current === undefined) throw new Error(`리스너 '${input.name}' 가 head 에 없다`);
  return commitPatch(http, listenerUpdatePatch(current, input));
}

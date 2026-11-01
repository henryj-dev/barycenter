/**
 * **reload 로 못 넘어가는 bind 전환** (2026-11-01, web-01 에서 잡았다).
 *
 * nginx 는 reload 때 옛 소켓을 연 채로 새 소켓을 먼저 bind() 한다. 주소가 정확히 같은 소켓만 물려받는다.
 * Linux 는 같은 포트에서 LISTEN 중인 소켓과 주소가 겹치는 bind() 를 `SO_REUSEADDR` 가 있어도 막는다(errno 98).
 * 그래서 아래 두 전환은 reload 가 `Address already in use` 로 실패한다. 엔진은 옛 세대로 남는다.
 *
 *   특정 주소(10.0.0.1:443) 가 열려 있는데 와일드카드(0.0.0.0:443) 를 새로 연다
 *   와일드카드(0.0.0.0:443) 가 열려 있는데 특정 주소(10.0.0.1:443) 를 새로 연다
 *
 * 서로 다른 특정 주소끼리는 겹치지 않는다. 한 세대 안에서 와일드카드와 특정 주소가 함께 있으면
 * nginx 는 와일드카드 소켓 하나만 연다(#150). 그래서 **실제로 bind 하는 소켓**끼리 비교한다.
 *
 * TCP 만 본다. UDP 프리셋은 `reuseport` 로 bind 하고, 한 세대 안의 와일드카드 · 특정 주소 섞임은 검증기가 막는다.
 */
import { withRedirectListeners } from '../model/redirect.js';
import type { Listener } from '../model/provisional.js';
import { normalizeBind, transportOf } from './sockets.js';

type Bound = { family: 'v4' | 'v6'; addr: string; wildcard: boolean; port: number };

export type BindTransitionConflict = {
  /** 새로 열어야 하는 소켓 — `tcp://주소:포트`. */
  opens: string;
  /** 그 bind 를 막는, 지금 열린 소켓. */
  blockedBy: string[];
  message: string;
};

const socketName = (b: Bound): string => `tcp://${b.family === 'v6' ? `[${b.addr}]` : b.addr}:${b.port}`;

/** nginx 가 이 리스너들로 **실제로 bind 하는** TCP 소켓. 와일드카드가 있는 포트는 와일드카드 하나다. */
export function boundTcpSockets(listeners: readonly Listener[]): Bound[] {
  const groups = new Map<string, Bound[]>();
  for (const l of withRedirectListeners(listeners)) {
    if (!l.enabled || transportOf(l.protocol) !== 'tcp') continue;
    const n = normalizeBind(l.bind);
    if (!n.ok) continue;
    const b: Bound = { ...n.value, port: l.port };
    const g = `${b.family}/${b.port}`;
    const list = groups.get(g) ?? [];
    if (!list.some((x) => x.addr === b.addr)) list.push(b);
    groups.set(g, list);
  }
  const out: Bound[] = [];
  for (const list of groups.values()) {
    const wild = list.find((b) => b.wildcard);
    out.push(...(wild === undefined ? list : [wild]));
  }
  return out.sort((a, b) => a.port - b.port || a.addr.localeCompare(b.addr));
}

/** 지금 서빙 중인 리스너(before)에서 새 리스너(after)로 reload 할 때 bind 가 막히는 소켓. */
export function bindTransitionConflicts(
  before: readonly Listener[], after: readonly Listener[],
): BindTransitionConflict[] {
  const open = boundTcpSockets(before);
  const openNames = new Set(open.map(socketName));
  const out: BindTransitionConflict[] = [];
  for (const n of boundTcpSockets(after)) {
    const name = socketName(n);
    if (openNames.has(name)) continue;   // 그대로 물려받는다
    const blockers = open.filter((o) => o.family === n.family && o.port === n.port && (o.wildcard || n.wildcard));
    if (blockers.length === 0) continue;
    const by = blockers.map(socketName);
    out.push({
      opens: name,
      blockedBy: by,
      message: `${name} 를 새로 열어야 하는데 지금 ${by.join(', ')} 가 열려 있다. `
        + 'reload 는 옛 소켓을 연 채로 새 소켓을 bind 하므로 Linux 가 막는다(Address already in use). '
        + `두 번에 나눠 적용한다: 먼저 :${n.port} 의 옛 소켓을 닫는 변경(그 리스너를 끄거나 지운다)을 적용하고, `
        + '그다음 원하는 바인드를 적용한다. 두 적용 사이에 그 포트가 잠깐 닫힌다.',
    });
  }
  return out;
}

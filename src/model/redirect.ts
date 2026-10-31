/**
 * HTTPS 리스너의 평문 리다이렉트 소켓 (2026-10-31).
 *
 * `httpRedirect: { port: 80 }` 을 단 HTTPS 리스너는 같은 바인드의 그 포트에 평문 server 를 세운다. 그 소켓은
 * 모델에 따로 적히지 않지만 **리스너처럼 다룬다** — 검증기는 소켓 충돌 · 호스트 충돌을, 렌더러는 server 블록을,
 * 소켓 목록(배포 · 방화벽)과 plan 의 소켓 변화는 열 포트를 본다. 넷이 같은 함수를 써야 갈리지 않는다.
 *
 * 키는 `<리스너>:http` 다. `:` 는 리소스 키에 못 쓰는 글자라 사용자 리스너와 겹치지 않는다.
 * 기본 동작은 'reject' 로 두고, 렌더러가 리다이렉트로 바꿔 낸다(`redirectTargetPort`).
 */
import type { HttpListener, RawListener } from './provisional.js';

export const redirectKeyOf = (listenerKey: string): string => `${listenerKey}:http`;

type WithRedirect = Pick<RawListener, 'key' | 'protocol' | 'bind' | 'enabled' | 'sourceAllow' | 'hosts' | 'httpRedirect'>;

/** 이 리스너의 리다이렉트 소켓. 없으면 undefined. https 가 아니면 언제나 없다. */
export function redirectListenerOf(l: WithRedirect): HttpListener | undefined {
  if (l.protocol !== 'https' || l.httpRedirect === undefined) return undefined;
  return {
    key: redirectKeyOf(l.key),
    protocol: 'http',
    bind: l.bind,
    port: l.httpRedirect.port,
    enabled: l.enabled,
    ...(l.sourceAllow === undefined ? {} : { sourceAllow: [...l.sourceAllow] }),
    ...(l.hosts === undefined ? {} : { hosts: [...l.hosts] }),
    http: { defaultAction: 'reject' },
  };
}

/** 모델의 리스너에 리다이렉트 소켓을 더한 목록 — 소켓을 세는 곳은 이것을 본다. */
export function withRedirectListeners<L extends WithRedirect>(listeners: readonly L[]): (L | HttpListener)[] {
  const out: (L | HttpListener)[] = [...listeners];
  for (const l of listeners) {
    const r = redirectListenerOf(l);
    if (r !== undefined) out.push(r);
  }
  return out;
}

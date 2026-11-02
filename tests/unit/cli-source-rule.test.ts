/**
 * **CLI 출발지 규칙** (2026-11-02, `bary route create --source-rule`). 전에는 GUI 나 patch 로만 넣을 수 있었다.
 */
import { describe, expect, it } from 'vitest';

import { parseSourceRule, routeCreatePatch } from '../../src/cli/route.js';

describe('parseSourceRule', () => {
  it('**대역 · 동작을 끊는다** — pool · redirect · reject, conn: 은 연결 주소', () => {
    expect(parseSourceRule('@cloudflare-ips-v4,@cloudflare-ips-v6=reject:444'))
      .toEqual({ from: ['@cloudflare-ips-v4', '@cloudflare-ips-v6'], action: { kind: 'reject', status: 444 } });
    expect(parseSourceRule('conn:10.0.0.0/8=pool:internal:ws'))
      .toEqual({ from: ['10.0.0.0/8'], address: 'connection', action: { kind: 'proxy', pool: 'internal', websocket: true } });
    expect(parseSourceRule('203.0.113.0/24=redirect:302:https://x.test/a?b=c'))
      .toEqual({ from: ['203.0.113.0/24'], action: { kind: 'redirect', to: 'https://x.test/a?b=c', status: 302 } });
    expect(parseSourceRule('10.0.0.1=reject').action).toEqual({ kind: 'reject', status: 403 });
  });

  it('모양이 틀리면 예와 함께 거절한다', () => {
    for (const bad of ['10.0.0.0/8', '=reject:403', '10.0.0.0/8=drop', '10.0.0.0/8=reject:500', '10.0.0.0/8=redirect:302:', '10.0.0.0/8=pool:']) {
      expect(() => parseSourceRule(bad), bad).toThrow(/--source-rule/);
    }
  });

  it('**route create 가 적은 순서대로 싣는다** · 패스스루에는 안 받는다', () => {
    const p = routeCreatePatch({ name: 'r', listener: 'web', hosts: 'a.test', pool: 'pub', sourceRules: ['10.1.0.0/16=reject:403', '10.0.0.0/8=pool:internal'] });
    expect((p?.[0]?.body as { sourceRules?: { from: string[] }[] }).sourceRules?.map((r) => r.from)).toEqual([['10.1.0.0/16'], ['10.0.0.0/8']]);
    expect(routeCreatePatch({ name: 'r', listener: 'tls', snis: 'a.test', pool: 'p', sourceRules: ['10.0.0.0/8=reject:403'] })).toBeUndefined();
  });
});

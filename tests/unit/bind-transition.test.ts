/**
 * reload 로 못 넘어가는 bind 전환 (2026-11-01, web-01 에서 잡았다).
 *
 * r20 은 `10.253.65.250:443` · `:80` 만 열었다. r23 이 `0.0.0.0:443` · `:80` 리스너를 더하자 reload 가
 * `bind() to 0.0.0.0:443 failed (98: Address already in use)` 로 실패했다. reload 는 옛 소켓을 연 채로 새 소켓을
 * bind 하고, Linux 는 LISTEN 중인 소켓과 주소가 겹치는 bind 를 막는다. 반대 방향도 같다(컨테이너에서 실측).
 */
import { describe, expect, it } from 'vitest';

import type { Listener } from '../../src/model/provisional.js';
import { bindTransitionConflicts, boundTcpSockets } from '../../src/validate/bind-transition.js';
import { planSummary } from '../../src/cli/flow.js';
import { viewOfImpact } from '../../src/web/impact-view.js';

const https = (key: string, bind: string, extra: Partial<Listener> = {}): Listener => ({
  key, protocol: 'https', bind, port: 443, enabled: true,
  http: { defaultAction: 'reject' }, tls: { policy: 'p', defaultCertificate: 'c' },
  httpRedirect: { port: 80 }, ...extra,
} as Listener);
const tcp = (key: string, bind: string, port: number): Listener =>
  ({ key, protocol: 'tcp', bind, port, enabled: true, defaultPool: 'p' } as Listener);

describe('nginx 가 실제로 bind 하는 소켓', () => {
  it('와일드카드가 있는 포트는 와일드카드 하나만 연다 — 특정 주소는 접힌다 (#150)', () => {
    const names = boundTcpSockets([https('default', '0.0.0.0'), https('site', '10.253.65.250')])
      .map((b) => `${b.addr}:${b.port}`);
    expect(names).toEqual(['0.0.0.0:80', '0.0.0.0:443']);
  });

  it('꺼진 리스너는 안 연다', () => {
    expect(boundTcpSockets([https('off', '0.0.0.0', { enabled: false })])).toEqual([]);
  });
});

describe('reload 로 못 여는 소켓', () => {
  const r20 = [https('site', '10.253.65.250')];

  it('**특정 주소가 열린 포트에 와일드카드를 새로 열면 막힌다** — web-01 r20 → r23', () => {
    const r23 = [https('default', '0.0.0.0'), https('site', '10.253.65.250')];
    const c = bindTransitionConflicts(r20, r23);
    expect(c.map((x) => [x.opens, x.blockedBy])).toEqual([
      ['tcp://0.0.0.0:80', ['tcp://10.253.65.250:80']],
      ['tcp://0.0.0.0:443', ['tcp://10.253.65.250:443']],
    ]);
    expect(c[0]!.message).toMatch(/두 번에 나눠 적용한다/);
  });

  it('**와일드카드가 열린 포트에 특정 주소를 새로 열어도 막힌다** — 반대 방향', () => {
    expect(bindTransitionConflicts([tcp('a', '0.0.0.0', 9000)], [tcp('a', '10.0.0.1', 9000)]).map((x) => x.opens))
      .toEqual(['tcp://10.0.0.1:9000']);
  });

  it('같은 소켓은 물려받는다 — 와일드카드 아래에 특정 주소를 더해도 새로 bind 하지 않는다', () => {
    expect(bindTransitionConflicts([https('default', '0.0.0.0')], [https('default', '0.0.0.0'), https('site', '10.0.0.1')]))
      .toEqual([]);
  });

  it('서로 다른 특정 주소끼리는 겹치지 않는다', () => {
    expect(bindTransitionConflicts([tcp('a', '10.0.0.1', 9000)], [tcp('a', '10.0.0.1', 9000), tcp('b', '10.0.0.2', 9000)]))
      .toEqual([]);
  });

  it('옛 소켓을 먼저 닫으면(두 단계의 둘째) 막히지 않는다', () => {
    expect(bindTransitionConflicts([], [https('default', '0.0.0.0'), https('site', '0.0.0.0', { hosts: ['a.test'] })]))
      .toEqual([]);
    expect(bindTransitionConflicts([https('site', '10.253.65.250', { enabled: false })], [https('default', '0.0.0.0')]))
      .toEqual([]);
  });

  it('주소 family 와 포트가 다르면 겹치지 않는다 — ipv6only', () => {
    expect(bindTransitionConflicts([tcp('a', '10.0.0.1', 9000)], [tcp('b', '::', 9000), tcp('c', '0.0.0.0', 9001)]))
      .toEqual([]);
  });

  it('UDP 는 보지 않는다', () => {
    const udp = (bind: string): Listener =>
      ({ key: 'u', protocol: 'udp', bind, port: 53, enabled: true, defaultPool: 'p', udp: { preset: 'dns' } } as Listener);
    expect(bindTransitionConflicts([udp('10.0.0.1')], [udp('0.0.0.0')])).toEqual([]);
  });
});

describe('화면과 CLI 가 막힘을 말한다', () => {
  const impact = {
    requiresReload: true, affectedListeners: [], socketChanges: { added: [], removed: [] }, planes: ['http'],
    bindTransitions: [{ opens: 'tcp://0.0.0.0:443', blockedBy: ['tcp://10.0.0.1:443'], message: '막힌다' }],
  };

  it('GUI 영향 화면', () => {
    expect(viewOfImpact({ planId: 'p', revision: '2' }, impact).bindBlockers).toEqual(['막힌다']);
  });

  it('옛 plan 에는 필드가 없다 — 막힘 없음', () => {
    const { bindTransitions: _b, ...old } = impact;
    expect(viewOfImpact({ planId: 'p', revision: '2' }, old).bindBlockers).toEqual([]);
  });

  it('CLI plan 요약', () => {
    expect(planSummary(impact)).toContain('적용 불가 — 막힌다');
  });
});

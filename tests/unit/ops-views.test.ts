/**
 * 운영 보기 (2026-11-21) — 서버에는 있는데 화면이 안 쓰던 창구를 화면에 붙인다.
 *
 *   · 드레인 진행(`GET /backends/:id/drain-status`) — 백엔드 상세 · 목록의 「드레인」 칸 · 기한 고르기.
 *   · ACME 주문의 챌린지(`GET /acme/orders/:id/challenges`) — 인증서의 ACME 상자.
 *   · 소켓(`GET /sockets`) · 모든 풀의 출처(`GET /discovery`) · ACME 계정(`GET /acme/accounts`) — 새 화면 셋.
 *
 * 전역 모드에서도 읽혀야 한다 — 중계 허용 목록에 새 읽기 넷이 있다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { backendStatusRows } from '../../src/control/backend-status.js';
import { RELAY_PATHS } from '../../src/global/relay.js';
import { DRAIN_CONDITION_MARK, deadlineText, drainCell, drainLines } from '../../src/web/drain-view.js';
import { NAV_GROUPS } from '../../src/web/nav.js';
import { pageOf } from '../../src/web/page.js';
import { socketViews, type SocketRow } from '../../src/web/sockets-view.js';
import type { Model } from '../../src/model/provisional.js';

const gui = (p: string): string => readFileSync(join(import.meta.dirname, '../../gui/src', p), 'utf8');

describe('드레인 진행의 말', () => {
  const now = Date.parse('2026-11-21T10:00:00Z');

  it('세 상태가 저마다 다른 말 · 색이다', () => {
    expect(DRAIN_CONDITION_MARK.no_new_traffic.tone).toBe('drain');
    expect(DRAIN_CONDITION_MARK.quiesced).toMatchObject({ tone: 'ok', text: expect.stringContaining('빼도 돼요') });
    expect(DRAIN_CONDITION_MARK.deadline_exceeded.tone).toBe('warn');
  });

  it('숫자가 없으면 「모름」 이다 — 0 으로 채우지 않는다', () => {
    const lines = drainLines({ drain_condition: 'no_new_traffic' }, now);
    expect(lines.find((l) => l.label === '진행 중 요청')?.value).toMatch(/^모름/);
    expect(lines.find((l) => l.label === '기한')?.value).toBe('없음');
    const counted = drainLines({ drain_condition: 'quiesced', inflight: 0, active_sessions: 0, started_by: 'kim' }, now);
    expect(counted.find((l) => l.label === '진행 중 요청')?.value).toBe('0');
    expect(counted.find((l) => l.label === '건 사람')?.value).toBe('kim');
  });

  it('기한은 남은 · 지난 시간으로 말한다', () => {
    expect(deadlineText('2026-11-21T10:15:00Z', now)).toBe('15분 남음');
    expect(deadlineText('2026-11-21T09:59:30Z', now)).toBe('30초 지남');
    expect(deadlineText('2026-11-21T12:30:00Z', now)).toBe('2시간 30분 남음');
    expect(deadlineText(undefined, now)).toBe('없음');
  });

  it('목록 칸은 기한을 넘긴 드레인을 경고 색으로 그린다', () => {
    expect(drainCell({ deadlineExceeded: true, deadlineAt: 'x' }).tone).toBe('warn');
    expect(drainCell({ deadlineExceeded: false }).text).toBe('드레인 중');
    expect(drainCell(undefined).tone).toBe('drain');
  });
});

describe('상태 목록이 드레인 기록을 싣는다', () => {
  const model = {
    listeners: [{ key: 'l', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true, http: { defaultAction: { pool: 'p' } } }],
    pools: [{ key: 'p', protocolClass: 'http', algorithm: 'round_robin' }],
    backends: [{ key: 'a', pool: 'p', host: '10.0.0.1', port: 1, weight: 1 }, { key: 'b', pool: 'p', host: '10.0.0.2', port: 1, weight: 1 }],
    httpRoutes: [], passthroughRoutes: [], certificates: [], tlsPolicies: [], sniBindings: [], addressSets: [],
  } as unknown as Model;

  it('드레인 중인 백엔드만 `drain` 이 있고, 기한을 넘겼는지 판정한다', () => {
    const rows = backendStatusRows({
      model, health: new Map(), draining: new Set(['a']), routedPools: new Set(['p']),
      drainInfo: new Map([
        ['a', { startedAt: '2026-11-21T09:00:00.000Z', startedBy: 'kim', deadlineAt: '2000-01-01T00:00:00.000Z' }],
        ['b', { startedAt: '2026-11-21T09:00:00.000Z', startedBy: 'lee' }],
      ]),
    });
    expect(rows.find((r) => r.key === 'a')?.drain).toEqual({
      startedAt: '2026-11-21T09:00:00.000Z', startedBy: 'kim', deadlineAt: '2000-01-01T00:00:00.000Z', deadlineExceeded: true,
    });
    // b 는 기록이 있어도 드레인 집합에 없다 — 리듀서가 보는 것과 같게, 싣지 않는다.
    expect(rows.find((r) => r.key === 'b')).not.toHaveProperty('drain');
  });
});

describe('소켓 화면의 줄', () => {
  const row = (listener: string, bind: string, port: number, over: Partial<SocketRow> = {}): SocketRow =>
    ({ listener, protocol: 'https', transport: 'tcp', bind, port, enabled: true, ...over });

  it('같은 소켓을 나눠 쓰는 켜진 리스너 수를 센다', () => {
    const v = socketViews([row('a', '10.0.0.1', 443), row('b', '10.0.0.1', 443), row('c', '10.0.0.1', 443, { enabled: false })]);
    expect(v.find((r) => r.listener === 'a')?.sharedWith).toBe(2);
    expect(v.find((r) => r.listener === 'c')?.sharedWith).toBe(0);
  });

  it('와일드카드와 특정 주소가 같은 포트에 있으면 짚는다 — 전송이 다르면 아니다', () => {
    const v = socketViews([row('w', '0.0.0.0', 443), row('s', '10.0.0.1', 443), row('u', '10.0.0.1', 443, { transport: 'udp' })]);
    expect(v.find((r) => r.listener === 'w')?.wildcardOverlap).toBe(true);
    expect(v.find((r) => r.listener === 's')?.wildcardOverlap).toBe(true);
    expect(v.find((r) => r.listener === 'u')?.wildcardOverlap).toBe(false);
  });

  it('리다이렉트 소켓의 주인은 HTTPS 리스너다 · IPv6 는 괄호로 쓴다', () => {
    const v = socketViews([row('site~http', '::', 80, { protocol: 'http' })]);
    expect(v[0]).toMatchObject({ owner: 'site', socket: 'tcp [::]:80' });
  });
});

describe('화면 — 새 창구를 쓴다', () => {
  it('백엔드 상세가 드레인 진행을 읽고, 드레인을 걸 때 기한을 고른다', () => {
    const src = gui('lib/detail/BackendHealth.svelte');
    expect(src).toContain('desk.drainStatus(k)');
    expect(src).toContain('options={DRAIN_DEADLINES}');
    expect(src).toContain('desk.drain(key, deadline > 0 ? deadline : undefined)');
    expect(gui('lib/desk.svelte.ts')).toContain('JSON.stringify({ deadline_s: deadlineS })');
  });

  it('ACME 상자가 고른 주문의 챌린지를 보인다', () => {
    const src = gui('lib/detail/Acme.svelte');
    expect(src).toContain('desk.acmeChallenges(id)');
    expect(src).toContain('bind:selected={picked}');
  });

  it('새 화면 셋이 메뉴에 있고 그 주소에서 불이 들어온다', () => {
    const items = NAV_GROUPS.flatMap((g) => g.items);
    for (const [href, place] of [['/ops/sockets', 'sockets'], ['/ops/discovery', 'discovery'], ['/tls/acme-account', 'acmeAccounts']] as const) {
      expect(items.find((i) => i.href === href)?.place).toBe(place);
      expect(pageOf(href)).toBe(place);
    }
    expect(gui('lib/ops/Sockets.svelte')).toContain('desk.sockets()');
    expect(gui('lib/ops/DiscoveryList.svelte')).toContain('desk.discoveryAll()');
    expect(gui('lib/tls/AcmeAccounts.svelte')).toContain('desk.acmeAccounts()');
  });

  it('전역 모드에서도 읽힌다 — 중계 허용 목록에 새 읽기 넷이 있다', () => {
    for (const p of ['backends/:id/drain-status', 'acme/orders/:id/challenges', 'acme/challenges/:id', 'discovery']) {
      expect(RELAY_PATHS).toContain(p);
    }
  });
});

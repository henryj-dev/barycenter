/**
 * **전역 = 전체 지역 합산 — 운영 화면** (2026-11-04 사용자 결정, docs/design-global-mode.md §2.5).
 *
 * 대시보드 · 상태 · 적용 대기 · 기록 · 렌더된 설정이 지역을 안 골라도 그린다. 붙은 지역만 세고, 연락 없는 지역은
 * 「연락 없음」 으로 보인다 — 0 으로 세지 않는다(§2.4). 적용 · 롤백 · 이어받기는 그 지역 하나로 간다(§1.1).
 * 순수 함수(`gui/src/lib/ops/aggregate-view.ts`)는 바로 부르고, 화면의 연결은 소스를 읽어 본다.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { AGGREGATE_PATHS, LOST_LABEL, isAggregatePath } from '../../gui/src/lib/global/aggregate.js';
import {
  mergeByTime, pendingDefault, pendingRow, pendingShown, regionBadge, sumTally, tallyNotices, type PendingFact, type Tally,
} from '../../gui/src/lib/ops/aggregate-view.js';

const src = (p: string): string => readFileSync(new URL(`../../gui/src/${p}`, import.meta.url), 'utf8');
const LOST = '이 지역과 연결되지 않아 지금은 쓸 수 없어요.';

const tally = (o: Partial<Tally> = {}): Tally => ({
  listeners: 0, serving: 0, joining: 0, backends: 0, healthy: 0, unhealthy: 0, drained: 0, idle: 0, certSoon: 0, pending: 0, unfinished: false, ...o,
});

describe('합계 — 붙은 지역만 더하고, 빠진 지역은 알린다', () => {
  it('리스너 · 백엔드 · 인증서 · 적용 대기를 더한다 · 가장 가까운 인증서는 지역을 단다 · 미완 전환 지역을 모은다', () => {
    const s = sumTally([
      { region: 'icn', tally: tally({ listeners: 5, serving: 4, joining: 1, backends: 12, healthy: 9, unhealthy: 1, drained: 1, certSoon: 1, pending: 2, nearest: { key: 'api', hasMaterial: true, days: 12 } }) },
      { region: 'nrt', tally: tally({ listeners: 9, serving: 7, backends: 20, healthy: 17, unhealthy: 2, certSoon: 2, pending: 1, unfinished: true, nearest: { key: 'www', hasMaterial: true, days: 3 } }) },
    ]);
    expect([s.serving, s.listeners, s.healthy, s.backends, s.unhealthy, s.certSoon, s.pending]).toEqual([11, 14, 26, 32, 3, 3, 3]);
    expect(s.nearest).toEqual({ key: 'www', hasMaterial: true, days: 3, region: 'nrt' });
    expect(s.unfinishedIn).toEqual(['nrt']);
    expect(s.regions).toBe(2);
  });

  it('자료 없는 인증서가 가장 가깝다', () => {
    const s = sumTally([
      { region: 'icn', tally: tally({ nearest: { key: 'a', hasMaterial: true, days: -3 } }) },
      { region: 'nrt', tally: tally({ nearest: { key: 'b', hasMaterial: false } }) },
    ]);
    expect(s.nearest?.region).toBe('nrt');
  });

  it('빠진 지역은 합계가 아니라 알림이 말한다', () => {
    expect(sumTally([]).listeners).toBe(0);
    expect(tallyNotices([{ name: 'icn', state: 'ok' }, { name: 'nrt', state: 'lost' }, { name: 'fra', state: 'rejected' }, { name: 'sin', state: 'loading' }])
      .map((n) => `${n.icon} ${n.text}`)).toEqual([
      `○ nrt ${LOST_LABEL} — 합계에서 빠졌어요`, '✕ fra 인증 거절 — 합계에서 빠졌어요', '↻ sin 불러오는 중 — 곧 합계에 들어와요',
    ]);
  });

  it('지역 상태 배지 — 연락 없음 · 인증 거절 · 불러오는 중 · 정상', () => {
    expect(regionBadge('lost')).toEqual({ tone: 'neutral', icon: '○', text: LOST_LABEL });
    expect(regionBadge('rejected').text).toBe('인증 거절');
    expect(regionBadge('loading').text).toBe('불러오는 중');
    expect(regionBadge('ok').text).toBe('정상');
  });
});

describe('기록 — 모든 지역을 시각 순서로 잇는다', () => {
  it('새것부터 · 지역을 단다 · 같은 키도 지역이 다르면 다른 행 · 시각이 없으면 끝', () => {
    const rows = mergeByTime([
      { region: 'icn', rows: [{ key: 'cs:1', at: '2026-11-04T10:00:00Z' }, { key: 'cs:0', at: undefined }] },
      { region: 'nrt', rows: [{ key: 'cs:1', at: '2026-11-04T11:00:00Z' }, { key: 'cs:2', at: '2026-11-04T09:00:00Z' }] },
    ], (r) => r.key, (r) => r.at);
    expect(rows.map((r) => `${r.region}:${r.key}`)).toEqual(['nrt:cs:1', 'icn:cs:1', 'nrt:cs:2', 'icn:cs:0']);
    expect(new Set(rows.map((r) => r.rid)).size).toBe(4);
  });
});

describe('적용 대기 — 지역마다 한 항목(시안 groupsOf)', () => {
  const facts: PendingFact[] = [
    { name: 'icn', state: 'ok', head: '10', pending: [], view: undefined },
    { name: 'nrt', state: 'ok', head: '9', pending: ['9', '8'], view: { revision: '9' }, by: 'alice' },
    { name: 'fra', state: 'lost', pending: [] },
  ];

  it('적용 대기 줄은 head 리비전 · 포함된 커밋 · 누가 · 적용 대기', () => {
    expect(pendingRow(facts[1]!, LOST)).toEqual({
      name: 'nrt', head: '9', by: 'alice', title: 'r9 적용 — 커밋 2건 포함 (r8, r9)', tone: 'pending', text: '적용 대기', lost: false, known: true,
    });
    expect(pendingRow({ name: 'x', state: 'ok', pending: [], failed: { revision: '4' } }, LOST)).toMatchObject({ tone: 'danger', text: '적용 실패', known: true });
  });

  it('연락 없는 지역은 「모른다」 — 적용 대기를 0 으로 쓰지 않고 막힌 사유를 쓴다', () => {
    const r = pendingRow(facts[2]!, LOST);
    expect(r).toMatchObject({ text: LOST_LABEL, title: LOST, lost: true, known: false });
    expect(r.head).toBeUndefined();
    expect(pendingRow({ name: 'x', state: 'rejected', pending: [] }, LOST)).toMatchObject({ text: '인증 거절', known: false });
  });

  it('할 일이 있는 지역과 고른 지역만 보인다 · 처음은 적용 대기가 있는 붙은 지역', () => {
    expect(pendingShown(facts, undefined).map((f) => f.name)).toEqual(['nrt', 'fra']);
    expect(pendingShown(facts, 'icn').map((f) => f.name)).toEqual(['icn', 'nrt', 'fra']);
    expect(pendingDefault(facts)).toBe('nrt');
    expect(pendingDefault([facts[0]!, facts[2]!])).toBe('icn');
    expect(pendingDefault([facts[2]!])).toBe('fra');
    expect(pendingDefault([])).toBeUndefined();
  });
});

describe('화면의 연결', () => {
  it('운영 화면은 합산으로 그린다 — 셸이 지역 고르기로 보내지 않는다 · 클러스터는 아니다', () => {
    for (const p of ['/', '/ops/status', '/change/pending', '/ops/audit', '/ops/rendered']) {
      expect(AGGREGATE_PATHS).toContain(p);
      expect(isAggregatePath(p)).toBe(true);
    }
    expect(isAggregatePath('/ops/cluster')).toBe(false);
    expect(src('lib/shell/Sidebar.svelte')).toContain("!(global && i.place === 'cluster')");
  });

  it.each(['lib/ops/Dashboard.svelte', 'lib/ops/StatusPanel.svelte', 'lib/ops/AuditLog.svelte', 'routes/change/pending/+page.svelte'])(
    '%s: 합산이면 지역마다 붙은 desk 로 그린다', (f) => {
      const s = src(f);
      expect(s).toContain('const agg = useAggregate();');
      expect(s).toMatch(/agg\.entries/);
    });

  it('대시보드: 카드는 붙은 지역의 합 · 지역별 표(지역 · head · 적용 대기 · 백엔드 정상 · 상태 — 시안) · 최근 변경은 시각 순서 · 빠진 지역 알림', () => {
    const s = src('lib/ops/Dashboard.svelte');
    expect(s).toContain('const total = $derived(sumTally(');
    expect(s).toContain('const t = $derived<Tally>(agg.on ? total : local);');
    const cols = s.slice(s.indexOf('const aggColumns'), s.indexOf('];', s.indexOf('const aggColumns')));
    expect([...cols.matchAll(/label: '([^']+)'/g)].map((m) => m[1])).toEqual(['지역', 'head', '적용 대기', '백엔드 정상', '상태']);
    expect(s).toContain('mergeByTime(parts.map((p) => ({ region: p.name, rows: p.groups.filter(committed) }))');
    expect(s).toContain('<RegionNotices {notices} strip={false} />');
    // 붙지 않은 지역은 숫자 없이 상태 배지 — 0 이 아니다.
    expect(cols).toContain("r.tally === undefined ? '—'");
  });

  it('상태: 합산이면 지역별 표가 본문이다 · 이어받기는 그 지역의 desk 로', () => {
    const s = src('lib/ops/StatusPanel.svelte');
    expect(s).toContain('<DataTable rows={aggRows}');
    expect(s).toContain('r.entry.desk.recover()');
    expect(s).toContain('agg.writable(r.name)');
  });

  it('기록: 합산이면 지역 열 · 시각 순서 · 행 키 rid · 빠진 지역 알림', () => {
    const s = src('lib/ops/AuditLog.svelte');
    expect(s).toContain('{#if agg.on}<span>지역</span>{/if}');
    expect(s).toContain("mergeByTime(agg.entries.filter((e) => e.state === 'ok')");
    expect(s).toContain('{#each shown as g (g.rid)}');
    expect(s).toContain('{#if agg.on}<RegionNotices notices={agg.notices} strip={false} />{/if}');
  });

  it('적용 대기: 고른 지역의 desk 로 영향 · 적용 · 롤백을 그린다 · 확인 창은 지역 이름을 쓴다 · 모르는 지역은 막힌 사유만', () => {
    const page = src('routes/change/pending/+page.svelte');
    expect(page).toMatch(/\{#key entry\.name\}\s*<InRegion \{entry\}>\s*<PendingImpact \{plans\}/);
    expect(page).toContain('pendingRow(f, LOST_MESSAGE)');
    const p = src('lib/ops/PendingImpact.svelte');
    expect(p).toContain("if (scope?.mode !== 'global' || plans !== undefined) return;");
    expect(p).toContain('{#if unknownRow !== undefined}');
    // 확인 창의 지역 이름은 그 지역에 묶인 범위에서 온다(InRegion 이 scope 를 덮는다).
    expect(p).toContain("const where = $derived(glob && scope?.region !== undefined ? ` 지역: ${scope.region.name}` : '');");
    expect(src('lib/ops/RevisionRollback.svelte')).toContain("scope.region !== undefined ? ` 지역: ${scope.region.name}` : ''");
  });

  it('렌더된 설정: 합산이면 닿는 첫 지역을 먼저 보이고 셸의 desk 를 기다리지 않는다', () => {
    const s = src('lib/ops/RenderedConf.svelte');
    expect(s).toContain('scope?.region?.name ?? (aggregate ? regionNames[0] : undefined)');
    expect(s).toContain('const ready = $derived(desk.live || (aggregate && region !== undefined));');
    expect(s).toContain('const own = $derived(!global || (!aggregate && region === scope?.region?.name));');
  });
});

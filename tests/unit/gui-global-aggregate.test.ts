/**
 * **전역 = 전체 지역 합산** (2026-11-04 사용자 결정, docs/design-global-mode.md §2.5).
 *
 * 전역에서 지역을 안 골랐으면 모든 지역을 합쳐 본다. 지역을 고르는 것은 「좁혀 보기」 다.
 * 쓰기는 그대로 한 번에 한 지역(§1.1) — 행의 수정 · 삭제 · 드레인은 그 행의 지역으로 간다. 연락 없는 지역의 행은 빠지고 알린다(§2.4).
 * 순수 함수(`gui/src/lib/global/aggregate.ts`)는 바로 부르고, 화면의 연결은 소스를 읽어 본다.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
  AGGREGATE_PATHS, LOST_LABEL, REGION_PARAM, aggregateFallback, aggregateListState, inRegion, isAggregatePath,
  mergeRegionRows, regionNotices, regionStateOf, rowId, splitRowId, withRegionColumn,
} from '../../gui/src/lib/global/aggregate.js';

const src = (p: string): string => readFileSync(new URL(`../../gui/src/${p}`, import.meta.url), 'utf8');

describe('합산 행 — 키 · 합치기 · 열', () => {
  it('지역이 다르면 같은 이름도 다른 행 키다 · 되돌릴 수 있다 · 키의 / 도 지킨다', () => {
    expect(rowId('icn', 'web')).not.toBe(rowId('nrt', 'web'));
    expect(splitRowId(rowId('icn', 'web'))).toEqual({ region: 'icn', key: 'web' });
    expect(splitRowId(rowId('a/b', 'x/y'))).toEqual({ region: 'a/b', key: 'x/y' });
    expect(splitRowId('web')).toBeUndefined();
  });

  it('지역 순서대로 잇고 행마다 region · rid 를 단다 — 키가 겹치지 않는다', () => {
    const rows = mergeRegionRows([
      { region: 'icn', rows: [{ key: 'web' }, { key: 'api' }] },
      { region: 'nrt', rows: [{ key: 'web' }] },
    ], (r) => r.key);
    expect(rows.map((r) => `${r.region}:${r.key}`)).toEqual(['icn:web', 'icn:api', 'nrt:web']);
    expect(new Set(rows.map((r) => r.rid)).size).toBe(3);
  });

  it('「지역」 열은 셋째 열 뒤다(시안) · 셋보다 적으면 끝 · 원래 배열은 그대로', () => {
    const cols = ['이름', '프로토콜', '바인드', '호스트'];
    expect(withRegionColumn(cols, '지역')).toEqual(['이름', '프로토콜', '바인드', '지역', '호스트']);
    expect(withRegionColumn(['이름'], '지역')).toEqual(['이름', '지역']);
    expect(cols).toHaveLength(4);
  });
});

describe('지역 상태 · 알림', () => {
  const base = { reachable: true, lost: false, live: false };
  it('인증 거절 > 연락 없음 > 붙음 > 끊김(지난 값은 안 보인다) > 불러오는 중', () => {
    expect(regionStateOf({ ...base, auth: 'rejected', live: true })).toBe('rejected');
    expect(regionStateOf({ ...base, reachable: false, live: true })).toBe('lost');
    expect(regionStateOf({ ...base, lost: true, live: true })).toBe('lost');
    expect(regionStateOf({ ...base, live: true })).toBe('ok');
    expect(regionStateOf({ ...base, head: '12' })).toBe('lost');
    expect(regionStateOf({ ...base, error: 'events 500' })).toBe('lost');
    expect(regionStateOf(base)).toBe('loading');
  });

  it('행이 빠진 지역마다 목록 위에 한 줄 — 「○ <지역> 연락 없음 — 이 지역의 행은 빠졌어요」', () => {
    const n = regionNotices([
      { name: 'icn', state: 'ok' }, { name: 'nrt', state: 'lost' }, { name: 'fra', state: 'rejected' }, { name: 'sin', state: 'loading' },
    ]);
    expect(n.map((x) => `${x.icon} ${x.text}`)).toEqual([
      `○ nrt ${LOST_LABEL} — 이 지역의 행은 빠졌어요`,
      '✕ fra 인증 거절 — 이 지역의 행은 빠졌어요',
      '↻ sin 불러오는 중 — 이 지역의 행은 곧 들어와요',
    ]);
    expect(regionNotices([{ name: 'icn', state: 'ok' }])).toEqual([]);
  });

  it('한 지역이라도 붙었으면 목록을 그린다 · 오는 중이면 불러오는 중 · 모두 빠지면 오류', () => {
    expect(aggregateListState([{ state: 'ok' }, { state: 'lost' }])).toEqual({ loading: false });
    expect(aggregateListState([{ state: 'loading' }, { state: 'lost' }])).toEqual({ loading: true });
    expect(aggregateListState([{ state: 'lost' }]).error).toBeDefined();
    expect(aggregateListState([]).error).toBe('지역이 없어요.');
  });
});

describe('행의 지역으로 좁혀 연다', () => {
  it('?region= 을 단다 — 있던 인자 · 해시는 둔다', () => {
    expect(REGION_PARAM).toBe('region');
    expect(inRegion('/traffic/listener/web', 'icn')).toBe('/traffic/listener/web?region=icn');
    expect(inRegion('/traffic/listener/web/settings?tab=1#x', 'a b')).toBe('/traffic/listener/web/settings?tab=1&region=a+b#x');
  });

  it('합산으로 그리는 화면은 목록 주소뿐이다 · 상세 · 만들기는 그 목록으로, 나머지는 지역 고르기로', () => {
    expect(AGGREGATE_PATHS).toEqual(['/traffic/listener', '/traffic/backend',
      '/', '/ops/status', '/change/pending', '/ops/audit', '/ops/rendered',
    ]);
    expect(isAggregatePath('/traffic/listener/')).toBe(true);
    expect(isAggregatePath('/traffic/listener/web')).toBe(false);
    expect(aggregateFallback('/traffic/backend/b1/settings')).toBe('/traffic/backend');
    expect(aggregateFallback('/')).toBe('/regions');
    expect(aggregateFallback('/traffic/pool')).toBe('/regions');
  });
});

describe('화면의 연결', () => {
  it('셸: 합산이면 지역 고르기로 끌고 가지 않는다 · ?region= 으로 좁힌다 · 「◎ 전역」 으로 돌아온다', () => {
    const l = src('routes/+layout.svelte');
    expect(l).toContain("setContext('regions', regionDesks);");
    expect(l).toContain('wanted === null && !isAggregatePath(page.url.pathname)');
    expect(l).toContain('void goto(aggregateFallback(page.url.pathname));');
    expect(l).toContain('regionDesks.sync(regions);');
    expect(l).toContain('u.searchParams.delete(REGION_PARAM);');
    expect(l).toMatch(/const widen = \(\): void => \{[\s\S]*scope\.choose\(undefined\);/);
    // 셸은 폴링하지 않는다 — 지역 요약은 대기 수 · head 가 바뀔 때만 다시 묻는다.
    expect(l).not.toMatch(/setInterval/);
  });

  it('지역마다 desk 는 createDesk 를 그 지역에 묶은 범위로 만든다 — 파싱 · SSE · 쓰기 코드를 다시 쓰지 않는다', () => {
    const m = src('lib/global/regions.svelte.ts');
    expect(m).toContain('const scope = createScope(r);');
    expect(m).toContain('desk: createDesk(scope)');
    // 못 닿은 · 인증 거절 지역에는 붙지 않는다. 마지막 화면이 떠나면 닫는다.
    expect(m).toContain('r.reachable && r.auth === undefined');
    expect(m).toMatch(/closeTimer = setTimeout\(/);
    expect(m).not.toMatch(/setInterval/);
    expect(src('lib/global/scope.svelte.ts')).toContain("get aggregate() { return mode === 'global' && region === undefined; }");
  });

  it.each(['ListenerList', 'BackendList'])('%s: 합산이면 지역 열 · 빠진 지역 알림 · 행 키 rid · 행의 지역으로 쓰기 · 만들 지역 고르기', (f) => {
    const s = src(`lib/lists/${f}.svelte`);
    expect(s).toContain('const agg = useAggregate();');
    expect(s).toContain('withRegionColumn(columns, regionColumn<AggRow>())');
    expect(s).toContain('{#if agg.on}<RegionNotices notices={agg.notices} />{:else}<WriteNote spaced />{/if}');
    expect(s).toContain('rowKey={(r) => r.rid}');
    expect(s).toContain('const rowRo = (r: AggRow): boolean => (agg.on ? !agg.writable(r.region) : ro);');
    expect(s).toMatch(/<InRegion entry=\{delEntry\}><DeleteConfirm bind:target=\{del\}/);
    expect(s).toContain('<RegionCreate {agg}');
  });

  it('목록 옆 상세는 합산이면 그 행의 지역 desk 로 그리고 링크를 그 지역으로 좁힌다', () => {
    const s = src('lib/detail/ListSplit.svelte');
    expect(s).toContain('const desk = $derived(agg.on ? entry?.desk : shell);');
    expect(s).toContain('<InRegion {entry}>{@render body(key)}</InRegion>');
    expect(s).toContain('href={link(resourcePath(kind, key))}');
  });
});

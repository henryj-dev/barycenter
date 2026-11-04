/**
 * 리소스별 「◐ 적용 대기」 (#126 후속) — `GET /api/v1/config/pending-resources` 를 화면이 쓰는 모양으로.
 *
 * 재는 것: 응답을 (kind, key) 로 읽고 모양이 틀린 줄은 버린다. 더함 · 바뀜만 행에 붙고 지움은 「지울 것」 으로 간다.
 * 상세 머리는 상태 배지 옆에 단다 — 리스너 「◐ 적용하면 열림」 과 둘을 같이 두지 않는다.
 * 배선: 목록 아홉이 모두 이름 칸에 단다. 리스너는 「적용하면 열림」 행에서 감춘다. 책상은 스냅샷마다 다시 읽고 폴링하지 않는다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  EMPTY_PENDING, PENDING_MARK, headerMarks, isPendingResource, viewOfPendingResources,
} from '../../gui/src/lib/pending';

const gui = join(__dirname, '../../gui/src/lib');
const read = (p: string): string => readFileSync(join(gui, p), 'utf8');

describe('적용 대기 리소스 — 읽기', () => {
  const v = viewOfPendingResources({
    activeRevision: '4', headRevision: '6',
    resources: [
      { kind: 'pool', key: 'api', change: 'added' },
      { kind: 'backend', key: 'w1', change: 'changed' },
      { kind: 'pool', key: 'old', change: 'removed' },
      { kind: 'pool', key: 'bad', change: 'moved' },
      { kind: 'pool', change: 'added' },
      null,
    ],
  });

  it('더함 · 바뀜은 그 행에 붙는다', () => {
    expect(isPendingResource(v, 'pool', 'api')).toBe(true);
    expect(isPendingResource(v, 'backend', 'w1')).toBe(true);
    // 같은 key 라도 kind 가 다르면 다른 리소스다.
    expect(isPendingResource(v, 'pool', 'w1')).toBe(false);
  });

  it('지움은 행에 안 붙고 「지울 것」 으로 간다', () => {
    expect(isPendingResource(v, 'pool', 'old')).toBe(false);
    expect(v.removed).toEqual([{ kind: 'pool', key: 'old' }]);
  });

  it('모양이 틀린 줄은 버린다 — 지어내지 않는다', () => {
    expect(v.changes.size).toBe(3);
    expect(v.activeRevision).toBe('4');
    expect(v.headRevision).toBe('6');
  });

  it('못 읽으면 비어 있다', () => {
    expect(viewOfPendingResources(undefined)).toEqual(EMPTY_PENDING);
    expect(viewOfPendingResources({ error: 'not_found' }).changes.size).toBe(0);
    expect(isPendingResource(EMPTY_PENDING, 'pool', 'api')).toBe(false);
  });
});

describe('적용 대기 리소스 — 상세 머리 배지', () => {
  const ok = { tone: 'ok' as const, icon: '●', text: '서빙 중' };
  const opens = { tone: 'pending' as const, icon: '◐', text: '적용하면 열림' };

  it('상태 배지 옆에 단다', () => {
    expect(headerMarks(ok, true)).toEqual([ok, PENDING_MARK]);
    expect(headerMarks(undefined, true)).toEqual([PENDING_MARK]);
  });

  it('적용 대기가 아니면 상태 배지만', () => {
    expect(headerMarks(ok, false)).toEqual([ok]);
    expect(headerMarks(undefined, false)).toEqual([]);
  });

  it('**이미 적용 대기 톤이면 하나만** — 「적용하면 열림」 과 「적용 대기」 를 같이 두지 않는다', () => {
    expect(headerMarks(opens, true)).toEqual([opens]);
  });

  it('배지 글은 시안 그대로다', () => {
    expect(PENDING_MARK).toEqual({ tone: 'pending', icon: '◐', text: '적용 대기' });
  });
});

describe('적용 대기 리소스 — 배선', () => {
  const LISTS = [
    ['HttpRouteList', 'httpRoute'], ['PassthroughRouteList', 'passthroughRoute'],
    ['PoolList', 'pool'], ['BackendList', 'backend'], ['AddressSetList', 'addressSet'],
    ['CertificateList', 'certificate'], ['TlsPolicyList', 'tlsPolicy'], ['SniBindingList', 'sniBinding'],
  ] as const;

  it.each(LISTS)('%s 는 이름 칸에 적용 대기를 단다', (file, kind) => {
    const src = read(`lists/${file}.svelte`);
    expect(src).toContain(`<PendingMark kind="${kind}" key={r.key}`);
  });

  it('리스너는 상태 칸이 적용 대기를 말한다(시안 `cells(\'listeners\')`) — 이름 칸에 따로 달지 않는다', () => {
    const cells = read('lists/traffic-cells.ts');
    expect(cells).toContain("pending: isPendingResource(desk.pendingResources, 'listener', r.key)");
    expect(cells).toContain("r.mark === 'join' ? b('pending', '◐', '반영대기') : r.pending ? b('pending', '◐', '적용 대기') : b('ok', '●', '정상')");
    expect(read('lists/ListenerList.svelte')).not.toContain('<PendingMark');
  });

  it('분할 상세 · 상세 머리가 같은 규칙(headerMarks)을 쓴다', () => {
    for (const f of ['detail/ListSplit.svelte', 'detail/ResourceFrame.svelte']) {
      const src = read(f);
      expect(src).toMatch(/headerMarks\(mark, isPendingResource\(desk\.pendingResources, kind, key\)\)/);
      expect(src).toContain('{#each marks as m');
    }
  });

  it('적용 대기 화면이 「지울 것」 을 보인다', () => {
    const src = read('ops/PendingImpact.svelte');
    expect(src).toContain('desk.pendingResources.removed');
    expect(src).toContain('지울 것');
  });

  it('책상은 스냅샷 · revision · apply 마다 다시 읽는다 — 폴링하지 않는다', () => {
    const src = read('desk.svelte.ts');
    const onStatus = src.slice(src.indexOf('const onStatus = async'), src.indexOf('const refreshAudit = async'));
    expect(onStatus).toContain('await refreshPendingResources();');
    expect(src).toContain("api('/api/v1/config/pending-resources')");
    expect(src).not.toMatch(/setInterval/);
  });
});

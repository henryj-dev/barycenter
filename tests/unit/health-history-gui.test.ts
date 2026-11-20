/**
 * 화면 — 풀 · 백엔드 개요가 「헬스 기록」 을 단다 (2026-11-20).
 *
 * 기록은 `desk.healthHistory` 하나로 읽는다. 화면이 API 경로를 직접 만들지 않는다 — 지역 고르기(`api()`)를 건너뛰면
 * 전역 모드에서 엉뚱한 지역을 읽는다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const gui = (p: string): string => readFileSync(join(import.meta.dirname, '../../gui/src', p), 'utf8');

describe('헬스 기록 화면', () => {
  it('개요가 풀 · 백엔드에 기록을 붙인다', () => {
    expect(gui('lib/detail/CellOverview.svelte')).toContain('<HealthHistory {kind} />');
  });

  it('기록은 desk 를 거쳐 읽고, 지역 범위의 `api()` 를 쓴다', () => {
    const src = gui('lib/detail/HealthHistory.svelte');
    expect(src).toContain('desk.healthHistory(');
    expect(src).not.toContain('fetch(');
    const desk = gui('lib/desk.svelte.ts');
    expect(desk).toContain('fetch(api(`/api/v1/${base}/${encodeURIComponent(key)}/health-history?');
  });

  it('앞 기록이 없으면 「처음」 이라고 쓰고, 빈 기록 · 못 읽음을 따로 말한다', () => {
    const src = gui('lib/detail/HealthHistory.svelte');
    expect(src).toContain('<span class="from">처음</span>');
    expect(src).toContain('판정이 바뀐 기록이 없어요.');
    expect(src).toContain('헬스 기록을 읽지 못했어요.');
    expect(src).toContain('더 보기');
  });
});

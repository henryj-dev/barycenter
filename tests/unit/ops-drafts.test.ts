/**
 * **변경 초안 · 작업** 의 판정과 화면 (2026-11-21).
 *
 * 「저장」 이 실패하면 지금까지는 changeset 을 버렸다. 충돌(남이 먼저 커밋했다 · 412 · 서버 오류)이면 이제 초안으로 남긴다 —
 * 내용이 틀린 것(422 등)만 버린다. 작업 화면은 끝나지 않은 전환만 취소하게 한다(활성은 롤백이다).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  draftMark, draftSummary, failureKind, impactLines, keepsDraft, keptDraftMessage, opLine, parseDrafts,
} from '../../src/web/drafts-view.js';
import { cancellable, detailFacts, parseOperations, phaseMark } from '../../src/web/operations-view.js';
import { NAV_GROUPS } from '../../src/web/nav.js';
import { pageOf } from '../../src/web/page.js';
import { viewOfStatus } from '../../src/web/status-view.js';

describe('저장 실패의 종류 — 초안으로 남길까', () => {
  it('head 가 움직였다 · 남이 먼저 고쳤다 · 서버 오류는 남긴다. 내용이 틀린 것은 버린다', () => {
    expect(failureKind({ status: 409, code: 'PLAN_STALE' })).toBe('stale');
    expect(failureKind({ status: 412, code: 'precondition_failed' })).toBe('changed');
    expect(failureKind({ status: 422, code: 'invalid_model' })).toBe('invalid');
    expect(failureKind({ status: 409, code: 'key_taken' })).toBe('invalid');
    expect(failureKind({ status: 503, code: 'not_leader' })).toBe('other');
    expect(['stale', 'changed', 'other', 'invalid'].map((k) => keepsDraft(k as never))).toEqual([true, true, true, false]);
  });

  it('남겼을 때의 말은 어디로 가야 하는지 말한다', () => {
    expect(keptDraftMessage('stale', 'head 가 움직였다')).toContain('「최신 head 로 다시 계획」');
    expect(keptDraftMessage('stale', 'head 가 움직였다')).toContain('(head 가 움직였다)');
    expect(keptDraftMessage('other')).toContain('변경 › 초안');
    expect(keptDraftMessage('invalid', '모양이 틀렸다')).toBe('모양이 틀렸다');
  });
});

describe('초안 한 줄', () => {
  const rows = parseDrafts([
    { id: 'a', state: 'open', baseRevision: '7', patch: [{ op: 'put', kind: 'pool', key: 'web' }, { op: 'delete', kind: 'backend', key: 'b1' }], ops: 2, createdAt: '2026-11-21T00:00:00Z', createdBy: 'w', sealedAt: null, stale: false, etag: '"x"' },
    { id: 'b', state: 'sealed', baseRevision: '6', patch: [{ op: 'rename', kind: 'listener', key: 'old', to: 'new' }], stale: true },
    { id: 'c', state: 'committed' },
    'junk',
  ]);

  it('모양이 다른 줄은 뺀다', () => {
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows[1]?.ops).toBe(1);
  });

  it('요약 · 상태 · op 한 줄', () => {
    expect(draftSummary(rows[0]!)).toBe('풀 web 만들기 · 고치기 외 1건');
    expect(opLine({ op: 'delete', kind: 'backend', key: 'b1' })).toBe('백엔드 b1 지우기');
    expect(opLine({ op: 'rename', kind: 'listener', key: 'old', to: 'new' })).toBe('리스너 old → new 이름 바꾸기');
    expect(opLine({ op: 'put', kind: 'engine', key: 'engine' })).toBe('엔진 설정 만들기 · 고치기');
    expect(draftSummary({ patch: [] })).toBe('빈 초안');
    expect(draftMark(rows[0]!).text).toBe('● 열림');
    expect(draftMark(rows[1]!).tone).toBe('warn');
  });

  it('영향 요약은 끊기는 연결부터 말한다', () => {
    expect(impactLines(undefined)[0]?.text).toBe('영향을 몰라요.');
    const quiet = impactLines({ requiresReload: false, affectedListeners: [], socketChanges: { added: [], removed: [] } });
    expect(quiet.map((l) => l.tone)).toEqual(['ok', 'ok']);
    const loud = impactLines({ requiresReload: true, affectedListeners: [{}], sessionImpact: [{ effect: 'may_reset' }], socketChanges: { added: ['a'], removed: [] }, bindTransitions: [{}] });
    expect(loud[0]).toEqual({ tone: 'danger', text: '기존 연결이 끊길 수 있는 곳 1개' });
    expect(loud.map((l) => l.text)).toContain('두 번에 나눠 적용해야 해요 — 적용 대기 화면에서 확인해요.');
  });
});

describe('작업(전환)', () => {
  it('끝나지 않은 것만 취소한다. 활성은 롤백이다', () => {
    expect(cancellable({ terminal: false, phase: 'reload_intent' })).toBe(true);
    expect(cancellable({ terminal: false, phase: 'partially_activated' })).toBe(true);
    expect(cancellable({ terminal: true, phase: 'failed' })).toBe(false);
    expect(cancellable({ terminal: false, phase: 'activated' })).toBe(false);
  });

  it('단계 이름 · detail 의 사실', () => {
    expect(phaseMark('activated')).toEqual({ text: '활성', tone: 'ok' });
    expect(phaseMark('mystery').text).toBe('mystery');
    expect(detailFacts({ cancelled: true, by: 'kim', planes: ['http', 'stream'], reload: false }))
      .toEqual([{ label: '취소', value: '취소함 · kim' }, { label: '평면', value: 'http, stream' }, { label: 'reload', value: '안 함' }]);
    expect(parseOperations([{ id: 'o', phase: 'failed', terminal: true }, { nope: 1 }]).map((o) => o.id)).toEqual(['o']);
  });

  it('상태가 끝나지 않은 전환의 id 를 넘긴다 — 작업 화면이 그것을 고른다', () => {
    expect(viewOfStatus({ unfinished: { operationId: 'op-1', generation: 'r1-e1' } }).unfinishedOperation).toBe('op-1');
    expect(viewOfStatus({}).unfinishedOperation).toBeUndefined();
  });
});

describe('화면', () => {
  const gui = (p: string): string => readFileSync(join(import.meta.dirname, '../../gui/src', p), 'utf8');

  it('메뉴 — 변경 › 초안, 운영 › 작업', () => {
    const items = NAV_GROUPS.flatMap((g) => g.items.map((i) => `${g.title}/${i.label}/${i.href}`));
    expect(items).toContain('변경/초안//change/drafts');
    expect(items).toContain('운영/작업//ops/operation');
    expect(pageOf('/change/drafts')).toBe('drafts');
    expect(pageOf('/ops/operation')).toBe('operations');
  });

  it('저장은 충돌이면 초안을 남긴다 — 버리기 전에 판정한다', () => {
    const desk = gui('lib/desk.svelte.ts');
    expect(desk).toContain('keep = csId !== undefined && keepsDraft(kind);');
    expect(desk).toContain("if (csId !== undefined && error !== undefined && !keep) {");
  });

  it('JSON 으로 고치기에 「초안으로 두기」, 상태 띠에 「작업 보기」, 작업 화면에 확인이 필요한 취소', () => {
    expect(gui('lib/detail/JsonEdit.svelte')).toContain('>초안으로 두기</Button>');
    expect(gui('lib/ops/StatusPanel.svelte')).toContain('href={unfinishedHref}>작업 보기</Button>');
    const ops = gui('lib/ops/Operations.svelte');
    expect(ops).toContain('confirmLabel="작업 취소" requireCheck');
    expect(ops).toContain('!blocked && cancellable(current)');
    const drafts = gui('lib/ops/Drafts.svelte');
    expect(drafts).toContain('최신 head 로 다시 계획');
  });
});

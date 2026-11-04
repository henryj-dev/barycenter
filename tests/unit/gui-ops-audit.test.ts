/**
 * 기록 화면의 묶음 (#126 3단계) — 감사 줄을 「변경 하나 = 한 묶음」 으로 접는 규칙.
 *
 * API 는 줄마다 id · 시각 · 주체 · 동작 · 대상 · 리비전만 준다. changeset 단계는 대상(changeset id)으로,
 * apply 는 리비전으로 묶는다. 자동 적용은 apply 줄의 `trigger: 'auto'` 로 안다 — 시각으로 추정하지 않는다.
 */
import { describe, expect, it } from 'vitest';
import { groupAudit, whenText } from '../../gui/src/lib/ops/audit';

type Row = { id: string; at: string; principal: string; action: string; subject?: string; revision?: string; trigger?: 'auto' };
const row = (id: number, sec: number, principal: string, action: string, subject?: string, revision?: string): Row => ({
  id: String(id), at: new Date(Date.UTC(2026, 10, 3, 5, 0, sec)).toISOString(), principal, action,
  ...(subject === undefined ? {} : { subject }), ...(revision === undefined ? {} : { revision }),
});
const asRows = (rs: Row[]) => rs.map((r) => ({ ...r, subject: r.subject, revision: r.revision }));

describe('감사 기록 묶음', () => {
  it('changeset create → patch → plan → commit → apply 를 한 묶음으로, 사람이 나중에 적용하면 자동이 아니다', () => {
    const g = groupAudit(asRows([
      row(1, 0, 'alice', 'changeset.create', 'cs1'), row(2, 1, 'alice', 'changeset.patch', 'cs1'),
      row(3, 2, 'alice', 'changeset.plan', 'cs1'), row(4, 3, 'alice', 'changeset.commit', 'cs1', '9'),
      row(5, 50, 'alice', 'apply', 'plan-1', '9'),
    ]));
    expect(g).toHaveLength(1);
    expect(g[0]!.steps.map((s) => s.name)).toEqual(['changeset create', 'patch', 'plan', 'commit', 'apply']);
    expect(g[0]!.revision).toBe('9');
    expect(g[0]!.auto).toBe(false);
    expect(g[0]!.result).toEqual({ tone: 'ok', text: '적용됨' });
  });

  it('**apply 줄에 trigger: auto 가 있어야 자동 적용이다**', () => {
    const g = groupAudit(asRows([
      row(1, 0, 'acme', 'changeset.create', 'cs2'), row(2, 0, 'acme', 'changeset.commit', 'cs2', '11'),
      { ...row(3, 1, 'acme', 'apply', 'plan-2', '11'), trigger: 'auto' as const },
    ]));
    expect(g[0]!.auto).toBe(true);
    expect(g[0]!.result?.text).toBe('적용됨 · 자동 적용');
    expect(g[0]!.steps.at(-1)?.note).toBe('자동 적용');
  });

  it('**커밋 1초 뒤에 사람이(또는 스크립트가) 적용해도 표시가 없으면 자동이 아니다** — quickstart 에서 실측한 오판', () => {
    const g = groupAudit(asRows([
      row(1, 0, 'dev', 'changeset.create', 'cs3'), row(2, 0, 'dev', 'changeset.commit', 'cs3', '2'),
      row(3, 1, 'dev', 'apply', 'plan-3', '2'),
    ]));
    expect(g[0]!.auto).toBe(false);
    expect(g[0]!.result?.text).toBe('적용됨');
  });

  it('적용 대기 · 뒤 리비전과 함께 적용됨 · 버림을 가른다', () => {
    const g = groupAudit(asRows([
      row(1, 0, 'bob', 'changeset.create', 'a'), row(2, 1, 'bob', 'changeset.commit', 'a', '5'),
      row(3, 2, 'bob', 'changeset.create', 'b'), row(4, 3, 'bob', 'changeset.commit', 'b', '6'),
      row(5, 40, 'bob', 'apply', 'p6', '6'),
      row(6, 41, 'bob', 'changeset.create', 'c'), row(7, 42, 'bob', 'changeset.commit', 'c', '7'),
      row(8, 43, 'bob', 'changeset.create', 'd'), row(9, 44, 'bob', 'changeset.discard', 'd'),
    ]), ['7']);
    const by = (t: string) => g.find((x) => x.target === `changeset ${t}`)!;
    expect(by('a').result?.text).toBe('적용됨 · r6 와 함께');
    expect(by('c').result).toEqual({ tone: 'pending', text: '적용 대기' });
    expect(by('c').waiting).toBeDefined();
    expect(by('d').result?.text).toBe('버림');
    // 마지막 단계가 새 것부터
    expect(g[0]!.target).toBe('changeset d');
  });

  it('변경이 아닌 줄은 하나씩이고, 모르는 동작은 그대로 낸다', () => {
    const g = groupAudit(asRows([row(1, 0, 'user:alice', 'session.login', 'u1'), row(2, 1, 'x', 'weird.thing')]));
    expect(g.map((x) => x.title).sort()).toEqual(['weird.thing', '로그인'].sort());
    expect(g.every((x) => !x.change)).toBe(true);
  });

  it('시각은 오늘 · 어제 · 날짜로 쓴다', () => {
    const now = new Date(2026, 10, 3, 15, 0, 0);
    expect(whenText(new Date(2026, 10, 3, 14, 20, 33).toISOString(), now)).toMatch(/^오늘 /);
    expect(whenText(new Date(2026, 10, 2, 18, 20, 9).toISOString(), now)).toMatch(/^어제 /);
    expect(whenText(new Date(2026, 9, 30, 1, 2, 3).toISOString(), now)).toMatch(/^10월 30일 /);
    expect(whenText(undefined, now)).toBe('—');
  });
});

describe('멤버십만의 적용 (전역 합산 로컬 실측)', () => {
  it('**apply.membership 도 그 리비전의 「적용됨」 이다** — 백엔드만 더한 리비전이 「적용 기록 없음」 으로 나왔다', () => {
    const g = groupAudit(asRows([
      row(1, 0, 'dev', 'changeset.create', 'cs9'), row(2, 1, 'dev', 'changeset.commit', 'cs9', '3'),
      row(3, 30, 'dev', 'apply.membership', 'plan-9', '3'),
    ]));
    expect(g[0]!.result).toEqual({ tone: 'ok', text: '적용됨' });
    expect(g[0]!.steps.at(-1)?.name).toBe('apply · 멤버십');
  });
});

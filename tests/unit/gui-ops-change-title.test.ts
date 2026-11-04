/**
 * 기록 · 대시보드 「최근 변경」 의 변경 설명 — changeset 의 patch(+첫 리소스가 바탕 리비전에 있었는지)로
 * 시안의 「작업」 · 「대상」 을 만든다(`백엔드 demo-2 추가` · `pool web-pool`, `리스너 web-https 타임아웃 60s → 90s`).
 * 못 만들면 undefined — 화면은 「설정 변경」 으로 돌아간다.
 */
import { describe, expect, it } from 'vitest';
import { describeChange, parseChangeset, stateAtBase, type ChangeOp, type ChangesetFacts } from '../../gui/src/lib/ops/change-title';
import { groupAudit } from '../../gui/src/lib/ops/audit';

const put = (kind: string, key: string, body: Record<string, unknown> = {}): ChangeOp => ({ op: 'put', kind, key, body: { key, ...body } });

describe('변경 설명', () => {
  it('없던 백엔드는 「추가」, 대상은 속한 풀이다', () => {
    expect(describeChange([put('backend', 'demo-2', { pool: 'web-pool', host: '10.0.0.2', port: 80 })], { existed: false, before: null }))
      .toEqual({ title: '백엔드 demo-2 추가', target: 'pool web-pool' });
  });

  it('없던 인증서 · 리스너는 「만들기」, 대상은 시안의 영문 kind 와 자기 key', () => {
    expect(describeChange([put('certificate', 'counter.tinyuniver.se')], { existed: false }))
      .toEqual({ title: '인증서 counter.tinyuniver.se 만들기', target: 'cert counter.tinyuniver.se' });
    expect(describeChange([put('httpRoute', 'api-v2')], { existed: false })?.target).toBe('route api-v2');
  });

  it('칸 하나만 바뀌었으면 「<칸> <전> → <후>」 를 붙인다', () => {
    const before = { key: 'web-https', port: 443, readTimeoutS: 60 };
    expect(describeChange([put('listener', 'web-https', { port: 443, readTimeoutS: 90 })], { existed: true, before }))
      .toEqual({ title: '리스너 web-https 타임아웃 60s → 90s', target: 'listener web-https' });
  });

  it('이름표에 없는 칸은 내부 이름을 보이지 않고 「수정」 — 출발지 규칙 안이면 그 말을 붙인다', async () => {
    const { fieldLabel } = await import('../../gui/src/lib/ops/change-title.js');
    expect(fieldLabel('sourceRules[0].action.status')).toEqual({ l: '출발지 규칙 응답 코드' });
    expect(fieldLabel('somethingNew')).toBeUndefined();
    expect(describeChange([put('listener', 'l', { zzz: 2 })], { existed: true, before: { key: 'l', zzz: 1 } })?.title).toBe('리스너 l 수정');
  });

  it('여러 칸이 바뀌었으면 「수정」 만', () => {
    const before = { key: 'web-https', port: 443, readTimeoutS: 60 };
    expect(describeChange([put('listener', 'web-https', { port: 8443, readTimeoutS: 90 })], { existed: true, before })?.title)
      .toBe('리스너 web-https 수정');
  });

  it('enabled 하나만 바뀌면 「비활성화」 · 「활성화」', () => {
    expect(describeChange([put('listener', 'db-tcp', { enabled: false })], { existed: true, before: { key: 'db-tcp', enabled: true } })?.title)
      .toBe('리스너 db-tcp 비활성화');
  });

  it('인증서 자료가 바뀌면 「갱신」', () => {
    expect(describeChange([put('certificate', 'api.example.com', { materialRef: 'b', chainDigest: 'y' })],
      { existed: true, before: { key: 'api.example.com', materialRef: 'a', chainDigest: 'x' } })?.title).toBe('인증서 api.example.com 갱신');
  });

  it('서버가 준 바뀐 뒤 모습(after)이 있으면 patch 몸보다 먼저 쓴다 — 기본값 차이로 「수정」 이 되지 않게', () => {
    expect(describeChange([put('listener', 'l', { port: 81 })],
      { existed: true, before: { key: 'l', port: 80, http2: false }, after: { key: 'l', port: 81, http2: false } })?.title).toBe('리스너 l 포트 80 → 81');
  });

  it('삭제는 있었는지 몰라도 「삭제」', () => {
    expect(describeChange([{ op: 'delete', kind: 'pool', key: 'old' }], undefined)).toEqual({ title: '풀 old 삭제', target: 'pool old' });
  });

  it('여러 리소스면 「<첫째> 외 N건」 — 같은 리소스를 두 번 고친 것은 하나다', () => {
    const t = describeChange([put('pool', 'p'), put('backend', 'b1', { pool: 'p' }), put('backend', 'b2', { pool: 'p' }), put('pool', 'p')], { existed: false });
    expect(t).toEqual({ title: '풀 p 만들기 외 2건', target: 'pool p' });
  });

  it('있었는지 모르거나 · patch 가 비었거나 · 모르는 kind 면 undefined', () => {
    expect(describeChange([put('listener', 'l')], undefined)).toBeUndefined();
    expect(describeChange([], { existed: false })).toBeUndefined();
    expect(describeChange([put('widget', 'w')], { existed: false })).toBeUndefined();
  });
});

describe('바탕 리비전 때의 모습', () => {
  const cs = (base: string, committed?: string): ChangesetFacts => ({ baseRevision: base, committedRevision: committed, patch: [] });

  it('이 changeset 이 커밋한 기록 줄의 전 · 후를 쓴다', () => {
    const h = [{ revision: '9', change: 'changed', changeset: 'cs1', before: { key: 'l', port: 80 }, after: { key: 'l', port: 81 } }];
    expect(stateAtBase(h, 'cs1', cs('8', '9'))).toEqual({ existed: true, before: { key: 'l', port: 80 }, after: { key: 'l', port: 81 } });
    expect(stateAtBase([{ ...h[0], change: 'created', before: null }], 'cs1', cs('8', '9'))?.existed).toBe(false);
  });

  it('커밋 전이면 바탕 리비전 이하의 마지막 줄 — 삭제였으면 없었다', () => {
    const h = [
      { revision: '12', change: 'changed', changeset: 'x', before: {}, after: { key: 'l', port: 2 } },
      { revision: '7', change: 'changed', changeset: 'y', before: {}, after: { key: 'l', port: 1 } },
    ];
    expect(stateAtBase(h, 'cs1', cs('10'))).toEqual({ existed: true, before: { key: 'l', port: 1 } });
    expect(stateAtBase([{ revision: '7', change: 'deleted', after: null }], 'cs1', cs('10'))?.existed).toBe(false);
  });

  it('바탕 앞 줄이 없으면 — 기록이 다 들어왔을 때만 「없었다」, 창이 잘렸으면 모른다', () => {
    expect(stateAtBase([], 'cs1', cs('10'))?.existed).toBe(false);
    expect(stateAtBase([{ revision: '11', change: 'earliest', after: { key: 'l' } }], 'cs1', cs('10'))).toBeUndefined();
  });
});

describe('changeset 몸 읽기 · 묶음의 changeset id', () => {
  it('`GET /api/v1/changesets/:id` 의 몸을 읽는다 · 모양이 다르면 undefined', () => {
    expect(parseChangeset({ id: 'c', base_revision: '8', committed_revision: '9', patch: [{ op: 'delete', kind: 'pool', key: 'p' }] }))
      .toEqual({ baseRevision: '8', committedRevision: '9', patch: [{ op: 'delete', kind: 'pool', key: 'p' }] });
    expect(parseChangeset({ base_revision: '8', committed_revision: null, patch: [] })?.committedRevision).toBeUndefined();
    expect(parseChangeset({ message: 'nope' })).toBeUndefined();
    expect(parseChangeset({ base_revision: '8', patch: [{ op: 'move' }] })).toBeUndefined();
  });

  it('changeset 묶음은 id 와 마지막 단계 id 를 단다 — 설명을 못 읽으면 지금 글 그대로다', () => {
    const at = new Date().toISOString();
    const g = groupAudit([
      { id: '1', at, principal: 'alice', action: 'changeset.create', subject: 'cs1', revision: undefined },
      { id: '2', at, principal: 'alice', action: 'changeset.commit', subject: 'cs1', revision: '9' },
    ]);
    expect(g[0]).toMatchObject({ changeset: { id: 'cs1', ver: '2' }, title: '설정 변경', target: 'changeset cs1' });
  });
});

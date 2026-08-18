/**
 * 나뉜 CLI 단계 — apply --plan 은 changeset 을 새로 열지 않는다.
 */
import { describe, expect, it } from 'vitest';

import {
  CliRequestError,
  applyByPlan,
  changesetNew,
  changesetPatch,
  changesetPlan,
  commitByPlan,
  flag,
  unwrap,
} from '../../src/cli/flow.js';
import type { Http, HttpResult } from '../../src/cli/flow.js';

const script = (replies: HttpResult[]): { http: Http; calls: [string, string][] } => {
  const calls: [string, string][] = [];
  let i = 0;
  const http: Http = async (method, path) => {
    calls.push([method, path]);
    const r = replies[i];
    i += 1;
    if (r === undefined) throw new Error(`예상 밖 호출 ${method} ${path}`);
    return r;
  };
  return { http, calls };
};

describe('flag', () => {
  it('--plan 값을 읽고, 없거나 다음이 플래그면 안 읽는다', () => {
    expect(flag(['apply', '--plan', 'p1'], '--plan')).toBe('p1');
    expect(flag(['apply', 'file.json'], '--plan')).toBeUndefined();
    expect(flag(['apply', '--plan'], '--plan')).toBeUndefined();
    expect(flag(['apply', '--plan', '--mode'], '--plan')).toBeUndefined();
  });
});

describe('나뉜 단계', () => {
  it('changeset new 는 head 를 읽어 연다', async () => {
    const { http, calls } = script([
      { status: 200, body: { revision: '3' } },
      { status: 201, body: { id: 'cs-1' } },
    ]);
    expect(await changesetNew(http)).toEqual({ id: 'cs-1' });
    expect(calls).toEqual([
      ['GET', '/api/v1/config/head'],
      ['POST', '/api/v1/changesets'],
    ]);
  });

  it('commit --plan 은 plan 의 changeset 으로 커밋한다', async () => {
    const { http, calls } = script([
      { status: 200, body: { changesetId: 'cs-9', id: 'pl-1' } },
      { status: 200, body: { revision: '4' } },
    ]);
    expect(await commitByPlan(http, 'pl-1')).toEqual({ revision: '4' });
    expect(calls).toEqual([
      ['GET', '/api/v1/plans/pl-1'],
      ['POST', '/api/v1/changesets/cs-9/commit'],
    ]);
  });

  it('apply --plan 은 changeset 을 열지 않는다', async () => {
    const { http, calls } = script([
      { status: 200, body: { phase: 'activated', generation: 'g1' } },
    ]);
    expect((await applyByPlan(http, 'pl-1')).phase).toBe('activated');
    expect(calls).toEqual([['POST', '/api/v1/apply']]);
  });

  it('롤백 plan 은 commit --plan 으로 못 닫는다', async () => {
    const { http } = script([{ status: 200, body: { changesetId: null, id: 'pl-r' } }]);
    await expect(commitByPlan(http, 'pl-r')).rejects.toThrow(/changeset 이 없다/);
  });

  it('실패는 종료하지 않고 던진다', async () => {
    const { http } = script([{ status: 409, body: { code: 'PLAN_STALE', message: '만료' } }]);
    await expect(changesetPlan(http, 'cs-1')).rejects.toBeInstanceOf(CliRequestError);
    expect(() => unwrap({ status: 404, body: { message: '없다' } }, 'x')).toThrow(CliRequestError);
  });

  it('patch 는 받은 ops 를 그대로 보낸다', async () => {
    const { http, calls } = script([{ status: 200, body: { ok: true } }]);
    await changesetPatch(http, 'cs-1', [{ op: 'put', kind: 'pool', key: 'p' }]);
    expect(calls).toEqual([['PATCH', '/api/v1/changesets/cs-1']]);
  });
});

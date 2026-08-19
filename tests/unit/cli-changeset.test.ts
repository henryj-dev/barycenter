/**
 * CLI changeset discard · reopen — DESIGN.md §5.2. apply 가 아니다.
 */
import { describe, expect, it } from 'vitest';

import {
  changesetDiscard, changesetReopen, type Http, type HttpResult,
} from '../../src/cli/flow.js';

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

describe('changeset discard', () => {
  it('discard 는 DELETE 다. apply 를 안 한다', async () => {
    const { http, calls } = script([{ status: 204, body: '' }]);
    await changesetDiscard(http, 'cs-1');
    expect(calls).toEqual([['DELETE', '/api/v1/changesets/cs-1']]);
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/apply')).toBe(false);
  });

  it('빈 키는 호출하지 않는다', async () => {
    const { http, calls } = script([]);
    await expect(changesetDiscard(http, '')).rejects.toThrow(/키가 비어/);
    expect(calls).toEqual([]);
  });
});

describe('changeset reopen', () => {
  it('reopen 은 sealed 를 연다. apply 를 안 한다', async () => {
    const { http, calls } = script([{ status: 200, body: { id: 'cs-1', state: 'open' } }]);
    expect(await changesetReopen(http, 'cs-1')).toEqual({ id: 'cs-1', state: 'open' });
    expect(calls).toEqual([['POST', '/api/v1/changesets/cs-1/reopen']]);
    expect(calls.some(([m, p]) => m === 'POST' && p === '/api/v1/apply')).toBe(false);
  });

  it('빈 키는 호출하지 않는다', async () => {
    const { http, calls } = script([]);
    await expect(changesetReopen(http, '')).rejects.toThrow(/키가 비어/);
    expect(calls).toEqual([]);
  });
});

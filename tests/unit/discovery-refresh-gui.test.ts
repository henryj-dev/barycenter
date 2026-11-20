/**
 * 풀의 「지금 다시 찾기」 — 화면과 CLI 가 같은 창구를 부른다 (2026-11-20).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { poolDiscoveryRefresh } from '../../src/cli/pool.js';

const src = (p: string): string => readFileSync(join(import.meta.dirname, '../..', p), 'utf8');

describe('화면', () => {
  it('출처 상자가 「지금 다시 찾기」 를 단다 — 쓰기가 막히면 감춘다', () => {
    const s = src('gui/src/lib/detail/PoolDiscovered.svelte');
    expect(s).toContain('desk.refreshDiscovery(pool)');
    expect(s).toContain('{#if canWrite}');
    expect(s).toContain('지금 다시 찾기');
  });

  it('desk 는 `POST /pools/:id/discovery/refresh` 를 부르고 실패에도 상태를 넘긴다', () => {
    const s = src('gui/src/lib/desk.svelte.ts');
    expect(s).toContain("call('POST', `/api/v1/pools/${encodeURIComponent(key)}/discovery/refresh`, {})");
    expect(s).toContain("const view = r.body['view'] as DiscoveryPoolView | undefined;");
  });

  it('감사 로그가 동작 이름을 사람 말로 보인다', () => {
    expect(src('gui/src/lib/ops/audit.ts')).toContain("'discovery.refresh': '백엔드 출처 다시 찾기'");
  });
});

describe('CLI', () => {
  it('`bary pool discovery-refresh` 가 같은 창구를 부른다', async () => {
    const calls: [string, string][] = [];
    const out = await poolDiscoveryRefresh(async (method, path) => {
      calls.push([method, path]);
      return { status: 200, body: { pool: 'a:b', state: 'ok', advertised: true, endpoints: [], changed: false } };
    }, 'a:b');
    expect(calls).toEqual([['POST', '/api/v1/pools/a%3Ab/discovery/refresh']]);
    expect(out.state).toBe('ok');
  });

  it('도움말에 있다', () => {
    expect(src('src/bin/bary.ts')).toContain('bary pool discovery-refresh <이름>');
  });
});

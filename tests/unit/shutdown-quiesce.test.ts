/**
 * 종료가 하던 일을 기다린 뒤 DB 를 닫는다 (2026-11-21).
 *
 * 재시작마다 옛 프로세스가 `prober.failed` · `api.internal`(`Cannot use a pool after calling end`)을
 * 한 줄 남겼다. 타이머를 멈춰도 돌던 한 바퀴와 요청은 계속 갔고, 그것이 닫힌 DB 를 썼다.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { HealthProber } from '../../src/control/health.js';
import { Inflight, settleWithin } from '../../src/control/quiesce.js';
import type { Database } from '../../src/store/db.js';

const later = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('Inflight', () => {
  it('진행 중인 일이 끝나면 idle 이 풀린다', async () => {
    const f = new Inflight();
    let done = false;
    void f.track(later(30).then(() => { done = true; }));
    expect(f.size).toBe(1);
    await f.idle();
    expect(done).toBe(true);
    expect(f.size).toBe(0);
  });

  it('실패한 일도 끝난 것으로 센다', async () => {
    const f = new Inflight();
    void f.track(Promise.reject(new Error('x'))).catch(() => undefined);
    await f.idle();
    expect(f.size).toBe(0);
  });
});

describe('settleWithin', () => {
  it('끝나면 true, 시간이 다 되면 false', async () => {
    expect(await settleWithin(200, [later(10)])).toBe(true);
    expect(await settleWithin(20, [later(500)])).toBe(false);
  });
});

describe('HealthProber.stop', () => {
  it('돌고 있던 한 바퀴가 끝난 뒤에 풀린다 — 그 뒤에 DB 를 닫아도 안전하다', async () => {
    const prober = new HealthProber({} as Database, { intervalMs: 60_000 });
    let finished = false;
    // 한 바퀴가 느리게 끝나는 것을 흉내 낸다 — `onSweep` 이 늦게 답하고 모델이 없다.
    prober.start(async () => { await later(40); finished = true; return undefined; }, async () => undefined);
    await later(5);
    await prober.stop();
    expect(finished).toBe(true);
  });
});

describe('barycenterd 종료 순서', () => {
  const src = readFileSync(join(import.meta.dirname, '../../src/bin/barycenterd.ts'), 'utf8');

  it('하던 일을 기다린 뒤 락을 놓고 DB 를 닫는다', () => {
    const wait = src.indexOf('settleWithin(QUIESCE_MS, [proberDone, acmeDone, inflight.idle()])');
    const close = src.indexOf('.then(() => db.close())');
    expect(wait).toBeGreaterThan(0);
    expect(close).toBeGreaterThan(wait);
  });

  it('API 요청을 센다', () => {
    expect(src).toContain('inflight,');
  });
});

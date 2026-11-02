/**
 * **풀 헬스체크 폼** (2026-11-02). 전에는 GUI 에 헬스체크를 고칠 곳이 없었다 — web-01 의 counter 백엔드가 Host 없는 `GET /` 에
 * 400 을 받아 빠졌을 때, 경로와 Host 헤더를 JSON 으로 손으로 넣어야 했다.
 */
import { describe, expect, it } from 'vitest';

import { HEALTH_DEFAULT, healthCheckOf, healthFormOf, healthIssue, poolBodyWithHealth } from '../../src/web/health-check.js';
import { decodeModel } from '../../src/model/decode.js';

const counter = {
  key: 'counter.tinyuniver.se', protocolClass: 'http', algorithm: 'round_robin',
  healthCheck: { protocol: 'http', path: '/status', hostHeader: 'counter.tinyuniver.se' },
};

describe('헬스체크 폼', () => {
  it('**web-01 counter 의 헬스체크가 폼으로 왔다가 그대로 돌아간다**', () => {
    const f = healthFormOf(counter);
    expect(f.mode).toBe('http');
    expect(f.path).toBe('/status');
    expect(poolBodyWithHealth(counter, f)).toEqual({
      protocolClass: 'http', algorithm: 'round_robin',
      healthCheck: { protocol: 'http', path: '/status', hostHeader: 'counter.tinyuniver.se' },
    });
  });

  it('기본은 필드를 뺀다 · 안 해요는 mode none · TCP 는 tcp_connect', () => {
    expect(poolBodyWithHealth(counter, { ...HEALTH_DEFAULT })).toEqual({ protocolClass: 'http', algorithm: 'round_robin' });
    expect(healthCheckOf({ ...HEALTH_DEFAULT, mode: 'none' })).toEqual({ mode: 'none' });
    expect(healthCheckOf({ ...HEALTH_DEFAULT, mode: 'tcp', port: '9000', intervalS: '5', timeoutS: '2' }))
      .toEqual({ protocol: 'tcp_connect', port: 9000, intervalS: 5, timeoutS: 2 });
  });

  it('기대 상태 코드는 쉼표 · 공백으로 나눈다', () => {
    expect(healthCheckOf({ ...HEALTH_DEFAULT, mode: 'http', expectStatus: '200, 204 301' })?.['expectStatus']).toEqual([200, 204, 301]);
  });

  it('**저장 못 하는 값은 미리 말한다** — 숫자가 아님 · 타임아웃이 주기보다 김 · / 없는 경로', () => {
    expect(healthIssue({ ...HEALTH_DEFAULT, mode: 'tcp', port: 'eighty' })).toMatch(/정수/);
    expect(healthIssue({ ...HEALTH_DEFAULT, mode: 'http', intervalS: '2', timeoutS: '5' })).toMatch(/주기/);
    expect(healthIssue({ ...HEALTH_DEFAULT, mode: 'http', path: 'status' })).toMatch(/\//);
    expect(() => poolBodyWithHealth(counter, { ...HEALTH_DEFAULT, mode: 'http', intervalS: '2', timeoutS: '5' })).toThrow();
  });

  it('폼이 만든 헬스체크는 해독기를 지난다', () => {
    const hc = healthCheckOf({ ...HEALTH_DEFAULT, mode: 'http', path: '/healthz', hostHeader: 'a.test', expectStatus: '200', rise: '2', fall: '3' });
    const d = decodeModel({
      listeners: [], httpRoutes: [], passthroughRoutes: [],
      pools: [{ key: 'p', protocolClass: 'http', algorithm: 'round_robin', healthCheck: hc }],
      backends: [], certificates: [], tlsPolicies: [], sniBindings: [],
    });
    expect(d.ok).toBe(true);
  });
});

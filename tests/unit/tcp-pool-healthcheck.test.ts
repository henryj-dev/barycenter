/**
 * tcp 풀의 헬스체크를 검증기가 받는다 (2026-11-21).
 *
 * GUI 는 tcp 풀에 헬스체크 편집기를 보였다. 해독기와 프로버(`probePlanOf`)도 tcp 풀의 헬스체크를
 * 따른다. 그런데 의미 검증기만 http 가 아닌 풀을 모두 막아서, 저장하면 거절되었다.
 * udp 는 프로브가 없으므로 계속 막는다.
 */
import { describe, expect, it } from 'vitest';

import { decodeModel } from '../../src/model/decode.js';
import { validateModel } from '../../src/validate/model.js';
import { probePlanOf } from '../../src/control/health.js';

const modelWith = (protocolClass: 'tcp' | 'udp', healthCheck: unknown): unknown => ({
  listeners: [], httpRoutes: [], passthroughRoutes: [],
  certificates: [], tlsPolicies: [], sniBindings: [],
  pools: [{ key: 'db', protocolClass, algorithm: 'round_robin', healthCheck }],
  backends: [{ key: 'db-1', pool: 'db', host: '10.0.0.5', port: 5432, weight: 1 }],
});

function issuesOf(raw: unknown): string[] {
  const r = decodeModel(raw);
  if (!r.ok) throw new Error(`해독 실패: ${JSON.stringify(r.issues)}`);
  return validateModel(r.model).filter((i) => i.subjects.includes('db')).map((i) => i.message);
}

describe('tcp 풀 헬스체크', () => {
  it('TCP 연결 검사의 포트 · 주기 · rise · fall 을 받는다', () => {
    const hc = { protocol: 'tcp_connect', port: 9000, intervalS: 5, timeoutS: 2, rise: 2, fall: 3 };
    expect(issuesOf(modelWith('tcp', hc))).toEqual([]);
    const r = decodeModel(modelWith('tcp', hc));
    if (!r.ok) throw new Error('해독 실패');
    expect(probePlanOf(r.model, 'db')).toMatchObject({ protocol: 'tcp_connect', port: 9000, intervalS: 5, rise: 2, fall: 3 });
  });

  it('검사 안 함과 HTTP 헬스 포트(§4.3.1)도 받는다', () => {
    expect(issuesOf(modelWith('tcp', { mode: 'none' }))).toEqual([]);
    expect(issuesOf(modelWith('tcp', { protocol: 'http', port: 8080, path: '/healthz' }))).toEqual([]);
  });

  it('udp 풀은 계속 막는다 — udp 프로브가 없다', () => {
    expect(issuesOf(modelWith('udp', { mode: 'none' })).join(' ')).toMatch(/udp 인데 healthCheck/);
  });
});

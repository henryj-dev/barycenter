/**
 * 리스너 상세·수정 (2026-10-30, GUI 경로 분리) — `/traffic/listener/<key>` · `/edit`.
 *
 * 수정은 `put` 이라 리스너 전체를 갈아 끼운다. 화면에 없는 칸이 지워지면 조용한 설정 손실이다 —
 * 그래서 **head 모델을 바탕으로** 고친 칸만 덮는지, 그리고 그 결과가 모델 해독기를 그대로
 * 통과하는지 잰다.
 */
import { describe, expect, it } from 'vitest';

import { decodeModel } from '../../src/model/decode.js';
import { editListenerPatch } from '../../src/web/edit.js';
import { detailOfListener } from '../../src/web/listeners-view.js';

const https = {
  key: 'edge-443',
  protocol: 'https',
  bind: '0.0.0.0',
  port: 443,
  enabled: true,
  sourceAllow: ['@cloudflare'],
  tls: { policy: 'modern', defaultCertificate: 'cf-origin' },
  http2: true,
  http: {
    defaultAction: { pool: 'web' },
    headers: { response: [{ name: 'x-served-by', value: 'bary' }] },
    rateLimit: { requestsPerSecond: 50, burst: 100 },
  },
};

const decodes = (body: Record<string, unknown>, key: string): void => {
  const r = decodeModel({ listeners: [{ key, ...body }] });
  expect(r.ok, JSON.stringify(r.ok ? [] : r.issues)).toBe(true);
};

describe('editListenerPatch', () => {
  it('고친 칸만 덮고 화면에 없는 칸(TLS·헤더·레이트리밋)은 그대로 싣는다', () => {
    const [op] = editListenerPatch(https, {
      bind: ' 10.0.0.1 ', port: 8443, enabled: false, sourceAllow: ['203.0.113.0/24'], defaultAction: 'reject',
    });
    expect(op).toMatchObject({ op: 'put', kind: 'listener', key: 'edge-443' });
    expect(op!.body).toEqual({
      protocol: 'https',
      bind: '10.0.0.1',
      port: 8443,
      enabled: false,
      sourceAllow: ['203.0.113.0/24'],
      tls: https.tls,
      http2: true,
      http: { ...https.http, defaultAction: 'reject' },
    });
    // body 에 key 를 다시 싣지 않는다 — key 는 op 의 것이다.
    expect(op!.body).not.toHaveProperty('key');
  });

  it('출발지 제한을 비우면 키를 지운다 — 빈 배열은 해독기가 거절한다', () => {
    const [op] = editListenerPatch(https, { bind: '0.0.0.0', port: 443, enabled: true, sourceAllow: [] });
    expect(op!.body).not.toHaveProperty('sourceAllow');
    // 기본 동작을 안 주면 그대로다.
    expect((op!.body['http'] as { defaultAction: unknown }).defaultAction).toEqual({ pool: 'web' });
  });

  it('tcp·udp 는 defaultPool 을 고치고, 거절은 못 둔다', () => {
    const tcp = { key: 'db', protocol: 'tcp', bind: '0.0.0.0', port: 5432, enabled: true, defaultPool: 'pg' };
    const [op] = editListenerPatch(tcp, { bind: '0.0.0.0', port: 5433, enabled: true, defaultAction: { pool: 'pg2' } });
    expect(op!.body).toEqual({ protocol: 'tcp', bind: '0.0.0.0', port: 5433, enabled: true, defaultPool: 'pg2' });
    decodes(op!.body, 'db');
    expect(() => editListenerPatch(tcp, { bind: '0.0.0.0', port: 1, enabled: true, defaultAction: 'reject' }))
      .toThrow(/거절/);
  });

  it('패스스루는 기본 풀을 여기서 못 고친다', () => {
    const pt = { key: 'sni', protocol: 'tls_passthrough', bind: '0.0.0.0', port: 443, enabled: true };
    expect(() => editListenerPatch(pt, { bind: '0.0.0.0', port: 443, enabled: true, defaultAction: { pool: 'x' } }))
      .toThrow(/못 고친다/);
    const [op] = editListenerPatch(pt, { bind: '0.0.0.0', port: 8443, enabled: true });
    decodes(op!.body, 'sni');
  });

  it('바인드·포트가 틀리면 패치를 안 만든다', () => {
    expect(() => editListenerPatch(https, { bind: ' ', port: 443, enabled: true })).toThrow(/바인드/);
    expect(() => editListenerPatch(https, { bind: '0.0.0.0', port: 0, enabled: true })).toThrow(/포트/);
    expect(() => editListenerPatch(https, { bind: '0.0.0.0', port: 70000, enabled: true })).toThrow(/포트/);
    expect(() => editListenerPatch({ protocol: 'http' }, { bind: '0.0.0.0', port: 80, enabled: true })).toThrow(/키/);
  });

  it('HTTP 리스너 결과가 모델 해독기를 그대로 통과한다', () => {
    const http = {
      key: 'web-80', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true,
      http: { defaultAction: 'reject', limits: { connectTimeoutMs: 5000 } },
    };
    decodes(Object.fromEntries(Object.entries(http).filter(([k]) => k !== 'key')), 'web-80');
    const [op] = editListenerPatch(http, {
      bind: '127.0.0.1', port: 8080, enabled: true, sourceAllow: ['10.0.0.0/8'], defaultAction: { pool: 'web' },
    });
    expect(op!.body['http']).toEqual({ defaultAction: { pool: 'web' }, limits: { connectTimeoutMs: 5000 } });
    decodes(op!.body, 'web-80');
  });
});

describe('detailOfListener', () => {
  const value = (lines: { label: string; value: string }[], label: string): string | undefined =>
    lines.find((l) => l.label === label)?.value;

  it('HTTPS 는 기본 동작·TLS 정책·기본 인증서·HTTP/2 를 편다', () => {
    const lines = detailOfListener(https);
    expect(value(lines, '바인드')).toBe('0.0.0.0:443');
    expect(value(lines, '출발지 제한')).toBe('@cloudflare');
    expect(value(lines, '기본 동작')).toBe('풀 web');
    expect(value(lines, 'TLS 정책')).toBe('modern');
    expect(value(lines, '기본 인증서')).toBe('cf-origin');
    expect(value(lines, 'HTTP/2')).toBe('켜짐');
  });

  it('없는 기본값을 지어내지 않는다 — 제한 없음·거절을 그대로 말한다', () => {
    const lines = detailOfListener({ key: 'p', protocol: 'tls_passthrough', bind: '::', port: 443, enabled: false });
    expect(value(lines, '켜짐')).toMatch(/꺼짐/);
    expect(value(lines, '출발지 제한')).toBe('없음 (누구나)');
    expect(value(lines, 'SNI 매칭 없음')).toBe('거절');
    expect(value(lines, 'SNI 없음')).toBe('거절');
    expect(value(lines, 'preread 타임아웃')).toBeUndefined();
    expect(value(lines, 'PROXY 수신')).toBeUndefined();
  });

  it('UDP 는 기본 풀과 프리셋', () => {
    const lines = detailOfListener({
      key: 'dns', protocol: 'udp', bind: '0.0.0.0', port: 53, enabled: true, defaultPool: 'dns', udp: { preset: 'dns' },
    });
    expect(value(lines, '기본 풀')).toBe('dns');
    expect(value(lines, '프리셋')).toBe('dns');
  });
});

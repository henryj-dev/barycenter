/**
 * 메트릭과 구조화 로그 (DESIGN.md §6.4 리소스 알람)
 *
 * §6.4 는 *"`serving_generations` 수, FD, 메모리, UDP 세션, conntrack"* 에 알람을 걸라고
 * 하는데 **하나도 없었다.** 그리고 이 저장소가 오래 달고 있는 부채가 전부 "오래 돌면
 * 자란다" 부류다 — 자라는지 보려면 재는 자리가 있어야 한다.
 *
 * 여기서 재는 것은 **재는 자리가 진짜를 말하는가**다. 게이지가 실제 디스크를 읽는지,
 * 로그가 파싱 가능한 한 줄인지.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { log, setSink } from '../../src/obs/log.js';
import {
  count, fileBytes, measureGenerations, render, resetCounters, type Gauges,
} from '../../src/obs/metrics.js';

let prefix: string;

const ZERO: Gauges = {
  generations: 0, generationBytes: 0, agentStateBytes: 0, head: 1, leader: 0,
  activationEpochHttp: 0, activationEpochStream: 0, unfinished: 0,
  backendsHealthy: 0, backendsUnhealthy: 0, backendsUnknown: 0, pendingApply: 0,
  uptimeSeconds: 0, rssBytes: 0,
};

beforeEach(() => {
  prefix = mkdtempSync(join(tmpdir(), 'bary-metrics-'));
  resetCounters();
});

afterEach(() => {
  rmSync(prefix, { recursive: true, force: true });
  setSink((line) => process.stdout.write(`${line}\n`));
});

describe('게이지는 실제를 읽는다', () => {
  it('세대가 없으면 0 — 실패가 아니라 "아직 없다" 다', () => {
    expect(measureGenerations(prefix)).toEqual({ count: 0, bytes: 0 });
  });

  it('**세대 수와 바이트를 센다** — 상한이 도는지 보는 자리다', () => {
    for (const g of ['r2-e1', 'r3-e2', 'bootstrap']) {
      mkdirSync(join(prefix, 'generations', g, 'admin'), { recursive: true });
      writeFileSync(join(prefix, 'generations', g, 'nginx.conf'), 'x'.repeat(100));
      writeFileSync(join(prefix, 'generations', g, 'admin', 'marker.conf'), 'y'.repeat(50));
    }
    const m = measureGenerations(prefix);
    expect(m.count).toBe(3);
    // **하위 디렉토리까지 센다.** 안 세면 인증서가 들어가는 v0.6 에서 크게 빗나간다.
    expect(m.bytes).toBe(3 * 150);
  });

  it('**durable 상태 파일의 바이트를 잰다** — 원장 성장의 관측 창구', () => {
    // 원장 내부를 안 들여다보는 이유: 저장소 payload 는 불투명하다는 계약이고(9차 검수),
    // 파일 크기는 그 계약을 안 깨면서 "자라는가" 에 답한다.
    const path = join(prefix, 'agent.json');
    expect(fileBytes(path)).toBe(0);
    writeFileSync(path, 'z'.repeat(4096));
    expect(fileBytes(path)).toBe(4096);
  });

  it('없는 파일은 0 이다 — 던지지 않는다', () => {
    expect(fileBytes(join(prefix, '없는것'))).toBe(0);
  });
});

describe('Prometheus 노출', () => {
  it('게이지마다 HELP·TYPE·값이 나온다', () => {
    const out = render({ ...ZERO, generations: 7, head: 42 });
    expect(out).toContain('# HELP bary_generations');
    expect(out).toContain('# TYPE bary_generations gauge');
    expect(out).toContain('bary_generations 7');
    expect(out).toContain('bary_config_head_revision 42');
  });

  it('카운터가 함께 나온다 — 라벨은 이름에 접어 넣는다', () => {
    count('bary_apply_total{phase="activated"}');
    count('bary_apply_total{phase="activated"}');
    count('bary_apply_total{phase="failed"}');
    const out = render(ZERO);
    expect(out).toContain('bary_apply_total{phase="activated"} 2');
    expect(out).toContain('bary_apply_total{phase="failed"} 1');
  });

  it('**모든 줄이 형식을 지킨다** — 스크레이퍼가 파싱할 수 있어야 한다', () => {
    count('bary_x_total{a="b"}');
    const withLabels = render({ ...ZERO, rssBytes: 12345 }, [{
      name: 'bary_certificate_expiry_seconds', help: '남은 초',
      samples: [{ labels: { certificate: 'c' }, value: -1 }],
    }]);
    for (const line of withLabels.trim().split('\n')) {
      expect(line, `형식이 아닌 줄: ${line}`).toMatch(/^(# (HELP|TYPE) \S+ .+|\S+ -?\d+(\.\d+)?)$/);
    }
  });

  it('**라벨 있는 게이지 계열이 나온다** — 인증서마다 하나 (§4.6)', () => {
    const out = render(ZERO, [{
      name: 'bary_certificate_expiry_seconds',
      help: '남은 초',
      samples: [
        { labels: { certificate: 'cert-a' }, value: 86400 },
        { labels: { certificate: 'cert-b' }, value: -10 },
      ],
    }]);
    expect(out).toContain('# TYPE bary_certificate_expiry_seconds gauge');
    expect(out).toContain('bary_certificate_expiry_seconds{certificate="cert-a"} 86400');
    // **음수가 나가야 한다.** 0 으로 깎으면 "이미 만료" 와 "오늘 만료" 가 같아진다.
    expect(out).toContain('bary_certificate_expiry_seconds{certificate="cert-b"} -10');
  });

  it('**표본이 없으면 헤더도 안 낸다** — 빈 계열은 "있는데 비었다" 로 읽힌다', () => {
    const out = render(ZERO, [{ name: 'bary_x', help: 'h', samples: [] }]);
    expect(out).not.toContain('bary_x');
  });

  it('라벨 값의 따옴표를 이스케이프한다 — 안 하면 노출이 통째로 깨진다', () => {
    const out = render(ZERO, [{
      name: 'bary_x', help: 'h',
      samples: [{ labels: { k: 'a"b' }, value: 1 }],
    }]);
    expect(out).toContain('bary_x{k="a\\"b"} 1');
  });

  it('카운터가 없으면 게이지만 나온다 — 빈 줄을 안 남긴다', () => {
    expect(render(ZERO)).not.toMatch(/\n\n/);
  });
});

describe('구조화 로그', () => {
  it('**한 줄에 JSON 하나** — 문장을 다시 파싱하지 않는다', () => {
    const lines: string[] = [];
    setSink((l) => lines.push(l));
    log.info('apply.activated', { generation: 'r2-e1', planes: ['http'] });
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed['event']).toBe('apply.activated');
    expect(parsed['level']).toBe('info');
    expect(parsed['generation']).toBe('r2-e1');
    expect(parsed['planes']).toEqual(['http']);
  });

  it('**시각이 먼저다** — `sort` 로 정렬할 수 있어야 한다', () => {
    const lines: string[] = [];
    setSink((l) => lines.push(l));
    log.info('a');
    expect(lines[0]).toMatch(/^\{"ts":"\d{4}-\d{2}-\d{2}T/);
  });

  it('**직렬화가 실패해도 프로세스를 안 죽인다**', () => {
    const lines: string[] = [];
    setSink((l) => lines.push(l));
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(() => log.error('boom', { cyclic })).not.toThrow();
    const parsed = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(parsed['error']).toBe('직렬화 실패');
    expect(parsed['event']).toBe('boom');
  });

  it('level 셋을 구분한다', () => {
    const lines: string[] = [];
    setSink((l) => lines.push(l));
    log.info('i');
    log.warn('w');
    log.error('e');
    expect(lines.map((l) => (JSON.parse(l) as { level: string }).level))
      .toEqual(['info', 'warn', 'error']);
  });
});

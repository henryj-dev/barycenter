/**
 * §4.3.1 프로브 필드 — **데이터 경로와 갈린다** (2026-08-29)
 *
 * v1 은 프로브 종류를 `protocolClass` 에 묶었고, 그것이 *"TCP/UDP 서비스가 별도 HTTP
 * 헬스 포트나 사이드카 프로브를 갖는 정당한 구성을 막았다"* (§4.3.1). `protocol`·`port`·
 * `hostOverride` 가 그 매듭을 푼다.
 *
 * ── 이 파일이 함께 못 박는 두 가지 결정
 *
 *   **평평하다.** §4.3.1 은 `probe.http.{path,...}` 로 중첩을 그렸지만 그대로 옮기지
 *   않는다. `path`·`expectStatus`·`expectBody` 가 이미 그 이름 그 자리에 살고 있고,
 *   옮기면 **그 필드를 쓴 옛 리비전이 해독 불가**가 되어 롤백이 막힌다. 그래서 아래
 *   「옛 모양」 검사가 있다 — 이 파일의 절반은 *넓혔다* 가 아니라 *안 깨뜨렸다* 를 잰다.
 *
 *   **`passive` 와 `udp_payload` 는 없다.** 전자는 이 평면에서 성립하지 않고(`server`
 *   줄이 없다), 후자는 §13-6 이 드라이버 위임으로 못 박았다. 표에 있다고 받으면
 *   **표현은 되는데 안 지켜지는** 설정이 된다 — `source_ip_hash` 가 한 번 그랬다.
 */
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, describe, expect, it } from 'vitest';

import { decodeModel } from '../../src/model/decode.js';
import { probeBackend, probePlanOf } from '../../src/control/health.js';
import type { Model } from '../../src/model/provisional.js';

const servers: { close(): void }[] = [];
afterAll(() => { for (const s of servers) s.close(); });

/** 열린 포트 하나. 프로브가 **어디를 찌르는지**를 재는 데만 쓴다. */
async function serveOk(): Promise<number> {
  const s = createServer((_q, r) => { r.writeHead(200); r.end('ok'); });
  servers.push(s);
  await new Promise<void>((res) => s.listen(0, '127.0.0.1', res));
  return (s.address() as AddressInfo).port;
}

const base = {
  listeners: [], httpRoutes: [], passthroughRoutes: [], backends: [],
  certificates: [], tlsPolicies: [], sniBindings: [],
};

const withHealthCheck = (healthCheck: unknown): unknown => ({
  ...base,
  pools: [{ key: 'app', protocolClass: 'tcp', algorithm: 'round_robin', healthCheck }],
});

/** 해독 결과의 풀 하나. 실패하면 이슈를 메세지에 실어 준다. */
function poolOf(raw: unknown): Record<string, unknown> {
  const r = decodeModel(raw);
  if (!r.ok) throw new Error(`해독 실패: ${JSON.stringify(r.issues)}`);
  return (r.model.pools[0] as unknown as Record<string, unknown>);
}

function issuesOf(raw: unknown): string {
  const r = decodeModel(raw);
  return r.ok ? '' : JSON.stringify(r.issues);
}

describe('프로브가 데이터 경로와 갈린다', () => {
  it('**tcp 풀도 http 프로브를 가질 수 있다** — §4.3.1 이 겨눈 자리', () => {
    const hc = poolOf(withHealthCheck({
      protocol: 'http', port: 9000, path: '/healthz', hostHeader: 'app.internal',
    }))['healthCheck'] as Record<string, unknown>;
    expect(hc['protocol']).toBe('http');
    expect(hc['port']).toBe(9000);
    expect(hc['hostHeader']).toBe('app.internal');
  });

  it('사이드카 주소로 찌를 수 있다', () => {
    const hc = poolOf(withHealthCheck({ hostOverride: '127.0.0.1' }))['healthCheck'] as Record<string, unknown>;
    expect(hc['hostOverride']).toBe('127.0.0.1');
  });

  it('주기·타임아웃·연속 판정을 풀별로 정한다', () => {
    const hc = poolOf(withHealthCheck({
      intervalS: 5, timeoutS: 2, rise: 3, fall: 4,
    }))['healthCheck'] as Record<string, unknown>;
    expect([hc['intervalS'], hc['timeoutS'], hc['rise'], hc['fall']]).toEqual([5, 2, 3, 4]);
  });

  it('`mode: none` 으로 이 풀만 프로브를 끈다', () => {
    const hc = poolOf(withHealthCheck({ mode: 'none' }))['healthCheck'] as Record<string, unknown>;
    expect(hc['mode']).toBe('none');
  });
});

describe('안 받는 것', () => {
  it('**`passive` 를 안 받는다** — 이 평면에서 성립하지 않는다', () => {
    expect(issuesOf(withHealthCheck({ mode: 'passive' }))).toMatch(/mode/);
  });

  it('**`udp_payload` 를 안 받는다** — §13-6 이 드라이버 위임으로 못 박았다', () => {
    expect(issuesOf(withHealthCheck({ protocol: 'udp_payload' }))).toMatch(/protocol/);
  });

  it('모르는 필드를 안 받는다 — 오타가 조용히 무시되면 안 켜진 설정이 켜진 줄 안다', () => {
    expect(issuesOf(withHealthCheck({ intervalSec: 5 }))).toMatch(/unknown_field/);
  });

  it('`rise: 0` 을 안 받는다 — 0 번 연속 성공이면 판정이 사라진다', () => {
    expect(issuesOf(withHealthCheck({ rise: 0 }))).toMatch(/rise/);
  });

  it('`intervalS: 0` 을 안 받는다 — 쉬지 않고 찌른다', () => {
    expect(issuesOf(withHealthCheck({ intervalS: 0 }))).toMatch(/intervalS/);
  });

  it('**타임아웃이 주기보다 길면 막는다** — 프로브가 쌓여 백엔드를 밀어뜨린다', () => {
    expect(issuesOf(withHealthCheck({ intervalS: 2, timeoutS: 5 }))).toMatch(/timeoutS/);
    // 같으면 통과한다 — 쌓이지 않는 경계다.
    expect(issuesOf(withHealthCheck({ intervalS: 2, timeoutS: 2 }))).toBe('');
  });
});

describe('옛 모양을 안 깨뜨린다', () => {
  /**
   * **이 검사가 이 회차의 절반이다.** 중첩으로 옮겼다면 여기가 빨개진다 — 그리고 그
   * 빨강의 진짜 뜻은 "테스트가 깨졌다" 가 아니라 **"이 필드를 쓴 리비전으로 롤백할 수
   * 없다"** 이다. `modelAt` 이 옛 리비전을 같은 해독기로 읽기 때문이다.
   */
  it('`path`·`expectStatus`·`expectBody` 가 그 이름 그 자리에 그대로 있다', () => {
    const hc = poolOf({
      ...base,
      pools: [{
        key: 'app', protocolClass: 'http', algorithm: 'round_robin',
        healthCheck: { path: '/up', expectStatus: [200, 204], expectBody: 'ok' },
      }],
    })['healthCheck'] as Record<string, unknown>;
    expect(hc['path']).toBe('/up');
    expect(hc['expectStatus']).toEqual([200, 204]);
    expect(hc['expectBody']).toBe('ok');
  });

  it('새 필드를 하나도 안 준 옛 리비전이 그대로 해독된다', () => {
    expect(issuesOf({
      ...base,
      pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' }],
    })).toBe('');
  });
});

describe('프로버가 계획대로 찌른다', () => {
  const poolModel = (healthCheck: unknown, protocolClass = 'tcp'): Model => ({
    listeners: [], httpRoutes: [], passthroughRoutes: [], backends: [],
    certificates: [], tlsPolicies: [], sniBindings: [],
    pools: [{ key: 'app', protocolClass, algorithm: 'round_robin', healthCheck }],
  } as unknown as Model);

  it('**tcp 풀의 http 프로브가 계획에 실린다** — 여기가 안 되면 필드가 장식이다', () => {
    const plan = probePlanOf(poolModel({ protocol: 'http', path: '/z' }), 'app');
    expect(plan.protocol).toBe('http');
    expect(plan.http?.path).toBe('/z');
  });

  it('별도 포트와 사이드카 주소를 계획이 든다', () => {
    const plan = probePlanOf(poolModel({ port: 9000, hostOverride: '10.0.0.9' }), 'app');
    expect([plan.port, plan.hostOverride]).toEqual([9000, '10.0.0.9']);
  });

  /**
   * **찌르는 자리가 백엔드가 아니라 계획이다.** 이 검사가 없으면 `port`·`hostOverride`
   * 가 모델에만 있고 프로브는 여전히 백엔드 주소로 가는 상태를 못 잡는다 — 이 저장소가
   * 반복해서 잡는 *"필드는 있는데 아무도 안 읽는다"* 다.
   */
  it('계획의 포트로 찌른다 — 백엔드 포트가 아니라', async () => {
    const open = await serveOk();
    // 백엔드 포트로는 닫힌 것을 주고, 계획이 열린 포트를 가리킨다.
    const reason = await probeBackend(
      { mode: 'active', protocol: 'tcp_connect', port: open }, '127.0.0.1', 1, 500);
    expect(reason, '계획의 포트를 안 썼다 — 닫힌 백엔드 포트로 갔다').toBeUndefined();
  });

  it('계획의 주소로 찌른다 — 백엔드 host 가 아니라', async () => {
    const open = await serveOk();
    const reason = await probeBackend(
      { mode: 'active', protocol: 'tcp_connect', hostOverride: '127.0.0.1' },
      '203.0.113.1', open, 500);
    expect(reason, '계획의 주소를 안 썼다').toBeUndefined();
  });

  it('안 적으면 옛 규칙 그대로 — http 풀은 http, 나머지는 tcp connect', () => {
    expect(probePlanOf(poolModel(undefined, 'http'), 'app').protocol).toBe('http');
    expect(probePlanOf(poolModel(undefined, 'tcp'), 'app').protocol).toBe('tcp_connect');
    expect(probePlanOf(poolModel(undefined, 'udp'), 'app').protocol).toBe('tcp_connect');
  });
});

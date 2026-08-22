/**
 * 검수 2026-08-22 · S-08a — **백엔드가 admin 포트를 겨누지 못한다**
 *
 * `127.0.0.1:19999/membership` 은 **인증 없이 밸런서 슬롯을 덮어쓴다.** `/acme` 는 챌린지
 * 토큰을 심는다. "루프백 전용" 이 유일한 보호인데, `assertAdminPortFree` 는 **리스너
 * 포트만** 검사하고 백엔드는 안 봤다.
 *
 * 에이전트와 엔진이 **한 컨테이너**에 산다(§3.2 · §11.1 — 실측 결과다). 그래서 풀 하나가
 * `127.0.0.1:19999` 를 백엔드로 갖고 그 풀로 가는 라우트가 있으면 **외부 요청이 admin
 * 표면에 그대로 닿는다.** 트래픽을 임의 peer 로 돌리거나 ACME 챌린지를 심을 수 있다.
 *
 * stream admin(기본 `adminPort + 1`)도 같다.
 */
import { describe, expect, it } from 'vitest';

import { adminPortConflicts } from '../../src/control/plane.js';
import type { Model } from '../../src/model/provisional.js';

const PORTS = { adminPort: 19999, streamAdminPort: 20000 };

const model = (backends: { host: string; port: number }[]): Model => ({
  listeners: [{
    key: 'front', protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true,
    http: { defaultAction: { pool: 'app' } },
  }],
  httpRoutes: [], passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: backends.map((b, i) => ({ key: `b${i}`, pool: 'app', weight: 1, ...b })),
  certificates: [], tlsPolicies: [], sniBindings: [],
});

describe('admin 포트 (검수 S-08a)', () => {
  it('백엔드가 admin 포트를 겨누지 못한다', () => {
    expect(adminPortConflicts(model([{ host: '127.0.0.1', port: 19999 }]), PORTS))
      .toHaveLength(1);
    // stream admin 도 같은 표면이다.
    expect(adminPortConflicts(model([{ host: '127.0.0.1', port: 20000 }]), PORTS))
      .toHaveLength(1);
    // `localhost` 와 `::1` 도 같은 곳이다 — 이름만 다르다고 통과시키면 우회가 열린다.
    expect(adminPortConflicts(model([{ host: 'localhost', port: 19999 }]), PORTS))
      .toHaveLength(1);
    expect(adminPortConflicts(model([{ host: '::1', port: 19999 }]), PORTS))
      .toHaveLength(1);
  });

  it('멀쩡한 백엔드는 그대로 지난다', () => {
    expect(adminPortConflicts(model([
      { host: '10.0.0.1', port: 8080 },
      // **다른 호스트의 같은 포트는 우리 admin 이 아니다.** admin 은 루프백에만 뜬다.
      { host: '10.0.0.2', port: 19999 },
      // 같은 호스트의 다른 포트도 마찬가지다.
      { host: '127.0.0.1', port: 8080 },
    ]), PORTS)).toEqual([]);
  });

  it('리스너 검사는 그대로다', () => {
    const m = model([{ host: '10.0.0.1', port: 8080 }]);
    m.listeners[0]!.port = 19999;
    expect(adminPortConflicts(m, PORTS)).toHaveLength(1);
    // udp 는 admin(tcp)과 안 부딪힌다 — 전송이 다르다 (E12).
    const udp = model([{ host: '10.0.0.1', port: 8080 }]);
    udp.listeners = [{
      key: 'u', protocol: 'udp', bind: '0.0.0.0', port: 19999, enabled: true,
      defaultPool: 'app', udp: { preset: 'dns' },
    }];
    expect(adminPortConflicts(udp, PORTS)).toEqual([]);
  });
});

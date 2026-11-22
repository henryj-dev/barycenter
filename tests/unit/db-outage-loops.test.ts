/**
 * **DB 가 끊겨도 주기 작업이 데몬을 죽이지 않는다** (2026-11-22, web-01).
 *
 * PG 연결이 끊기자 표본기(`TrafficSampler`)의 모델 읽기가 처리되지 않은 rejection 이 되어 데몬이 세 번 죽었다.
 * 죽은 프로세스의 리더 락이 PG 에 남아, 새 프로세스는 한 시간 넘게 팔로워였다 — 설정 쓰기가 막혔다.
 * 여기서는 주기 작업이 실패를 삼키고 다음 주기를 기다리는지 잰다. 처리되지 않은 rejection 은 vitest 가 실패로 센다.
 */
import { describe, expect, it } from 'vitest';

import { ClusterNode } from '../../src/control/cluster.js';
import { TrafficSampler } from '../../src/control/traffic.js';
import type { ControlPlane } from '../../src/control/plane.js';
import type { LeaderElection } from '../../src/control/leader.js';
import type { DataplaneDriver } from '../../src/dp/driver.js';
import type { Database } from '../../src/store/db.js';

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 30));
const cut = (): Error => new Error('Connection terminated unexpectedly');

describe('주기 작업 — DB 가 끊겼을 때', () => {
  it('표본기: 모델을 못 읽으면 표본 하나를 잃고 산다', async () => {
    const s = new TrafficSampler({
      read: async () => ({ http: 'l|web|n=1' }),
      model: async () => { throw cut(); },
      lua: () => ({ http: true, stream: true }),
      intervalMs: 60_000,
    });
    s.start();
    await settle();
    s.stop();
    expect(s.state()).toEqual({ state: 'unavailable', reason: '표본을 못 만들었다: Connection terminated unexpectedly' });
  });

  it('클러스터 보고: 상태를 못 쓰면 경고만 남기고 산다', async () => {
    let writes = 0;
    const db = { dialect: { name: 'postgres' }, query: async () => { writes += 1; throw cut(); } } as unknown as Database;
    const election = { state: { isLeader: true } } as unknown as LeaderElection;
    const driver = { status: async () => { throw cut(); } } as unknown as DataplaneDriver;
    const node = new ClusterNode(db, {} as ControlPlane, driver, election, 'web-01', undefined);
    node.start(60_000);
    await settle();
    node.stop();
    expect(writes).toBe(1);
  });
});

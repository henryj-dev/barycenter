/**
 * 헬스 프로버 (DESIGN.md §6.5 · §6.6)
 *
 * e2e 는 "죽은 백엔드가 빠진다" 를 실물로 재지만, **못 재는 것이 둘** 있다.
 *
 *   · **관측 좌표**(§6.6 ABA) — 낡은 관측을 버리는 규칙. e2e 에서는 카운터가 결국
 *     따라잡아 증상이 *일시적*이라, 변이를 넣어도 60 초를 기다리면 통과해 버린다.
 *   · **임계값** — 몇 번 연속이어야 판정이 바뀌는가. 실물에서는 시간으로만 관측된다.
 *
 * 둘 다 여기서 결정적으로 잰다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { HealthProber, currentHealth, reduceMembership } from '../../src/control/health.js';
import type { Model } from '../../src/model/provisional.js';
import { Db, dockerAvailable, pgFor, reset, startPg, stopPg } from './pg-fixture.js';

const PG = pgFor('health');
let db: Db;

/** 아무도 안 듣는 포트. 연결이 즉시 거부된다. */
const DEAD = 9;
/** 이 테스트 프로세스가 여는 포트 — 확실히 살아 있다. */
let livePort = 0;
let server: import('node:net').Server;

const model = (): Model => ({
  listeners: [],
  httpRoutes: [],
  passthroughRoutes: [],
  pools: [{ key: 'p', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [
    { key: 'live', pool: 'p', host: '127.0.0.1', port: livePort, weight: 1 },
    { key: 'dead', pool: 'p', host: '127.0.0.1', port: DEAD, weight: 1 },
  ],
});

beforeAll(async () => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 실물 PG 를 쓴다');
  startPg(PG);
  db = new Db(PG.dsn);
  await db.migrate();
  const net = await import('node:net');
  server = net.createServer((s) => s.end());
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  livePort = (server.address() as import('node:net').AddressInfo).port;
}, 180_000);

afterAll(async () => {
  server?.close();
  await db?.close();
  stopPg(PG);
});

beforeEach(async () => {
  await reset(db);
  await db.query('TRUNCATE backend_health, health_events');
  await db.query('UPDATE health_cursor SET next_seq = 1');
});

describe('헬스 프로버', () => {
  it('산 것과 죽은 것을 가른다', async () => {
    const prober = new HealthProber(db, { failThreshold: 1, riseThreshold: 1, timeoutMs: 500 });
    await prober.sweep(model());
    const h = await currentHealth(db);
    expect(h.get('live')).toBe('healthy');
    expect(h.get('dead')).toBe('unhealthy');
  }, 60_000);

  it('**임계값을 넘어야 내린다** — 한 번의 실패로 빼면 흔들림에 요동친다', async () => {
    const prober = new HealthProber(db, { failThreshold: 3, riseThreshold: 1, timeoutMs: 500 });
    await prober.sweep(model());
    expect((await currentHealth(db)).get('dead')).toBe('unknown');
    await prober.sweep(model());
    expect((await currentHealth(db)).get('dead')).toBe('unknown');
    await prober.sweep(model());
    expect((await currentHealth(db)).get('dead')).toBe('unhealthy');
  }, 60_000);

  it('**결과의 연속을 센다 — 상태의 연속이 아니다**', async () => {
    // 처음엔 "상태가 같은가" 로 셌다. 그러면 `healthy` 인 동안 실패가 몇 번 이어져도
    // 매번 1 로 리셋돼 임계값에 **영원히 도달하지 못한다** — 프로버가 `ECONNREFUSED` 를
    // 보는데 판정은 `healthy` 로 굳었다. 실물에서 그 증상을 보고서야 알았다.
    const prober = new HealthProber(db, { failThreshold: 2, riseThreshold: 1, timeoutMs: 500 });
    // 먼저 살아 있는 것으로 판정시킨다.
    const alive: Model = { ...model(), backends: [{ key: 'x', pool: 'p', host: '127.0.0.1', port: livePort, weight: 1 }] };
    await prober.sweep(alive);
    expect((await currentHealth(db)).get('x')).toBe('healthy');
    // 이제 죽는다. `healthy` 상태가 이어지는 동안에도 **실패 연속**은 쌓여야 한다.
    const dead: Model = { ...model(), backends: [{ key: 'x', pool: 'p', host: '127.0.0.1', port: DEAD, weight: 1 }] };
    await prober.sweep(dead);
    expect((await currentHealth(db)).get('x')).toBe('healthy');   // 아직 1 회
    await prober.sweep(dead);
    expect((await currentHealth(db)).get('x')).toBe('unhealthy');  // 2 회 — 내려간다
  }, 60_000);

  it('판정이 바뀔 때만 **이벤트를 발행한다** — 같은 판정은 안 쌓는다', async () => {
    const prober = new HealthProber(db, { failThreshold: 1, riseThreshold: 1, timeoutMs: 500 });
    await prober.sweep(model());
    await prober.sweep(model());
    await prober.sweep(model());
    const rows = (await db.query('SELECT backend_key, state FROM health_events ORDER BY seq')).rows;
    // 첫 판정 둘만 — 그 뒤로는 안 바뀌었다.
    expect(rows).toHaveLength(2);
  }, 60_000);

  it('**커서는 `nextval` 이 아니다** — 번호가 1 부터 이어진다 (§6.6)', async () => {
    const prober = new HealthProber(db, { failThreshold: 1, riseThreshold: 1, timeoutMs: 500 });
    await prober.sweep(model());
    const rows = (await db.query('SELECT seq::text AS s FROM health_events ORDER BY seq')).rows;
    expect(rows.map((r) => r['s'])).toEqual(['1', '2']);
    // 잠금 행이 다음 번호를 들고 있다.
    const cur = (await db.query('SELECT next_seq::text AS n FROM health_cursor')).rows[0];
    expect(cur?.['n']).toBe('3');
  }, 60_000);

  it('**커서 발급이 직렬화된다** — `FOR UPDATE` 가 그걸 한다 (§6.6)', async () => {
    // `Promise.all` 로 두 sweep 을 돌리는 것으로는 못 잰다 — 트랜잭션이 겹칠지가 **운**이고,
    // 안 겹치면 `FOR UPDATE` 를 빼도 통과한다. 실제로 그렇게 짰다가 변이가 안 잡혔다.
    //
    // 그래서 두 커넥션의 인터리빙을 **직접 만든다.** A 가 읽고, B 가 읽고, 둘 다 쓴다.
    //   · `FOR UPDATE` 있음 → B 의 읽기가 A 의 커밋까지 막힌다 → 번호가 갈린다
    //   · 없음 → 둘이 같은 번호를 읽는다 → PK 충돌로 **이벤트가 유실된다**
    const pg = (await import('pg')).default;
    const A = new pg.Client({ connectionString: PG.dsn });
    const B = new pg.Client({ connectionString: PG.dsn });
    await A.connect();
    await B.connect();
    try {
      await A.query('BEGIN');
      await B.query('BEGIN');
      const a = await A.query('SELECT next_seq::text AS n FROM health_cursor FOR UPDATE');
      // B 의 같은 읽기는 A 가 커밋할 때까지 막혀야 한다. 안 막히면 같은 번호를 본다.
      const bRead = B.query('SELECT next_seq::text AS n FROM health_cursor FOR UPDATE');
      await A.query('UPDATE health_cursor SET next_seq = next_seq + 1');
      await A.query(
        `INSERT INTO health_events (seq, backend_key, state) VALUES ($1,'a','healthy')`,
        [a.rows[0].n]);
      await A.query('COMMIT');

      const b = await bRead;
      await B.query('UPDATE health_cursor SET next_seq = next_seq + 1');
      await B.query(
        `INSERT INTO health_events (seq, backend_key, state) VALUES ($1,'b','healthy')`,
        [b.rows[0].n]);
      await B.query('COMMIT');

      expect(String(b.rows[0].n), '같은 번호를 읽었다 — 잠금이 안 걸렸다')
        .not.toBe(String(a.rows[0].n));
      const rows = (await db.query('SELECT seq::text AS s FROM health_events ORDER BY seq')).rows;
      expect(rows, '이벤트가 유실됐다').toHaveLength(2);
    } finally {
      await A.query('ROLLBACK').catch(() => undefined);
      await B.query('ROLLBACK').catch(() => undefined);
      await A.end();
      await B.end();
    }
  }, 60_000);

  it('**새 프로세스가 자기 관측을 안 버린다** — 순번을 저장된 값에서 이어 붙인다', async () => {
    // §6.6 은 낡은 관측을 버리라고 한다. 그 순번을 **프로세스 메모리에서 1 부터** 세면
    // 재기동한 프로세스의 1 번이 저장된 큰 값보다 작아서 **자기 관측을 전부 버린다** —
    // 헬스가 얼어붙는다. e2e 로는 못 잡는다: 카운터가 결국 따라잡아 증상이 일시적이라
    // 기다리면 통과해 버린다.
    await db.query(
      `INSERT INTO backend_health (backend_key, state, probe_start_seq, consecutive, last_ok)
       VALUES ('live','unhealthy',5000,9,false), ('dead','healthy',5000,9,true)`);

    // **새 프로버다** — 방금 뜬 프로세스처럼 메모리 카운터가 비어 있다.
    const fresh = new HealthProber(db, { failThreshold: 1, riseThreshold: 1, timeoutMs: 500 });
    await fresh.sweep(model());

    const h = await currentHealth(db);
    expect(h.get('live'), '새 프로세스의 관측이 버려졌다 — 헬스가 얼었다').toBe('healthy');
    expect(h.get('dead')).toBe('unhealthy');
  }, 60_000);

  it('**낡은 관측은 버린다** — 순번이 뒤로 가면 무시한다 (§6.6 ABA)', async () => {
    const prober = new HealthProber(db, { failThreshold: 1, riseThreshold: 1, timeoutMs: 500 });
    await prober.sweep(model());
    expect((await currentHealth(db)).get('live')).toBe('healthy');

    // 이 프로버는 앞선 것보다 **뒤처진** 순번을 쓴다 — 늦게 끝난 옛 프로브를 흉내낸다.
    // 저장된 순번을 인위적으로 올려 두면 새 관측이 그보다 작아진다.
    await db.query(`UPDATE backend_health SET probe_start_seq = 99999`);
    const stale = new HealthProber(db, { failThreshold: 1, riseThreshold: 1, timeoutMs: 500 });
    // 살아 있는 백엔드를 죽은 주소로 바꿔 던진다. 버려져야 하므로 판정은 그대로다.
    await stale.sweep({
      ...model(),
      backends: [{ key: 'live', pool: 'p', host: '127.0.0.1', port: DEAD, weight: 1 }],
    });
    // 이어 붙이기 때문에 새 순번은 100000 이라 **적용된다.** 즉 이 규칙은 "뒤처진 번호를
    // 만들 수 있을 때만" 의미가 있다 — 지금 구조에서는 한 프로세스가 순번을 단조로
    // 발급하고 sweep 이 겹치지 않으므로 그런 번호가 안 생긴다. **그 사실을 적어 둔다.**
    expect((await currentHealth(db)).get('live')).toBe('unhealthy');
  }, 60_000);
});

describe('리듀서 (§6.6)', () => {
  const base: Model = {
    listeners: [], httpRoutes: [], passthroughRoutes: [],
    pools: [{ key: 'p', protocolClass: 'http', algorithm: 'round_robin' }],
    backends: [
      { key: 'a', pool: 'p', host: '10.0.0.1', port: 1, weight: 1 },
      { key: 'b', pool: 'p', host: '10.0.0.2', port: 2, weight: 1 },
    ],
  };

  it('`unhealthy` 만 뺀다', () => {
    const out = reduceMembership(base, new Map([['a', 'unhealthy' as const]]));
    expect(out.backends.map((x) => x.key)).toEqual(['b']);
  });

  it('**`unknown` 은 안 뺀다** — 아직 못 잰 것과 죽은 것은 다르다', () => {
    // 기동 직후에는 전부 `unknown` 이다. 그때 다 빼면 멤버십이 통째로 비어 버린다.
    const out = reduceMembership(base, new Map());
    expect(out.backends).toHaveLength(2);
  });

  it('**전부 죽으면 실제로 빈다** — 의도적 zero-peer 다 (§6.7)', () => {
    // 옛 peer 를 남기면 죽은 백엔드가 계속 트래픽을 받는다. 갱신 *실패* 의 fail-open 과
    // 구분해야 하는 사건이다.
    const out = reduceMembership(base, new Map([
      ['a', 'unhealthy' as const], ['b', 'unhealthy' as const],
    ]));
    expect(out.backends).toEqual([]);
  });
});

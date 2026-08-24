/**
 * PostgreSQL 연결과 마이그레이션 (DESIGN.md §11.2)
 *
 * **v0 는 PostgreSQL 하나만.** 격리 수준·advisory lock·제약 표현·크래시 시맨틱이 달라
 * 리더 선출과 그래프 스냅샷 구현이 갈린다. SQLite 는 *같은 불변식 스위트 통과* 를 완료
 * 조건으로 하는 별도 과제다 — "추상화해 두면 나중에 갈아 끼울 수 있다" 는 여기서 거짓이다.
 * 그래서 추상 레이어를 두지 않고 pg 를 직접 쓴다.
 *
 * `pg` 는 이 저장소의 **첫 런타임 의존성**이다. 지금까지 stdlib 뿐이었다. 와이어 프로토콜을
 * 직접 구현할 이유가 없어서 받아들였고, 대신 여기 한 파일에 가둔다.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

/**
 * `bigint`(OID 20)를 **문자열로** 받는다.
 *
 * pg 는 기본으로 bigint 를 문자열로 주지만 명시해 둔다. `activation_epoch` 와 리비전은
 * `Number` 로 지나가면 2^53 위에서 조용히 뭉개진다 — DESIGN 이 "큰 수는 decimal string 으로
 * 다룬다" 고 적은 이유이고, DP 층의 좌표가 전부 문자열인 이유이기도 하다.
 */
pg.types.setTypeParser(20, (v) => v);

export type Row = Record<string, unknown>;

export interface Queryable {
  query(text: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number | null }>;
}

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

export class Db {
  readonly #pool: pg.Pool;

  constructor(connectionString: string) {
    this.#pool = new pg.Pool({ connectionString, max: 8 });
  }

  async query(text: string, values?: readonly unknown[]): Promise<{ rows: Row[]; rowCount: number | null }> {
    const r = await this.#pool.query(text, values as unknown[] | undefined);
    return { rows: r.rows as Row[], rowCount: r.rowCount };
  }

  /**
   * 트랜잭션. 콜백이 던지면 롤백한다.
   *
   * **plan 은 이걸 던져서 되돌린다.** 후보 모델을 만들려면 패치를 실제로 적용해 봐야 하는데
   * (그래야 DB 제약이 같이 걸린다), 적용한 채로 두면 안 된다. 손으로 계산한 그림자 상태에
   * 대고 검증하면 **DB 가 거는 제약을 통과하지 못한다** — 그게 §4.0 이 층을 나눈 이유다.
   */
  async tx<T>(fn: (c: Queryable) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const out = await fn({
        query: async (text, values) => {
          const r = await client.query(text, values as unknown[] | undefined);
          return { rows: r.rows as Row[], rowCount: r.rowCount };
        },
      });
      await client.query('COMMIT');
      return out;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** 콜백 결과와 무관하게 **항상 롤백**한다. plan 의 시뮬레이션 전용. */
  async dryRun<T>(fn: (c: Queryable) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      return await fn({
        query: async (text, values) => {
          const r = await client.query(text, values as unknown[] | undefined);
          return { rows: r.rows as Row[], rowCount: r.rowCount };
        },
      });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  /**
   * 마이그레이션 잠금의 advisory 키 (검수 D15).
   *
   * **리더 선출과 다른 키다.** 같은 키를 쓰면 마이그레이션이 선출을 기다리게 되는데,
   * 마이그레이션은 선출 **전에** 도는 것이 계약이다(스탠바이도 스키마는 최신이어야
   * 읽기를 답한다). `hashtext()` 를 안 쓰는 이유도 저쪽과 같다 — 버전 간 안정성이
   * 보장되지 않아 PG 를 올리면 키가 바뀐다.
   */
  static readonly MIGRATE_LOCK = [0x62_61, 0x6d_67] as const;   // 'ba' 'mg'

  /**
   * 스키마를 최신으로. **한 번에 하나만 돈다** (검수 D15).
   *
   * ── 왜 트랜잭션만으로는 부족한가
   *
   * 마이그레이션 하나가 한 트랜잭션인 것은 **부분 적용**을 막는다. 동시 실행은 못
   * 막는다 — `schema_migrations` 를 읽는 시점에는 둘 다 「아직 안 했다」로 보이고,
   * 그 다음 둘 다 같은 DDL 을 커밋하려 든다. 진 쪽은
   * `duplicate key value violates unique constraint "pg_type_typname_nsp_index"` 로
   * 죽고, 데몬은 `process.exit(1)` → 오케스트레이터의 재시작 루프다.
   *
   * 이 배포는 인스턴스가 여럿인 것을 정상으로 친다(§11.4 콜드 스탠바이). 업그레이드는
   * **정확히 둘이 동시에 뜨는 순간**이다.
   *
   * 세션 잠금을 쓰고 `finally` 로 놓는다. 트랜잭션 잠금(`xact`)은 마이그레이션마다
   * 트랜잭션이 갈리므로 그 사이가 열린다.
   */
  async migrate(): Promise<string[]> {
    const client = await this.#pool.connect();
    try {
      const [hi, lo] = Db.MIGRATE_LOCK;
      // **기다린다.** `try_` 로 두고 물러나면 진 쪽이 낡은 스키마로 서비스를 시작한다.
      await client.query('SELECT pg_advisory_lock($1::int, $2::int)', [hi, lo]);
      try {
        return await this.#migrateLocked();
      } finally {
        // 놓는 것을 잊으면 다음 기동이 영영 매달린다. 세션을 닫아도 풀리지만,
        // 이 커넥션은 풀로 **돌아가므로** 명시적으로 놓는다.
        await client.query('SELECT pg_advisory_unlock($1::int, $2::int)', [hi, lo])
          .catch(() => undefined);
      }
    } finally {
      client.release();
    }
  }

  async #migrateLocked(): Promise<string[]> {
    await this.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`,
    );
    const done = new Set(
      (await this.query('SELECT name FROM schema_migrations')).rows.map((r) => String(r['name'])),
    );
    const applied: string[] = [];
    for (const name of readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql')).sort()) {
      if (done.has(name)) continue;
      const sql = readFileSync(join(MIGRATIONS, name), 'utf8');
      // 마이그레이션 하나가 **한 트랜잭션**이다. 중간에 깨지면 부분 적용된 스키마가 남고,
      // 그 상태는 어느 버전도 아니라 다음 실행이 무엇을 해야 할지 알 수 없다.
      await this.tx(async (c) => {
        await c.query(sql);
        await c.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      });
      applied.push(name);
    }
    return applied;
  }

  async close(): Promise<void> {
    await this.#pool.end();
  }
}

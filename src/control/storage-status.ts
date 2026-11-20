/**
 * **저장소 상태** (2026-11-20). DB 종류 · 시크릿 드라이버 · 보존 정책 · 마지막 청소 결과를 한곳에서 말한다.
 *
 * 전에는 이것이 환경 변수와 로그 줄에만 있었다. 운영자가 「health_events 를 며칠 남기나」 「시크릿 청소가 마지막으로 언제
 * 돌았나」 를 알려면 서버에 들어가 env 를 읽고 로그를 훑어야 했다.
 *
 * ── 비밀을 싣지 않는다
 *
 * DSN · 호스트 · 사용자 · 비밀번호 · KEK 값 · KEK 이름은 **하나도 안 나간다.** 종류(`postgres` …)와 서버 판, 그리고
 * 「KEK 가 있다」 라는 참/거짓만 나간다. 이 몸통은 `read` 범위로 열리고 전역이 그대로 중계한다.
 *
 * ── 모르는 것은 모른다고 한다
 *
 * 청소는 **리더만** 돈다. 팔로워와 방금 뜬 노드에는 마지막 결과가 없다 — 그것을 「0 건 지웠다」 로 채우지 않고
 * `null` 로 둔다. 서버 판을 못 물었으면 판도 `null` 이다.
 */
import { measureGenerations } from '../obs/metrics.js';
import type { SweepResult } from '../dp/retention.js';
import type { SecretSweepResult } from '../dp/secret-gc.js';
import { byDialect, type Database, type DbKind } from '../store/db.js';
import type { DbRetentionResult } from '../store/db-retention.js';

/** 보존 정책을 거는 표. 순서가 화면 순서다. */
export const RETENTION_TABLES = [
  'health_events', 'audit', 'plans', 'changesets', 'operations', 'config_revisions',
] as const;
export type RetentionTable = (typeof RETENTION_TABLES)[number];

/** `DbRetentionResult` 의 칸 → 표 이름. 두 이름을 한 자리에서 잇는다. */
const RESULT_FIELD: Readonly<Record<RetentionTable, keyof DbRetentionResult>> = {
  health_events: 'healthEvents', audit: 'audit', plans: 'plans',
  changesets: 'changesets', operations: 'operations', config_revisions: 'revisions',
};

export type SweepOutcome =
  | { at: string; ok: true; removed: number; kept?: number; failed: number }
  | { at: string; ok: false; error: string };

export type DbSweepOutcome =
  | { at: string; ok: true; removed: number; byTable: Record<RetentionTable, number> }
  | { at: string; ok: false; error: string };

export type StorageFacts = {
  configDb: { kind: DbKind };
  /** 사람 계정 DB. 계정이 꺼져 있으면 `null`. */
  accountsDb: { kind: DbKind } | null;
  secrets: { backend: 'fs' | 'pg' };
  /** 표마다 보존 일수. `null` 은 **안 지운다**(무한 보존). */
  retention: { days: Readonly<Record<RetentionTable, number | null>>; intervalMs: number };
  /** 세대 디렉토리 — 몇 개를 남기는지. 활성 · 서빙 세대는 이 수와 무관하게 남는다. */
  generations: { keep: number; prefix: string };
  /** 시크릿 청소. ACME 가 꺼진 배포에서는 돌지 않는다. */
  secretGc: { enabled: boolean; keepPerName: number; minAgeMs: number; intervalMs: number };
};

export type StorageBody = {
  isLeader: boolean;
  configDb: { kind: DbKind; version: string | null };
  accountsDb: { kind: DbKind } | null;
  secrets: { backend: 'fs' | 'pg'; encrypted: boolean; kekConfigured: boolean };
  retention: {
    intervalMs: number;
    tables: { table: RetentionTable; days: number | null }[];
    last: DbSweepOutcome | null;
  };
  generations: { keep: number; count: number; bytes: number; last: SweepOutcome | null };
  secretGc: {
    enabled: boolean; keepPerName: number; minAgeMs: number; intervalMs: number;
    last: SweepOutcome | null;
  };
};

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export class StorageStatus {
  private db: DbSweepOutcome | null = null;
  private gen: SweepOutcome | null = null;
  private sec: SweepOutcome | null = null;

  constructor(readonly facts: StorageFacts, private readonly now: () => number = Date.now) {}

  private stamp(): string { return new Date(this.now()).toISOString(); }

  recordDbSweep(out: DbRetentionResult): void {
    const byTable = Object.fromEntries(
      RETENTION_TABLES.map((t) => [t, out[RESULT_FIELD[t]]]),
    ) as Record<RetentionTable, number>;
    const removed = Object.values(byTable).reduce((a, n) => a + n, 0);
    this.db = { at: this.stamp(), ok: true, removed, byTable };
  }

  recordDbFailure(e: unknown): void { this.db = { at: this.stamp(), ok: false, error: errText(e) }; }

  recordGenerationSweep(out: SweepResult): void {
    this.gen = { at: this.stamp(), ok: true, removed: out.removed.length, kept: out.kept.length, failed: out.failed.length };
  }

  recordGenerationFailure(e: unknown): void { this.gen = { at: this.stamp(), ok: false, error: errText(e) }; }

  recordSecretSweep(out: SecretSweepResult): void {
    this.sec = { at: this.stamp(), ok: true, removed: out.removed.length, kept: out.kept.length, failed: out.failed.length };
  }

  recordSecretFailure(e: unknown): void { this.sec = { at: this.stamp(), ok: false, error: errText(e) }; }

  /** API 몸통. DB 판은 한 번 묻는다 — 못 물으면 `null` 이다. */
  async body(opts: { db: Pick<Database, 'query' | 'dialect'>; isLeader: boolean }): Promise<StorageBody> {
    const f = this.facts;
    const gen = measureGenerations(f.generations.prefix);
    const pg = f.secrets.backend === 'pg';
    return {
      isLeader: opts.isLeader,
      configDb: { kind: f.configDb.kind, version: await serverVersion(opts.db) },
      accountsDb: f.accountsDb,
      // PG 드라이버는 KEK 없이 안 뜬다(`secrets-pg.ts`). fs 는 평문 파일(0400)이다.
      secrets: { backend: f.secrets.backend, encrypted: pg, kekConfigured: pg },
      retention: {
        intervalMs: f.retention.intervalMs,
        tables: RETENTION_TABLES.map((table) => ({ table, days: f.retention.days[table] })),
        last: this.db,
      },
      generations: { keep: f.generations.keep, count: gen.count, bytes: gen.bytes, last: this.gen },
      secretGc: {
        enabled: f.secretGc.enabled, keepPerName: f.secretGc.keepPerName,
        minAgeMs: f.secretGc.minAgeMs, intervalMs: f.secretGc.intervalMs, last: this.sec,
      },
    };
  }
}

/**
 * DB 서버 판. **호스트 · 사용자를 안 묻는다** — 판 문자열만이다. MariaDB 는 판 문자열에 `MariaDB` 가 든다.
 * 못 물으면 `null` 이다(권한 · 연결 끊김). 그것으로 상태 화면이 실패하지 않는다.
 */
export async function serverVersion(db: Pick<Database, 'query' | 'dialect'>): Promise<string | null> {
  try {
    const r = await db.query(byDialect(db, {
      postgres: `SELECT current_setting('server_version') AS v`,
      mysql: `SELECT VERSION() AS v`,
      sqlite: `SELECT sqlite_version() AS v`,
    }));
    const v = r.rows[0]?.['v'];
    return typeof v === 'string' && v !== '' ? v : null;
  } catch {
    return null;
  }
}

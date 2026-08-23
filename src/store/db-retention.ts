/**
 * DB 보존 — 자라기만 하던 표들에 상한을 준다 (검수 B-08 · 제안#10).
 *
 * 여섯 표를 본다. **다섯은 안 정하면 안 지운다** — `health_events` 만 기본값이 있다.
 *
 *   `health_events`     30일 기본. 프로덕션에서 아무도 안 읽는다
 *   `audit`             옵트인. 감사 추적의 보존 기간은 우리가 정할 것이 아니다
 *   `plans`             옵트인. 만료된 것만 — 커밋된 것은 롤백 수단이다
 *   `changesets`        옵트인. 버려진 것만
 *   `operations`        옵트인. 종단한 것만, 그리고 head 것은 빼고 (멱등 판정)
 *   `config_revisions`  옵트인. 사슬이라 **가장 오래된 접두사**만
 *
 * `terminal` 원장(`dp/agent.ts`)은 **여기 없다.** 그건 감사 기록이 아니라 부활 방지
 * 장치라 지우면 운영자가 포기한 전환이 되살아난다 — 그 파일의 `prune` 머리말이 근거와
 * 아직 안 한 설계 스케치를 함께 적어 뒀다.
 *
 * 세대는 상한이 있었고(`dp/retention.ts`), 시크릿은 뒤늦게 얻었고(`dp/secret-gc.ts`),
 * DB 는 없었다. `health_events` 와 `audit` 은 **삽입만 있고 지우는 코드가 없다.**
 *
 * ── 왜 두 테이블의 기본값이 다른가
 *
 * 같은 정책을 주고 싶은 유혹이 있는데, 그건 단순한 것이 아니라 **둘이 다른 것이라는
 * 사실을 안 본 것**이다.
 *
 *   · `health_events` 는 프로덕션에서 **아무도 안 읽는다.** replay 는 `projectHealth()`
 *     로 대체됐고, 006 의 머리말이 말하는 *"이벤트 로그가 단일 정본이다"* 는 지금은
 *     사실이 아니다 — 정본은 `backend_health` 다. 읽는 곳이 없으니 기본 상한을 걸어도
 *     잃는 것이 없고, 안 걸면 프로브 주기 × 백엔드 수만큼 영원히 자란다.
 *   · `audit` 은 `GET /api/v1/audit` 가 읽는 **진짜 감사 추적**이다. 여기에 기본값으로
 *     칼을 대면 업그레이드가 조용히 남의 보존 요건을 위반한다. 그건 우리가 정할 것이
 *     아니다 — 안 정하면 안 지운다.
 *
 * 남기는 쪽으로 틀린다. `secret-gc.ts` 가 개인키에 대해 세운 것과 같은 원칙이다.
 */
import type { Db } from './pg.js';
import { TERMINAL_PHASES } from '../dp/operation.js';

/** SQL 배열로 넘길 종단 상태 이름들. 목록을 두 벌 두면 반드시 갈라진다. */
const TERMINAL_PHASE_NAMES: string[] = [...TERMINAL_PHASES];

/** 아무도 안 읽는 로그의 기본 상한. 디버깅에 쓸 만큼은 남기고 무한 성장만 막는다. */
export const DEFAULT_HEALTH_EVENT_DAYS = 30;

/**
 * 한 번에 지우는 상한.
 *
 * 처음 켜는 배포에서는 이 테이블이 수백만 행일 수 있다. 한 트랜잭션으로 밀면 그 시간
 * 동안 `emit()` 의 `health_cursor FOR UPDATE` 뒤로 프로버가 줄을 선다 — §6.7 의 판정
 * 동결과 같은 증상이다. 잘라서 지우고, 남은 것은 다음 주기가 가져간다.
 */
export const DEFAULT_MAX_PER_SWEEP = 50_000;

export type DbRetentionOptions = {
  db: Pick<Db, 'query'>;
  /** **안 정하면 안 지운다.** 감사 추적의 보존 기간은 우리가 정할 것이 아니다. */
  auditDays?: number;
  healthEventDays?: number;
  /**
   * 만료된 plan 을 며칠 뒤 지우나 (제안 #10). **안 정하면 안 지운다.**
   *
   * `committed`·`operation_bound` 는 **절대 안 지운다** — 스키마 주석이 적어 뒀듯이
   * 커밋된 artifact 는 롤백 수단이고, 24시간 뒤 되돌릴 방법이 사라지는 상황을
   * 안 만든다.
   */
  planDays?: number;
  /**
   * 버려진 changeset 을 며칠 뒤 지우나. **안 정하면 안 지운다.**
   *
   * `discarded` 만 본다. `open`·`sealed` 는 누가 편집 중이고, `committed` 에는
   * 커밋된 plan 이 매달려 있다(FK CASCADE 라 함께 사라진다).
   */
  changesetDays?: number;
  /**
   * 종단한 오퍼레이션을 며칠 뒤 지우나. **안 정하면 안 지운다.**
   *
   * 종단(`activated`·`partial_exhausted`·`failed`·`superseded`·`no_operation`)만 본다.
   * 비종단 행은 **복구가 이어받을 것**이라 나이와 무관하게 남긴다 — §6.2 의 저널이
   * "무엇을 하던 중이었는지" 를 아는 유일한 자리다.
   *
   * FK 방향이 `operations → plans` 라 지워도 고아가 안 생긴다. 잃는 것은 apply 이력이고,
   * 그건 `audit` 에도 남는다(`action='apply'`).
   */
  operationDays?: number;
  /**
   * 옛 리비전을 며칠 뒤 지우나. **안 정하면 안 지운다.**
   *
   * ── 왜 이것만 모양이 다른가
   *
   * `config_revisions` 는 `parent` 로 이어진 **사슬**이다. 가운데를 지우면 자식의
   * `parent` 가 허공을 가리키고 FK 가 막는다. 그러니 지울 수 있는 것은 **가장 오래된
   * 접두사**뿐이고, 지운 뒤 새 최고참의 `parent` 를 NULL 로 만들어야 한다 — 그게
   * "여기서 이력이 끊긴다" 는 뜻이다.
   *
   * 접두사는 다음 중 **하나라도 걸리면 거기서 멈춘다**:
   *   · head 다 (`config_head`)
   *   · plan 이 `target_revision` 으로 가리킨다 — 롤백 수단이다
   *   · operation 이 가리킨다
   *   · 살아남는 리비전이 `rollback_of` 로 가리킨다 — 그 롤백의 출처가 사라진다
   *
   * 그래서 실제 배포에서 이 값이 지우는 양은 **대개 0** 이다. 그것이 맞는 동작이다 —
   * 상한을 준다는 것과 이력을 버린다는 것은 다르다.
   */
  revisionDays?: number;
  maxPerSweep?: number;
};

export type DbRetentionResult = {
  healthEvents: number;
  audit: number;
  plans: number;
  changesets: number;
  operations: number;
  revisions: number;
};

/**
 * 나이는 **정수 일수**만 받는다.
 *
 * nginx 크기 표기(B-12)·디렉티브 문자열(S-11)과 같은 부류다: 간격을 문자열로 받으면
 * 그것이 곧 SQL 로 가는 자유 문자열이 된다. 아래 질의도 문자열 이어붙이기 대신
 * `make_interval(days => $1)` 을 써서 값이 문법이 될 자리를 아예 없앤다.
 */
function checkDays(label: string, value: number): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(
      `${label} 보존 일수는 1 이상의 정수여야 한다: ${JSON.stringify(value)}`,
    );
  }
  return value;
}

/**
 * 나이 지난 행을 지운다. `ctid` 로 잘라 담아 **한 번에 지우는 양을 묶는다.**
 *
 * `ORDER BY` 를 넣는 이유는 결정성이 아니라 **오래된 것부터**여야 하기 때문이다.
 * 상한에 걸려 일부만 지워질 때 최신 행이 먼저 사라지면 안 된다.
 */
async function prune(
  db: Pick<Db, 'query'>, table: 'health_events' | 'audit', order: 'seq' | 'id',
  days: number, limit: number,
): Promise<number> {
  const out = await db.query(
    `DELETE FROM ${table} WHERE ctid IN (
       SELECT ctid FROM ${table}
       WHERE at < now() - make_interval(days => $1::int)
       ORDER BY ${order} LIMIT $2::int)`,
    [String(days), String(limit)],
  );
  return out.rowCount ?? 0;
}

/**
 * 한 바퀴 돈다. **리더만 부른다** — 여러 노드가 동시에 밀면 서로의 잠금을 기다린다.
 *
 * `health_cursor` 는 **건드리지 않는다.** 남은 최대 seq 로 되감고 싶은 유혹이 있는데,
 * 그러면 번호가 재사용되고 §6.6 이 적어 둔 "번호 순서 = 커밋 순서" 가 깨진다. 커서는
 * 단조다 — 행을 지우는 것과 번호를 되돌리는 것은 다른 일이다.
 */
export async function sweepDatabase(opts: DbRetentionOptions): Promise<DbRetentionResult> {
  const limit = opts.maxPerSweep ?? DEFAULT_MAX_PER_SWEEP;
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`한 주기 상한은 1 이상의 정수여야 한다: ${JSON.stringify(limit)}`);
  }
  const healthDays = checkDays(
    'health_events', opts.healthEventDays ?? DEFAULT_HEALTH_EVENT_DAYS,
  );
  // 정한 경우에만 본다. `undefined` 는 "무한 보존" 이고 `0` 은 오타다 — 구별한다.
  const auditDays = opts.auditDays === undefined
    ? undefined
    : checkDays('audit', opts.auditDays);

  const planDays = opts.planDays === undefined ? undefined : checkDays('plans', opts.planDays);
  const changesetDays = opts.changesetDays === undefined
    ? undefined
    : checkDays('changesets', opts.changesetDays);
  const operationDays = opts.operationDays === undefined
    ? undefined
    : checkDays('operations', opts.operationDays);
  const revisionDays = opts.revisionDays === undefined
    ? undefined
    : checkDays('config_revisions', opts.revisionDays);

  const healthEvents = await prune(opts.db, 'health_events', 'seq', healthDays, limit);
  const audit = auditDays === undefined
    ? 0
    : await prune(opts.db, 'audit', 'id', auditDays, limit);

  /**
   * **만료된 plan 만.** `state` 로 거른다 — 나이만 보면 커밋된 것까지 간다.
   *
   * `expires_at` 이 **이미 지났고** 그 위에 보존 기간을 더 준다. TTL 은 "이 plan 을
   * 더는 못 쓴다" 는 선이고, 보존 기간은 "그 뒤로 얼마나 더 들고 있나" 다 — 둘을 한
   * 숫자로 접으면 진단하려고 남겨 둔 창이 사라진다.
   */
  const plans = planDays === undefined ? 0 : (await opts.db.query(
    `DELETE FROM plans WHERE ctid IN (
       SELECT ctid FROM plans
       WHERE state IN ('planned', 'expired')
         AND expires_at < now() - make_interval(days => $1::int)
       ORDER BY created_at LIMIT $2::int)`,
    [String(planDays), String(limit)],
  )).rowCount ?? 0;

  /**
   * **버려진 changeset 만.** 딸린 plan 은 FK CASCADE 로 따라간다 — 고아를 안 남긴다.
   *
   * `committed` 를 안 지우는 이유가 그 CASCADE 다: 커밋된 changeset 을 지우면 롤백
   * 수단인 plan 이 **함께** 사라진다.
   */
  const changesets = changesetDays === undefined ? 0 : (await opts.db.query(
    `DELETE FROM changesets WHERE ctid IN (
       SELECT ctid FROM changesets
       WHERE state = 'discarded'
         AND created_at < now() - make_interval(days => $1::int)
       ORDER BY created_at LIMIT $2::int)`,
    [String(changesetDays), String(limit)],
  )).rowCount ?? 0;

  /**
   * **종단한 오퍼레이션만.** 비종단은 복구가 이어받을 것이라 나이와 무관하게 남긴다.
   *
   * `updated_at` 으로 잰다 — `created_at` 으로 재면 오래 걸린 전환이 끝나자마자 지워질
   * 수 있다. 보존 기간은 "끝난 뒤로 얼마나" 다.
   *
   * ⚠️ **head 리비전의 것은 안 지운다.** `ControlPlane.apply()` 가 멱등을 이 표로
   * 판정한다 — `findOperation(planId)` 가 있으면 그대로 돌려준다. head 의 오퍼레이션을
   * 지우면 같은 plan 에 apply 를 다시 부를 수 있고, 그러면 이미 끝난 전환이 새
   * 오퍼레이션으로 되살아난다. 다른 리비전의 것은 `PLAN_STALE` 이 먼저 막는다.
   */
  const operations = operationDays === undefined ? 0 : (await opts.db.query(
    `DELETE FROM operations WHERE ctid IN (
       SELECT ctid FROM operations o
       WHERE o.phase = ANY($1::text[])
         AND o.updated_at < now() - make_interval(days => $2::int)
         AND NOT EXISTS (SELECT 1 FROM config_head h WHERE h.revision = o.revision)
       ORDER BY o.updated_at LIMIT $3::int)`,
    [TERMINAL_PHASE_NAMES, String(operationDays), String(limit)],
  )).rowCount ?? 0;

  const revisions = revisionDays === undefined
    ? 0
    : await pruneRevisionPrefix(opts.db, revisionDays, limit);

  return { healthEvents, audit, plans, changesets, operations, revisions };
}

/**
 * `config_revisions` 의 **가장 오래된 접두사**를 지운다.
 *
 * 사슬이라 가운데를 못 지운다(§ 위 `revisionDays` 주석). 오름차순으로 훑다가 붙잡힌
 * 것이 나오면 **거기서 멈춘다** — 그 뒤를 건너뛰고 더 지우면 사슬에 구멍이 난다.
 *
 * 마지막에 새 최고참의 `parent` 를 NULL 로 만든다. 안 하면 FK 가 막고, 막히는 것을
 * 무시하려고 FK 를 지우면 허공을 가리키는 리비전이 남는다 — 그건 지운 것보다 나쁘다.
 */
/**
 * 리비전을 붙잡는 자리 **전부**를 조건에 넣는다.
 *
 * 001 의 `REFERENCES config_revisions` 는 여섯 자리다:
 *   `config_revisions.parent` · `rollback_of`   — 자기 참조. 아래에서 사슬로 다룬다
 *   `changesets.base_revision` · `committed_revision`
 *   `plans.target_revision`
 *   `operations.revision`
 * 그리고 `config_head.revision`.
 *
 * **처음에 changeset 둘을 빠뜨렸고 FK 가 실물 PG 에서 잡았다.** 조건을 기억으로 세면
 * 반드시 빠진다 — 스키마의 참조 목록을 그대로 옮겨 적는다.
 */
async function pruneRevisionPrefix(
  db: Pick<Db, 'query'>, days: number, limit: number,
): Promise<number> {
  const rows = (await db.query(
    `SELECT r.revision::text AS revision
       FROM config_revisions r
      WHERE r.created_at < now() - make_interval(days => $1::int)
        AND NOT EXISTS (SELECT 1 FROM config_head h WHERE h.revision = r.revision)
        AND NOT EXISTS (SELECT 1 FROM plans p WHERE p.target_revision = r.revision)
        AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.revision = r.revision)
        -- changeset 도 리비전을 붙잡는다 (base_revision · committed_revision 둘 다).
        -- 처음에 이 둘을 빠뜨렸고 FK 가 실물 PG 에서 잡았다.
        AND NOT EXISTS (SELECT 1 FROM changesets c
                         WHERE c.base_revision = r.revision
                            OR c.committed_revision = r.revision)
      ORDER BY r.revision
      LIMIT $2::int`,
    [String(days), String(limit)],
  )).rows.map((x) => String(x['revision']));
  if (rows.length === 0) return 0;

  /**
   * **접두사가 끊기면 거기서 멈춘다.** 위 질의는 조건에 걸린 리비전을 그냥 빼고 주므로
   * 결과가 연속이 아닐 수 있다 — 그대로 지우면 사슬 가운데가 사라진다. 가장 오래된
   * 것부터 **연속인 만큼만** 취한다.
   */
  const oldest = (await db.query(
    'SELECT min(revision)::text AS m FROM config_revisions',
  )).rows[0];
  const first = oldest === undefined || oldest['m'] === null ? undefined : String(oldest['m']);
  if (first === undefined || rows[0] !== first) return 0;

  const prefix: string[] = [];
  let expect = BigInt(first);
  for (const r of rows) {
    if (BigInt(r) !== expect) break;
    prefix.push(r);
    expect += 1n;
  }
  if (prefix.length === 0) return 0;

  // 살아남는 쪽이 `rollback_of` 로 접두사를 가리키면 그 롤백의 출처가 사라진다.
  const cut = prefix[prefix.length - 1]!;
  const held = (await db.query(
    `SELECT min(rollback_of)::text AS m FROM config_revisions
      WHERE rollback_of IS NOT NULL AND rollback_of <= $1::bigint
        AND revision > $1::bigint`,
    [cut],
  )).rows[0];
  const heldFrom = held === undefined || held['m'] === null ? undefined : String(held['m']);
  const finalPrefix = heldFrom === undefined
    ? prefix
    : prefix.filter((r) => BigInt(r) < BigInt(heldFrom));
  if (finalPrefix.length === 0) return 0;

  // 새 최고참의 `parent` 를 끊는다 — **지우기 전에** 해야 FK 가 안 막는다.
  await db.query(
    `UPDATE config_revisions SET parent = NULL
      WHERE parent = ANY($1::bigint[]) AND revision <> ALL($1::bigint[])`,
    [finalPrefix],
  );
  return (await db.query(
    'DELETE FROM config_revisions WHERE revision = ANY($1::bigint[])',
    [finalPrefix],
  )).rowCount ?? 0;
}

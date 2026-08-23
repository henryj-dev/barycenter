/**
 * DB 보존 — 자라기만 하던 두 테이블에 상한을 준다 (검수 B-08 · 제안#10).
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
  maxPerSweep?: number;
};

export type DbRetentionResult = {
  healthEvents: number;
  audit: number;
  plans: number;
  changesets: number;
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

  return { healthEvents, audit, plans, changesets };
}

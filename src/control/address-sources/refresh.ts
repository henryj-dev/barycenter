/**
 * 주소 집합 **다시 받기** — 화면의 「목록 다시 받기」 · 데몬의 주기 갱신이 쓰는 한 자리 (2026-11-05).
 *
 * 받은 목록이 지금 집합과 **같은 집합이면 아무것도 쓰지 않는다**(순서만 바뀐 것도 같다) — 리비전 · 적용 대기를
 * 받을 때마다 만들지 않는다. 다르면 정상 쓰기 경로(changeset → plan → commit)로 간다. 그래서 검증 · 영향 · 감사 ·
 * 롤백이 다른 변경과 같다. 「누가」 는 `by`(주기 갱신은 `address-source` — 시스템)다.
 *
 * **받기가 실패하면 집합을 그대로 둔다.** 기록(`address_set_refresh`)에 실패의 뜻과 사유를 남기고
 * `address_set.refresh_failed` 이벤트를 낸다(알림 어댑터가 받을 이름).
 *
 * 적용은 호출자가 고른다. 주기 갱신은 ACME 게시와 같은 규칙이다 — 켜져 있고 **다른 변경이 적용 대기에 없을 때만**
 * 자동 적용한다(사람이 커밋만 해 둔 변경을 함께 내보내지 않는다). 화면 · CLI 의 다시 받기는 커밋까지다.
 */
import type { AddressSet } from '../../model/provisional.js';
import type { ConfigStore } from '../../store/config-store.js';
import { byDialect, type Database, type Queryable } from '../../store/db.js';
import { pendingApplies, type ControlPlane } from '../plane.js';
import type { SourceFailure } from '../sources/fetch.js';
import type { AddressSources } from './registry.js';

/** 실패의 뜻 — 출처의 것에 둘을 더한다. */
export type RefreshFailure = SourceFailure | 'no-source' | 'commit';

export type RefreshOutcome =
  | { key: string; outcome: 'unchanged'; count: number }
  | {
    key: string; outcome: 'committed'; count: number; revision: string; planId: string;
    /** 자동 적용했다. */
    operation?: string;
    /** 자동 적용을 미뤘다 — 이 리비전들이 먼저 적용 대기에 있었다. */
    held?: string[];
  }
  | { key: string; outcome: 'failed'; reason: RefreshFailure; detail: string };

export type RefreshRow = {
  key: string; checkedAt: string; ok: boolean;
  reason?: string; detail?: string; refreshedAt?: string; revision?: string; by: string;
};

export type RefreshOptions = {
  db: Database;
  store: ConfigStore;
  sources: AddressSources;
  by: string;
  /** 있으면 커밋한 뒤 자동 적용을 시도한다(대기 중인 다른 변경이 없을 때만). */
  control?: ControlPlane;
};

const sameSet = (a: readonly string[], b: readonly string[]): boolean => {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

export async function refreshAddressSet(o: RefreshOptions, key: string): Promise<RefreshOutcome> {
  const head = await o.store.head();
  const model = await o.store.modelAt(head.revision);
  const set = (model.addressSets ?? []).find((s) => s.key === key);
  if (set === undefined) return { key, outcome: 'failed', reason: 'no-source', detail: `주소 집합 '${key}' 가 없다` };
  return refreshOne(o, set, head.revision);
}

/** head 의 출처가 있는 집합을 모두. 하나씩 — 하나가 실패해도 나머지를 계속한다. */
export async function refreshAllAddressSets(o: RefreshOptions): Promise<RefreshOutcome[]> {
  const head = await o.store.head();
  const sets = ((await o.store.modelAt(head.revision)).addressSets ?? []).filter((s) => s.source !== undefined);
  const out: RefreshOutcome[] = [];
  for (const s of sets) {
    // head 는 집합마다 다시 읽는다 — 앞의 집합이 커밋했으면 base 가 바뀌었다.
    out.push(await refreshAddressSet(o, s.key).catch((e: unknown): RefreshOutcome => ({
      key: s.key, outcome: 'failed', reason: 'commit', detail: e instanceof Error ? e.message : String(e),
    })));
  }
  return out;
}

async function refreshOne(o: RefreshOptions, set: AddressSet, base: string): Promise<RefreshOutcome> {
  if (set.source === undefined) {
    return { key: set.key, outcome: 'failed', reason: 'no-source', detail: `주소 집합 '${set.key}' 는 손으로 적은 집합이다 — 다시 받을 출처가 없다` };
  }
  const got = await o.sources(set.source).fetch(set.sourceOptions ?? {});
  if (!got.ok) {
    await record(o.db, { key: set.key, ok: false, reason: got.reason, detail: got.detail, by: o.by });
    return { key: set.key, outcome: 'failed', reason: got.reason, detail: got.detail };
  }
  if (sameSet(got.cidrs, set.cidrs)) {
    await record(o.db, { key: set.key, ok: true, by: o.by });
    return { key: set.key, outcome: 'unchanged', count: set.cidrs.length };
  }

  const cs = await o.store.createChangeset(base, o.by);
  let planId: string;
  let revision: string;
  try {
    await o.store.patchChangeset(cs, [{
      op: 'put', kind: 'addressSet', key: set.key,
      body: {
        cidrs: got.cidrs, source: set.source,
        ...(set.sourceOptions === undefined ? {} : { sourceOptions: set.sourceOptions }),
      },
    }], o.by);
    const plan = await o.store.plan(cs, o.by);
    planId = plan.id;
    revision = (await o.store.commit(cs, plan.id, o.by)).revision;
  } catch (e) {
    // 검증에 걸렸거나 head 가 그 사이 움직였다 — 집합은 그대로다. 빈 changeset 을 남기지 않는다.
    await o.store.discardChangeset(cs, o.by).catch(() => undefined);
    const detail = e instanceof Error ? e.message : String(e);
    await record(o.db, { key: set.key, ok: false, reason: 'commit', detail, by: o.by });
    return { key: set.key, outcome: 'failed', reason: 'commit', detail };
  }
  await record(o.db, { key: set.key, ok: true, revision, by: o.by });

  const out: RefreshOutcome = { key: set.key, outcome: 'committed', count: got.cidrs.length, revision, planId };
  if (o.control !== undefined) {
    const others = (await pendingApplies(o.db)).filter((p) => p.planId !== planId);
    if (others.length === 0) {
      out.operation = (await o.control.apply(planId, o.by, { trigger: 'auto' })).id;
    } else {
      out.held = others.map((p) => `r${p.revision}`);
    }
  }
  return out;
}

async function record(
  db: Queryable,
  r: { key: string; ok: boolean; reason?: string; detail?: string; revision?: string; by: string },
): Promise<void> {
  // 성공이면 `refreshed_at` 을 지금으로, 실패면 앞의 값을 남긴다(「마지막 갱신」 은 마지막 **성공**이다).
  // `revision` 은 바뀌어 커밋한 때만 바꾼다.
  const upsert = `INSERT INTO address_set_refresh (key, checked_at, ok, reason, detail, refreshed_at, revision, by_actor)
     VALUES ($1, now(), $2, $3, $4, CASE WHEN $2 THEN now() END, $5, $6)
     ON CONFLICT (key) DO UPDATE SET
       checked_at = now(), ok = EXCLUDED.ok, reason = EXCLUDED.reason, detail = EXCLUDED.detail,
       refreshed_at = CASE WHEN EXCLUDED.ok THEN now() ELSE address_set_refresh.refreshed_at END,
       revision = COALESCE(EXCLUDED.revision, address_set_refresh.revision),
       by_actor = EXCLUDED.by_actor`;
  await db.query(byDialect(db, {
    postgres: upsert,
    sqlite: upsert,
    // 오른쪽 식은 `VALUES(…)` 만 본다 — MySQL 은 SET 을 왼쪽부터 적용해 뒤 식이 바뀐 열을 본다.
    mysql: `INSERT INTO address_set_refresh (key, checked_at, ok, reason, detail, refreshed_at, revision, by_actor)
     VALUES ($1, now(), $2, $3, $4, CASE WHEN $2 THEN now() END, $5, $6)
     ON DUPLICATE KEY UPDATE
       checked_at = now(), ok = VALUES(ok), reason = VALUES(reason), detail = VALUES(detail),
       refreshed_at = CASE WHEN VALUES(ok) THEN now() ELSE refreshed_at END,
       revision = COALESCE(VALUES(revision), revision),
       by_actor = VALUES(by_actor)`,
  }),
    [r.key, r.ok, r.reason ?? null, r.detail === undefined ? null : r.detail.slice(0, 1000), r.revision ?? null, r.by],
  );
}

/** 화면의 「마지막 갱신」. 지금 head 에 있는 집합만 — 지운 집합의 옛 기록은 거른다. */
export async function refreshRows(db: Queryable, keys: readonly string[]): Promise<RefreshRow[]> {
  const rows = (await db.query(byDialect(db, {
    postgres: `SELECT key, checked_at, ok, reason, detail, refreshed_at, revision::text AS revision, by_actor
       FROM address_set_refresh WHERE key = ANY($1) ORDER BY key`,
    sqlite: `SELECT key, checked_at, ok, reason, detail, refreshed_at, CAST(revision AS TEXT) AS revision, by_actor
       FROM address_set_refresh WHERE key IN (SELECT value FROM json_each($1)) ORDER BY key`,
    mysql: `SELECT key, checked_at, ok, reason, detail, refreshed_at, CAST(revision AS CHAR) AS revision, by_actor
       FROM address_set_refresh
      WHERE key IN (SELECT jt.v FROM JSON_TABLE($1, '$[*]' COLUMNS (v VARCHAR(768) PATH '$')) jt) ORDER BY key`,
  }), [keys],
  )).rows;
  const iso = (v: unknown): string => new Date(String(v)).toISOString();
  return rows.map((r) => ({
    key: String(r['key']),
    checkedAt: iso(r['checked_at']),
    ok: r['ok'] === true,
    ...(r['reason'] === null ? {} : { reason: String(r['reason']) }),
    // 저장된 문장(예외 메시지가 섞일 수 있다)은 API 로 내보내지 않는다 — 사유와 정해진 말만. 원문은 로그 address_set.refresh_failed.
    ...(r['detail'] === null ? {} : { detail: `출처에서 목록을 받지 못했다 (${r['reason'] === null ? '알 수 없음' : String(r['reason'])}) — 자세한 내용은 데몬 로그` }),
    ...(r['refreshed_at'] === null ? {} : { refreshedAt: iso(r['refreshed_at']) }),
    ...(r['revision'] === null ? {} : { revision: String(r['revision']) }),
    by: String(r['by_actor']),
  }));
}

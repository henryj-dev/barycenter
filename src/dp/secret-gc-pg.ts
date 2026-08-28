/**
 * `PgSecretStore` 의 청소 (DESIGN.md §8.3 · §8.4 · §4.8.1)
 *
 * `secret-gc.ts` 가 파일시스템에 대해 하는 일을 PG 에 대해 한다. **정책은 안 다시
 * 짓는다** — `partitionForSweep` 하나가 root · 이름당 안전망 · 최소 나이를 판정하고
 * 여기서는 스캔과 삭제만 한다.
 *
 * 정책을 두 벌로 두면 드라이버를 바꾸는 것이 곧 보존 규칙을 바꾸는 것이 되고, 그
 * 차이는 **개인키가 사라진 뒤에야** 보인다. §8.4 가 보수적으로 틀리라고 한 자리다.
 *
 * ── 왜 드라이버가 아니라 별도 모듈인가
 *
 * `SecretStore` 인터페이스에는 삭제가 없다. 일부러 없다 — 지우는 판단은 "무엇이 아직
 * 쓰이는가" 를 아는 쪽(설정·세대·주문)의 것이고, 저장소가 그것을 추측하기 시작하면
 * 추측이 틀렸을 때 살아 있는 키를 지운다. root 는 호출자가 모아서 준다.
 */
import { partitionForSweep, type SecretSweepResult, type SweepEntry } from './secret-gc.js';
import type { Queryable } from '../store/pg.js';

export type PgSecretSweepOptions = {
  db: Queryable;
  /** §8.4 GC root. **호출자가 모은다** — `collectSecretRoots` 가 그 자리다. */
  roots: Iterable<string>;
  keepPerName?: number;
  minAgeMs?: number;
  now?: () => number;
};

export async function sweepSecretsPg(opts: PgSecretSweepOptions): Promise<SecretSweepResult> {
  const rows = (await opts.db.query(
    'SELECT scheme, name, version, created_at FROM secret_materials')).rows;
  const all: SweepEntry[] = rows.map((r) => ({
    ref: `${String(r['scheme'])}://${String(r['name'])}@${String(r['version'])}`,
    name: String(r['name']),
    scheme: String(r['scheme']),
    // `timestamptz` 는 드라이버가 `Date` 로 준다. 문자열로 와도 `new Date` 가 받는다.
    mtime: new Date(r['created_at'] as string | Date).getTime(),
  }));

  const { keep, sweep } = partitionForSweep(all, {
    roots: opts.roots,
    ...(opts.keepPerName === undefined ? {} : { keepPerName: opts.keepPerName }),
    ...(opts.minAgeMs === undefined ? {} : { minAgeMs: opts.minAgeMs }),
    now: opts.now?.() ?? Date.now(),
  });

  const result: SecretSweepResult = { kept: keep.map((e) => e.ref), removed: [], failed: [] };
  for (const e of sweep) {
    // **한 줄씩 지운다.** 한 문장으로 묶으면 하나가 걸릴 때 전부가 안 지워지고,
    // 무엇이 걸렸는지도 안 남는다 — `failed` 를 한 줄씩 적는 것이 이 모듈의 계약이다.
    const at = e.ref.indexOf('://');
    const [name, version] = e.ref.slice(at + 3).split('@');
    try {
      await opts.db.query(
        'DELETE FROM secret_materials WHERE scheme = $1 AND name = $2 AND version = $3',
        [e.scheme, name, version]);
      result.removed.push(e.ref);
    } catch (err) {
      result.failed.push({ ref: e.ref, reason: (err as Error).message });
    }
  }
  return result;
}

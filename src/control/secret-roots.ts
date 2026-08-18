/**
 * SecretStore GC 의 root 수집 (DESIGN.md §8.4)
 *
 * **여기서 하나라도 놓치면 살아 있는 개인키를 지운다.** 증상은 S8 이 실측한 그대로다 —
 * 열린 fd 로 트래픽은 계속 흐르고 **다음 reload 가 깨진다.** 트래픽만 보면 알 수 없다.
 *
 * 그래서 root 를 **넓게** 잡는다. 남기는 쪽으로 틀리면 디스크가 조금 더 쓰이고, 지우는
 * 쪽으로 틀리면 서비스가 죽는다. 둘은 대칭이 아니다.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { Db } from '../store/pg.js';

/** 롤백이 닿을 수 있는 리비전 수. 이 밖으로의 롤백은 자료가 없어 **실패한다.** */
export const DEFAULT_ROLLBACK_REVISIONS = 20;

export type RootsOptions = {
  db: Db;
  /** `generations/` 가 있는 곳. 세대 안의 인증서 디렉토리를 훑는다. */
  prefix: string;
  rollbackRevisions?: number;
};

/**
 * 지금 지우면 안 되는 참조 전부.
 *
 * 넷을 모은다:
 *
 *   ① **최근 N 리비전의 인증서 자료** — 롤백이 닿을 수 있는 범위 (§8.3)
 *   ② **디스크에 남아 있는 세대가 참조하는 자료** — 세대 보존이 이미 상한을 걸었고,
 *      그 안에 있는 것은 다음 reload 가 읽을 수 있다
 *   ③ **ACME 계정 키** — 계정은 지워지지 않으므로 언제나 root 다
 *   ④ **진행 중이거나 최근에 끝난 주문의 자료·키** — finalize 직전에 죽은 주문이 다음
 *      틱에 같은 키로 이어 가야 한다
 */
export async function collectSecretRoots(opts: RootsOptions): Promise<Set<string>> {
  const roots = new Set<string>();
  const limit = opts.rollbackRevisions ?? DEFAULT_ROLLBACK_REVISIONS;

  // ① 최근 N 리비전의 스냅샷에서 자료 참조를 뽑는다.
  //
  // **정규화 테이블(`certificates`)이 아니라 스냅샷을 본다.** head 의 인증서만 보면
  // 갱신 직후 옛 자료가 바로 root 에서 빠지고, 그러면 **직전 리비전으로 롤백할 수가
  // 없다** — 롤백은 그 자료를 되살리는 일인데.
  for (const r of (await opts.db.query(
    `SELECT model FROM config_revisions ORDER BY revision DESC LIMIT $1`, [limit])).rows) {
    const model = r['model'] as { certificates?: { materialRef?: string }[] } | null;
    for (const c of model?.certificates ?? []) {
      if (typeof c.materialRef === 'string') roots.add(c.materialRef);
    }
  }

  // ② 디스크의 세대가 들고 있는 인증서. **경로에서 읽는다** — 세대는 자기완결적이고
  //    (§7.2) 그 안의 `certs/<key>/<version>/` 이 곧 참조다.
  const gens = join(opts.prefix, 'generations');
  if (existsSync(gens)) {
    for (const gen of readdirSync(gens)) {
      const certs = join(gens, gen, 'certs');
      if (!existsSync(certs)) continue;
      for (const key of readdirSync(certs)) {
        for (const version of readdirSync(join(certs, key))) {
          // 세대의 디렉토리 이름은 **인증서 키**이고 시크릿 이름이 아니다. 시크릿
          // 이름을 모르므로 버전으로만 맞춘다 — 아래에서 버전 일치로 지킨다.
          roots.add(`@${version}`);
        }
      }
    }
  }

  // ③ ACME 계정 키 — 계정이 사라지지 않으므로 언제나 root 다.
  for (const r of (await opts.db.query('SELECT account_key_ref FROM acme_accounts')).rows) {
    roots.add(String(r['account_key_ref']));
  }

  // ④ 주문이 든 자료·키. **끝난 주문도 최근 것은 남긴다** — 게시가 아직 안 갔을 수 있고,
  //    그때 자료를 지우면 발급해 놓고 못 쓰는 상태가 된다.
  for (const r of (await opts.db.query(
    `SELECT issued_ref, cert_key_ref FROM acme_orders
      WHERE state <> 'abandoned' OR updated_at > now() - interval '7 days'`)).rows) {
    for (const k of ['issued_ref', 'cert_key_ref']) {
      const v = r[k];
      if (typeof v === 'string') roots.add(v);
    }
  }
  return roots;
}

/**
 * 세대에서 뽑은 **버전만의** root 를 참조 목록에 맞춘다.
 *
 * 세대 디렉토리는 인증서 키로 갈려 있어서 시크릿 이름을 모른다. 그래서 `@version` 만
 * 모아 두고, 여기서 "버전이 같으면 root" 로 넓힌다 — **넓게 잡는 쪽으로 틀린다.**
 */
export function expandVersionRoots(roots: Set<string>, allRefs: readonly string[]): Set<string> {
  const versions = new Set(
    [...roots].filter((r) => r.startsWith('@')).map((r) => r.slice(1)));
  const out = new Set([...roots].filter((r) => !r.startsWith('@')));
  for (const ref of allRefs) {
    const v = ref.split('@')[1];
    if (v !== undefined && versions.has(v)) out.add(ref);
  }
  return out;
}

/**
 * SecretStore 청소 (DESIGN.md §8.3 · §8.4 · ADR-ACME)
 *
 * ── 왜 지금 필요한가 ────────────────────────────────────────────────────
 *
 * v0.6 이 자동 갱신을 붙이면서 **저절로 자라는 것**이 하나 생겼다. 갱신은 새 버전을
 * 만들 뿐 옛 것을 안 덮으므로(§8.3), 인증서 하나가 90 일마다 버전 하나씩 쌓는다.
 * 그리고 그 버전들은 **개인키를 담고 있다.**
 *
 * 세대는 이미 상한이 있는데(`retention.ts`) 시크릿은 없었다. 자동 갱신 전에는 사람이
 * 올릴 때만 늘었으니 안 보였다 — **자동화가 부채를 스스로 채우기 시작한 것**이고, 그건
 * 내가 지난 회차에 만든 것이다.
 *
 * ── 답이 정해져 있지 않던 질문 ──────────────────────────────────────────
 *
 * `config_revisions` 는 **영원히 남는다** (불변 스냅샷). 롤백은 아무 리비전이나 겨눌 수
 * 있다. 그 둘을 그대로 두면 **어떤 자료도 지울 수 없다** — 언젠가 그 리비전으로 롤백할지
 * 모르니까.
 *
 * §8.4 가 GC root 표에 *"롤백 보존 기간 안의 세대"* 라고 적어 둔 것이 이 뜻이다. 기간을
 * 정해야 지울 수 있고, 정하면 **그 밖으로의 롤백은 실패한다.**
 *
 * 그래서 정한다: **최근 N 리비전이 참조하는 자료는 남긴다.** 그 밖은 지운다.
 *
 * 대가를 적어 둔다 — N 을 넘어선 리비전으로 롤백하면 `SecretStore.get` 이 **던진다.**
 * 조용히 최신 버전으로 물러나지 않는다(§8.3: `@latest` 금지). 롤백이 거짓말을 하느니
 * 실패하는 편이 낫고, 실패는 apply 전 `prepare` 에서 난다 — 트래픽은 안 흔들린다.
 *
 * ── 보수적으로 틀린다 ──────────────────────────────────────────────────
 *
 * root 를 하나라도 놓치면 **살아 있는 인증서를 지운다.** 그 증상은 S8 이 실측한 그대로다:
 * 열린 fd 로 트래픽은 계속 흐르고 **다음 reload 가 깨진다.** 트래픽만 보면 알 수 없다.
 * 그래서 root 는 호출자가 모아서 준다 — 이 모듈이 추측하지 않는다.
 */
import { chmodSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { VERSION_DIR } from './secrets.js';

export type SecretSweepResult = {
  kept: string[];
  removed: string[];
  /** 지우려 했지만 못 지운 것. **조용히 넘기지 않는다.** */
  failed: { ref: string; reason: string }[];
};

export type SecretSweepOptions = {
  /** `FsSecretStore` 의 루트. */
  root: string;
  /**
   * 절대 지우면 안 되는 참조들 — §8.4 GC root.
   *
   * `store://name@version` 과 `key://name@version` 을 섞어서 받는다. **호출자가 모은다** —
   * "무엇이 아직 쓰이는가" 는 설정·세대·주문이 아는 것이고, 이 모듈이 추측하기 시작하면
   * 추측이 틀렸을 때 개인키를 지운다.
   */
  roots: Iterable<string>;
  /**
   * 이름당 최소 이 개수는 남긴다 — root 가 아니어도.
   *
   * **root 수집이 틀렸을 때의 안전망**이다. 0 으로 두면 root 계산에 버그가 있는 순간
   * 전부 지워지고, 그건 되돌릴 수 없다.
   */
  keepPerName?: number;
  /** 이보다 최근에 만들어진 것은 안 지운다. 진행 중인 주문과의 경합을 피한다. */
  minAgeMs?: number;
  now?: () => number;
};

export const DEFAULT_KEEP_PER_NAME = 2;
/** 갓 만든 자료를 지우지 않는다 — 주문이 아직 참조를 DB 에 안 적었을 수 있다. */
export const DEFAULT_MIN_AGE_MS = 3600_000;

/**
 * 청소 정책이 보는 자료 하나 (§4.8.1).
 *
 * **저장소가 무엇이든 정책은 하나다.** 파일시스템은 디렉토리 mtime 을, PG 는
 * `created_at` 을 낸다 — 정책이 두 벌이 되면 드라이버를 바꾸는 것이 곧 보존 규칙을
 * 바꾸는 것이 되고, 그 차이는 개인키가 사라진 뒤에야 보인다.
 */
export type SweepEntry = { ref: string; name: string; scheme: string; mtime: number };

type Entry = SweepEntry & { dir: string };

/**
 * 지울 것과 남길 것을 가른다. **여기가 유일한 정책 자리다.**
 *
 * 남기는 쪽으로 틀린다 — root · 이름당 안전망 · 최소 나이 셋 중 하나라도 걸리면 남는다.
 */
export function partitionForSweep(
  all: readonly SweepEntry[],
  opts: { roots: Iterable<string>; keepPerName?: number; minAgeMs?: number; now?: number },
): { keep: SweepEntry[]; sweep: SweepEntry[] } {
  const keepPerName = opts.keepPerName ?? DEFAULT_KEEP_PER_NAME;
  const minAge = opts.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const now = opts.now ?? Date.now();
  const roots = new Set(opts.roots);

  // 이름별로 최신 것부터. `keepPerName` 안전망이 여기 걸린다.
  const byName = new Map<string, SweepEntry[]>();
  for (const e of all) {
    const k = `${e.scheme}:${e.name}`;
    const list = byName.get(k) ?? [];
    list.push(e);
    byName.set(k, list);
  }
  const protectedByAge = new Set<string>();
  for (const list of byName.values()) {
    list.sort((a, b) => b.mtime - a.mtime);
    for (const e of list.slice(0, keepPerName)) protectedByAge.add(e.ref);
  }

  const keep: SweepEntry[] = [];
  const sweep: SweepEntry[] = [];
  for (const e of all) {
    if (roots.has(e.ref) || protectedByAge.has(e.ref) || now - e.mtime < minAge) keep.push(e);
    else sweep.push(e);
  }
  return { keep, sweep };
}

/** `store://` 와 `key://` 자료를 전부 훑는다. */
function scan(root: string): Entry[] {
  const out: Entry[] = [];
  const walk = (base: string, scheme: 'store' | 'key'): void => {
    if (!existsSync(base)) return;
    for (const name of readdirSync(base)) {
      // `keys/` 는 인증서 자료 루트 아래 있으므로 이름으로 걸러낸다.
      if (scheme === 'store' && name === 'keys') continue;
      const nameDir = join(base, name);
      let versions: string[];
      try {
        if (!statSync(nameDir).isDirectory()) continue;
        versions = readdirSync(nameDir);
      } catch {
        continue;
      }
      for (const version of versions) {
        const dir = join(nameDir, version);
        try {
          const st = statSync(dir);
          if (!st.isDirectory()) continue;
          /**
           * **버전 이름이 아닌 것은 버전이 아니다** (검수 D8).
           *
           * `FsSecretStore.put` 이 `<version>.tmp-<nonce>` 를 잠깐 만들고, 크래시가
           * 그것을 남길 수 있다. 여기서 걸러내지 않으면 그 tmp 가 **mtime 이 제일
           * 커서** `keepPerName` 의 보호 자리를 차지하고, 그만큼 **진짜 최신 버전이
           * 보호 밖으로 밀려난다.** 지켜야 할 것이 안 지켜지는 쪽이라 조용하다.
           *
           * 걸러낸 tmp 는 이 목록에 안 들어가므로 **여기서 안 지운다.** 지우는 것은
           * 다음 `put` 의 `finally` 이고, 그것으로 충분하다 — 남아 있어도 아무도 그것을
           * 참조로 읽지 않는다.
           */
          if (!VERSION_DIR.test(version)) continue;
          out.push({ ref: `${scheme}://${name}@${version}`, dir, mtime: st.mtimeMs, name, scheme });
        } catch {
          /* 그 사이 사라졌으면 그만 */
        }
      }
    }
  };
  walk(root, 'store');
  walk(join(root, 'keys'), 'key');
  return out;
}

/**
 * root 가 아니고 충분히 오래된 자료를 지운다.
 *
 * **0500 디렉토리를 먼저 풀어야 지워진다.** `FsSecretStore` 가 자료를 그렇게 지키기
 * 때문이고(§4.8), 안 풀면 `rmSync` 가 `ENOTEMPTY` 로 실패한다 — 테스트를 짜다가 실제로
 * 물렸다. 권한을 되돌리는 것 자체가 이 모듈이 하는 일의 일부다.
 */
export function sweepSecrets(opts: SecretSweepOptions): SecretSweepResult {
  const all = scan(opts.root);
  const { keep, sweep } = partitionForSweep(all, {
    roots: opts.roots,
    ...(opts.keepPerName === undefined ? {} : { keepPerName: opts.keepPerName }),
    ...(opts.minAgeMs === undefined ? {} : { minAgeMs: opts.minAgeMs }),
    now: opts.now?.() ?? Date.now(),
  });

  const dirOf = new Map(all.map((e) => [e.ref, e.dir]));
  const result: SecretSweepResult = {
    kept: keep.map((e) => e.ref), removed: [], failed: [],
  };
  for (const e of sweep) {
    try {
      // 0500 을 풀고 지운다. 파일도 0400 이라 디렉토리 권한만으로는 부족하다.
      const dir = dirOf.get(e.ref)!;
      chmodSync(dir, 0o700);
      rmSync(dir, { recursive: true, force: true });
      result.removed.push(e.ref);
    } catch (err) {
      result.failed.push({ ref: e.ref, reason: (err as Error).message });
    }
  }
  return result;
}

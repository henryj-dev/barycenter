/**
 * 세대 보존 상한 (DESIGN.md §8.4, §12.0 S13)
 *
 * **§8.4 의 GC 원장이 아니다.** 그건 릴리스 원장·tombstone·다단계 크래시 안전까지
 * 포함하고 S13 이 미착수다. 여기 있는 것은 §9.1.1 이 v0.1 에 배정한 것 —
 * *"GC 원장(S13) → 세대 보존은 **수동 상한**으로 대체"* — 딱 그만큼이다.
 *
 * **그런데 그 상한을 안 넣고 v0.1 을 냈다.** 제품화 초안을 띄워 놓고 apply 를 세 번
 * 돌려 보니 `bootstrap r2-e1 r3-e2 r4-e3` 가 그대로 쌓여 있었고, 지우는 코드가 한 줄도
 * 없었다. 세대마다 conf 와 (v0.6 부터는) 인증서가 통째로 들어가므로 **디스크가 무한히
 * 자란다.** 오래 도는 인스턴스에서 확실히 터진다.
 *
 * ── 무엇을 절대 지우지 않는가 ───────────────────────────────────────────
 *
 * §8.4 의 GC root 를 그대로 지킨다. 보수적으로 틀린다 — 지우는 쪽으로 틀리면 **다음
 * reload 가 실패한다.** S8 이 실측한 그대로다: 활성 세대의 인증서를 지워도 열린 fd 로
 * 트래픽은 계속 흐르지만 다음 reload 가 깨진다. **트래픽만 보면 알 수 없다.**
 */
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 기본 보존 개수. 활성·서빙 세대는 이 수와 무관하게 남는다. */
export const DEFAULT_KEEP = 10;

export type SweepResult = {
  kept: string[];
  removed: string[];
  /** 지우려 했지만 못 지운 것. **조용히 넘기지 않는다.** */
  failed: { generation: string; reason: string }[];
};

export type SweepOptions = {
  prefix: string;
  /** 최근 몇 개를 남길 것인가. 활성·보호 대상은 여기 세지 않는다. */
  keep?: number;
  /**
   * 절대 지우면 안 되는 세대들 — §8.4 GC root.
   *
   * 호출자가 준다. 여기서 알아서 찾지 않는 이유가 있다: "무엇이 서빙 중인가" 는
   * 드라이버와 저널이 아는 것이고, 이 모듈이 그걸 추측하기 시작하면 **추측이 틀렸을 때
   * 활성 세대를 지운다.**
   */
  protect: readonly string[];
  /**
   * **옛 워커가 아직 들 수 있는 창** (§4.10 · S13). 없으면 시간 보호를 안 건다.
   *
   * ── 왜 개수 상한만으로는 부족한가 ─────────────────────────────────────
   *
   * S13 이 실측했다: **마커로는 옛 워커를 셀 수 없다.** HUP 뒤 옛 워커는 리스닝 소켓을
   * 닫으므로 새 요청이 절대 안 가고, nginx 는 "어느 워커가 어느 세대인가" 를 안 알려준다.
   * 그래서 개수 상한(기본 10)은 **우연한 보호**다 — 오래 사는 연결(WebSocket)을 든 워커가
   * 전환 10 회를 넘겨 살아남으면 그 세대가 지워진다.
   *
   * 그때 무슨 일이 나는지도 실측돼 있다(S8): **열린 fd 로 트래픽은 계속 흐르고 다음
   * reload 가 깨진다.** 트래픽만 보면 알 수 없다.
   *
   * ── 시간으로 푼다 ────────────────────────────────────────────────────
   *
   * `worker_shutdown_timeout` 이 걸려 있으면 옛 워커는 그 시간 안에 죽는다. 그러면
   * **"비활성이 된 지 이 시간이 지난 세대는 아무도 안 든다"** 가 성립한다.
   *
   * 비활성 시각은 디스크에서 나온다 — 세대 i 는 **세대 i+1 이 만들어진 순간** 비활성이
   * 된다. 새 상태를 안 만들고 mtime 만으로 계산한다.
   *
   * **상한이 없는 배포에서는 이 보호가 없다.** 그건 숨길 것이 아니라 계약이다 —
   * `undefined` 를 "안전하다" 로 읽지 않는다.
   */
  workerLingerMs?: number;
  now?: () => number;
};

/**
 * 오래된 세대를 지운다.
 *
 * 순서: 보호 대상을 빼고 → 수정 시각 역순으로 정렬 → 앞의 `keep` 개를 남기고 → 나머지
 * 삭제. **이름 순이 아니라 시각 순**이다 — `r10-e9` 와 `r9-e8` 을 문자열로 비교하면
 * `r10` 이 먼저 온다.
 */
export function sweepGenerations(opts: SweepOptions): SweepResult {
  const keep = opts.keep ?? DEFAULT_KEEP;
  // **0 이면 아무것도 안 지운다.**
  //
  // "0 개를 남긴다 = 전부 지운다" 로 읽을 수도 있다. 파괴적인 함수에서는 **안전한
  // 쪽으로 읽는다.** 처음엔 이 판단을 호출자(`ControlPlane.sweep`)에만 뒀는데, 그러면
  // 이 함수를 직접 부르는 다음 사람이 세대를 통째로 날린다 — 테스트가 그 자리를 짚었다.
  if (keep <= 0) return { kept: [], removed: [], failed: [] };
  const root = join(opts.prefix, 'generations');
  const protect = new Set(opts.protect);

  let entries: string[];
  try {
    entries = readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    // 아직 세대가 하나도 없다. 실패가 아니다.
    return { kept: [], removed: [], failed: [] };
  }

  const candidates = entries
    .filter((name) => !protect.has(name))
    // **`bootstrap` 은 지우지 않는다.** 컨트롤 플레인이 만든 세대가 아니고, 지우면
    // 다음 콜드 스타트에서 엔진이 설 자리가 없다.
    .filter((name) => name !== 'bootstrap')
    .map((name) => {
      let mtime = 0;
      try {
        mtime = statSync(join(root, name)).mtimeMs;
      } catch {
        /* 그 사이 사라졌으면 0 으로 두고 뒤로 보낸다 */
      }
      return { name, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);

  /**
   * **비활성이 된 지 얼마 안 된 세대는 개수 상한 밖이어도 남긴다.**
   *
   * `candidates` 는 mtime 역순이므로, `candidates[i]` 는 `candidates[i-1]` 이 만들어질 때
   * 비활성이 됐다. 가장 새 것(i=0)은 아직 활성일 수 있으므로 언제나 남는다 — 어차피
   * 개수 상한 안이다.
   */
  const linger = opts.workerLingerMs;
  const now = opts.now?.() ?? Date.now();
  const stillHeld = new Set<string>();
  if (linger !== undefined) {
    for (let i = 1; i < candidates.length; i += 1) {
      const deactivatedAt = candidates[i - 1]!.mtime;
      if (now - deactivatedAt < linger) stillHeld.add(candidates[i]!.name);
    }
  }

  const kept = [
    ...protect,
    ...candidates.slice(0, keep).map((c) => c.name),
    ...candidates.slice(keep).filter((c) => stillHeld.has(c.name)).map((c) => c.name),
  ];
  const doomed = candidates.slice(keep).filter((c) => !stillHeld.has(c.name)).map((c) => c.name);

  const removed: string[] = [];
  const failed: { generation: string; reason: string }[] = [];
  for (const name of doomed) {
    try {
      rmSync(join(root, name), { recursive: true, force: true });
      removed.push(name);
    } catch (e) {
      // **조용히 넘기지 않는다.** 못 지우는 상태가 계속되면 디스크는 계속 자라는데
      // 아무도 모르는 것이 최악이다.
      failed.push({ generation: name, reason: String(e) });
    }
  }
  return { kept, removed, failed };
}

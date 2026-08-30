/**
 * 드레인 시작·관측 (DESIGN.md §6.5 S2 축소).
 *
 * 새 트래픽은 멤버십에서 뺀다. peer 별 inflight/sessions 를 엔진이 안 주면
 * 조건은 `no_new_traffic` 뿐이고 **숫자를 짓지 않는다.**
 */
import { resolvePeer } from './membership.js';
import type { Db } from '../store/pg.js';

export type DrainCondition = 'no_new_traffic' | 'quiesced' | 'deadline_exceeded';

export type DrainStatus = {
  backend: string;
  drain_condition: DrainCondition;
};

/**
 * 엔진이 준 관측만 받는다. 필드가 없거나 정수가 아니면 **숫자를 안 만든다.**
 * `inflight: 0` 을 기본값으로 두지 않는다.
 */
/**
 * 슬롯과 같은 키. 밸런서는 resolve 된 IP 로 `in:` 을 올린다.
 * 모델 호스트 이름을 그대로 치면 관측이 있어도 숫자를 못 읽는다.
 */
export async function observationPeerOf(host: string, port: number): Promise<string> {
  return resolvePeer(`${host}:${port}`);
}

/**
 * 엔진 admin 에서 peer 관측을 읽는다. 없거나 깨지면 undefined — 숫자를 안 짓는다.
 */
export async function observePeerFromAdmin(
  fetchImpl: typeof fetch, peer: string,
): Promise<unknown> {
  try {
    // **호스트는 뜻이 없다** (검수 S-08b). 전송을 정하는 것은 `adminFetch` 가 쥔 소켓
    // 경로이고, 포트 인자는 그래서 사라졌다 — 남겨 두면 "여기를 바꾸면 다른 데로
    // 간다" 는 거짓을 부르는 쪽에 준다.
    const r = await fetchImpl(
      `http://admin/membership/inflight?peer=${encodeURIComponent(peer)}`,
      { signal: AbortSignal.timeout(2000) },
    );
    if (!r.ok) return undefined;
    const text = await r.text();
    if (text === '' || text === '{}') return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * stream 평면에 같은 것을 묻는다 — **전송만 다르다** (S2, 2026-08-23).
 *
 * stream 에는 HTTP 가 없어 admin 이 원시 TCP 다. 그래서 `fetch` 대신 "한 줄 보내고 답을
 * 받는" 함수를 주입받는다. 답의 **모양은 http 창구와 같다** — 다르게 두면 그 순간
 * "어느 평면이냐" 가 드레인 판정 곳곳으로 새어 나가고, `parsePeerObservation` 이 둘로
 * 갈라진다.
 *
 * epoch 은 뜻이 없다(`in:` 은 epoch 에 안 매인다). 헤더 문법을 맞추려고 `0` 을 보낸다.
 */
export async function observeStreamPeer(
  talk: (payload: string) => Promise<string>, peer: string,
): Promise<unknown> {
  try {
    const text = (await talk(`0 inflight\n${peer}\n`)).trim();
    if (text === '' || text === '{}') return undefined;
    return JSON.parse(text) as unknown;
  } catch {
    // 못 읽은 것과 0 인 것은 다르다. 지어내지 않는다.
    return undefined;
  }
}

export function parsePeerObservation(raw: unknown): { inflight: number; sessions: number } | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const o = raw as Record<string, unknown>;
  const inflight = o['inflight'];
  const sessions = o['active_sessions'] ?? o['sessions'];
  if (typeof inflight !== 'number' || typeof sessions !== 'number') return undefined;
  if (!Number.isInteger(inflight) || !Number.isInteger(sessions)) return undefined;
  if (inflight < 0 || sessions < 0) return undefined;
  return { inflight, sessions };
}

export async function startDrain(
  db: Db, backendKey: string, by: string, deadlineSeconds?: number,
): Promise<void> {
  const deadline = deadlineSeconds === undefined
    ? null
    : new Date(Date.now() + deadlineSeconds * 1000).toISOString();
  await db.query(
    `INSERT INTO backend_drain (backend_key, started_by, deadline_at)
     VALUES ($1,$2,$3)
     ON CONFLICT (backend_key) DO UPDATE SET
       started_at=now(), started_by=EXCLUDED.started_by, deadline_at=EXCLUDED.deadline_at`,
    [backendKey, by, deadline],
  );
}

/**
 * 드레인을 푼다. 없었으면 `false` (검수 B-04).
 *
 * **행을 지운다.** 종료 시각을 적고 남기는 길도 있지만, 이 표는 감사 기록이 아니라
 * 리듀서가 매번 읽는 **현재 상태**다 — 끝난 것을 남기면 읽는 쪽이 매번 걸러야 하고,
 * 그 필터를 한 군데서 빠뜨리면 풀린 백엔드가 계속 빠진다. 누가 언제 뺐다 넣었는지는
 * `audit` 이 든다.
 */
export async function endDrain(db: Db, backendKey: string): Promise<boolean> {
  const r = await db.query('DELETE FROM backend_drain WHERE backend_key=$1', [backendKey]);
  return (r.rowCount ?? 0) > 0;
}

/**
 * 지금 빼야 할 백엔드들.
 *
 * ── **기한은 관측이지 자동 해제가 아니다** (2026-08-30 · §4.4 · ADR §6)
 *
 * 전에는 `deadline_at IS NULL OR deadline_at > now()` 로 걸렀다. 그래서 기한이 지나면
 * 백엔드가 **멤버십에 도로 들어오고 트래픽이 자동으로 재개**됐다.
 *
 * §4.4 는 그것을 *"관측 목적의 기한. 강제 종료는 별도 capability"* 라고 적었고, 그 표의
 * `drain_condition` 에 `deadline_exceeded` 를 뒀는데 **구현이 그 상태를 만들 수 없었다** —
 * 기한이 지나면 드레인 자체가 사라지니까. 설계와 구현이 어긋나 있었다.
 *
 * 실제 위험이 그 어긋남에 있다: 운영자가 백엔드를 빼고 정비하려고 기한을 주면,
 * 그 시간 뒤 **정비 중인 백엔드로 트래픽이 조용히 돌아온다.** 드레인 계약표의 첫 줄
 * (*"새 연결/세션이 이 백엔드로 가지 않음 ✅"*)에 아무도 안 적은 시한이 붙어 있었다.
 *
 * **잃는 것도 적어 둔다:** 잊힌 드레인이 용량을 영구히 깎는다. 그 대신 기한을 넘긴 것이
 * `deadline_exceeded` 로 드러나므로 **보이는 상태**가 됐다 — 전에는 조용히 풀렸다.
 *
 * 만료된 행을 여기서 지우지 않는 것은 그대로다. 읽기 경로가 쓰면 프로버 틱마다 쓰기가
 * 생기고, 리더가 아닌 인스턴스도 이 함수를 부른다. 지우는 것은 `endDrain` 과 백엔드 삭제
 * CASCADE 의 몫이다.
 */
export async function drainKeys(db: Db): Promise<Set<string>> {
  const rows = (await db.query('SELECT backend_key FROM backend_drain')).rows;
  return new Set(rows.map((r) => String(r['backend_key'])));
}

export async function isDraining(db: Db, backendKey: string): Promise<boolean> {
  // **`drainKeys` 와 같은 조건이어야 한다.** 갈리면 "드레인 중이라는데 트래픽은 간다" 가 된다.
  const r = (await db.query(
    'SELECT 1 FROM backend_drain WHERE backend_key=$1', [backendKey])).rows[0];
  return r !== undefined;
}

/** 기한을 넘긴 드레인들. **빼는 판단이 아니라 관측이다.** */
export async function deadlineExceededKeys(db: Db): Promise<Set<string>> {
  const rows = (await db.query(
    'SELECT backend_key FROM backend_drain WHERE deadline_at IS NOT NULL AND deadline_at <= now()',
  )).rows;
  return new Set(rows.map((r) => String(r['backend_key'])));
}

/**
 * 관측이 없으면 숫자를 안 싣는다. `inflight: 0` 을 기본값으로 두지 않는다.
 */
export function drainStatusOf(opts: {
  backend: string;
  draining: boolean;
  inflight?: number;
  sessions?: number;
  /** 기한을 넘겼는가 (§4.4). **드레인이 끝났다는 뜻이 아니다** — 관측이다. */
  deadlineExceeded?: boolean;
}): DrainStatus | undefined {
  if (!opts.draining) return undefined;
  const out: DrainStatus & { inflight?: number; active_sessions?: number } = {
    backend: opts.backend,
    drain_condition: 'no_new_traffic',
  };
  if (opts.inflight !== undefined) out.inflight = opts.inflight;
  if (opts.sessions !== undefined) out.active_sessions = opts.sessions;
  // 기한을 넘겼으면 그것을 말한다 — 제 시간에 안 비었다는 사실이다.
  if (opts.deadlineExceeded === true) out.drain_condition = 'deadline_exceeded';
  /**
   * **`quiesced` 가 마지막이다.** 기한을 넘겼어도 실제로 다 빠졌으면 그것이 더 강한
   * 사실이다 — 운영자가 알고 싶은 것은 "지금 빼도 되는가" 이고 그 답은 `quiesced` 다.
   * 순서를 뒤집으면 다 빠진 백엔드를 기한 때문에 못 빼는 것으로 읽는다.
   */
  if (opts.inflight === 0 && opts.sessions === 0) out.drain_condition = 'quiesced';
  return out;
}

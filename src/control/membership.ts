/**
 * 멤버십 자료와 세대 admin 조각 (DESIGN.md §6.5 · §7.2 · §7.3)
 *
 * **멤버십은 세대 안에 산다.** §7.2 의 레이아웃이 `lua/bootstrap-membership.json` 을
 * 적어 뒀고, §6.4 도 *"부트스트랩 멤버십은 아티팩트에 포함한다"* 고 했다. 그래서
 * `ApplyOperation` 을 넓히지 않는다 — 봉투는 **좌표**를 나르고, 자료는 **세대**가 나른다.
 *
 * epoch 리터럴도 여기 있다. 렌더러가 굽지 않는 이유는 `render_digest` 가 모델만의
 * 함수여야 하기 때문이고(그래야 plan 이 렌더러 드리프트를 잡는다), 세대 admin 조각은
 * `include` 가 conf_prefix 기준으로 풀리므로 세대에 결박된다(E62).
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

import {
  ACME_DICT, render, upstreamName, MEMBERSHIP_DICT, type RenderCapabilities,
} from '../conf/render.js';

import { applyDiscoveredEndpoints, type DiscoveryIntake } from './discovery.js';
import { log } from '../obs/log.js';
import type { Model } from '../model/provisional.js';

/**
 * ACME 토큰의 dict 수명 (초).
 *
 * **왜 만료를 거는가.** S18 이 실측했다 — 버려진 주문을 **CA 는 안 치운다** (`pending`
 * 으로 남는다). 우리가 안 치우면 실패한 주문의 토큰이 dict 에 영원히 쌓이고, dict 가
 * 차면 LRU 가 **살아 있는 토큰을 밀어낸다.** 그때 증상은 "인증서 발급이 가끔 안 된다" 다.
 *
 * 30 분은 CA 의 검증이 그보다 훨씬 빨리 끝나기 때문이다(Pebble 은 즉시, Let's Encrypt 는
 * 보통 수 초). 넉넉하되 유한하게.
 */
export const ACME_TTL_SECONDS = 1800;


export type Plane = 'http' | 'stream';

/** 풀 이름(렌더된 upstream 이름) → `host:port` 목록. */
export type Slots = Record<string, string[]>;

/**
 * peer 별 속성 — **슬롯과 나란히 간다** (`docs/adr-membership-attrs.md` ②).
 *
 * ── 왜 peer 문자열에 안 싣나
 *
 * `membership.ts` 가 가중치에서 이미 그 길을 안 골랐다: 슬롯에 실으면 **peer 문자열이
 * `in:<peer>` 카운터와 두 평면의 inflight 질의 키와 갈린다** — 접미사를 벗기는 자리가
 * 넷이 된다. 여기서도 같다. peer 문자열은 키로 그대로 둔다.
 *
 * ── 왜 한 덩어리 맵이 아닌가
 *
 * 밸런서가 **요청마다** 읽는 값이다. 맵 하나를 두면 요청마다 파싱해야 하고, 고르는 비용이
 * hash 23.1ns · rr 0.48ns 인 자리에서 그건 백 배다(S15). `in:<peer>` 가 이미 답을 갖고
 * 있었다 — peer 마다 키 하나, 조회 하나.
 *
 * **속성이 없는 peer 는 아예 안 실린다.** 그래서 안 쓰는 배포는 키가 안 늘고 조회도
 * `nil` 한 번이다 — 가중치가 전부 1 일 때 산출물이 안 바뀌는 것과 같은 성질이다.
 */
export type PeerAttrs = {
  /** 인플라이트 힌트. 후보를 좁힐 뿐 알고리즘을 안 바꾼다. */
  softMaxConns?: number;
  /** 1차가 전부 빠졌을 때만 받는다. */
  isBackup?: boolean;
};

/** upstream 이름 → (peer → 속성). 속성이 없는 upstream 은 키가 없다. */
export type Attrs = Record<string, Record<string, PeerAttrs>>;

/**
 * 모델에서 평면별 멤버십을 뽑는다.
 *
 * **렌더된 upstream 이름을 키로 쓴다.** 풀 키를 그대로 쓰면 밸런서가 보는 이름과
 * 달라진다 — 렌더러가 nginx 식별자로 바꾸면서 단사성을 위해 다이제스트를 붙일 수 있다.
 */
/**
 * 확장 상한 (검수 D2 · DESIGN §7.3.1).
 *
 * 해독기가 `weight` 를 **1..1,000,000** 으로 받는다. 그 범위를 안 좁히는 이유는
 * `modelAt` 이 옛 리비전을 같은 해독기로 읽기 때문이다 — 좁히면 그런 값이 든 리비전이
 * 해독 불가가 되고 **롤백이 막힌다**(검수 D7). 그러니 막을 자리는 여기다.
 *
 * 256 은 dict 값 길이와 선택 비용의 균형이다. peer 하나가 `10.0.0.1:80` 쯤이라
 * 256 칸이면 값이 4 KB 남짓이고, `pickExpression` 의 `least_conn` 이 목록을 두 번
 * 훑으므로 그만큼이 요청당 비용이다.
 */
const SLOT_EXPANSION_CAP = 256;

const gcd2 = (a: number, b: number): number => (b === 0 ? a : gcd2(b, a % b));

/**
 * 가중치를 **슬롯 칸 수**로 편다 (검수 D2 · DESIGN §7.3.1).
 *
 * ── 왜 반복인가
 *
 * 슬롯에 가중치를 실으면(`host:port|w`) admin 와이어가 넓어지고, 더 나쁘게는 **peer
 * 문자열이 `in:<peer>` 카운터와 `/membership/inflight` 의 질의 키와 갈린다** —
 * 접미사를 벗기는 자리가 넷이 된다. 반복은 와이어를 안 건드린다.
 *
 * ── 셋을 지킨다
 *
 *   ① **GCD 로 나눈다.** `2:4` 와 `1:2` 는 같은 뜻이고, 안 나누면 dict 를 두 배 먹는다
 *   ② **상한을 넘으면 비율을 유지한 채 줄이되 모두가 최소 한 칸**을 갖는다 —
 *      줄이다가 백엔드를 조용히 빼면 그건 밸런싱이 아니라 장애다
 *   ③ **사본을 고르게 섞는다.** 뭉쳐 두면 `round_robin` 의 순차 순회가 무거운 peer
 *      에게 연속으로 몰아준다. 비율은 맞고 버스트가 생긴다
 *
 * **가중치가 전부 1 이면 산출물이 정렬된 목록 그대로다** — GCD 가 1 이고 사본이 하나씩
 * 이라 ③ 의 정렬 키가 전부 같고 peer 이름으로 갈린다. 안 쓰는 배포의 거동이 안 바뀐다.
 *
 * 결정적이어야 한다 — 이 목록이 `payloadDigest` 로 들어간다.
 */
function weightedSlots(peers: readonly { peer: string; weight: number }[]): string[] {
  const sorted = [...peers].sort((a, b) => (a.peer < b.peer ? -1 : a.peer > b.peer ? 1 : 0));
  // ① 약분.
  const g = sorted.reduce((acc, p) => gcd2(acc, Math.max(1, p.weight)), 0) || 1;
  let counts = sorted.map((p) => Math.max(1, Math.floor(Math.max(1, p.weight) / g)));

  /**
   * ② 상한. **먼저 한 칸씩 떼어 놓고 남은 예산만 비례 배분한다.**
   *
   * 처음엔 그냥 `max(1, round(c * CAP / total))` 로 뒀는데 **상한을 넘겼다** —
   * `1:1000000` 에서 무거운 쪽이 256 으로 반올림되고 가벼운 쪽이 하한 1 을 받아
   * 합이 257 이 됐다. 「모두 최소 한 칸」과 비례 축소가 서로 민 것이다.
   *
   * peer 수가 상한보다 많으면 **상한을 포기하고 한 칸씩 준다.** 백엔드를 빼는 것보다
   * dict 를 조금 더 쓰는 편이 낫다 — 빼는 것은 장애이고 쓰는 것은 비용이다.
   */
  const total = counts.reduce((a, b) => a + b, 0);
  const n = counts.length;
  if (total > SLOT_EXPANSION_CAP && n < SLOT_EXPANSION_CAP) {
    const budget = SLOT_EXPANSION_CAP - n;          // 한 칸씩 떼고 남은 것
    const excess = counts.map((c) => c - 1);
    const excessTotal = excess.reduce((a, b) => a + b, 0);
    counts = excess.map((e) => 1 + Math.floor((e * budget) / excessTotal));
    // 내림이 남긴 칸을 **무거운 것부터** 채운다. 결정적이어야 하므로 동점은 인덱스로 가른다.
    let left = SLOT_EXPANSION_CAP - counts.reduce((a, b) => a + b, 0);
    const order = counts.map((_, i) => i)
      .sort((a, b) => (excess[b]! - excess[a]!) || (a - b));
    for (let i = 0; left > 0; i = (i + 1) % order.length, left -= 1) {
      counts[order[i]!] = (counts[order[i]!] ?? 1) + 1;
    }
  } else if (total > SLOT_EXPANSION_CAP) {
    counts = counts.map(() => 1);
  }

  // ③ 고르게 섞는다. 사본 k(0부터)의 자리를 `(k + 0.5) / w` 로 잡는다 — 같은 비율이면
  //    같은 간격으로 퍼지는 표준적인 방법이고, 동점은 peer 이름으로 갈라 결정성을 지킨다.
  const marks: { key: number; peer: string }[] = [];
  sorted.forEach((p, i) => {
    const w = counts[i] ?? 1;
    for (let k = 0; k < w; k += 1) marks.push({ key: (k + 0.5) / w, peer: p.peer });
  });
  marks.sort((a, b) => (a.key !== b.key ? a.key - b.key : (a.peer < b.peer ? -1 : 1)));
  return marks.map((m) => m.peer);
}

export function slotsOf(
  model: Model, caps: RenderCapabilities, discovery?: DiscoveryIntake,
): Record<Plane, Slots> {
  const used = applyDiscoveredEndpoints(model, discovery);
  const out: Record<Plane, Slots> = { http: {}, stream: {} };
  // 렌더는 풀의 upstream 이름을 읽기 위한 것이다. 광고가 비면 백엔드가 없어
  // validate 가 막으므로 이름은 정적 모델에서 읽고, peer 만 발견한 집합에서 온다.
  const conf = render(model, caps).conf;
  const byPool = new Map<string, { peer: string; weight: number; attrs: PeerAttrs }[]>();
  for (const b of used.backends) {
    const list = byPool.get(b.pool) ?? [];
    list.push({
      peer: `${b.host}:${b.port}`,
      weight: b.weight,
      attrs: {
        ...(b.softMaxConns === undefined ? {} : { softMaxConns: b.softMaxConns }),
        ...(b.isBackup === undefined ? {} : { isBackup: b.isBackup }),
      },
    });
    byPool.set(b.pool, list);
  }
  for (const pool of used.pools) {
    const peers = byPool.get(pool.key);
    if (peers === undefined || peers.length === 0) continue;
    // 렌더된 conf 에서 그 풀의 upstream 이름을 찾는다. **이름 규칙을 여기서 다시
    // 구현하지 않는다** — 두 군데서 계산하면 언젠가 갈린다.
    const name = upstreamNameIn(conf, pool.key);
    if (name === undefined) continue;        // 렌더에 안 쓰인 풀이다
    const plane: Plane = pool.protocolClass === 'http' ? 'http' : 'stream';
    out[plane][name] = weightedSlots(peers);
  }
  return out;
}

/**
 * 슬롯과 **같은 이름·같은 필터**로 속성을 낸다.
 *
 * 이름 규칙을 여기서 다시 구현하지 않는 것이 요점이다 — `slotsOf` 와 갈리면 속성이
 * 엉뚱한 upstream 에 실리고, 그건 밖에서 안 보인다(D18 이 슬롯에서 겪은 그 사고다).
 * 그래서 **`slotsOf` 를 그대로 부르고 그 키만 쓴다.**
 *
 * 속성이 하나도 없으면 그 upstream 은 결과에 **없다** — 안 쓰는 배포에 키를 안 만든다.
 */
export function attrsOf(
  model: Model, caps: RenderCapabilities, discovery?: DiscoveryIntake,
): Record<Plane, Attrs> {
  const used = applyDiscoveredEndpoints(model, discovery);
  const slots = slotsOf(model, caps, discovery);
  const byPeer = new Map<string, PeerAttrs>();
  for (const b of used.backends) {
    const a: PeerAttrs = {
      ...(b.softMaxConns === undefined ? {} : { softMaxConns: b.softMaxConns }),
      ...(b.isBackup === undefined ? {} : { isBackup: b.isBackup }),
    };
    if (Object.keys(a).length > 0) byPeer.set(`${b.host}:${b.port}`, a);
  }

  const out: Record<Plane, Attrs> = { http: {}, stream: {} };
  if (byPeer.size === 0) return out;
  for (const plane of ['http', 'stream'] as const) {
    for (const [name, peers] of Object.entries(slots[plane])) {
      const here: Record<string, PeerAttrs> = {};
      // **슬롯에 실제로 있는 peer 만.** 안 그러면 그 upstream 에 없는 peer 의 속성이
      // dict 에 남고, 회수는 upstream 단위라 아무도 그것을 안 지운다.
      for (const peer of new Set(peers)) {
        const a = byPeer.get(peer);
        if (a !== undefined) here[peer] = a;
      }
      if (Object.keys(here).length > 0) out[plane][name] = here;
    }
  }
  return out;
}

/**
 * head 모델로 이름을 읽고, 적격 peer 만 남긴다. 한 평면이 비어도 렌더가 막히지 않는다.
 * 빈 목록은 슬롯에 `name=` 으로 써서 죽은 peer 가 옛 값을 유지하지 못하게 한다 (S3).
 */
export function slotsForEligible(
  head: Model, eligible: Model, caps: RenderCapabilities, discovery?: DiscoveryIntake,
): Record<Plane, Slots> {
  const full = slotsOf(head, caps, discovery);
  const allowed = new Set(eligible.backends.map((b) => `${b.host}:${b.port}`));
  const out: Record<Plane, Slots> = { http: {}, stream: {} };
  for (const plane of ['http', 'stream'] as const) {
    for (const [name, peers] of Object.entries(full[plane])) {
      out[plane][name] = peers.filter((p) => allowed.has(p));
    }
  }
  return out;
}

/**
 * 이 풀이 렌더에 upstream 을 가지면 그 이름, 아니면 `undefined`.
 *
 * ── 이름은 **렌더러가 정한다** (검수 D18)
 *
 * 전에는 여기서 산출물을 정규식으로 훑었다. 취지는 옳았다 — *"이름을 정하는 자리가
 * 둘이 되면 갈린다"*. 그런데 **방법이 틀렸다.** 그 정규식은
 * `pool_<ident>(_<hex>)?` 였고 다이제스트 접미가 **선택**이었는데, `ident` 는
 * 비영숫자를 `_` 로 접으므로 `a-b` 와 `a_b` 가 같은 `ident` 를 만든다. 렌더러는 그
 * 비단사성을 접미로 푸는데 정규식은 그 접미를 안 요구하니, 둘이 **서로의 upstream 에
 * 매치됐다.**
 *
 * 그러면 멤버십이 엉뚱한 슬롯에 실리고, 제 슬롯이 빈 풀은 `balancer_by_lua` 가
 * `ngx.exit(ngx.ERROR)` 를 타 **그 풀의 모든 요청이 끊긴다**(§6.5-3). 슬롯은
 * 이름으로만 갈리므로 어느 쪽이 어느 쪽을 먹었는지 밖에서 안 보인다.
 *
 * 규칙을 두 번 구현하지 않는 방법은 산출물을 파싱하는 것이 아니라 **같은 함수를
 * 쓰는 것**이다. 산출물은 이제 *"그 이름이 정말 거기 있는가"* 에만 쓴다 — 어떤
 * 리스너·라우트에도 안 걸린 풀은 렌더에 upstream 이 없고, 그 판정은 여기 남아야 한다.
 */
export function upstreamNameIn(conf: string, poolKey: string): string | undefined {
  const name = upstreamName(poolKey);
  return conf.includes(`upstream ${name} {`) ? name : undefined;
}

/**
 * **렌더에 upstream 이 생기는 풀들** (제안 #9).
 *
 * 어떤 리스너·라우트에도 안 걸린 풀은 렌더에 안 나오고, 그러면 슬롯이 아예 없다 —
 * 백엔드가 멀쩡하고 헬스가 초록이어도 트래픽이 0 이다. `slotsOf` 가 `continue` 로
 * 조용히 건너뛰던 그 경우이고, 밖에서는 안 보였다.
 *
 * **`slotsOf` 와 같은 판정을 쓴다.** 여기서 "걸렸는가" 를 따로 구현하면 두 자리가
 * 갈리고, 그때 이 API 는 슬롯에 없는 것을 있다고 말한다.
 */
export function routedPools(model: Model, caps: RenderCapabilities): Set<string> {
  const conf = render(model, caps).conf;
  const out = new Set<string>();
  for (const pool of model.pools) {
    if (upstreamNameIn(conf, pool.key) !== undefined) out.add(pool.key);
  }
  return out;
}

/**
 * 슬롯과 속성을 admin 이 받는 줄 모양으로.
 *
 *   `이름=peer,peer`                       슬롯
 *   `!이름=peer|<max>|<backup>,…`          속성 (ADR ②-a)
 *
 * **`!` 는 nginx 식별자가 될 수 없다** — upstream 이름과 문법이 안 겹친다.
 *
 * 속성이 없으면 그 줄을 **아예 안 낸다.** 안 쓰는 배포의 본문이 안 바뀌고, dict 에 키도
 * 안 생긴다 — 가중치가 전부 1 일 때 산출물이 안 바뀌는 것과 같은 성질이다.
 */
export const encodeSlots = (slots: Slots, attrs: Attrs = {}): string => {
  const lines = Object.entries(slots).map(([name, peers]) => `${name}=${peers.join(',')}`);
  for (const [name, peers] of Object.entries(attrs)) {
    const entries = Object.entries(peers).sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([peer, a]) => `${peer}|${a.softMaxConns ?? ''}|${a.isBackup === true ? '1' : ''}`);
    if (entries.length > 0) lines.push(`!${name}=${entries.join(',')}`);
  }
  /**
   * **줄 전체를 한 번에 정렬한다.**
   *
   * 적재는 **되읽어 비교**한다(`effects-boot` 의 *"적재를 되읽었더니 다르다"*). 그 검사가
   * 뜻을 가지려면 쓰는 형식과 읽는 형식이 같아야 하고, **순서도 같아야** 한다. 되읽는
   * 쪽은 Lua 의 `table.sort` 라 바이트 순서다 — 슬롯과 속성을 따로 정렬하면
   * `!`(0x21)가 글자보다 앞서므로 두 순서가 갈린다.
   */
  return lines.sort().join('\n');
};

/**
 * Lua `ngx.balancer.set_current_peer` 는 호스트 이름을 거절한다.
 * 슬롯에 넣기 전에 A/AAAA 를 풀어 둔다. 이미 IP 면 그대로다.
 */
export async function resolveSlots(
  slots: Slots,
  /** 테스트가 갈아 끼운다. 판정이 망 상태에 걸리면 안 된다. */
  lookupPeer: (hp: string) => Promise<string> = resolvePeer,
): Promise<Slots> {
  const out: Slots = {};
  for (const [name, peers] of Object.entries(slots)) {
    /**
     * **부분 실패는 부분 실패로 다룬다** (검수 B-09).
     *
     * 전에는 `Promise.all` 이라 하나만 안 풀려도 **그 평면의 멤버십 갱신 전체가
     * 실패했다.** 호스트명 백엔드 하나가 잠깐 흔들리면 나머지 전부의 헬스 반영이
     * 멈추고, 그건 §6.7 이 나눈 두 사건 중 "갱신 실패" 쪽이라 옛 슬롯이 남는다 —
     * 죽은 백엔드가 계속 트래픽을 받는다.
     *
     * 안 풀린 peer 만 뺀다. 전부 안 풀리면 빈 슬롯이고, 그것을 쓸지 말지는
     * `shouldPushMembership` 이 정한다(S3 의도적 zero-peer 와 S4 갱신 실패의 구분).
     * 여기서 던지면 그 판단이 아예 안 돈다.
     */
    const settled = await Promise.allSettled(peers.map((p) => lookupPeer(p)));
    const resolved: string[] = [];
    for (const [i, r] of settled.entries()) {
      if (r.status === 'fulfilled') {
        resolved.push(r.value);
      } else {
        log.warn('membership.peer_unresolved', {
          slot: name, peer: peers[i], error: String(r.reason),
        });
      }
    }
    out[name] = resolved;
  }
  return out;
}

export async function resolvePeer(hp: string): Promise<string> {
  const cut = hp.lastIndexOf(':');
  if (cut <= 0) return hp;
  const host = hp.slice(0, cut);
  const port = hp.slice(cut + 1);
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  if (isIP(bare)) return hp;
  const { address, family } = await lookup(bare);
  return family === 6 ? `[${address}]:${port}` : `${address}:${port}`;
}

/**
 * http 평면의 세대 admin 조각.
 *
 * `init_worker_by_lua_block` 이 **세대에 구워진 epoch 리터럴**이다 (§6.5-1). 이게 있어야
 * HUP 뒤에도 옛 워커가 자기 epoch 슬롯을 계속 본다.
 *
 * ⚠️ **`nginx -t` 는 이 Lua 를 안 본다** (E64). 여기 문법 오류가 있으면 게시 전 검사를
 * 그대로 통과하고, 세대 마커(`return 200`)는 Lua 와 무관하게 답하므로 **활성화 판정도
 * 못 잡는다.** 그래서 staging 뒤에 **되읽어 대조**한다 — 그게 Lua 경로가 실제로 살아
 * 있다는 유일한 증거다.
 */
/**
 * 소켓 경로를 검사한다 (검수 S-08b · S-11 부류).
 *
 * 이 문자열은 그대로 `listen unix:<path>;` 가 된다 — 세미콜론 하나면 디렉티브가 하나
 * 는다. 만드는 자리는 데몬이지만 **만드는 자리가 하나라는 보장은 없으므로** 쓰는 쪽에서
 * 막는다. 렌더러가 디렉티브 문자열을 검사하는 것과 같은 규칙이다.
 *
 * 절대 경로만 받는다. 상대 경로는 nginx prefix 기준으로 풀려 세대·배포마다 어디에
 * 생길지 갈리고, 그러면 에이전트가 붙을 자리를 못 찾는다.
 */
export function assertAdminSocket(path: string): string {
  if (!path.startsWith('/') || !/^[A-Za-z0-9/._-]+$/.test(path)) {
    throw new Error(
      `admin 소켓 경로가 아니다: ${JSON.stringify(path)} — 절대 경로에 [A-Za-z0-9/._-] 만`,
    );
  }
  return path;
}

export const httpAdminConf = (generation: string, epoch: string, socket: string): string =>
  `# 세대에 결박된다. 세대마다 리터럴이 다르다 (§6.3-4 · §6.5-1).
init_worker_by_lua_block { _G.BARY_EPOCH = "${epoch}" }

server {
    listen unix:${assertAdminSocket(socket)};
    default_type text/plain;

    location = /generation { return 200 "${generation}"; }
    location = /healthz    { return 200 "ok"; }

    # 멤버십 슬롯 쓰기. **유닉스 소켓 전용이다** (검수 S-08b) — 관리 표면이지 트래픽
    # 표면이 아니다. 인증이 없는 대신 접근 통제를 OS 가 진다: 소켓이 사는 디렉토리가
    # 에이전트 사용자 소유 0700 이다. 루프백 TCP 였을 때는 hostNetwork 배포에서
    # 같은 호스트의 아무 프로세스나 슬롯을 다시 쓸 수 있었다.
    location = /membership {
        content_by_lua_block {
            ngx.req.read_body()
            local body = ngx.req.get_body_data() or ""
            local epoch = ngx.var.arg_epoch
            if not epoch or epoch == "" then ngx.status = 400; ngx.print("no epoch"); return end
            local d = ngx.shared.${MEMBERSHIP_DICT.http}

            -- **퇴역한 epoch 의 슬롯을 회수한다** (검수 D4).
            --
            -- 전에는 쓰기만 있었다. dict 는 프로세스 수명이라 nginx 재시작 전까지
            -- **세대 전환마다 풀 수만큼 키가 쌓였다.** 차면 LRU 가 밀어내고, 밀려난
            -- 것이 \`slot:\` 이면 \`balancer_by_lua\` 가 \`ngx.exit(ngx.ERROR)\` 를 타
            -- **그 풀의 모든 요청이 끊긴다.** \`membershipDictKb\`(B-12)는 그 절벽을
            -- 뒤로 미는 손잡이인데, 미는 것과 안 자라게 하는 것은 다르다.
            --
            -- ACME 토큰의 \`arg_remove\` 와 **같은 모양**이다 — 새 계약이 아니다.
            -- 다만 지우는 단위가 토큰 하나가 아니라 **epoch 하나**다: 그 epoch 의
            -- 슬롯이 몇 개인지는 부르는 쪽이 모르고(풀 수는 모델이 정한다),
            -- 알 필요도 없다.
            if ngx.var.arg_remove then
                local n = 0
                local suffix = ":" .. epoch
                for _, k in ipairs(d:get_keys(0)) do
                    -- **접두사와 접미사를 함께 본다.** \`slot:\` 로만 걸면 다른 키를
                    -- 지울 수 있고, epoch 으로만 걸면 \`in:\`·\`rr:\` 이 걸린다.
                    --
                    -- **\`attr:\` 도 함께 지운다.** 슬롯만 지우면 속성이 세대마다 쌓이고,
                    -- 그 결말은 위 문단이 이미 적었다 — 차면 LRU 가 밀어내고 밀려난 것이
                    -- \`slot:\` 이면 그 풀의 모든 요청이 끊긴다. 속성을 새는 채로 넣으면
                    -- **결국 트래픽이 끊긴다.**
                    local head = k:sub(1, 5)
                    if (head == "slot:" or head == "attr:") and k:sub(-#suffix) == suffix then
                        d:delete(k)
                        n = n + 1
                    end
                end
                ngx.print("removed ", n)
                return
            end

            local n = 0
            for line in body:gmatch("[^\\n]+") do
                -- **\`!\` 로 시작하면 속성 줄이다** (ADR ②-a). upstream 이름은 nginx
                -- 식별자라 \`!\` 로 시작할 수 없으므로 문법이 안 겹친다.
                --
                -- 파싱은 **여기서 한 번**이다. 밸런서가 요청마다 하면 고르는 비용(hash
                -- 23.1ns · rr 0.48ns)의 백 배가 된다 — 그래서 peer 마다 키 하나로 편다.
                if line:sub(1, 1) == "!" then
                    local name, list = line:match("^!([^=]+)=(.*)$")
                    if name then
                        for entry in list:gmatch("[^,]+") do
                            local peer, rest = entry:match("^(.-)|(.*)$")
                            if peer then
                                local ok, err = d:set(
                                    "attr:" .. name .. ":" .. peer .. ":" .. epoch, rest)
                                if not ok then
                                    ngx.status = 500; ngx.print("set failed: ", err); return
                                end
                                n = n + 1
                            end
                        end
                    end
                else
                local name, peers = line:match("^([^=]+)=(.*)$")
                if name then
                    local ok, err = d:set("slot:" .. name .. ":" .. epoch, peers)
                    if not ok then ngx.status = 500; ngx.print("set failed: ", err); return end
                    n = n + 1
                end
                end
            end
            ngx.print("staged ", n)
        }
    }

    # ACME http-01 토큰 적재 (§8.2). **유닉스 소켓 전용** (검수 S-08b).
    #
    # 멤버십과 같은 이유로 dict 다 — 토큰을 conf 에 실으면 갱신 한 번에 세대 전환이
    # 한 번 붙고, 그 대가는 실측돼 있다(트래픽 2.6%).
    #
    # exptime 을 준다. ACME 주문은 유한하고, 실패한 주문의 토큰이 영원히 남으면
    # dict 가 찬다 — §8.2 가 "고아 스캔" 을 요구한 것과 같은 문제를 여기서는 만료로
    # 푼다. S18 이 실측했다: **버려진 주문을 CA 는 안 치운다.**
    location = /acme {
        content_by_lua_block {
            ngx.req.read_body()
            local body = ngx.req.get_body_data() or ""
            local d = ngx.shared.${ACME_DICT}
            -- 제거는 별도 인자다. TTL 에만 기대면 "치웠다" 를 언제 적을지 알 수 없고,
            -- 그러면 고아 목록이 안 줄어든다.
            local rm = ngx.var.arg_remove
            if rm and rm ~= "" then
                d:delete("tok:" .. rm)
                ngx.print("removed")
                return
            end
            local n = 0
            for line in body:gmatch("[^\\n]+") do
                local token, value = line:match("^([^=]+)=(.*)$")
                if token then
                    local ok, err = d:set("tok:" .. token, value, ${ACME_TTL_SECONDS})
                    if not ok then ngx.status = 500; ngx.print("set failed: ", err); return end
                    n = n + 1
                end
            end
            ngx.print("staged ", n)
        }
    }

    location = /acme/read {
        content_by_lua_block {
            local d = ngx.shared.${ACME_DICT}
            local out = {}
            for _, k in ipairs(d:get_keys(0)) do
                local t = k:match("^tok:(.+)$")
                if t then out[#out + 1] = t .. "=" .. (d:get(k) or "") end
            end
            table.sort(out)
            ngx.print(table.concat(out, "\\n"))
        }
    }

    # **되읽기.** nginx -t 가 Lua 를 안 보므로(E64), 이 경로가 실제로 도는지는
    # 써 놓고 다시 읽어 대조하는 것으로만 알 수 있다.
    location = /membership/read {
        content_by_lua_block {
            local d = ngx.shared.${MEMBERSHIP_DICT.http}
            local epoch = ngx.var.arg_epoch or ""
            local out = {}
            local byName = {}
            for _, k in ipairs(d:get_keys(0)) do
                local name = k:match("^slot:(.+):" .. epoch .. "$")
                if name then out[#out + 1] = name .. "=" .. (d:get(k) or "") end
                -- **속성도 되읽을 수 있어야 한다.** 밖에서 못 보면 회수가 지웠는지를
                -- 잴 방법이 없고, 안 지우면 결국 dict 가 차서 트래픽이 끊긴다.
                --
                -- **쓴 형식 그대로 낸다** (\`!이름=peer|max|backup,…\`). 적재는 되읽어
                -- 비교하므로 형식이 갈리면 그 검사가 **언제나 실패**한다.
                local an, ap = k:match("^attr:(.+):([^:]+:%d+):" .. epoch .. "$")
                if an then
                    byName[an] = byName[an] or {}
                    local t = byName[an]
                    t[#t + 1] = ap .. "|" .. (d:get(k) or "")
                end
            end
            for name, list in pairs(byName) do
                table.sort(list)
                out[#out + 1] = "!" .. name .. "=" .. table.concat(list, ",")
            end
            table.sort(out)
            ngx.print(table.concat(out, "\\n"))
        }
    }

    # **지금 dict 에 있는 \`slot:\` 키 수** (검수 D4).
    #
    # 회수를 붙였다고 안 자란다는 보장은 없다 — 회수가 안 불리는 경로, 세대 GC 가
    # 꺼진 배포, 아직 모르는 자리가 남는다. **자라는 것이 보여야** 다음 사람이 이
    # 자리를 다시 만들지 않는다.
    #
    # 키만 센다. 값을 안 읽는 이유는 이 창구가 \`/metrics\` 스크레이프마다 불리기
    # 때문이다 — 세는 비용은 키 수에 비례하지만 읽는 비용은 바이트에 비례한다.
    location = /membership/count {
        content_by_lua_block {
            local d = ngx.shared.${MEMBERSHIP_DICT.http}
            local n = 0
            for _, k in ipairs(d:get_keys(0)) do
                if k:sub(1, 5) == "slot:" then n = n + 1 end
            end
            ngx.print(n)
        }
    }

    # peer 별 inflight. 밸런서가 올린 숫자만 준다. 없으면 빈 객체 — 숫자를 안 짓는다.
    location = /membership/inflight {
        content_by_lua_block {
            local peer = ngx.var.arg_peer or ""
            if peer == "" then ngx.status = 400; ngx.print("{}"); return end
            local d = ngx.shared.${MEMBERSHIP_DICT.http}
            local n = d:get("in:" .. peer)
            if n == nil then ngx.print("{}"); return end
            ngx.print('{"inflight":' .. n .. ',"active_sessions":' .. n .. '}')
        }
    }
}
`;

/**
 * stream 평면의 세대 admin 조각.
 *
 * stream 에는 HTTP 가 없으므로 admin 도 **원시 TCP** 다. 한 줄씩 읽어 처리하고 답한다.
 * http zone 과 stream zone 은 서로 안 보이므로(E14 · E25 · §3.4) 각 평면이 자기 admin 을
 * 가져야 한다 — 하나로 합칠 수 없다.
 */
export const streamAdminConf = (epoch: string, socket: string): string =>
  `init_worker_by_lua_block { _G.BARY_EPOCH = "${epoch}" }

server {
    listen unix:${assertAdminSocket(socket)};
    content_by_lua_block {
        local sock = assert(ngx.req.socket())
        local d = ngx.shared.${MEMBERSHIP_DICT.stream}
        -- 첫 줄이 "<epoch> <write|read>", 그 뒤로 "이름=peer,peer" 가 이어진다.
        local head = sock:receive("*l")
        if not head then return end
        local epoch, verb = head:match("^(%S+)%s+(%S+)$")
        if not epoch then ngx.print("bad header\\n") return end
        -- **peer 별 inflight** (S2). 밸런서가 올린 숫자만 준다 — 없으면 빈 객체다.
        --
        -- 전에는 이 창구가 http 에만 있었다. 그런데 \`in:\` 을 올리는 balancer 와 내리는
        -- log 단계는 **양쪽 평면에 다 있다** — 즉 숫자는 세고 있는데 물을 데가 없어서
        -- TCP·UDP 백엔드는 \`quiesced\` 판정을 영영 못 받았다. 두 zone 은 서로 안 보이므로
        -- (E14 · E25) http admin 으로 대신 물을 수도 없다.
        --
        -- peer 는 **다음 줄**로 받는다. 헤더는 정확히 두 토큰이고(\`write\`·\`read\` 가 같은
        -- 문법을 쓴다) 거기 끼워 넣으면 그 파싱이 함께 헐거워진다.
        if verb == "inflight" then
            local peer = sock:receive("*l")
            if not peer or peer == "" then ngx.print("{}\\n") return end
            local n = d:get("in:" .. peer)
            if n == nil then ngx.print("{}\\n") return end
            ngx.print('{"inflight":' .. n .. ',"active_sessions":' .. n .. '}\\n')
            return
        end
        if verb == "read" then
            local out = {}
            for _, k in ipairs(d:get_keys(0)) do
                local name = k:match("^slot:(.+):" .. epoch .. "$")
                if name then out[#out + 1] = name .. "=" .. (d:get(k) or "") end
            end
            table.sort(out)
            ngx.print(table.concat(out, "\\n"), "\\n")
            return
        end
        -- 슬롯 키 수 (검수 D4). http 의 \`/membership/count\` 와 같은 값이다 —
        -- 두 zone 은 서로 안 보이므로 각자 답해야 한다.
        if verb == "count" then
            local n = 0
            for _, k in ipairs(d:get_keys(0)) do
                if k:sub(1, 5) == "slot:" then n = n + 1 end
            end
            ngx.print(n, "\\n")
            return
        end
        -- **회수도 양 평면에 있어야 한다** (검수 D4). 두 zone 은 서로 안 보이므로
        -- (E14 · E25) http admin 으로 대신 지울 수가 없다 — 한쪽만 회수하면 다른
        -- 쪽이 계속 자란다.
        if verb == "remove" then
            local n = 0
            local suffix = ":" .. epoch
            for _, k in ipairs(d:get_keys(0)) do
                if k:sub(1, 5) == "slot:" and k:sub(-#suffix) == suffix then
                    d:delete(k)
                    n = n + 1
                end
            end
            ngx.print("removed ", n, "\\n")
            return
        end
        local n = 0
        while true do
            local line = sock:receive("*l")
            if not line or line == "" then break end
            local name, peers = line:match("^([^=]+)=(.*)$")
            if name then
                local ok, err = d:set("slot:" .. name .. ":" .. epoch, peers)
                if not ok then ngx.print("set failed: ", err, "\\n") return end
                n = n + 1
            end
        end
        ngx.print("staged ", n, "\\n")
    }
}
`;

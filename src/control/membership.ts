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
 * 모델에서 평면별 멤버십을 뽑는다.
 *
 * **렌더된 upstream 이름을 키로 쓴다.** 풀 키를 그대로 쓰면 밸런서가 보는 이름과
 * 달라진다 — 렌더러가 nginx 식별자로 바꾸면서 단사성을 위해 다이제스트를 붙일 수 있다.
 */
export function slotsOf(
  model: Model, caps: RenderCapabilities, discovery?: DiscoveryIntake,
): Record<Plane, Slots> {
  const used = applyDiscoveredEndpoints(model, discovery);
  const out: Record<Plane, Slots> = { http: {}, stream: {} };
  // 렌더는 풀의 upstream 이름을 읽기 위한 것이다. 광고가 비면 백엔드가 없어
  // validate 가 막으므로 이름은 정적 모델에서 읽고, peer 만 발견한 집합에서 온다.
  const conf = render(model, caps).conf;
  const byPool = new Map<string, string[]>();
  for (const b of used.backends) {
    const list = byPool.get(b.pool) ?? [];
    list.push(`${b.host}:${b.port}`);
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
    out[plane][name] = [...peers].sort();
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

/** 슬롯을 admin 이 받는 줄 모양으로. `이름=peer,peer` 한 줄씩. */
export const encodeSlots = (slots: Slots): string =>
  Object.entries(slots).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, peers]) => `${name}=${peers.join(',')}`).join('\n');

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
            local n = 0
            for line in body:gmatch("[^\\n]+") do
                local name, peers = line:match("^([^=]+)=(.*)$")
                if name then
                    local ok, err = d:set("slot:" .. name .. ":" .. epoch, peers)
                    if not ok then ngx.status = 500; ngx.print("set failed: ", err); return end
                    n = n + 1
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
            for _, k in ipairs(d:get_keys(0)) do
                local name = k:match("^slot:(.+):" .. epoch .. "$")
                if name then out[#out + 1] = name .. "=" .. (d:get(k) or "") end
            end
            table.sort(out)
            ngx.print(table.concat(out, "\\n"))
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

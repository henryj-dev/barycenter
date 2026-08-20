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

import { ACME_DICT, render, MEMBERSHIP_DICT, type RenderCapabilities } from '../conf/render.js';

import { applyDiscoveredEndpoints, type DiscoveryIntake } from './discovery.js';
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
 * 렌더된 conf 에서 풀의 upstream 이름을 읽는다.
 *
 * 렌더러의 `upstreamName` 을 여기서 다시 구현하고 싶어지는데, 그러면 **이름을 정하는
 * 자리가 둘**이 되고 단사성 보정(다이제스트 접미)이 붙는 순간 갈린다.
 * 산출물에서 읽는 편이 한 자리를 유지한다.
 */
function upstreamNameIn(conf: string, poolKey: string): string | undefined {
  const ident = poolKey.replace(/[^A-Za-z0-9_]/g, '_');
  const re = new RegExp(`^\\s*upstream (pool_${ident}(?:_[0-9a-f]+)?) \\{`, 'm');
  return re.exec(conf)?.[1];
}

/** 슬롯을 admin 이 받는 줄 모양으로. `이름=peer,peer` 한 줄씩. */
export const encodeSlots = (slots: Slots): string =>
  Object.entries(slots).sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([name, peers]) => `${name}=${peers.join(',')}`).join('\n');

/**
 * Lua `ngx.balancer.set_current_peer` 는 호스트 이름을 거절한다.
 * 슬롯에 넣기 전에 A/AAAA 를 풀어 둔다. 이미 IP 면 그대로다.
 */
export async function resolveSlots(slots: Slots): Promise<Slots> {
  const out: Slots = {};
  for (const [name, peers] of Object.entries(slots)) {
    out[name] = await Promise.all(peers.map(resolvePeer));
  }
  return out;
}

async function resolvePeer(hp: string): Promise<string> {
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
export const httpAdminConf = (generation: string, epoch: string, port: number): string =>
  `# 세대에 결박된다. 세대마다 리터럴이 다르다 (§6.3-4 · §6.5-1).
init_worker_by_lua_block { _G.BARY_EPOCH = "${epoch}" }

server {
    listen 127.0.0.1:${port};
    default_type text/plain;

    location = /generation { return 200 "${generation}"; }
    location = /healthz    { return 200 "ok"; }

    # 멤버십 슬롯 쓰기. **루프백 전용이다** — 관리 표면이지 트래픽 표면이 아니다.
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

    # ACME http-01 토큰 적재 (§8.2). **루프백 전용.**
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
}
`;

/**
 * stream 평면의 세대 admin 조각.
 *
 * stream 에는 HTTP 가 없으므로 admin 도 **원시 TCP** 다. 한 줄씩 읽어 처리하고 답한다.
 * http zone 과 stream zone 은 서로 안 보이므로(E14 · E25 · §3.4) 각 평면이 자기 admin 을
 * 가져야 한다 — 하나로 합칠 수 없다.
 */
export const streamAdminConf = (epoch: string, port: number): string =>
  `init_worker_by_lua_block { _G.BARY_EPOCH = "${epoch}" }

server {
    listen 127.0.0.1:${port};
    content_by_lua_block {
        local sock = assert(ngx.req.socket())
        local d = ngx.shared.${MEMBERSHIP_DICT.stream}
        -- 첫 줄이 "<epoch> <write|read>", 그 뒤로 "이름=peer,peer" 가 이어진다.
        local head = sock:receive("*l")
        if not head then return end
        local epoch, verb = head:match("^(%S+)%s+(%S+)$")
        if not epoch then ngx.print("bad header\\n") return end
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

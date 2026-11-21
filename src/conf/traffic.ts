/**
 * 트래픽 카운터 (2026-11-20).
 *
 * **엔진이 센다.** 요청(stream 은 연결)이 끝날 때 log 단계가 리소스마다 수를 올린다.
 * 데몬은 그 수를 읽기만 하고 시간에 따라 차이를 낸다(`src/control/traffic.ts`).
 *
 * ── 무엇을 세는가
 *
 *   키는 `<종류>|<이름>|<칸>` 이다. 종류는 넷이다.
 *     · `l` 리스너 — server 블록이 `$bary_l` 에 이름을 적는다.
 *     · `r` 라우트 — location 이 `$bary_r` 에 적는다. 패스스루는 SNI map 이 정한다.
 *     · `p` 풀 — 밸런서가 upstream 이름을 적는다. http 는 `$bary_p`, stream 은 `ngx.ctx.bary_up` 이다.
 *     · `b` 백엔드 — `b|<upstream>|<peer>`. peer 는 `$upstream_addr` 의 마지막 주소다.
 *   칸은 `n`(수) · `s1`..`s5`(상태 계열) · `bi`·`bo`(받은·보낸 바이트) · `ms`(걸린 시간 합, 밀리초).
 *
 * ── 왜 dict 를 따로 두는가
 *
 *   멤버십 dict 와 같이 쓰면 카운터가 `slot:` 을 LRU 로 밀어낼 수 있다. 밀려나면 그 풀의
 *   모든 요청이 끊긴다(render.ts 의 `DEFAULT_MEMBERSHIP_KB` 주석). 카운터는 잃어도 되는 값이다.
 *
 * ── `|` 를 쓰는 이유
 *
 *   리소스 이름 규칙(`RESOURCE_KEY_SYNTAX`)에 `|` 가 없다. peer 는 `:` 를 쓰므로 `:` 로는 못 가른다.
 */
export const TRAFFIC_DICT = { http: 'bary_http_traffic', stream: 'bary_stream_traffic' } as const;

/** 카운터 dict 크기. 리소스 하나가 키 9개 안팎이다 — 2m 이면 수천 개를 담는다. */
export const TRAFFIC_DICT_SIZE = '2m';

/** 이름을 싣는 nginx 변수. */
export const LISTENER_VAR = 'bary_l';
export const ROUTE_VAR = 'bary_r';
/** stream 패스스루는 라우트를 SNI map 이 정한다. 그 map 변수의 **이름**을 여기 둔다. */
export const ROUTE_MAP_VAR = 'bary_rv';

/**
 * http 평면에서 **내부 리다이렉트를 넘어 살아야 하는 값**을 싣는 변수 (2026-11-21).
 *
 * `ngx.ctx` 는 `error_page` 의 내부 리다이렉트에서 비워진다. 백엔드에 못 붙어 엔진이 502 · 504 를 만들면 바로 그
 * 리다이렉트가 일어난다. 그래서 고른 peer 를 ctx 에만 두면 log 단계가 그것을 못 찾고 `in:` 이 **실패한 요청에서만**
 * 샜다. nginx 변수는 리다이렉트를 넘어 남는다. stream 에는 `error_page` 가 없으므로 ctx 그대로다.
 *
 *   · `$bary_peers` — 이 요청이 고른 peer 들. 쉼표로 잇는다(peer 에는 쉼표가 없다).
 *   · `$bary_p` — 고른 upstream 이름. 풀 카운터가 읽는다.
 *
 * 값을 쓰려면 변수가 선언되어 있어야 한다. server 마다 `set` 으로 빈 값을 둔다(`httpRequestVars`).
 */
export const PEERS_VAR = 'bary_peers';
export const POOL_VAR = 'bary_p';

/** 카운터 칸. 데몬이 이 목록으로 읽는다. */
export const TRAFFIC_FIELDS = ['n', 's1', 's2', 's3', 's4', 's5', 'bi', 'bo', 'ms'] as const;
export type TrafficField = (typeof TRAFFIC_FIELDS)[number];

/**
 * log 단계에서 수를 올리는 Lua. 멤버십의 `in:` 내리기 **앞에** 둔다 — 그쪽은 고른 peer 가
 * 없으면 `return` 한다.
 *
 * 리스너 · 라우트 · 풀은 nginx 변수에서 읽는다 — 내부 리다이렉트(`error_page`)를 넘어 남는다. 백엔드는
 * `$upstream_addr` 로 잡는다. stream 의 풀만 ctx 다(stream 에는 리다이렉트가 없다).
 */
export function trafficLogLua(plane: 'http' | 'stream'): string {
  const bytesIn = plane === 'http' ? 'request_length' : 'bytes_received';
  const time = plane === 'http' ? 'request_time' : 'session_time';
  const route = plane === 'http'
    ? `local r = ngx.var.${ROUTE_VAR}`
    : `local rv = ngx.var.${ROUTE_MAP_VAR}
            local r = (rv and rv ~= "") and ngx.var[rv] or nil`;
  return `
            -- **트래픽 카운터** (2026-11-20, src/conf/traffic.ts). 잃어도 되는 값이라 실패해도 넘어간다.
            local t = ngx.shared.${TRAFFIC_DICT[plane]}
            if t then
                local st = tonumber(ngx.var.status) or 0
                local cls = "s" .. math.floor(st / 100)
                local bi = tonumber(ngx.var.${bytesIn}) or 0
                local bo = tonumber(ngx.var.bytes_sent) or 0
                local ms = (tonumber(ngx.var.${time}) or 0) * 1000
                local function add(id)
                    t:incr(id .. "|n", 1, 0)
                    if st >= 100 and st < 600 then t:incr(id .. "|" .. cls, 1, 0) end
                    if bi > 0 then t:incr(id .. "|bi", bi, 0) end
                    if bo > 0 then t:incr(id .. "|bo", bo, 0) end
                    t:incr(id .. "|ms", ms, 0)
                end
                local l = ngx.var.${LISTENER_VAR}
                if l and l ~= "" then add("l|" .. l) end
                ${route}
                if r and r ~= "" then add("r|" .. r) end
                ${plane === 'http' ? `local up = ngx.var.${POOL_VAR}
                if up == "" then up = nil end` : 'local up = ngx.ctx.bary_up'}
                if up then add("p|" .. up) end
                local ua = ngx.var.upstream_addr
                if ua and ua ~= "" then
                    local peer = ua:match("([^%s,]+)$")
                    if peer and peer ~= "0.0.0.1:1" then add("b|" .. (up or "") .. "|" .. peer) end
                end
            end
`;
}

/**
 * admin 이 카운터를 그대로 낸다 — 한 줄에 `키=값`. http 는 `/traffic`, stream 은 `0 traffic`.
 * 값을 해석하지 않는다. 해석은 데몬 한 곳(`parseTrafficDump`)이 한다.
 */
export function trafficDumpLua(plane: 'http' | 'stream'): string {
  return `local t = ngx.shared.${TRAFFIC_DICT[plane]}
            if not t then ngx.print("") return end
            local out = {}
            for _, k in ipairs(t:get_keys(0)) do
                local v = t:get(k)
                if v then out[#out + 1] = k .. "=" .. string.format("%.17g", v) end
            end
            ngx.print(table.concat(out, "\\n"))`;
}

export type TrafficKind = 'listener' | 'route' | 'pool' | 'backend';

/** 한 리소스의 카운터. `upstream` 과 `peer` 는 백엔드에만 있다. */
export type TrafficCounter = {
  kind: TrafficKind;
  id: string;
  upstream?: string;
  peer?: string;
  values: Partial<Record<TrafficField, number>>;
};

const KIND_OF: Record<string, TrafficKind> = { l: 'listener', r: 'route', p: 'pool', b: 'backend' };

/**
 * admin 이 낸 덤프를 읽는다. 모르는 줄은 버린다 — 지어내지 않는다.
 */
export function parseTrafficDump(text: string): TrafficCounter[] {
  const byId = new Map<string, TrafficCounter>();
  for (const line of text.split('\n')) {
    const eq = line.lastIndexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq);
    const value = Number(line.slice(eq + 1));
    if (!Number.isFinite(value) || value < 0) continue;
    const parts = key.split('|');
    const field = parts.pop() as TrafficField | undefined;
    if (field === undefined || !(TRAFFIC_FIELDS as readonly string[]).includes(field)) continue;
    const kind = KIND_OF[parts[0] ?? ''];
    if (kind === undefined) continue;
    let c: TrafficCounter | undefined;
    const slot = parts.join('|');
    if (kind === 'backend') {
      if (parts.length !== 3 || parts[2] === '') continue;
      c = byId.get(slot) ?? { kind, id: `${parts[1]}|${parts[2]}`, upstream: parts[1] ?? '', peer: parts[2] ?? '', values: {} };
    } else {
      if (parts.length !== 2 || parts[1] === '') continue;
      c = byId.get(slot) ?? { kind, id: parts[1] ?? '', values: {} };
    }
    c.values[field] = value;
    byId.set(slot, c);
  }
  return [...byId.values()];
}

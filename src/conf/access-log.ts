/**
 * 액세스 로그 (2026-11-22).
 *
 * **엔진이 적는다.** 요청(stream 은 연결)이 끝날 때 log 단계가 한 줄을 공유 메모리의 **고리**에 적는다.
 * 데몬은 admin 창구로 마지막에 읽은 순번 뒤의 줄만 가져간다(`src/control/access-log.ts`).
 *
 * ── 왜 파일이 아닌가
 *
 *   설정 파일을 쓰는 것은 DP 에이전트뿐이고, 로그 파일을 돌리고 지우는 일까지 지면 디스크가 새 장애 원인이 된다.
 *   고리는 크기가 정해져 있다 — 가득 차면 가장 오래된 줄을 덮는다. 오래 남기려면 내보내기를 쓴다.
 *   트래픽 카운터처럼 **잃어도 되는 값**이다. 엔진이 다시 뜨면 비어도 된다.
 *
 * ── 고리
 *
 *   `seq` 를 하나씩 올리고, 줄은 `e:<seq % ACCESS_RING>` 에 둔다. 줄 안에 자기 순번(`q`)을 싣는다 — 읽을 때
 *   순번이 다르면 그 칸은 이미 덮인 것이다. `boot` 는 dict 가 처음 쓰인 시각이다. 바뀌면 엔진이 다시 뜬 것이고,
 *   데몬은 순번을 처음부터 다시 센다.
 *   dict 가 차면 nginx 는 오래 안 쓴 키부터 지운다. 그때 지워지는 것은 가장 오래된 줄이다 — 고리가 조금 짧아질 뿐이다.
 *
 * ── 무엇을 싣지 않는가
 *
 *   쿼리 문자열은 뺀다 — 토큰 · 개인 정보가 거기 자주 실린다. Referer 도 같은 이유로 쿼리를 뺀다.
 *   요청 · 응답 본문과 쿠키 · Authorization 은 싣지 않는다. 긴 값은 자른다(`CUT`).
 */
import { LISTENER_VAR, POOL_VAR, ROUTE_MAP_VAR, ROUTE_VAR } from './traffic.js';

export const ACCESS_DICT = { http: 'bary_http_access', stream: 'bary_stream_access' } as const;

/** 평면마다 남기는 줄 수. 한 줄이 1KB 를 넘지 않으므로(`CUT`) 8m dict 에 넉넉히 들어간다. */
export const ACCESS_RING = 5000;
export const ACCESS_DICT_SIZE = '8m';

/** admin 이 한 번에 내는 줄 수의 상한. 데몬은 남은 것을 다음 주기에 마저 읽는다. */
export const ACCESS_DUMP_MAX = 1000;

/** 문자열 칸의 길이 상한 (바이트). */
const CUT = { path: 512, host: 255, ua: 256, ref: 256, xff: 128, sni: 255 } as const;

/**
 * log 단계의 Lua. 트래픽 카운터 다음에 둔다 — 그 뒤의 멤버십 내리기는 고른 peer 가 없으면 `return` 한다.
 * 실패해도 요청에는 영향이 없다 — `pcall` 로 감싼다.
 */
export function accessLogLua(plane: 'http' | 'stream'): string {
  const fields = plane === 'http'
    ? `t = ngx.req.start_time(),
                    id = v.request_id,
                    m = v.request_method,
                    h = cut(v.host, ${CUT.host}),
                    u = cut(strip(v.request_uri), ${CUT.path}),
                    pr = v.server_protocol,
                    s = tonumber(v.status) or 0,
                    us = tonumber(last(v.upstream_status)),
                    d = num(v.request_time),
                    uc = num(last(v.upstream_connect_time)),
                    uh = num(last(v.upstream_header_time)),
                    bi = tonumber(v.request_length) or 0,
                    bo = tonumber(v.bytes_sent) or 0,
                    r = nz(v.${ROUTE_VAR}),
                    p = nz(v.${POOL_VAR}),
                    sni = cut(v.ssl_server_name, ${CUT.sni}),
                    tv = nz(v.ssl_protocol),
                    ag = cut(v.http_user_agent, ${CUT.ua}),
                    rf = cut(strip(v.http_referer), ${CUT.ref}),
                    xf = cut(v.http_x_forwarded_for, ${CUT.xff}),`
    : `t = ngx.now() - (num(v.session_time) or 0),
                    s = tonumber(v.status) or 0,
                    d = num(v.session_time),
                    uc = num(last(v.upstream_connect_time)),
                    bi = tonumber(v.bytes_received) or 0,
                    bo = tonumber(v.bytes_sent) or 0,
                    r = (function() local rv = v.${ROUTE_MAP_VAR}; return (rv and rv ~= "") and nz(v[rv]) or nil end)(),
                    p = ngx.ctx.bary_up,
                    sni = cut(v.ssl_preread_server_name, ${CUT.sni}),
                    tr = (v.protocol == "UDP") and "udp" or "tcp",`;
  return `
            -- **액세스 로그** (2026-11-22, src/conf/access-log.ts). 잃어도 되는 값이라 실패해도 넘어간다.
            local A = ngx.shared.${ACCESS_DICT[plane]}
            if A then
                pcall(function()
                    local v = ngx.var
                    local function nz(x) if x == nil or x == "" or x == "-" then return nil end return x end
                    local function cut(x, n) x = nz(x); if x and #x > n then return x:sub(1, n) end return x end
                    local function strip(x) x = nz(x); if x then return (x:match("^[^?#]*")) end return nil end
                    local function last(x) x = nz(x); if x then return x:match("([^%s,]+)$") end return nil end
                    local function num(x) x = tonumber(x); if x then return x end return nil end
                    -- 리스너가 없는 server 는 admin 창구다. 적지 않는다.
                    local l = nz(v.${LISTENER_VAR})
                    if not l then return end
                    local ua = last(v.upstream_addr)
                    if ua == "0.0.0.1:1" then ua = nil end
                    local seq = A:incr("seq", 1, 0)
                    -- \`get\` 은 키를 LRU 앞으로 옮긴다. dict 가 차도 \`boot\` 가 밀려나지 않는다 — 밀려나면
                    -- 데몬이 엔진 재시작으로 읽고 같은 줄을 두 번 받는다. \`seq\` 는 \`incr\` 이 같은 일을 한다.
                    if not A:get("boot") then A:add("boot", string.format("%.3f", ngx.now())) end
                    local e = {
                    q = seq,
                    c = v.remote_addr,
                    l = l,
                    ${fields}
                    ua = ua,
                    }
                    A:set("e:" .. (seq % ${ACCESS_RING}), require("cjson.safe").encode(e))
                end)
            end
`;
}

/**
 * admin 이 고리를 낸다. `after` 뒤의 줄을 오래된 것부터, 많아야 `ACCESS_DUMP_MAX` 줄.
 *
 *   첫 줄   `boot <boot> <seq>` — dict 가 한 번도 안 쓰였으면 `boot - 0`
 *   그 뒤   줄마다 JSON 하나
 *
 * 값을 해석하지 않는다. 해석은 데몬 한 곳(`parseAccessDump`)이 한다. `after` 는 Lua 변수 `after` 로 받는다.
 */
export function accessDumpLua(plane: 'http' | 'stream'): string {
  return `local A = ngx.shared.${ACCESS_DICT[plane]}
            if not A then ngx.print("boot - 0\\n") return end
            local seq = A:get("seq") or 0
            local boot = A:get("boot") or "-"
            local out = { "boot " .. boot .. " " .. string.format("%d", seq) }
            local from = math.max((tonumber(after) or 0) + 1, seq - ${ACCESS_RING} + 1, 1)
            local to = math.min(seq, from + ${ACCESS_DUMP_MAX} - 1)
            for i = from, to do
                local e = A:get("e:" .. (i % ${ACCESS_RING}))
                if e then out[#out + 1] = e end
            end
            ngx.print(table.concat(out, "\\n"), "\\n")`;
}

/** 엔진이 적은 줄 하나 — 칸 이름은 Lua 와 같다. 없는 칸은 엔진이 몰랐던 것이다. */
export type RawAccess = {
  q: number; t: number; c?: string; l?: string; s: number;
  id?: string; m?: string; h?: string; u?: string; pr?: string;
  us?: number; d?: number; uc?: number; uh?: number; bi?: number; bo?: number;
  r?: string; p?: string; ua?: string; sni?: string; tv?: string;
  ag?: string; rf?: string; xf?: string; tr?: 'tcp' | 'udp';
};

export type AccessDump = { boot: string; seq: number; entries: RawAccess[] };

const str = (o: Record<string, unknown>, k: string): string | undefined =>
  typeof o[k] === 'string' && o[k] !== '' ? o[k] : undefined;
const nonNeg = (o: Record<string, unknown>, k: string): number | undefined => {
  const v = o[k];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined;
};

/** admin 이 낸 덤프를 읽는다. 머리가 틀리면 `undefined` — 지어내지 않는다. 모르는 줄 · 칸은 버린다. */
export function parseAccessDump(text: string): AccessDump | undefined {
  const lines = text.split('\n');
  const head = /^boot (\S+) ([0-9]+)$/.exec((lines[0] ?? '').trim());
  if (head === null) return undefined;
  const entries: RawAccess[] = [];
  for (const line of lines.slice(1)) {
    if (line.trim() === '') continue;
    let o: unknown;
    try { o = JSON.parse(line); } catch { continue; }
    if (o === null || typeof o !== 'object' || Array.isArray(o)) continue;
    const r = o as Record<string, unknown>;
    const q = nonNeg(r, 'q');
    const t = nonNeg(r, 't');
    const s = nonNeg(r, 's');
    if (q === undefined || !Number.isInteger(q) || t === undefined || s === undefined) continue;
    const e: RawAccess = { q, t, s };
    for (const k of ['c', 'l', 'id', 'm', 'h', 'u', 'pr', 'r', 'p', 'ua', 'sni', 'tv', 'ag', 'rf', 'xf'] as const) {
      const v = str(r, k);
      if (v !== undefined) e[k] = v;
    }
    for (const k of ['us', 'd', 'uc', 'uh', 'bi', 'bo'] as const) {
      const v = nonNeg(r, k);
      if (v !== undefined) e[k] = v;
    }
    if (r['tr'] === 'tcp' || r['tr'] === 'udp') e.tr = r['tr'];
    entries.push(e);
  }
  entries.sort((a, b) => a.q - b.q);
  return { boot: head[1]!, seq: Number(head[2]), entries };
}

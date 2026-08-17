/**
 * 모델 → nginx conf 렌더러 — DESIGN.md §7
 *
 * 계약
 *   · 결정적이다. 같은 모델은 항상 같은 바이트를 만든다 (R2/R3). 그래서 아티팩트
 *     다이제스트가 의미를 갖고, plan diff 가 흔들리지 않는다.
 *   · 문자열 템플릿을 쓰지 않는다. 전부 conf AST 를 거친다 (src/conf/ast.ts).
 *   · 산출물은 실제 엔진 `nginx -t` 를 통과해야 한다 (tests/golden).
 *
 * 엔진 근거 (tests/engine)
 *   E1/E3  — stream 에는 ip_hash 가 없다. source_ip_hash 는 서브시스템별로 다르게 렌더한다.
 *   E7     — $connection_upgrade 는 내장 변수가 아니다. websocket 라우트가 있으면 map 을
 *            http 컨텍스트에 정확히 한 번 렌더해야 한다.
 *   E21    — map 의 `~` 는 대소문자를 구분한다. SNI/DNS 는 대소문자 무시이므로 `~*` 를 쓴다.
 *   E26    — $ssl_preread_protocol 이 비어 있으면 비-TLS 다. no-SNI 분기의 근거.
 */
import { createHash } from 'node:crypto';
import { isIPv6 } from 'node:net';

import {
  block, directive, entry, lit, lua, num, regex, serialize, variable,
  type ConfNode, type ConfValue,
} from './ast.js';
import { compileHostRoutes, type RouteInput } from '../route/compile.js';
import { parseHostPattern } from '../validate/strings.js';
import { poolsReachedBy } from '../validate/engine-constraints.js';
import { ModelValidationError, validateModel } from '../validate/model.js';
import { decodeModel } from '../model/decode.js';
import { parseHashKey } from '../validate/strings.js';
import { normalizeBind } from '../validate/sockets.js';
import type {
  HttpListener,
  PassthroughListener,
  TcpListener,
  UdpListener,
  Backend,
  HttpRoute,
  Listener,
  Model,
  PassthroughRoute,
  Pool,
  SniOutcome,
  UdpPreset,
} from '../model/provisional.js';

export type RenderedConfig = {
  conf: string;
  digest: string;
  /**
   * 이 설정이 **실제로 구성하는 평면들** (10차 반례 ②).
   *
   * 하나의 `nginx.conf` 가 http 와 stream 을 함께 바꾼다. 그런데 apply 는 평면별
   * 좌표를 옮기므로, 어느 평면을 건드리는지 모르면 "stream 설정도 활성화됐는데
   * stream 좌표는 옛 값" 인 상태가 조용히 생긴다.
   */
  planes: ('http' | 'stream')[];
};

/**
 * 렌더에 영향을 주는 엔진 capability.
 *
 * `streamRealip` 이 없으면 stream 의 `$remote_addr` 는 앞단 프록시 주소로 남는다. 그러면
 * 소스IP 해시가 **모든 클라이언트를 한 백엔드로 몰아버린다.** 실측으로 확인한 대체 경로는
 * `$proxy_protocol_addr` 다 — 모듈 없이도 실 클라이언트 IP 를 준다.
 */
export type RenderCapabilities = {
  streamRealip: boolean;
  /**
   * `ngx_http_lua` / `ngx_stream_lua` — **멤버십 평면의 전제**다 (§7.3 · S1).
   *
   * 있으면 upstream 을 `balancer_by_lua_block` 으로 낸다. 그러면 백엔드 목록이 shared
   * dict 에 살고 **reload 없이** 바뀐다 — S1 이 HTTP·TCP·UDP 세 서브시스템 전부에서
   * 실증한 경로다.
   *
   * 없으면 정적 `server` 줄로 낸다(지금까지의 모양). 그건 열등한 것이 아니라 **다른
   * 계약**이다 — 백엔드가 바뀔 때마다 세대 전환과 reload 가 필요하다.
   */
  httpLua?: boolean;
  streamLua?: boolean;
};

/** capability 를 모르면 없는 쪽으로 가정한다. 모르는 것을 할 수 있다고 하지 않는다. */
const CONSERVATIVE: RenderCapabilities = { streamRealip: false };

/**
 * 멤버십 평면의 shared dict 이름. 평면마다 **다른 이름**이어야 한다.
 *
 * E14 로 실측: 같은 이름을 http 와 stream 에 선언하면
 * `already declared for a different use` 로 거부된다. 이름이 달라도 서로의 zone 은
 * 안 보인다(E25 · S5.zones) — §3.4 가 "별개 상태 평면" 이라고 한 것이 이 뜻이다.
 */
export const MEMBERSHIP_DICT = { http: 'bary_http', stream: 'bary_stream' } as const;

const byKey = <T extends { key: string }>(xs: T[]): T[] =>
  [...xs].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

/**
 * 키를 nginx 식별자로 바꾼다.
 *
 * 단순 치환은 **비단사**다 — `a-b` 와 `a_b` 가 같은 이름이 되어 upstream 이 중복 선언되고
 * `nginx -t` 가 실패한다. 치환이 손실을 낳는 경우에만 짧은 다이제스트를 붙여 단사로 만든다
 * (4차 검수). 손실이 없으면 읽기 좋은 이름을 그대로 쓴다.
 */
function ident(key: string): string {
  const safe = key.replace(/[^A-Za-z0-9_]/g, '_');
  if (safe === key) return safe;
  const digest = createHash('sha256').update(key, 'utf8').digest('hex').slice(0, 8);
  return `${safe}_${digest}`;
}
const upstreamName = (poolKey: string): string => `pool_${ident(poolKey)}`;

/** nginx 는 IPv6 업스트림에 대괄호를 요구한다 (E34). 없으면 `invalid port` 로 거부된다. */
const endpoint = (host: string, port: number): string =>
  isIPv6(host) ? `[${host}]:${port}` : `${host}:${port}`;

/**
 * map 의 제어어. 인용해도 제어어로 해석되므로(E33) 리터럴로 매칭하려면 앵커 정규식을 쓴다.
 */
const MAP_KEYWORDS = new Set(['default', 'hostnames', 'volatile', 'include']);

/** 정규식 메타문자를 이스케이프한다. */
const reEscape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** UDP 프리셋 — 값을 틀리면 세션이 안 닫히거나 조기에 닫힌다 (§4.1). */
const UDP_PRESETS: Record<UdpPreset, { responses?: number; timeoutS: number; reuseport: boolean }> = {
  dns: { responses: 1, timeoutS: 5, reuseport: true },
  wireguard: { timeoutS: 180, reuseport: true },
  game_generic: { timeoutS: 60, reuseport: true },
  custom: { timeoutS: 600, reuseport: false },
};

/**
 * `listen` 인자.
 *
 * 잘못된 bind 는 여기 도달하지 않는다 — `validateModel` 이 먼저 막는다. 도달했다면
 * 검증을 건너뛴 것이므로 조용히 와일드카드로 바꾸지 않고 던진다 (4차 검수 Critical).
 *
 * IPv6 는 `ipv6only=on` 을 **명시**한다. 그게 nginx 기본값이지만(E30), 겹침 판정이 그
 * 가정 위에 서 있으므로 산출물이 가정을 드러내야 한다.
 */
function listenArgs(l: Listener): ConfValue[] {
  const bind = normalizeBind(l.bind);
  if (!bind.ok) {
    throw new Error(`검증되지 않은 bind 가 렌더에 도달했다: ${l.key} → ${JSON.stringify(l.bind)}`);
  }
  const base: ConfValue[] = bind.value.wildcard
    ? [num(l.port)]
    : bind.value.family === 'v6'
      ? [lit(`[${bind.value.addr}]:${l.port}`), lit('ipv6only=on')]
      : [lit(`${bind.value.addr}:${l.port}`)];
  // udp 는 PROXY 수신을 지원하지 않는다 (§4.7). **타입에 그 필드가 없다** — 먼저 좁힌다.
  if (l.protocol !== 'udp' && l.acceptProxyProtocol !== undefined) base.push(lit('proxy_protocol'));
  return base;
}

function algorithmDirectives(pool: Pool, sourceIpVar: string): ConfNode[] {
  switch (pool.algorithm) {
    case 'round_robin':
      return [];
    case 'source_ip_hash':
      // E1 — stream 에는 ip_hash 디렉티브가 없다.
      return pool.protocolClass === 'http'
        ? [directive('ip_hash', [])]
        : [directive('hash', [variable(sourceIpVar), lit('consistent')])];
    case 'hash':
      return [directive('hash', [variable(hashVariable(pool)), lit('consistent')])];
  }
}

/**
 * 해시 변수명은 **검증기가 정한 것을 그대로 쓴다.** 렌더가 따로 해석하면 검증기와 결론이
 * 갈려 `$cookie_sid-token` 같은 무효 변수가 나간다 (4차 검수).
 */
function hashVariable(pool: Pool): string {
  const parsed = parseHashKey(pool.protocolClass, pool.hashKey ?? 'remote_addr');
  if (!parsed.ok) {
    throw new Error(`검증되지 않은 hash_key 가 렌더에 도달했다: ${pool.key} → ${pool.hashKey}`);
  }
  return parsed.value.variable;
}

function upstreamBlock(pool: Pool, backends: Backend[], sourceIpVar: string): ConfNode {
  const servers = byKey(backends).map((b) => {
    const args: ConfValue[] = [lit(endpoint(b.host, b.port))];
    if (b.weight !== 1) args.push(lit(`weight=${b.weight}`));
    return directive('server', args);
  });
  return block('upstream', [lit(upstreamName(pool.key))], [
    ...algorithmDirectives(pool, sourceIpVar),
    ...servers,
  ]);
}

/**
 * **멤버십 평면 upstream** — 백엔드 목록이 conf 가 아니라 shared dict 에 산다 (§7.3 · S1).
 *
 * 정적 `server` 줄과의 차이는 성능이 아니라 **계약**이다. 정적이면 백엔드가 바뀔 때마다
 * 세대 전환 + reload 가 필요하고, 여기서는 dict 만 바뀌면 다음 연결부터 반영된다.
 * S1 이 HTTP·TCP·UDP 세 서브시스템 전부에서 reload 0 회로 실증했다.
 *
 * 세 가지가 중요하다.
 *
 *   1. **자기 epoch 의 슬롯만 본다** (§6.5-1). `_G.BARY_EPOCH` 는 세대의 admin 조각에
 *      구워진다 — 렌더러가 굽지 않는 이유는 `render_digest` 가 모델만의 함수여야 하기
 *      때문이다. 이게 있어야 HUP 뒤에도 옛 워커가 E-old 를 계속 쓴다 (§6.5-5).
 *   2. **슬롯이 없으면 503 으로 끊는다.** 조용히 옛 peer 로 흐르면 §6.5-3 이 막으려던
 *      바로 그 상태가 된다 — staging 되지 않은 세대가 트래픽을 받는다.
 *   3. `server 0.0.0.1:1` 은 **자리표시**다. nginx 는 upstream 에 최소 하나의 server 를
 *      요구하고, `balancer_by_lua` 가 매 연결마다 그것을 대체한다.
 */
function membershipUpstream(pool: Pool, plane: 'http' | 'stream'): ConfNode {
  const dict = MEMBERSHIP_DICT[plane];
  // 풀마다 자기 키를 본다. 한 dict 에 여러 풀이 들어가므로 키에 풀 이름이 필요하다.
  const name = upstreamName(pool.key);
  const slotKey = `slot:${name}:`;
  return block('upstream', [lit(name)], [
    directive('server', [lit('0.0.0.1:1')]),
    lua('balancer_by_lua_block', `
            local balancer = require "ngx.balancer"
            local d = ngx.shared.${dict}
            local peers = d:get("${slotKey}" .. (_G.BARY_EPOCH or "0"))
            if not peers or peers == "" then return ngx.exit(ngx.ERROR) end
            local list = {}
            for hp in peers:gmatch("[^,]+") do list[#list + 1] = hp end
            local n = #list
            ${pickExpression(pool)}
            local h, p = list[idx]:match("^(.*):(%d+)$")
            assert(balancer.set_current_peer(h, tonumber(p)))
        `),
  ]);
}

/**
 * 밸런싱 알고리즘을 Lua 로 옮긴다.
 *
 * **처음엔 `math.random` 하나로 뒀다가 테스트가 잡았다.** 멤버십 평면이 켜지면 upstream 이
 * `balancer_by_lua_block` 이 되면서 `ip_hash`/`hash` 디렉티브가 산출물에서 통째로
 * 사라지는데, 모델은 여전히 `source_ip_hash` 를 표현할 수 있었다 — **필드는 있는데
 * 아무도 안 지키는** 상태였다. 이 저장소가 반복해서 잡아 온 바로 그 부류다.
 *
 * | 알고리즘 | 정적 `server` 줄 | 멤버십 평면 |
 * |---|---|---|
 * | `round_robin` | 엔진 기본 | dict 카운터 — **워커 간 공유**다. 워커 로컬로 두면 워커 수만큼 편향된다 |
 * | `source_ip_hash` | `ip_hash` / `hash $remote_addr` | `crc32($remote_addr) % n` |
 * | `hash <key>` | `hash $<var> consistent` | `crc32($<var>) % n` |
 *
 * **consistent hashing 은 아니다.** 정적 경로의 `consistent` 는 peer 가 바뀔 때 재매핑을
 * 최소화하는데, 여기 `% n` 은 목록이 바뀌면 거의 전부 재매핑된다. 멤버십이 자주 바뀌는
 * 것이 이 평면의 이유이므로 **이건 실제로 다른 계약이다** — S15(밸런서 품질)가 잴 축이고,
 * 지금은 그 사실을 여기 적어 둔다.
 */
function pickExpression(pool: Pool): string {
  if (pool.algorithm === 'round_robin') {
    // dict 카운터. `incr` 은 원자적이라 워커가 여럿이어도 순서가 섞이지 않는다.
    return `local c = d:incr("rr:${upstreamName(pool.key)}", 1, 0) or 1
            local idx = (c % n) + 1`;
  }
  const variable = pool.algorithm === 'source_ip_hash' ? 'remote_addr' : hashVariable(pool);
  return `local key = ngx.var.${variable} or ""
            local idx = (ngx.crc32_short(key) % n) + 1`;
}

// ─────────────────────────────────────────────────────────────── http ───────

/**
 * HTTP server 블록 — **호스트 하나에 블록 하나**.
 *
 * v3 은 라우트의 호스트 배열을 통째로 묶어 `server_name a b;` 를 냈고, 컴파일러에는
 * `hosts[0]` 만 넘겼다. 두 문제가 있었다.
 *   · 배열이 부분적으로 겹치면(`[a,b]` 와 `[b,c]`) nginx 는 **경고만 내고 첫 블록에 준다**
 *     (E36). `nginx -t` 는 통과하므로 조용한 오동작이다. → 모델이 막는다 (validateModel).
 *   · 호스트마다 매치 클래스가 다를 수 있는데 하나만 보고 순서를 정했다.
 * 호스트를 독립 단위로 펼치면 둘 다 사라진다.
 */
function httpServerBlocks(
  listener: HttpListener,
  routes: HttpRoute[],
  poolsWithBackends: Set<string>,
): ConfNode[] {
  // (호스트, 라우트) 쌍으로 펼친다.
  const byHost = new Map<string, HttpRoute[]>();
  for (const r of byKey(routes)) {
    for (const h of r.hosts) {
      const list = byHost.get(h) ?? [];
      list.push(r);
      byHost.set(h, list);
    }
  }

  const out: ConfNode[] = [];
  for (const host of [...byHost.keys()].sort()) {
    const hostRoutes = byHost.get(host)!;
    const parsed = parseHostPattern(host);
    if (!parsed.ok) continue; // validateModel 이 이미 막았다

    const inputs: RouteInput[] = hostRoutes.map((r) =>
      r.pathPrefix === undefined
        ? { key: r.key, host, priority: r.priority }
        : { key: r.key, host, priority: r.priority, pathPrefix: r.pathPrefix },
    );
    const compiled = compileHostRoutes(inputs);
    const ordered =
      compiled.errors.length > 0
        ? hostRoutes
        : compiled.order.map((c) => hostRoutes.find((r) => r.key === c.key)!);

    const locations: ConfNode[] = [];
    for (const r of ordered) {
      const body = locationBody(r, poolsWithBackends);
      if (body.length > 0) locations.push(block('location', [lit(r.pathPrefix ?? '/')], body));
    }
    if (locations.length === 0) continue;

    // E22.2/E35 — nginx 의 `*.example.com` 은 다중 라벨을 삼킨다. X.509 와일드카드는
    // 한 라벨만 보장하므로, 계약대로 **앵커 정규식**으로 낸다. 패스스루와 같은 규칙이다.
    const nameArg: ConfValue =
      parsed.value.kind === 'exact'
        ? lit(parsed.value.host)
        : regex(`~^[^.]+\\.${parsed.value.suffix.replace(/\./g, '\\.')}$`);

    out.push(
      block('server', [], [
        directive('listen', listenArgs(listener)),
        directive('server_name', [nameArg]),
        ...realipNodes(listener),
        ...locations,
      ]),
    );
  }
  return out;
}

/** 라우트 액션 하나를 location 본문으로. */
function locationBody(r: HttpRoute, poolsWithBackends: Set<string>): ConfNode[] {
  const body: ConfNode[] = [];
  switch (r.action.kind) {
    case 'proxy': {
      if (!poolsWithBackends.has(r.action.pool)) return [];
      body.push(directive('proxy_pass', [lit(`http://${upstreamName(r.action.pool)}`)]));
      body.push(directive('proxy_set_header', [lit('Host'), variable('host')]));
      body.push(
        directive('proxy_set_header', [lit('X-Forwarded-For'), variable('proxy_add_x_forwarded_for')]),
      );
      body.push(directive('proxy_set_header', [lit('X-Forwarded-Proto'), variable('scheme')]));
      body.push(directive('proxy_http_version', [lit('1.1')]));
      if (r.action.websocket) {
        body.push(directive('proxy_set_header', [lit('Upgrade'), variable('http_upgrade')]));
        body.push(directive('proxy_set_header', [lit('Connection'), variable('connection_upgrade')]));
      }
      break;
    }
    case 'redirect':
      body.push(directive('return', [num(r.action.status), lit(r.action.to)]));
      break;
    case 'reject':
      body.push(directive('return', [num(r.action.status)]));
      break;
  }
  return body;
}

/**
 * 명시적 `default_server`.
 *
 * E32 로 실측: 없으면 모르는 Host 가 **첫 번째 server 블록**으로 조용히 들어간다.
 * 멀티테넌트에서 그건 테넌트 간 누수다. 기본은 `444`(응답 없이 끊기)로 막는다.
 */
/**
 * 신뢰 경계 (§4.7 · E63).
 *
 * `listen ... proxy_protocol` 만으로는 **누구의 헤더든 받는다.** 실제로 게이팅하는 것은
 * realip 이고, 신뢰 목록에 없는 peer 가 보낸 헤더는 `$remote_addr` 를 못 바꾼다. 그래서
 * 이 둘은 **함께** 나가야 한다 — 하나만 내면 스위치는 켜졌는데 잠금이 없다.
 *
 * **capability 로 분기하지 않는다.** 엔진에 realip 모듈이 없으면 이 설정은 `nginx -t` 에서
 * 실패하고, 그 실패는 게시 **전에** 잡힌다(§6.2 preflight). 조용히 열등한 대체물로
 * 물러나는 것보다 낫다 — 전에 그렇게 하다가 스푸핑 가능한 변수로 해시하고 있었다.
 */
function realipNodes(listener: Listener): ConfNode[] {
  const pp = listener.protocol === 'udp' ? undefined : listener.acceptProxyProtocol;
  if (pp === undefined) return [];
  return [
    ...pp.trustedCidrs.map((cidr) => directive('set_real_ip_from', [lit(cidr)])),
    // **`real_ip_header` 는 http 전용이다.** stream 의 realip 모듈에는 그 디렉티브가
    // 아예 없고, 넣으면 `"real_ip_header" directive is not allowed here` 로 기동이
    // 깨진다. stream 에서는 PROXY 가 유일한 출처라 선언할 것이 없다 — `set_real_ip_from`
    // 만으로 게이트가 그대로 성립한다(E63.5·E63.6 으로 실측).
    //
    // 처음엔 양쪽에 똑같이 냈다가 공식 nginx e2e 가 잡았다. OpenResty 이미지에는
    // stream_realip 이 없어 그 조합이 애초에 검증기에 막히므로 **기본 이미지로는
    // 영원히 안 드러나는 자리**였다.
    ...(listener.protocol === 'http'
      ? [directive('real_ip_header', [lit('proxy_protocol')])]
      : []),
  ];
}

function defaultServerBlock(listener: HttpListener, poolsWithBackends: Set<string>): ConfNode {
  const action = listener.http?.defaultAction ?? 'reject';
  const body: ConfNode[] =
    action !== 'reject' && poolsWithBackends.has(action.pool)
      ? [
          block('location', [lit('/')], [
            directive('proxy_pass', [lit(`http://${upstreamName(action.pool)}`)]),
            directive('proxy_set_header', [lit('Host'), variable('host')]),
          ]),
        ]
      : [directive('return', [num(444)])];

  return block('server', [], [
    directive('listen', [...listenArgs(listener), lit('default_server')]),
    directive('server_name', [lit('_')]),
    ...realipNodes(listener),
    ...body,
  ]);
}

// ───────────────────────────────────────────────────────────── stream ───────

/** SNI 결과를 map 값으로 바꾼다. reject 는 빈 값 → proxy_pass 가 실패하고 연결이 끊긴다. */
function outcomeValue(outcome: SniOutcome | undefined, poolsWithBackends: Set<string>): ConfValue {
  if (outcome === undefined || outcome === 'reject') return lit('');
  if (!poolsWithBackends.has(outcome.pool)) return lit('');
  return lit(upstreamName(outcome.pool));
}

function passthroughNodes(
  listener: PassthroughListener,
  routes: PassthroughRoute[],
  poolsWithBackends: Set<string>,
): ConfNode[] {
  const sniVar = `bary_sni_${ident(listener.key)}`;

  // SNI 하나하나를 독립 매치로 펼친 뒤 컴파일 순서를 따른다.
  const inputs: RouteInput[] = [];
  const owner = new Map<string, PassthroughRoute>();
  for (const r of byKey(routes)) {
    r.snis.forEach((sni, i) => {
      const key = `${r.key}#${i}`;
      inputs.push({ key, host: sni, priority: r.priority });
      owner.set(key, r);
    });
  }
  const compiled = compileHostRoutes(inputs);

  const entries: ConfNode[] = [];
  for (const c of compiled.order) {
    const route = owner.get(c.key)!;
    const target =
      route.action.kind === 'proxy' && poolsWithBackends.has(route.action.pool)
        ? lit(upstreamName(route.action.pool))
        : lit('');
    const match: ConfValue =
      c.pattern.kind === 'exact'
        ? // E33 — map 제어어와 겹치는 호스트는 인용해도 제어어로 해석된다.
          // 앵커 정규식으로 내야 리터럴로 매칭된다.
          MAP_KEYWORDS.has(c.pattern.host)
          ? regex(`~^${reEscape(c.pattern.host)}$`)
          : lit(c.pattern.host)
        : // E21 — SNI 는 대소문자를 구분하지 않으므로 ~* 여야 한다.
          // [^.]+ 로 한 라벨만 매치한다: nginx 와일드카드는 다중 라벨을 삼키지만(E22.2)
          // X.509 와일드카드는 한 라벨만 보장한다. 넓게 잡으면 인증서 오선택이 된다.
          regex(`~*^[^.]+\\.${c.pattern.suffix.replace(/\./g, '\\.')}$`);
    entries.push(entry(match, target));
  }

  // SNI 가 없으면(비-TLS·파싱 실패 포함) 빈 값 → proxy_pass 실패 → 연결 종료.
  // §4.1 — 이건 설정 대상이 아니다. 설정 가능한 폴백으로 보내면 SNI 를 안 보내는
  // 클라이언트가 조용히 임의 백엔드에 닿는다.
  entries.push(entry(lit(''), lit('')));
  entries.push(entry(lit('default'), outcomeValue(listener.onUnmatchedSni, poolsWithBackends)));

  const sniMap = block('map', [variable('ssl_preread_server_name'), variable(sniVar)], entries);

  const server = block('server', [], [
    directive('listen', listenArgs(listener)),
    ...realipNodes(listener),
    directive('ssl_preread', [lit('on')]),
    ...(listener.prereadTimeoutS === undefined
      ? []
      : [directive('preread_timeout', [lit(`${listener.prereadTimeoutS}s`)])]),
    directive('proxy_pass', [variable(sniVar)]),
  ]);

  return [sniMap, server];
}

function streamServerBlock(listener: TcpListener | UdpListener, pool: Pool | undefined): ConfNode {
  const children: ConfNode[] = [];
  const isUdp = listener.protocol === 'udp';
  const preset = isUdp ? UDP_PRESETS[listener.udp?.preset ?? 'custom'] : undefined;

  const args = listenArgs(listener);
  if (isUdp) {
    args.push(lit('udp'));
    if (preset?.reuseport) args.push(lit('reuseport'));
  }
  children.push(directive('listen', args));
  children.push(...realipNodes(listener));
  children.push(directive('proxy_pass', [lit(upstreamName(listener.defaultPool))]));

  if (preset) {
    if (preset.responses !== undefined) {
      children.push(directive('proxy_responses', [num(preset.responses)]));
    }
    children.push(directive('proxy_timeout', [lit(`${preset.timeoutS}s`)]));
  }
  if (pool?.sendProxyProtocol === 'v1') {
    // §4.7 — stock nginx 는 업스트림으로 v1 만 보낸다. 버전 선택 디렉티브가 없다.
    children.push(directive('proxy_protocol', [lit('on')]));
  }
  return block('server', [], children);
}

// ──────────────────────────────────────────────────────────── render ───────

export function render(model: Model, caps: RenderCapabilities = CONSERVATIVE): RenderedConfig {
  // fail closed. 검증 실패를 렌더가 흡수하면 의미가 바뀐다 (4차 검수 Critical).
  //
  // **해독을 여기서도 한 번 더 한다.** 타입이 `Model` 이라는 것은 컴파일 타임의 약속일
  // 뿐이고, JSON 에서 온 값을 캐스팅해 넣으면 그 약속은 없는 것과 같다. 6차 검수가
  // `protocol: 'https'` 로 평문 설정을 만들어 낸 경로가 정확히 그것이었다.
  const decoded = decodeModel(model);
  if (!decoded.ok) throw new ModelValidationError(decoded.issues);

  const issues = validateModel(model, { streamRealip: caps.streamRealip });
  if (issues.length > 0) throw new ModelValidationError(issues);

  const pools = new Map(model.pools.map((p) => [p.key, p]));
  const backendsByPool = new Map<string, Backend[]>();
  for (const b of model.backends) {
    const list = backendsByPool.get(b.pool);
    if (list) list.push(b);
    else backendsByPool.set(b.pool, [b]);
  }
  const poolsWithBackends = new Set(
    [...backendsByPool.entries()].filter(([, bs]) => bs.length > 0).map(([k]) => k),
  );

  const listeners = byKey(model.listeners).filter((l) => l.enabled);

  /**
   * 소스IP 해시는 **언제나 `$remote_addr`** 다.
   *
   * 전에는 `stream_realip` 이 없을 때 `$proxy_protocol_addr` 로 바꿔 렌더했다. 실 클라이언트
   * IP 를 준다는 게 이유였고 그 말 자체는 참이다 — **다만 그 값은 클라이언트가 정한다.**
   * E63 으로 실측했다: `$proxy_protocol_addr` 는 realip 설정과 무관하게 **언제나 헤더가
   * 말하는 값**이고, 신뢰 경계는 오직 realip 을 거친 `$remote_addr` 에만 걸린다.
   *
   * 그래서 그 변수로 해시하면 **클라이언트가 자기를 원하는 백엔드로 몬다.** 실 클라이언트
   * 기준이 되는 대신 공격자 기준이 된 셈이었다.
   *
   * 지금은 `set_real_ip_from` 을 함께 렌더해 `$remote_addr` 자체를 옳게 만든다. 엔진이
   * 그걸 못 하는 경우(stream 인데 `stream_realip` 없음)는 **검증기가 막는다** — 렌더러가
   * 조용히 열등한 대체물을 고르지 않는다.
   */
  const httpListeners = listeners.filter((l): l is HttpListener => l.protocol === 'http');
  const streamListeners = listeners.filter(
    (l): l is PassthroughListener | TcpListener | UdpListener => l.protocol !== 'http',
  );

  const top: ConfNode[] = [block('events', [], [directive('worker_connections', [num(1024)])])];

  /**
   * **세대에 결박된 admin 조각을 끌어들인다** (§7.2 레이아웃의 `http/admin.conf`).
   *
   * §6.3 은 활성화를 *세대별 렌더 리터럴*로 판정하라고 한다 — S7 의 A4.3 이 shared dict
   * 마커로는 "누가 응답했는가" 를 말할 수 없음을 실측했다. 그러려면 세대마다 다른
   * 리터럴이 conf 안에 있어야 하는데, 그 리터럴은 **모델의 일부가 아니다.**
   *
   * 그래서 렌더러는 자리만 낸다. 세대 번호를 `render()` 인자로 받으면 *같은 모델 → 같은
   * digest* 가 깨지고, plan 이 렌더러 드리프트를 잡는 근거가 사라진다.
   *
   * 상대경로인 것이 핵심이다. `include` 는 `ssl_certificate` 와 똑같이 **conf_prefix**
   * (= conf 파일이 있는 디렉토리) 기준으로 풀린다 — 실측했다(E62). 그래서
   *   · `-c current/nginx.conf`         → 활성 세대의 admin
   *   · `-t -c generations/N/nginx.conf` → 그 세대 자신의 admin (게시 전 검증)
   * 양쪽 모두 자기 세대를 가리킨다. prefix(`-p`) 쪽에 같은 이름을 둬도 안 읽힌다.
   *
   * 빈 glob 도 통과하므로(E62) admin 조각이 없는 세대도 유효하다.
   */
  const adminInclude = directive('include', [lit('admin/*.conf')]);


  // ── http ──
  // **http 블록은 항상 낸다.** 모델에 http 리스너가 없어도 마커를 서빙할 자리가
  // 필요하다 — 활성화를 증명하지 못하면 apply 가 좌표를 못 옮긴다. 이건 v0.1 의
  // 명시적 선택이다: **데이터 플레인은 언제나 admin http 서버를 띄운다.**
  //
  // `planes` 는 그대로 모델에서 나온다. admin 블록은 상태 평면을 구성하지 않는다 —
  // 세대마다 마커 리터럴만 다르고 좌표도 멤버십도 안 든다.
  {
    const routesByListener = new Map<string, HttpRoute[]>();
    for (const r of model.httpRoutes) {
      const list = routesByListener.get(r.listener);
      if (list) list.push(r);
      else routesByListener.set(r.listener, [r]);
    }

    const usedPools = new Set<string>();
    let anyWebsocket = false;
    for (const l of httpListeners) {
      const da = l.http?.defaultAction;
      if (da !== undefined && da !== 'reject' && poolsWithBackends.has(da.pool)) usedPools.add(da.pool);
      for (const r of routesByListener.get(l.key) ?? []) {
        if (r.action.kind !== 'proxy') continue;
        if (!poolsWithBackends.has(r.action.pool)) continue;
        usedPools.add(r.action.pool);
        if (r.action.websocket) anyWebsocket = true;
      }
    }

    const children: ConfNode[] = [adminInclude];
    // **멤버십 평면의 zone.** 평면마다 다른 이름이어야 한다 (E14).
    if (caps.httpLua === true) {
      children.unshift(directive('lua_shared_dict', [lit(MEMBERSHIP_DICT.http), lit('1m')]));
    }
    // E7 — 내장 변수가 아니므로 반드시 함께 렌더한다. 그리고 정확히 한 번만.
    if (anyWebsocket) {
      children.push(
        block('map', [variable('http_upgrade'), variable('connection_upgrade')], [
          entry(lit('default'), lit('upgrade')),
          entry(lit(''), lit('close')),
        ]),
      );
    }
    for (const poolKey of [...usedPools].sort()) {
      children.push(caps.httpLua === true
        ? membershipUpstream(pools.get(poolKey)!, 'http')
        : upstreamBlock(pools.get(poolKey)!, backendsByPool.get(poolKey) ?? [], 'remote_addr'));
    }
    for (const l of httpListeners) {
      children.push(defaultServerBlock(l, poolsWithBackends));
      children.push(
        ...httpServerBlocks(l, routesByListener.get(l.key) ?? [], poolsWithBackends),
      );
    }
    top.push(block('http', [], children));
  }

  // ── stream ──
  //
  // **`streamLua` 가 켜지면 리스너가 없어도 블록을 낸다.** 멤버십 dict 가 여기 살고,
  // §6.5-1 은 HUP **전에** 적재하라고 한다 — 그 시점에 도는 것은 옛 세대이므로 dict 가
  // 거기 이미 있어야 한다. 부트스트랩(빈 모델)에 stream 블록이 없으면 첫 stream apply 가
  // 쓸 곳을 못 찾는다. http 블록을 항상 내는 것과 같은 이유다.
  if (streamListeners.length > 0 || caps.streamLua === true) {
    const ptByListener = new Map<string, PassthroughRoute[]>();
    for (const r of model.passthroughRoutes) {
      const list = ptByListener.get(r.listener);
      if (list) list.push(r);
      else ptByListener.set(r.listener, [r]);
    }

    const usedPools = new Set<string>();
    for (const l of streamListeners) {
      if (l.protocol === 'tls_passthrough') {
        for (const r of ptByListener.get(l.key) ?? []) {
          if (r.action.kind === 'proxy' && poolsWithBackends.has(r.action.pool)) {
            usedPools.add(r.action.pool);
          }
        }
        const o = l.onUnmatchedSni;
        if (o !== undefined && o !== 'reject' && poolsWithBackends.has(o.pool)) {
          usedPools.add(o.pool);
        }
      } else if (poolsWithBackends.has(l.defaultPool)) {
        // tcp·udp 는 기본 풀이 **필수**다 (타입이 강제한다). undefined 검사가 필요 없다.
        usedPools.add(l.defaultPool);
      }
    }

    const children: ConfNode[] = [];
    if (caps.streamLua === true) {
      children.push(directive('lua_shared_dict', [lit(MEMBERSHIP_DICT.stream), lit('1m')]));
      // stream 에도 세대별 admin 조각을 끌어들인다 — epoch 리터럴이 거기 산다.
      children.push(directive('include', [lit('stream-admin/*.conf')]));
    }
    for (const poolKey of [...usedPools].sort()) {
      children.push(caps.streamLua === true
        ? membershipUpstream(pools.get(poolKey)!, 'stream')
        : upstreamBlock(pools.get(poolKey)!, backendsByPool.get(poolKey) ?? [], 'remote_addr'));
    }
    for (const l of streamListeners) {
      if (l.protocol === 'tls_passthrough') {
        children.push(...passthroughNodes(l, ptByListener.get(l.key) ?? [], poolsWithBackends));
      } else if (poolsWithBackends.has(l.defaultPool)) {
        children.push(streamServerBlock(l, pools.get(l.defaultPool)));
      }
    }
    if (children.length > 0) top.push(block('stream', [], children));
  }

  const conf = serialize(top);
  const digest = createHash('sha256').update(conf, 'utf8').digest('hex');
  const planes: ('http' | 'stream')[] = [];
  if (httpListeners.length > 0) planes.push('http');
  if (streamListeners.length > 0) planes.push('stream');
  return { conf, digest, planes };
}

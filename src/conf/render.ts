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
import { coversHost, parseHostPattern } from '../validate/strings.js';
import { parseRef } from '../dp/secrets.js';
import { ModelValidationError, validateModel } from '../validate/model.js';
import { decodeModel } from '../model/decode.js';
import { parseHashKey } from '../validate/strings.js';
import { normalizeBind } from '../validate/sockets.js';
import type {
  HttpListener,
  HttpsListener,
  PassthroughListener,
  TcpListener,
  UdpListener,
  Backend,
  HttpRoute,
  Listener,
  Model,
  PassthroughRoute,
  Certificate,
  CipherPolicyRef,
  HstsPolicy,
  Pool,
  SniCertificateBinding,
  SniOutcome,
  TlsPolicy,
  TlsVersion,
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
  /** `ssl_conf_command` — TLS1.3 ciphersuite 를 정하는 유일한 길 (§4.6). */
  sslConfCommand?: boolean;
  /**
   * `http2 on;` 을 낼 수 있는가 (§4.9 · §7.6).
   *
   * `ngx_http_v2_module` **과** core 1.25.1+ 가 함께 필요하다 — 그 전 문법은
   * `listen ... http2` 라 리스너 단위였고, 지금 규칙(server 별)이 성립하지 않는다.
   *
   * **없으면 안 낸다.** 켜 달라고 명시했는데 못 내는 경우는 검증기가 막는다 —
   * 조용히 무시하면 "켰는데 h2 가 안 나온다" 가 되고, 그건 이 저장소가 반복해서
   * 잡아온 모양이다.
   */
  http2?: boolean;
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

/**
 * ACME http-01 챌린지 토큰이 사는 곳 (§8.2).
 *
 * **왜 dict 인가 — reload 를 피하려고.** 챌린지 토큰은 주문마다 바뀌는데, 그걸 conf 에
 * 실으면 **인증서 갱신 한 번에 세대 전환이 한 번** 붙는다. 이 저장소는 그 대가를
 * 실측해 뒀다: 세대 전환당 트래픽 2.6% 손실. 인증서가 여럿이면 갱신 주기마다 그게
 * 곱해진다.
 *
 * 멤버십 평면이 백엔드에 대해 푼 문제와 같은 문제이고, 같은 수법으로 푼다 (S1).
 */
export const ACME_DICT = 'bary_acme';

/**
 * ACME http-01 이 쓰는 경로 (RFC 8555 §8.3). **바꿀 수 없다** — CA 가 여기로 온다.
 */
export const ACME_PREFIX = '/.well-known/acme-challenge/';

/** SNI↔Host 불일치 판정을 담는 변수 (§4.6). */
const SNI_MISMATCH_VAR = 'bary_sni_mismatch';

/**
 * SNI 와 Host 가 다른지 판정하는 map (§4.6).
 *
 * **`if` 안에서 문자열 둘을 비교할 방법이 없어서** map 을 쓴다. nginx 의 `if` 는 변수
 * 하나만 보므로, 두 값을 `:` 로 이어 붙여 정규식 역참조로 같은지 본다.
 *
 * 세 경우를 실측했다:
 *
 * | 입력 | 결과 | 왜 |
 * |---|---|---|
 * | `Host: a.test:443` | 통과 | `$host` 가 **포트를 뗀다** |
 * | `Host: A.TEST` | 통과 | `$host` 가 **소문자로 내린다** |
 * | SNI 없음 | 통과 | 비교할 것이 없다 — 여기서 막으면 SNI 를 안 보내는 옛 클라이언트가 끊긴다 |
 */
function sniMismatchMap(): ConfNode {
  return block('map', [lit('$ssl_server_name:$host'), variable(SNI_MISMATCH_VAR)], [
    entry(lit('default'), lit('1')),
    // SNI 가 비어 있으면 비교 불가 — 통과시킨다.
    entry(lit('~^:'), lit('0')),
    // 역참조로 "앞과 뒤가 같다" 를 본다.
    entry(lit('~^(.+):\\1$'), lit('0')),
  ]);
}

/**
 * 불일치면 421. RFC 7540 §9.1.1 이 정한 답이다.
 *
 * **`if` 는 괄호를 요구한다** — `variable()` 은 `$x` 만 내므로 `if $x {` 가 되고 nginx 가
 * 거절한다. 인용되면 안 되므로 `regex()`(그대로 내는 노드)로 괄호째 낸다.
 */
function sniMismatchGuard(): ConfNode {
  return block('if', [lit(`($${SNI_MISMATCH_VAR})`)], [directive('return', [num(421)])]);
}

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
  if (l.protocol === 'https') base.push(lit('ssl'));
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
            local peer = list[idx]
            local h, p = peer:match("^(.*):(%d+)$")
            assert(balancer.set_current_peer(h, tonumber(p)))
            ngx.ctx.bary_peer = peer
            d:incr("in:" .. peer, 1, 0)
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
  listener: HttpListener | HttpsListener,
  routes: HttpRoute[],
  poolsWithBackends: Set<string>,
  tls: TlsContext | undefined,
  acme: boolean,
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

    // S16 — 인증서와 정책은 **이 server 블록 안**에 낸다. 그래야 SNI 별로 갈린다.
    const tlsBody = tls === undefined ? [] : (() => {
      const c = certFor(host, tls.listener, tls.bindings, tls.policy, tls.certs);
      return [
        ...tlsNodes(c.cert, c.min, c.max),
        ...cipherNodes(tls.cipher, tls.confCommand),
        ...(tls.hsts === undefined ? [] : [hstsNode(tls.hsts)]),
        ...(tls.http2 ? [http2Node()] : []),
        // ⚠️ **`if` 는 rewrite 단계다** — location 선택보다 **앞**이다(§7.x 에서
        // `return 444` 로 한 번 물렸다). 그래서 이 가드가 걸리면 같은 server 의 어떤
        // location 도 안 돈다. ACME 예약 라우트를 포함해서.
        //
        // 그래도 문제가 안 되는 이유: http-01 검증은 **평문 80 포트**로 오고(CA 가
        // 리다이렉트를 따라와 TLS 로 붙는 경우에도 SNI 와 Host 가 같다), 이 가드는
        // **불일치일 때만** 걸린다. 일치하는 요청은 그대로 location 으로 간다.
        ...(tls.rejectMismatch ? [sniMismatchGuard()] : []),
      ];
    })();

    out.push(
      block('server', [], [
        directive('listen', listenArgs(listener)),
        directive('server_name', [nameArg]),
        ...tlsBody,
        ...realipNodes(listener),
        ...(acme ? [acmeChallengeLocation()] : []),
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
    //
    // **`http` 가 아니라 http *컨텍스트* 가 기준이다.** 처음엔 `protocol === 'http'` 로
    // 적었고, 그래서 **https 리스너에 `set_real_ip_from` 만 나갔다** — nginx 의 기본
    // `real_ip_header` 는 `X-Real-IP` 이므로 PROXY 주소가 아니라 앞단이 넘긴 HTTP 헤더가
    // `$remote_addr` 가 된다. 신뢰 경계를 걸었다고 믿으면서 클라이언트가 정하는 값으로
    // 해시하고 XFF 를 쌓고 있었다 (검수 S-02).
    ...(listener.protocol === 'http' || listener.protocol === 'https'
      ? [directive('real_ip_header', [lit('proxy_protocol')])]
      : []),
  ];
}

/**
 * 세대 안에서의 인증서 경로. §7.2 · §4.8 · S8
 *
 * **conf_prefix 상대경로다.** `ssl_certificate` 는 `include` 와 마찬가지로 conf 파일이
 * 있는 디렉토리 기준으로 풀린다(E62). 그래서 `current/nginx.conf` 로 띄우든 게시 전
 * `generations/N/nginx.conf` 를 `nginx -t` 하든 **자기 세대의 자료**를 가리킨다.
 *
 * ── 경로에 버전이 들어가는 이유 ─────────────────────────────────────────
 *
 * 처음엔 `certs/<key>/` 였다. 그러면 **인증서를 갱신해도 렌더 산출물이 글자 하나 안
 * 바뀐다** — 경로가 같고 conf 의 나머지도 같으니 digest 가 동일하다. 그리고 apply 는
 * "산출물이 안 바뀌었다" 를 멤버십 전용 전환의 근거로 쓰므로(§6.5), **갱신이 세대를
 * 안 만들고 조용히 통과한다.** 옛 인증서가 그대로 제시되는데 apply 는 성공이라고 답한다.
 *
 * e2e 가 정확히 이걸로 걸렸다. 참조는 §4.8 대로 버전 고정이었는데, **그 버전이 렌더까지
 * 내려오지 않아서** 아무 효과가 없었다 — 이 저장소가 반복해서 밟은 *"필드는 있는데
 * 아무도 안 읽는다"* 의 한 판이다.
 *
 * 버전을 경로에 넣으면 갱신이 곧 다른 conf 가 되고, 세대·digest·롤백이 전부 따라온다.
 */
export function certPaths(certKey: string, version: string): { chain: string; key: string } {
  return {
    chain: `certs/${certKey}/${version}/fullchain.pem`,
    key: `certs/${certKey}/${version}/privkey.pem`,
  };
}

const TLS_ORDER: readonly TlsVersion[] = ['1.2', '1.3'];

/**
 * 암호군 정책의 실제 내용 (§4.6).
 *
 * **둘로 갈려 있는 것이 요점이다.** 실측했다 — `ssl_ciphers` 는 TLS1.3 에 **안 걸린다**:
 *
 * ```
 * ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256
 *   → TLS1.2 는 그것,  TLS1.3 은 TLS_AES_256_GCM_SHA384 (전혀 다른 것)
 * ```
 *
 * 그래서 1.3 은 `ssl_conf_command Ciphersuites` 가 따로 정한다. 한 필드로 합쳐 두면
 * "약한 암호를 껐다" 고 믿으면서 1.3 쪽은 손도 안 댄 상태가 된다.
 *
 * `preferServer` 도 갈린다: 목록을 좁게 고른 `modern` 은 클라이언트 선호를 따르는 편이
 * 낫고(둘 다 안전하다), 넓은 `intermediate` 는 서버가 골라야 약한 쪽으로 안 밀린다.
 */
const CIPHER_POLICIES: Record<CipherPolicyRef, {
  ciphers: string; ciphersuites: string; preferServer: boolean;
}> = {
  'modern-2026': {
    // TLS1.2 를 허용하더라도 AEAD + PFS 만 남긴다.
    ciphers: 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:'
      + 'ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:'
      + 'ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305',
    ciphersuites: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256',
    preferServer: false,
  },
  'intermediate-2026': {
    ciphers: 'ECDHE-ECDSA-AES128-GCM-SHA256:ECDHE-RSA-AES128-GCM-SHA256:'
      + 'ECDHE-ECDSA-AES256-GCM-SHA384:ECDHE-RSA-AES256-GCM-SHA384:'
      + 'ECDHE-ECDSA-CHACHA20-POLY1305:ECDHE-RSA-CHACHA20-POLY1305:'
      + 'DHE-RSA-AES128-GCM-SHA256:DHE-RSA-AES256-GCM-SHA384',
    ciphersuites: 'TLS_AES_128_GCM_SHA256:TLS_AES_256_GCM_SHA384:TLS_CHACHA20_POLY1305_SHA256',
    preferServer: true,
  },
};

export const DEFAULT_CIPHER_POLICY: CipherPolicyRef = 'intermediate-2026';

/**
 * HSTS 헤더 (§4.6).
 *
 * ⚠️ **`add_header` 는 상속이 아니라 대체다.** location 에 `add_header` 가 **하나라도**
 * 있으면 상위 server 의 것이 **전부 사라진다.** 실측했다:
 *
 * | 위치 | HSTS |
 * |---|---|
 * | 자기 `add_header` 가 없는 location | 나온다 |
 * | 자기 `add_header` 가 있는 location | **안 나온다** |
 * | 500 응답 (`always` 덕분) | 나온다 |
 *
 * 지금 렌더러는 location 에 `add_header` 를 하나도 안 낸다. **그 사실에 기대고 있다** —
 * 그래서 conformance 가 그 불변식을 지킨다(`tests/conformance/hsts-*`). 응답 헤더 기능을
 * 나중에 라우트에 붙이는 사람은 여기서 걸린다.
 *
 * `always` 가 필요한 이유: 없으면 2xx/3xx 에만 붙는다. 인증서가 깨져 5xx 를 내는 동안
 * HSTS 가 사라지는 것은 **의미가 정반대**다.
 */
function hstsNode(h: HstsPolicy): ConfNode {
  const parts = [`max-age=${h.maxAgeSeconds}`];
  if (h.includeSubdomains === true) parts.push('includeSubDomains');
  if (h.preload === true) parts.push('preload');
  return directive('add_header', [
    lit('Strict-Transport-Security'), lit(parts.join('; ')), lit('always'),
  ]);
}

/**
 * 암호군 디렉티브. **server 별로 낸다** — 실측이다(같은 리스너에서 SNI 별로 다른 암호군이
 * 협상된다). `ssl_protocols`(S16)·`http2`(§4.9)와 같은 자리다.
 */
function cipherNodes(ref: CipherPolicyRef, canConfCommand: boolean): ConfNode[] {
  const p = CIPHER_POLICIES[ref];
  return [
    directive('ssl_ciphers', [lit(p.ciphers)]),
    directive('ssl_prefer_server_ciphers', [lit(p.preferServer ? 'on' : 'off')]),
    // **TLS1.3 은 이것으로만 정해진다.** 엔진이 못 하면 안 낸다 — 그 경우 1.3 은 엔진
    // 기본값을 쓰고, 그 사실은 capability 로 관측된다.
    ...(canConfCommand
      ? [directive('ssl_conf_command', [lit('Ciphersuites'), lit(p.ciphersuites)])]
      : []),
  ];
}

/**
 * min/max 를 `ssl_protocols` 인자들로.
 *
 * **한 문자열이 아니라 인자 배열이다.** `TLSv1.2 TLSv1.3` 을 값 하나로 내면 AST 가
 * 공백 때문에 통째로 인용하고, nginx 는 `invalid value "TLSv1.2 TLSv1.3"` 으로 죽는다.
 * 디렉티브의 인자 수를 문자열 안에 숨기지 않는다.
 */
function sslProtocols(min: TlsVersion, max: TlsVersion | undefined): ConfValue[] {
  const lo = TLS_ORDER.indexOf(min);
  const hi = max === undefined ? TLS_ORDER.length - 1 : TLS_ORDER.indexOf(max);
  return TLS_ORDER.slice(lo, hi + 1).map((v) => lit(`TLSv${v}`));
}

/**
 * 한 server 블록의 TLS 디렉티브. S16 · S17
 *
 * **policy 를 server 블록 안에 낸다.** S16 이 실측했다 — server 레벨이 http 레벨을 덮고,
 * 비-default server 의 값도 실제 handshake 에 걸린다. http 레벨에 한 번만 내면 SNI 별
 * override 가 표시만 하고 마는 거짓말이 된다.
 */
/**
 * `http2 on;` — **server 별로 낸다.**
 *
 * §4.9 가 실측했다: 같은 리스너에서 `a.test`(on) 는 `h2` 를, `b.test`(off) 는
 * `http/1.1` 을 협상한다. `ssl_protocols`(S16)와 같은 성질이고, 그래서 같은 자리에 낸다.
 *
 * http 블록에 한 번만 내는 길도 있지만 안 쓴다 — server 별 재정의가 http 레벨을 덮는지
 * **또 재야 하고**, S16 이 정확히 그 자리에서 한 번 물었다.
 */
function http2Node(): ConfNode {
  return directive('http2', [lit('on')]);
}

function tlsNodes(
  cert: Certificate, min: TlsVersion, max: TlsVersion | undefined,
): ConfNode[] {
  // **자료 없는 인증서가 여기 오면 터진다.** ACME 로 아직 못 받은 인증서를 바인딩하는
  // 것은 검증기가 막는다(`certificate_has_no_material`) — 렌더러가 조용히 빈 경로를
  // 내면 `nginx -t` 가 "파일이 없다" 로 죽고, 원인은 apply 실패로만 보인다.
  if (cert.materialRef === undefined) {
    throw new Error(`자료 없는 인증서가 렌더에 도달했다: '${cert.key}' (ACME 발급 전이다)`);
  }
  const paths = certPaths(cert.key, parseRef(cert.materialRef).version);
  return [
    directive('ssl_certificate', [lit(paths.chain)]),
    directive('ssl_certificate_key', [lit(paths.key)]),
    directive('ssl_protocols', sslProtocols(min, max)),
  ];
}

/** 리스너의 SNI 바인딩에서 이 호스트의 인증서와 버전 범위를 찾는다. */
function certFor(
  host: string,
  listener: HttpsListener,
  bindings: SniCertificateBinding[],
  policy: TlsPolicy,
  certs: Map<string, Certificate>,
): { cert: Certificate; min: TlsVersion; max: TlsVersion | undefined } {
  for (const b of bindings) {
    if (!b.hosts.some((p) => coversHost(p, host))) continue;
    const cert = certs.get(b.certificate);
    if (cert === undefined) {
      throw new Error(`알 수 없는 인증서가 렌더에 도달했다: '${b.certificate}'`);
    }
    return {
      cert,
      min: b.override?.minVersion ?? policy.minVersion,
      // `override.maxVersion` 가 없으면 policy 로 돌아간다. `undefined` 를 "상한 없음"
      // 으로 읽으면 override 가 정책을 **넓히는** 셈이 된다.
      max: b.override?.maxVersion ?? policy.maxVersion,
    };
  }
  // 검증기가 이미 막았다 (`sni_binding_missing`). 여기 오면 렌더러가 인증서를 지어내는
  // 대신 **터진다** — 조용히 default 인증서를 물리면 SAN 미커버 제시가 된다.
  throw new Error(
    `SNI 바인딩 없는 호스트가 렌더에 도달했다: 리스너 '${listener.key}' 의 '${host}'`,
  );
}

/**
 * ACME http-01 예약 라우트 (§8.2).
 *
 * *"시스템 소유 예약 라우트로 렌더되고 사용자가 만들거나 지울 수 없다."* 사용자 라우트가
 * 이 경로를 가로채면 발급이 조용히 실패한다 — 검증기가 그걸 막고(`acme_path_reserved`),
 * 렌더러는 여기서 **`^~`** 로 낸다.
 *
 * **`^~` 인 이유.** nginx 의 location 은 정규식이 접두사보다 먼저 이긴다. 사용자가
 * `location ~ \.well-known` 같은 것을 낼 수 있는 표면은 지금 없지만, `^~` 는 "이 접두사가
 * 맞으면 정규식을 아예 안 본다" 는 뜻이라 **미래의 표면 확장에 대해서도 안전하다.**
 *
 * 토큰이 없으면 404 다. **빈 200 을 주면 안 된다** — CA 는 그걸 "틀린 값" 으로 읽고,
 * 그러면 실패 원인이 "토큰이 없다" 가 아니라 "값이 다르다" 로 보인다.
 */
function acmeChallengeLocation(): ConfNode {
  return block('location', [lit('^~'), lit(ACME_PREFIX)], [
    directive('default_type', [lit('text/plain')]),
    lua('content_by_lua_block', `
      local token = ngx.var.uri:sub(${ACME_PREFIX.length + 1})
      local v = token ~= "" and ngx.shared.${ACME_DICT}:get("tok:" .. token) or nil
      if not v then ngx.status = 404; ngx.print("no challenge"); return end
      ngx.print(v)
    `),
  ]);
}

/** https 렌더에 필요한 문맥. http 리스너에는 `undefined` 다. */
type TlsContext = {
  listener: HttpsListener;
  bindings: SniCertificateBinding[];
  policy: TlsPolicy;
  certs: Map<string, Certificate>;
  /** 이 리스너에 `http2 on;` 을 낼 것인가 (모델의 의도 × 엔진 capability). */
  http2: boolean;
  /** SNI↔Host 불일치를 421 로 막을 것인가 (§4.6). */
  rejectMismatch: boolean;
  /** 암호군 정책과 엔진이 `ssl_conf_command` 를 낼 수 있는가. */
  cipher: CipherPolicyRef;
  confCommand: boolean;
  /** HSTS. 없으면 안 낸다 — 되돌릴 수 없는 설정이라 기본이 꺼짐이다. */
  hsts: HstsPolicy | undefined;
};

const withHttp2 = (tls: TlsContext, body: ConfNode[]): ConfNode[] => [
  ...body,
  ...cipherNodes(tls.cipher, tls.confCommand),
  ...(tls.hsts === undefined ? [] : [hstsNode(tls.hsts)]),
  ...(tls.http2 ? [http2Node()] : []),
  ...(tls.rejectMismatch ? [sniMismatchGuard()] : []),
];

function defaultServerBlock(
  listener: HttpListener | HttpsListener,
  poolsWithBackends: Set<string>,
  tls: TlsContext | undefined,
  acme: boolean,
): ConfNode {
  const action = listener.http?.defaultAction ?? 'reject';
  const body: ConfNode[] =
    action !== 'reject' && poolsWithBackends.has(action.pool)
      ? [
          block('location', [lit('/')], [
            directive('proxy_pass', [lit(`http://${upstreamName(action.pool)}`)]),
            directive('proxy_set_header', [lit('Host'), variable('host')]),
          ]),
        ]
      // **`location /` 안에 넣는다. server 레벨 `return` 이 아니다.**
      //
      // nginx 의 server 레벨 `return` 은 **rewrite 단계**에서 실행되고, 그건 location
      // 선택보다 **앞이다.** 그래서 같은 server 안에 다른 location 이 아무리 있어도
      // 도달하지 못한다 — ACME 예약 라우트가 정확히 그렇게 죽어 있었다. conf 는 옳아
      // 보이고 `nginx -t` 도 통과하는데, 요청이 그냥 끊긴다(curl 은 `000` 으로 본다).
      //
      // `location /` 은 모든 경로를 덮으므로 "안 맞으면 끊는다" 는 뜻이 그대로 유지되고,
      // 더 긴 접두사(`^~ /.well-known/acme-challenge/`)는 이제 이길 수 있다.
      : [block('location', [lit('/')], [directive('return', [num(444)])])];

  // **S17 — TLS 리스너의 default_server 는 선택이 아니다.** 없으면 모르는 SNI 가 첫
  // 블록의 인증서를 받는다(E32 의 TLS 판). 여기 쓰는 인증서는 리스너의
  // `tls.defaultCertificate` 이고, 그 값이 없는 https 리스너는 타입이 표현하지 못한다.
  const tlsBody = tls === undefined
    ? []
    : withHttp2(tls, tlsNodes(
        tls.certs.get(tls.listener.tls.defaultCertificate)
          ?? ((): Certificate => {
            throw new Error(
              `알 수 없는 default 인증서가 렌더에 도달했다: '${tls.listener.tls.defaultCertificate}'`);
          })(),
        tls.policy.minVersion, tls.policy.maxVersion,
      ));

  // **default_server 에도 낸다.** CA 는 Host 헤더를 도메인으로 보내지만, 그 도메인에
  // 라우트가 아직 없을 수 있다 — 첫 발급이 정확히 그 상황이다. default 에 없으면
  // "설정을 먼저 넣어야 인증서를 받고, 인증서가 있어야 설정이 선다" 가 된다.
  return block('server', [], [
    directive('listen', [...listenArgs(listener), lit('default_server')]),
    directive('server_name', [lit('_')]),
    ...tlsBody,
    ...realipNodes(listener),
    ...(acme ? [acmeChallengeLocation()] : []),
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

  const issues = validateModel(model, {
    streamRealip: caps.streamRealip,
    ...(caps.http2 === undefined ? {} : { http2: caps.http2 }),
  });
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
  // **https 도 http 블록에서 산다.** TLS 종단은 stream 이 아니라 http 의 일이다 —
  // `tls_passthrough` 만 stream 이고, 그쪽은 인증서를 제시하지 않는다 (§4.6).
  const httpListeners = listeners.filter(
    (l): l is HttpListener | HttpsListener => l.protocol === 'http' || l.protocol === 'https',
  );
  const streamListeners = listeners.filter(
    (l): l is PassthroughListener | TcpListener | UdpListener =>
      l.protocol !== 'http' && l.protocol !== 'https',
  );

  /**
   * **main 컨텍스트.** 여기 내는 것은 재 보고 대가를 아는 것뿐이다 (§4.10).
   *
   * `worker_shutdown_timeout` 을 안 적으면 **안 낸다** — nginx 기본값(무한)이 안전한
   * 기본값이기 때문이다. 켜면 HUP 뒤 in-flight 요청이 **응답 없이 죽는다**(실측:
   * `exit=52` empty reply). 그 대가를 내고 사는 것은 **옛 워커 잔존 창의 상한**이고,
   * 그게 있어야 GC 가 "이 시간이 지나면 아무도 안 든다" 를 쓸 수 있다 (S13).
   */
  const shutdownTimeout = model.engine?.workerShutdownTimeoutS;
  const top: ConfNode[] = [
    ...(shutdownTimeout === undefined
      ? []
      : [directive('worker_shutdown_timeout', [lit(`${shutdownTimeout}s`)])]),
    block('events', [], [directive('worker_connections', [num(1024)])]),
  ];

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
      children.unshift(lua('log_by_lua_block', `
            local peer = ngx.ctx.bary_peer
            if not peer then return end
            local d = ngx.shared.${MEMBERSHIP_DICT.http}
            local n = d:incr("in:" .. peer, -1)
            if n and n < 0 then d:set("in:" .. peer, 0) end
        `));
      children.unshift(directive('lua_shared_dict', [lit(MEMBERSHIP_DICT.http), lit('1m')]));
      // ACME 토큰은 멤버십과 **다른 dict** 다. 같이 쓰면 멤버십 staging 이 토큰을 밀어내고
      // (dict 는 LRU 로 밀어낸다) 그 실패는 "인증서 발급이 가끔 안 된다" 로 보인다.
      children.unshift(directive('lua_shared_dict', [lit(ACME_DICT), lit('64k')]));
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
    const policies = new Map(model.tlsPolicies.map((t) => [t.key, t]));
    const certs = new Map(model.certificates.map((c) => [c.key, c]));
    // **map 은 http 블록에 하나만.** 리스너마다 내면 이름이 겹쳐 nginx 가 거절한다.
    const anyMismatchGuard = httpListeners.some((l) =>
      l.protocol === 'https'
      && (policies.get(l.tls.policy)?.sniHostMismatch ?? 'allow') === 'reject_421');
    if (anyMismatchGuard) children.push(sniMismatchMap());
    for (const l of httpListeners) {
      const tls: TlsContext | undefined = l.protocol === 'https'
        ? {
            listener: l,
            bindings: byKey(model.sniBindings.filter((b) => b.listener === l.key)),
            certs,
            // **기본은 켜는 것이다.** 요즘 HTTPS 에서 h2 없이 서비스하는 것은 사실상
            // 결함이다. 다만 엔진이 못 하면 안 낸다 — 명시적으로 켜 달라고 한 경우는
            // 검증기가 미리 막으므로, 여기서 조용히 꺼지는 것은 "기본값" 뿐이다.
            http2: (l.http2 ?? true) && caps.http2 === true,
            rejectMismatch:
              (policies.get(l.tls.policy)?.sniHostMismatch ?? 'allow') === 'reject_421',
            cipher: policies.get(l.tls.policy)?.cipherPolicy ?? DEFAULT_CIPHER_POLICY,
            confCommand: caps.sslConfCommand === true,
            hsts: policies.get(l.tls.policy)?.hsts,
            // 검증기가 참조를 이미 봤다. 없으면 인증서를 지어내는 대신 터진다.
            policy: policies.get(l.tls.policy) ?? ((): TlsPolicy => {
              throw new Error(`알 수 없는 TLS 정책이 렌더에 도달했다: '${l.tls.policy}'`);
            })(),
          }
        : undefined;
      // ACME 예약 라우트는 **Lua 가 있어야** 낸다. 없으면 토큰을 conf 에 실어야 하고,
      // 그건 갱신마다 세대 전환이다 (§8.2 · ADR-ACME).
      const acme = caps.httpLua === true;
      children.push(defaultServerBlock(l, poolsWithBackends, tls, acme));
      children.push(
        ...httpServerBlocks(l, routesByListener.get(l.key) ?? [], poolsWithBackends, tls, acme),
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
      children.push(lua('log_by_lua_block', `
            local peer = ngx.ctx.bary_peer
            if not peer then return end
            local d = ngx.shared.${MEMBERSHIP_DICT.stream}
            local n = d:incr("in:" .. peer, -1)
            if n and n < 0 then d:set("in:" .. peer, 0) end
        `));
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

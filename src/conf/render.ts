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
  block, directive, entry, lit, num, regex, serialize, variable,
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
export type RenderCapabilities = { streamRealip: boolean };

/** capability 를 모르면 없는 쪽으로 가정한다. 모르는 것을 할 수 있다고 하지 않는다. */
const CONSERVATIVE: RenderCapabilities = { streamRealip: false };

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
  if (l.protocol !== 'udp' && l.acceptProxyProtocol === true) base.push(lit('proxy_protocol'));
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

  // PROXY 헤더를 받는 리스너로 도달하는 풀은, stream_realip 이 없을 때 $remote_addr 대신
  // $proxy_protocol_addr 로 해시해야 실 클라이언트 기준이 된다.
  const viaProxyProtocol = new Set<string>();
  if (!caps.streamRealip) {
    for (const l of listeners) {
      if (l.protocol === 'udp' || l.acceptProxyProtocol !== true) continue;
      for (const poolKey of poolsReachedBy(l, model)) viaProxyProtocol.add(poolKey);
    }
  }
  const sourceIpVar = (poolKey: string): string =>
    viaProxyProtocol.has(poolKey) ? 'proxy_protocol_addr' : 'remote_addr';
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
      children.push(
        upstreamBlock(pools.get(poolKey)!, backendsByPool.get(poolKey) ?? [], sourceIpVar(poolKey)),
      );
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
  if (streamListeners.length > 0) {
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
    for (const poolKey of [...usedPools].sort()) {
      children.push(
        upstreamBlock(pools.get(poolKey)!, backendsByPool.get(poolKey) ?? [], sourceIpVar(poolKey)),
      );
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

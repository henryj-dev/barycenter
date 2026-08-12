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

import {
  block, directive, entry, lit, num, regex, serialize, variable,
  type ConfNode, type ConfValue,
} from './ast.js';
import { compileHostRoutes, type RouteInput } from '../route/compile.js';
import { poolsReachedBy } from '../validate/engine-constraints.js';
import { ModelValidationError, validateModel } from '../validate/model.js';
import { normalizeBind } from '../validate/sockets.js';
import type {
  Backend,
  HttpRoute,
  Listener,
  Model,
  PassthroughRoute,
  Pool,
  SniOutcome,
  UdpPreset,
} from '../model/provisional.js';

export type RenderedConfig = { conf: string; digest: string };

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

const ident = (key: string): string => key.replace(/[^A-Za-z0-9_]/g, '_');
const upstreamName = (poolKey: string): string => `pool_${ident(poolKey)}`;

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
  // udp 는 PROXY 수신을 지원하지 않는다 (§4.7). 모델이 막지만 렌더도 내지 않는다.
  if (l.acceptProxyProtocol === true && l.protocol !== 'udp') base.push(lit('proxy_protocol'));
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

function hashVariable(pool: Pool): string {
  const spec = pool.hashKey ?? 'remote_addr';
  if (spec === 'request_uri') return 'request_uri';
  const header = /^header\((.+)\)$/.exec(spec);
  if (header) return `http_${header[1]!.toLowerCase().replace(/-/g, '_')}`;
  const cookie = /^cookie\((.+)\)$/.exec(spec);
  if (cookie) return `cookie_${cookie[1]!}`;
  return 'remote_addr';
}

function upstreamBlock(pool: Pool, backends: Backend[], sourceIpVar: string): ConfNode {
  const servers = byKey(backends).map((b) => {
    const args: ConfValue[] = [lit(`${b.host}:${b.port}`)];
    if (b.weight !== 1) args.push(lit(`weight=${b.weight}`));
    return directive('server', args);
  });
  return block('upstream', [lit(upstreamName(pool.key))], [
    ...algorithmDirectives(pool, sourceIpVar),
    ...servers,
  ]);
}

// ─────────────────────────────────────────────────────────────── http ───────

function httpServerBlocks(
  listener: Listener,
  routes: HttpRoute[],
  poolsWithBackends: Set<string>,
): ConfNode[] {
  // 같은 호스트 집합을 쓰는 라우트는 한 server 블록에 모은다.
  // 그래야 server_name 이 중복되지 않는다.
  const groups = new Map<string, { hosts: string[]; routes: HttpRoute[] }>();
  for (const r of byKey(routes)) {
    const hosts = [...r.hosts].sort();
    const sig = hosts.join(' ');
    const g = groups.get(sig);
    if (g) g.routes.push(r);
    else groups.set(sig, { hosts, routes: [r] });
  }

  const out: ConfNode[] = [];
  for (const sig of [...groups.keys()].sort()) {
    const g = groups.get(sig)!;
    const locations: ConfNode[] = [];

    // 컴파일된 순서대로 location 을 낸다 — 사용자가 본 순서와 conf 순서를 일치시킨다.
    const inputs: RouteInput[] = g.routes.map((r) =>
      r.pathPrefix === undefined
        ? { key: r.key, host: r.hosts[0]!, priority: r.priority }
        : { key: r.key, host: r.hosts[0]!, priority: r.priority, pathPrefix: r.pathPrefix },
    );
    const compiled = compileHostRoutes(inputs);
    const ordered =
      compiled.errors.length > 0
        ? g.routes
        : compiled.order.map((c) => g.routes.find((r) => r.key === c.key)!);

    for (const r of ordered) {
      const prefix = r.pathPrefix ?? '/';
      const body: ConfNode[] = [];
      switch (r.action.kind) {
        case 'proxy': {
          if (!poolsWithBackends.has(r.action.pool)) continue;
          body.push(directive('proxy_pass', [lit(`http://${upstreamName(r.action.pool)}`)]));
          body.push(directive('proxy_set_header', [lit('Host'), variable('host')]));
          body.push(
            directive('proxy_set_header', [
              lit('X-Forwarded-For'),
              variable('proxy_add_x_forwarded_for'),
            ]),
          );
          body.push(directive('proxy_set_header', [lit('X-Forwarded-Proto'), variable('scheme')]));
          body.push(directive('proxy_http_version', [lit('1.1')]));
          if (r.action.websocket) {
            body.push(directive('proxy_set_header', [lit('Upgrade'), variable('http_upgrade')]));
            body.push(
              directive('proxy_set_header', [lit('Connection'), variable('connection_upgrade')]),
            );
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
      if (body.length > 0) locations.push(block('location', [lit(prefix)], body));
    }

    if (locations.length === 0) continue;
    out.push(
      block('server', [], [
        directive('listen', listenArgs(listener)),
        directive('server_name', g.hosts.map((h) => lit(h))),
        ...locations,
      ]),
    );
  }
  return out;
}

/**
 * 명시적 `default_server`.
 *
 * E32 로 실측: 없으면 모르는 Host 가 **첫 번째 server 블록**으로 조용히 들어간다.
 * 멀티테넌트에서 그건 테넌트 간 누수다. 기본은 `444`(응답 없이 끊기)로 막는다.
 */
function defaultServerBlock(listener: Listener, poolsWithBackends: Set<string>): ConfNode {
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
  listener: Listener,
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
        ? lit(c.pattern.host)
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

function streamServerBlock(listener: Listener, pool: Pool | undefined): ConfNode {
  const children: ConfNode[] = [];
  const isUdp = listener.protocol === 'udp';
  const preset = isUdp ? UDP_PRESETS[listener.udp?.preset ?? 'custom'] : undefined;

  const args = listenArgs(listener);
  if (isUdp) {
    args.push(lit('udp'));
    if (preset?.reuseport) args.push(lit('reuseport'));
  }
  children.push(directive('listen', args));
  children.push(directive('proxy_pass', [lit(upstreamName(listener.defaultPool!))]));

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
  const issues = validateModel(model);
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
      if (l.acceptProxyProtocol !== true || l.protocol === 'udp') continue;
      for (const poolKey of poolsReachedBy(l, model)) viaProxyProtocol.add(poolKey);
    }
  }
  const sourceIpVar = (poolKey: string): string =>
    viaProxyProtocol.has(poolKey) ? 'proxy_protocol_addr' : 'remote_addr';
  const httpListeners = listeners.filter((l) => l.protocol === 'http');
  const streamListeners = listeners.filter(
    (l) => l.protocol === 'tcp' || l.protocol === 'udp' || l.protocol === 'tls_passthrough',
  );

  const top: ConfNode[] = [block('events', [], [directive('worker_connections', [num(1024)])])];

  // ── http ──
  if (httpListeners.length > 0) {
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

    const children: ConfNode[] = [];
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
    if (children.length > 0) top.push(block('http', [], children));
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
      } else if (l.defaultPool !== undefined && poolsWithBackends.has(l.defaultPool)) {
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
      } else if (l.defaultPool !== undefined && poolsWithBackends.has(l.defaultPool)) {
        children.push(streamServerBlock(l, pools.get(l.defaultPool)));
      }
    }
    if (children.length > 0) top.push(block('stream', [], children));
  }

  const conf = serialize(top);
  const digest = createHash('sha256').update(conf, 'utf8').digest('hex');
  return { conf, digest };
}

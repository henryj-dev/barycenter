/**
 * GUI 가 changeset 에 얹는 패치 — DESIGN.md §5.3 · §10
 *
 * 저장(commit)과 적용(apply)은 다르다. 여기서 만드는 것은 patch 뿐이다.
 * 메서드×경로 ALLOW/DENY 는 WAF 다. 여기 없다.
 */
import { parseHashKey } from '../validate/strings.js';

export type EditKind =
  | 'backend' | 'listener' | 'pool' | 'httpRoute' | 'passthroughRoute'
  | 'sniBinding' | 'certificate' | 'tlsPolicy';

export type DeleteOp = { op: 'delete'; kind: EditKind; key: string };

export type PutBackendOp = {
  op: 'put';
  kind: 'backend';
  key: string;
  body: { pool: string; host: string; port: number; weight: number };
};

export function deletePatch(kind: EditKind, key: string): DeleteOp[] {
  if (key === '') throw new Error('키가 비어 있다');
  return [{ op: 'delete', kind, key }];
}

export function putBackendPatch(
  key: string,
  body: { pool: string; host: string; port: number; weight?: number },
): PutBackendOp[] {
  if (key === '') throw new Error('키가 비어 있다');
  if (body.pool === '') throw new Error('풀이 비어 있다');
  if (body.host === '') throw new Error('호스트가 비어 있다');
  if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
    throw new Error('포트가 1–65535 정수가 아니다');
  }
  const weight = body.weight ?? 1;
  if (!Number.isInteger(weight) || weight < 1) throw new Error('가중치가 1 이상 정수가 아니다');
  return [{ op: 'put', kind: 'backend', key, body: { pool: body.pool, host: body.host, port: body.port, weight } }];
}

/**
 * 리스너 옵션 셋 — 제안 6·7·8 의 **저작 표면** (2026-08-23).
 *
 * 모델·검증·렌더까지만 열어 두면 raw JSON patch 로만 넣을 수 있다. §12.1 이
 * *"GUI 는 맨 뒤로 미루지 않는다 — 제품 명제가 GUI 이므로"* 라고 적어 뒀고,
 * **쓸 수 있는 것과 이 제품의 방식으로 쓸 수 있는 것은 다르다.**
 *
 * GUI 와 CLI 가 **같은 자리**를 쓴다. 두 곳에서 각자 만들면 "GUI 로는 되는데 CLI 로는
 * 안 되는" 것이 생긴다.
 */
export type ListenerOptions = {
  limits?: ProxyLimitsInput;
  headers?: HeaderRulesInput;
  rateLimit?: RateLimitInput;
};

export type ProxyLimitsInput = {
  connectTimeoutMs?: number;
  readTimeoutMs?: number;
  sendTimeoutMs?: number;
  clientMaxBodyBytes?: number;
};

export type HeaderRuleInput = { name: string; value: string };
export type HeaderRulesInput = { request?: HeaderRuleInput[]; response?: HeaderRuleInput[] };

export type RateLimitInput = {
  requestsPerSecond?: number;
  burst?: number;
  nodelay?: boolean;
  maxConnections?: number;
  zoneKb?: number;
};

/** 값이 하나라도 있는 것만 남긴다. `undefined` 면 키 자체를 안 만든다. */
const someOf = <T extends object>(v: T | undefined): T | undefined => {
  if (v === undefined) return undefined;
  const kept = Object.entries(v).filter(([, x]) => x !== undefined && x !== '');
  return kept.length === 0 ? undefined : (Object.fromEntries(kept) as T);
};

/**
 * 폼의 **빈 행을 버린다.** 이름 없는 줄은 사용자가 안 채운 칸이지 "빈 이름 헤더" 가
 * 아니다 — 그대로 보내면 해독기가 422 로 튕기고, 폼은 왜 막혔는지 못 말한다.
 */
const headerList = (rows: HeaderRuleInput[] | undefined): HeaderRuleInput[] | undefined => {
  if (rows === undefined) return undefined;
  const kept = rows.filter((r) => r.name.trim() !== '');
  return kept.length === 0 ? undefined : kept.map((r) => ({ name: r.name.trim(), value: r.value }));
};

/**
 * 옵션 → `http` 프로필에 얹을 조각.
 *
 * **안 적으면 아무것도 안 만든다.** 빈 객체라도 실으면 렌더 바이트가 바뀌고, 그러면
 * 설정을 안 건드린 배포가 다음 apply 에서 세대 전환을 한다.
 */
export function listenerOptionFields(opts: ListenerOptions | undefined): {
  limits?: ProxyLimitsInput;
  headers?: HeaderRulesInput;
  rateLimit?: RateLimitInput;
} {
  if (opts === undefined) return {};
  const limits = someOf(opts.limits);
  const rateLimit = someOf(opts.rateLimit);
  const headers = someOf({
    ...(headerList(opts.headers?.request) === undefined ? {} : { request: headerList(opts.headers?.request) }),
    ...(headerList(opts.headers?.response) === undefined ? {} : { response: headerList(opts.headers?.response) }),
  } as HeaderRulesInput);

  // **해독기와 같은 규칙을 여기서도 건다.** `burst`·`nodelay` 는 `limit_req` 의 인자라
  // zone 이 없으면 쓸 데가 없다 — 폼이 저장 못 하는 patch 를 만들지 않는다.
  if (rateLimit !== undefined
    && rateLimit.requestsPerSecond === undefined
    && (rateLimit.burst !== undefined || rateLimit.nodelay !== undefined)) {
    throw new Error('burst·nodelay 는 requestsPerSecond 가 있어야 한다');
  }
  return {
    ...(limits === undefined ? {} : { limits }),
    ...(headers === undefined ? {} : { headers }),
    ...(rateLimit === undefined ? {} : { rateLimit }),
  };
}

/**
 * 플래그·폼 문자열 → 리스너 옵션 (제안 6·7·8, 2026-08-23).
 *
 * CLI 플래그와 GUI 폼이 **같은 것**을 쓴다. 둘 다 문자열을 받고(`50m` · `120s`),
 * 해석은 여기 한 자리다 — 두 벌로 두면 "GUI 로 넣은 값과 CLI 로 넣은 값이 다르게
 * 저장되는" 것이 생기고, 그 차이는 트래픽이 물리는 날에만 드러난다.
 *
 * ── 파싱이 계약이다
 *
 * 플래그는 문자열로 온다. 여기서 틀리면 **사용자가 적은 것과 저장되는 것이 달라지고**,
 * 그 차이는 트래픽이 물리는 날에만 드러난다. 그래서 단위를 추측하지 않는다 —
 * `--read-timeout 120` 은 초인지 밀리초인지 모르므로 거부한다.
 */
export type ListenerOptionFlags = {
  connectTimeout?: string;
  readTimeout?: string;
  sendTimeout?: string;
  maxBody?: string;
  header?: string[];
  rate?: string;
  burst?: string;
  nodelay?: boolean;
  maxConn?: string;
};

/** `50m` · `512k` · `1500`. **모르는 단위는 거부한다** — 조용히 바이트로 읽지 않는다. */
function sizeBytes(v: string): number {
  const m = /^(\d+)([km]?)$/.exec(v.trim());
  if (m === null) throw new Error(`크기가 아니다: ${JSON.stringify(v)} — 예: 50m · 512k · 1500`);
  const n = Number(m[1]);
  if (m[2] === 'm') return n * 1024 * 1024;
  if (m[2] === 'k') return n * 1024;
  return n;
}

/**
 * `120s` · `1500ms`. **단위가 없으면 거부한다.**
 *
 * nginx 는 맨 숫자를 초로 읽지만 우리 모델은 ms 로 든다. 둘 중 하나를 골라 추측하면
 * 60 배 틀린 값이 조용히 저장된다.
 */
function durationMs(v: string): number {
  const m = /^(\d+)(ms|s)$/.exec(v.trim());
  if (m === null) throw new Error(`시간이 아니다: ${JSON.stringify(v)} — 단위를 적는다 (예: 120s · 1500ms)`);
  return m[2] === 's' ? Number(m[1]) * 1000 : Number(m[1]);
}

/** `10r/s` 와 맨 `10` 을 둘 다 받는다 — `r/s` 는 nginx 표기이지 사용자의 것이 아니다. */
function ratePerSecond(v: string): number {
  const m = /^(\d+)(?:r\/s)?$/.exec(v.trim());
  if (m === null) throw new Error(`초당 요청 수가 아니다: ${JSON.stringify(v)} — 예: 10 · 10r/s`);
  return Number(m[1]);
}

/**
 * `req:이름:값` · `res:이름:값`.
 *
 * **첫 두 개만 가른다** — 값에 콜론이 있는 것이 정상이다 (`https://a/b`).
 */
function headerRule(spec: string): { dir: 'request' | 'response'; name: string; value: string } {
  const first = spec.indexOf(':');
  const second = spec.indexOf(':', first + 1);
  if (first < 0 || second < 0) {
    throw new Error(`헤더가 아니다: ${JSON.stringify(spec)} — req:이름:값 또는 res:이름:값`);
  }
  const dir = spec.slice(0, first);
  if (dir !== 'req' && dir !== 'res') {
    throw new Error(`방향이 req 나 res 가 아니다: ${JSON.stringify(dir)}`);
  }
  return {
    dir: dir === 'req' ? 'request' : 'response',
    name: spec.slice(first + 1, second),
    value: spec.slice(second + 1),
  };
}

export function parseListenerOptions(f: ListenerOptionFlags): ListenerOptions {
  const limits = {
    ...(f.connectTimeout === undefined ? {} : { connectTimeoutMs: durationMs(f.connectTimeout) }),
    ...(f.readTimeout === undefined ? {} : { readTimeoutMs: durationMs(f.readTimeout) }),
    ...(f.sendTimeout === undefined ? {} : { sendTimeoutMs: durationMs(f.sendTimeout) }),
    ...(f.maxBody === undefined ? {} : { clientMaxBodyBytes: sizeBytes(f.maxBody) }),
  };
  const rateLimit = {
    ...(f.rate === undefined ? {} : { requestsPerSecond: ratePerSecond(f.rate) }),
    ...(f.burst === undefined ? {} : { burst: Number(f.burst) }),
    ...(f.nodelay === undefined ? {} : { nodelay: f.nodelay }),
    ...(f.maxConn === undefined ? {} : { maxConnections: Number(f.maxConn) }),
  };
  const request: { name: string; value: string }[] = [];
  const response: { name: string; value: string }[] = [];
  for (const spec of f.header ?? []) {
    const r = headerRule(spec);
    (r.dir === 'request' ? request : response).push({ name: r.name, value: r.value });
  }
  const headers = {
    ...(request.length === 0 ? {} : { request }),
    ...(response.length === 0 ? {} : { response }),
  };

  // **`listenerOptionFields` 와 같은 규칙을 지난다** — 빈 것을 버리고, `burst` 만 있는
  // 조합을 막는 곳이 한 자리여야 한다. 여기서 따로 판정하면 GUI 와 갈린다.
  return listenerOptionFields({
    ...(Object.keys(limits).length === 0 ? {} : { limits }),
    ...(Object.keys(headers).length === 0 ? {} : { headers }),
    ...(Object.keys(rateLimit).length === 0 ? {} : { rateLimit }),
  });
}

export type PutHttpListenerOp = {
  op: 'put';
  kind: 'listener';
  key: string;
  body: {
    protocol: 'http';
    bind: string;
    port: number;
    enabled: true;
    http: {
      defaultAction: { pool: string };
      limits?: ProxyLimitsInput;
      headers?: HeaderRulesInput;
      rateLimit?: RateLimitInput;
    };
  };
};

/** HTTP 만. HTTPS 는 tls 결박이 따로 있다. */
export function putHttpListenerPatch(
  key: string,
  body: { bind: string; port: number; pool: string } & ListenerOptions,
): PutHttpListenerOp[] {
  if (key === '') throw new Error('키가 비어 있다');
  if (body.bind === '') throw new Error('바인드가 비어 있다');
  if (body.pool === '') throw new Error('풀이 비어 있다');
  if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
    throw new Error('포트가 1–65535 정수가 아니다');
  }
  return [{
    op: 'put',
    kind: 'listener',
    key,
    body: {
      protocol: 'http',
      bind: body.bind,
      port: body.port,
      enabled: true,
      http: { defaultAction: { pool: body.pool }, ...listenerOptionFields(body) },
    },
  }];
}

export type PutTcpListenerOp = {
  op: 'put';
  kind: 'listener';
  key: string;
  body: {
    protocol: 'tcp';
    bind: string;
    port: number;
    enabled: true;
    defaultPool: string;
  };
};

/**
 * TCP 만. defaultPool 은 최상위 필드다 — http.defaultAction 이 아니다.
 * PROXY 수신은 trustedCidrs 가 없어서 안 켠다.
 */
export function putTcpListenerPatch(
  key: string,
  body: { bind: string; port: number; pool: string },
): PutTcpListenerOp[] {
  if (key === '') throw new Error('키가 비어 있다');
  if (body.bind === '') throw new Error('바인드가 비어 있다');
  if (body.pool === '') throw new Error('풀이 비어 있다');
  if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
    throw new Error('포트가 1–65535 정수가 아니다');
  }
  return [{
    op: 'put',
    kind: 'listener',
    key,
    body: {
      protocol: 'tcp',
      bind: body.bind,
      port: body.port,
      enabled: true,
      defaultPool: body.pool,
    },
  }];
}

export type UdpPreset = 'dns' | 'wireguard' | 'game_generic' | 'custom';

const UDP_PRESETS: readonly UdpPreset[] = ['dns', 'wireguard', 'game_generic', 'custom'];

export type PutUdpListenerOp = {
  op: 'put';
  kind: 'listener';
  key: string;
  body: {
    protocol: 'udp';
    bind: string;
    port: number;
    enabled: true;
    defaultPool: string;
    udp: { preset: UdpPreset };
  };
};

/**
 * UDP 만. preset 이 없으면 렌더러가 custom 을 지어 낸다 — 해독기가 막는다.
 * PROXY 수신 필드가 타입에 없다. 모르는 preset 은 패치를 안 만든다.
 */
export function putUdpListenerPatch(
  key: string,
  body: { bind: string; port: number; pool: string; preset: UdpPreset },
): PutUdpListenerOp[] {
  if (key === '') throw new Error('키가 비어 있다');
  if (body.bind === '') throw new Error('바인드가 비어 있다');
  if (body.pool === '') throw new Error('풀이 비어 있다');
  if (!UDP_PRESETS.includes(body.preset)) throw new Error('preset 이 dns|wireguard|game_generic|custom 이 아니다');
  if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
    throw new Error('포트가 1–65535 정수가 아니다');
  }
  return [{
    op: 'put',
    kind: 'listener',
    key,
    body: {
      protocol: 'udp',
      bind: body.bind,
      port: body.port,
      enabled: true,
      defaultPool: body.pool,
      udp: { preset: body.preset },
    },
  }];
}

export type TlsVersion = '1.2' | '1.3';

export type PutTlsPolicyOp = {
  op: 'put';
  kind: 'tlsPolicy';
  key: string;
  body: { minVersion: TlsVersion };
};

/** minVersion 만. cipherPolicy 는 안 적으면 intermediate-2026. HSTS 는 안 켠다. */
export function putTlsPolicyPatch(
  key: string,
  body: { minVersion?: TlsVersion } = {},
): PutTlsPolicyOp[] {
  if (key === '') throw new Error('키가 비어 있다');
  const minVersion = body.minVersion ?? '1.2';
  if (minVersion !== '1.2' && minVersion !== '1.3') {
    throw new Error('minVersion 이 1.2|1.3 이 아니다');
  }
  return [{ op: 'put', kind: 'tlsPolicy', key, body: { minVersion } }];
}

export type PutHttpsListenerOp = {
  op: 'put';
  kind: 'listener';
  key: string;
  body: {
    protocol: 'https';
    bind: string;
    port: number;
    enabled: true;
    http: {
      defaultAction: { pool: string };
      limits?: ProxyLimitsInput;
      headers?: HeaderRulesInput;
      rateLimit?: RateLimitInput;
    };
    tls: { policy: string; defaultCertificate: string };
  };
};

/**
 * HTTPS. tls.policy 와 tls.defaultCertificate 가 필수다.
 * 자료 없는 인증서는 검증기가 막는다 — 여기서 자료를 지어내지 않는다.
 * http2 는 안 적는다 (기본이 켠다).
 */
export function putHttpsListenerPatch(
  key: string,
  body: { bind: string; port: number; pool: string; policy: string; certificate: string }
    & ListenerOptions,
): PutHttpsListenerOp[] {
  if (key === '') throw new Error('키가 비어 있다');
  if (body.bind === '') throw new Error('바인드가 비어 있다');
  if (body.pool === '') throw new Error('풀이 비어 있다');
  if (body.policy === '') throw new Error('정책이 비어 있다');
  if (body.certificate === '') throw new Error('인증서가 비어 있다');
  if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
    throw new Error('포트가 1–65535 정수가 아니다');
  }
  return [{
    op: 'put',
    kind: 'listener',
    key,
    body: {
      protocol: 'https',
      bind: body.bind,
      port: body.port,
      enabled: true,
      http: { defaultAction: { pool: body.pool }, ...listenerOptionFields(body) },
      tls: { policy: body.policy, defaultCertificate: body.certificate },
    },
  }];
}

export type PutCertificateOp = {
  op: 'put';
  kind: 'certificate';
  key: string;
  body: { materialRef: string; chainDigest: string; keyDigest: string };
};

/**
 * 설정에는 참조만 실린다. fullchain·privkey 자리는 없다.
 * 자료는 POST /certificates/material 로 SecretStore 에 먼저 들어간다.
 */
export function putCertificatePatch(
  key: string,
  body: { materialRef: string; chainDigest: string; keyDigest: string },
): PutCertificateOp[] {
  if (key === '') throw new Error('키가 비어 있다');
  if (body.materialRef === '') throw new Error('자료 참조가 비어 있다');
  if (body.chainDigest === '') throw new Error('chainDigest 가 비어 있다');
  if (body.keyDigest === '') throw new Error('keyDigest 가 비어 있다');
  return [{
    op: 'put',
    kind: 'certificate',
    key,
    body: {
      materialRef: body.materialRef,
      chainDigest: body.chainDigest,
      keyDigest: body.keyDigest,
    },
  }];
}

export type PutSniBindingOp = {
  op: 'put';
  kind: 'sniBinding';
  key: string;
  body: { listener: string; hosts: string[]; certificate: string };
};

/**
 * HTTPS 호스트에 제시할 인증서. 라우트에 붙이지 않는다 — handshake 는 SNI 다.
 * override 는 안 붙인다.
 */
export function putSniBindingPatch(input: {
  key: string;
  listener: string;
  hosts: readonly string[];
  certificate: string;
}): PutSniBindingOp[] {
  if (input.key === '') throw new Error('키가 비어 있다');
  if (input.listener === '') throw new Error('리스너가 비어 있다');
  if (input.certificate === '') throw new Error('인증서가 비어 있다');
  const hosts = input.hosts.map((h) => h.trim()).filter((h) => h !== '');
  if (hosts.length === 0) throw new Error('호스트가 비어 있다');
  return [{
    op: 'put',
    kind: 'sniBinding',
    key: input.key,
    body: { listener: input.listener, hosts, certificate: input.certificate },
  }];
}

export type PutPassthroughListenerOp = {
  op: 'put';
  kind: 'listener';
  key: string;
  body: {
    protocol: 'tls_passthrough';
    bind: string;
    port: number;
    enabled: true;
    onUnmatchedSni?: { pool: string };
  };
};

/**
 * TLS 패스스루. 인증서를 제시하지 않는다 — tls 를 안 붙인다.
 * 기본 풀은 없다. 라우트가 목적지를 가른다.
 * unmatched SNI 만 풀로 보낼 수 있다. 부재·파싱 실패는 설정 대상이 아니다.
 * PROXY 수신은 trustedCidrs 가 없어서 안 켠다.
 */
export function putPassthroughListenerPatch(
  key: string,
  body: { bind: string; port: number; pool?: string },
): PutPassthroughListenerOp[] {
  if (key === '') throw new Error('키가 비어 있다');
  if (body.bind === '') throw new Error('바인드가 비어 있다');
  if (!Number.isInteger(body.port) || body.port < 1 || body.port > 65535) {
    throw new Error('포트가 1–65535 정수가 아니다');
  }
  const pool = body.pool?.trim();
  const patchBody: PutPassthroughListenerOp['body'] = {
    protocol: 'tls_passthrough',
    bind: body.bind,
    port: body.port,
    enabled: true,
  };
  if (pool !== undefined && pool !== '') patchBody.onUnmatchedSni = { pool };
  return [{ op: 'put', kind: 'listener', key, body: patchBody }];
}

export type ProtocolClass = 'http' | 'tcp' | 'udp';

export type PutPoolOp = {
  op: 'put';
  kind: 'pool';
  key: string;
  body: { protocolClass: ProtocolClass; algorithm: 'round_robin' };
};

export type PutHashPoolOp = {
  op: 'put';
  kind: 'pool';
  key: string;
  body: { protocolClass: ProtocolClass; algorithm: 'hash'; hashKey: string };
};

/**
 * 빈 풀은 검증기가 막는다. 풀만 put 하면 plan 이 실패한다.
 * 첫 백엔드를 같은 changeset 에 얹는다.
 */
export function putPoolWithBackendPatch(input: {
  pool: string;
  protocolClass: ProtocolClass;
  backend: string;
  host: string;
  port: number;
}): [PutPoolOp, ...PutBackendOp[]] {
  if (input.pool === '') throw new Error('풀 키가 비어 있다');
  if (input.protocolClass !== 'http' && input.protocolClass !== 'tcp' && input.protocolClass !== 'udp') {
    throw new Error('protocolClass 가 http|tcp|udp 가 아니다');
  }
  const backends = putBackendPatch(input.backend, {
    pool: input.pool, host: input.host, port: input.port,
  });
  return [
    {
      op: 'put',
      kind: 'pool',
      key: input.pool,
      body: { protocolClass: input.protocolClass, algorithm: 'round_robin' },
    },
    ...backends,
  ];
}

/**
 * hash 는 hashKey 가 필수다. 검증기와 같은 parseHashKey 를 쓴다.
 * 자유 문자열은 패치를 안 만든다. 첫 백엔드를 같이 넣는다.
 */
export function putHashPoolWithBackendPatch(input: {
  pool: string;
  protocolClass: ProtocolClass;
  hashKey: string;
  backend: string;
  host: string;
  port: number;
}): [PutHashPoolOp, ...PutBackendOp[]] {
  if (input.pool === '') throw new Error('풀 키가 비어 있다');
  if (input.protocolClass !== 'http' && input.protocolClass !== 'tcp' && input.protocolClass !== 'udp') {
    throw new Error('protocolClass 가 http|tcp|udp 가 아니다');
  }
  const hashKey = input.hashKey.trim();
  if (hashKey === '') throw new Error('hashKey 가 비어 있다');
  const parsed = parseHashKey(input.protocolClass, hashKey);
  if (!parsed.ok) throw new Error(parsed.message);
  const backends = putBackendPatch(input.backend, {
    pool: input.pool, host: input.host, port: input.port,
  });
  return [
    {
      op: 'put',
      kind: 'pool',
      key: input.pool,
      body: { protocolClass: input.protocolClass, algorithm: 'hash', hashKey },
    },
    ...backends,
  ];
}

export type PutSourceIpHashPoolOp = {
  op: 'put';
  kind: 'pool';
  key: string;
  body: { protocolClass: ProtocolClass; algorithm: 'source_ip_hash' };
};

/**
 * source_ip_hash. hashKey 를 안 붙인다 — 키는 소스 IP 다.
 * 첫 백엔드를 같이 넣는다.
 */
export function putSourceIpHashPoolWithBackendPatch(input: {
  pool: string;
  protocolClass: ProtocolClass;
  backend: string;
  host: string;
  port: number;
}): [PutSourceIpHashPoolOp, ...PutBackendOp[]] {
  if (input.pool === '') throw new Error('풀 키가 비어 있다');
  if (input.protocolClass !== 'http' && input.protocolClass !== 'tcp' && input.protocolClass !== 'udp') {
    throw new Error('protocolClass 가 http|tcp|udp 가 아니다');
  }
  const backends = putBackendPatch(input.backend, {
    pool: input.pool, host: input.host, port: input.port,
  });
  return [
    {
      op: 'put',
      kind: 'pool',
      key: input.pool,
      body: { protocolClass: input.protocolClass, algorithm: 'source_ip_hash' },
    },
    ...backends,
  ];
}

export type PutHttpRouteOp = {
  op: 'put';
  kind: 'httpRoute';
  key: string;
  body: {
    listener: string;
    hosts: string[];
    priority: number;
    pathPrefix?: string;
    action: { kind: 'proxy'; pool: string; websocket: boolean };
  };
};

/**
 * 호스트 → 풀 proxy. websocket 은 기본이 끈다 — 켜려면 명시한다.
 * redirect 는 putHttpRedirectPatch. reject 는 putHttpRejectPatch.
 */
export function putHttpRoutePatch(input: {
  key: string;
  listener: string;
  hosts: readonly string[];
  pool: string;
  pathPrefix?: string;
  priority?: number;
  websocket?: boolean;
}): PutHttpRouteOp[] {
  if (input.key === '') throw new Error('키가 비어 있다');
  if (input.listener === '') throw new Error('리스너가 비어 있다');
  if (input.pool === '') throw new Error('풀이 비어 있다');
  const hosts = input.hosts.map((h) => h.trim()).filter((h) => h !== '');
  if (hosts.length === 0) throw new Error('호스트가 비어 있다');
  const priority = input.priority ?? 0;
  if (!Number.isInteger(priority) || priority < 0) {
    throw new Error('priority 가 0 이상 정수가 아니다');
  }
  const pathPrefix = input.pathPrefix?.trim();
  const body: PutHttpRouteOp['body'] = {
    listener: input.listener,
    hosts,
    priority,
    action: { kind: 'proxy', pool: input.pool, websocket: input.websocket === true },
  };
  if (pathPrefix !== undefined && pathPrefix !== '') body.pathPrefix = pathPrefix;
  return [{ op: 'put', kind: 'httpRoute', key: input.key, body }];
}

export type RedirectStatus = 301 | 302 | 307 | 308;

const REDIRECT_STATUSES: readonly RedirectStatus[] = [301, 302, 307, 308];

export type PutHttpRedirectOp = {
  op: 'put';
  kind: 'httpRoute';
  key: string;
  body: {
    listener: string;
    hosts: string[];
    priority: number;
    pathPrefix?: string;
    action: { kind: 'redirect'; to: string; status: RedirectStatus };
  };
};

/**
 * 호스트 → URL redirect. pool·websocket 을 안 붙인다.
 * reject 는 putHttpRejectPatch. 기본 상태는 302.
 */
export function putHttpRedirectPatch(input: {
  key: string;
  listener: string;
  hosts: readonly string[];
  to: string;
  status?: RedirectStatus;
  pathPrefix?: string;
  priority?: number;
}): PutHttpRedirectOp[] {
  if (input.key === '') throw new Error('키가 비어 있다');
  if (input.listener === '') throw new Error('리스너가 비어 있다');
  const to = input.to.trim();
  if (to === '') throw new Error('대상이 비어 있다');
  const hosts = input.hosts.map((h) => h.trim()).filter((h) => h !== '');
  if (hosts.length === 0) throw new Error('호스트가 비어 있다');
  const status = Number(input.status ?? 302) as RedirectStatus;
  if (!REDIRECT_STATUSES.includes(status)) {
    throw new Error('status 가 301|302|307|308 이 아니다');
  }
  const priority = input.priority ?? 0;
  if (!Number.isInteger(priority) || priority < 0) {
    throw new Error('priority 가 0 이상 정수가 아니다');
  }
  const pathPrefix = input.pathPrefix?.trim();
  const body: PutHttpRedirectOp['body'] = {
    listener: input.listener,
    hosts,
    priority,
    action: { kind: 'redirect', to, status },
  };
  if (pathPrefix !== undefined && pathPrefix !== '') body.pathPrefix = pathPrefix;
  return [{ op: 'put', kind: 'httpRoute', key: input.key, body }];
}

export type RejectStatus = 403 | 404 | 444;

const REJECT_STATUSES: readonly RejectStatus[] = [403, 404, 444];

export type PutHttpRejectOp = {
  op: 'put';
  kind: 'httpRoute';
  key: string;
  body: {
    listener: string;
    hosts: string[];
    priority: number;
    pathPrefix?: string;
    action: { kind: 'reject'; status: RejectStatus };
  };
};

/**
 * 호스트 → 상태 코드. to·pool·websocket 을 안 붙인다.
 * 444 는 응답 없이 끊는다. 기본은 403.
 */
export function putHttpRejectPatch(input: {
  key: string;
  listener: string;
  hosts: readonly string[];
  status?: RejectStatus;
  pathPrefix?: string;
  priority?: number;
}): PutHttpRejectOp[] {
  if (input.key === '') throw new Error('키가 비어 있다');
  if (input.listener === '') throw new Error('리스너가 비어 있다');
  const hosts = input.hosts.map((h) => h.trim()).filter((h) => h !== '');
  if (hosts.length === 0) throw new Error('호스트가 비어 있다');
  const status = Number(input.status ?? 403) as RejectStatus;
  if (!REJECT_STATUSES.includes(status)) {
    throw new Error('status 가 403|404|444 이 아니다');
  }
  const priority = input.priority ?? 0;
  if (!Number.isInteger(priority) || priority < 0) {
    throw new Error('priority 가 0 이상 정수가 아니다');
  }
  const pathPrefix = input.pathPrefix?.trim();
  const body: PutHttpRejectOp['body'] = {
    listener: input.listener,
    hosts,
    priority,
    action: { kind: 'reject', status },
  };
  if (pathPrefix !== undefined && pathPrefix !== '') body.pathPrefix = pathPrefix;
  return [{ op: 'put', kind: 'httpRoute', key: input.key, body }];
}

export type PutPassthroughRouteOp = {
  op: 'put';
  kind: 'passthroughRoute';
  key: string;
  body: {
    listener: string;
    snis: string[];
    priority: number;
    action: { kind: 'proxy'; pool: string };
  };
};

/**
 * SNI → TCP 풀 proxy. TLS 를 종단하지 않으므로 websocket·path·status 가 없다.
 * reject 는 putPassthroughRejectPatch. 라우트에 인증서를 안 붙인다 — handshake 는 백엔드다.
 */
export function putPassthroughRoutePatch(input: {
  key: string;
  listener: string;
  snis: readonly string[];
  pool: string;
  priority?: number;
}): PutPassthroughRouteOp[] {
  if (input.key === '') throw new Error('키가 비어 있다');
  if (input.listener === '') throw new Error('리스너가 비어 있다');
  if (input.pool === '') throw new Error('풀이 비어 있다');
  const snis = input.snis.map((s) => s.trim()).filter((s) => s !== '');
  if (snis.length === 0) throw new Error('SNI 가 비어 있다');
  const priority = input.priority ?? 0;
  if (!Number.isInteger(priority) || priority < 0) {
    throw new Error('priority 가 0 이상 정수가 아니다');
  }
  return [{
    op: 'put',
    kind: 'passthroughRoute',
    key: input.key,
    body: {
      listener: input.listener,
      snis,
      priority,
      action: { kind: 'proxy', pool: input.pool },
    },
  }];
}

export type PutPassthroughRejectOp = {
  op: 'put';
  kind: 'passthroughRoute';
  key: string;
  body: {
    listener: string;
    snis: string[];
    priority: number;
    action: { kind: 'reject' };
  };
};

/**
 * SNI → 끊기. HTTP status 가 없다 — handshake 를 종단하지 않으므로.
 * pool·websocket·path 를 안 붙인다.
 */
export function putPassthroughRejectPatch(input: {
  key: string;
  listener: string;
  snis: readonly string[];
  priority?: number;
}): PutPassthroughRejectOp[] {
  if (input.key === '') throw new Error('키가 비어 있다');
  if (input.listener === '') throw new Error('리스너가 비어 있다');
  const snis = input.snis.map((s) => s.trim()).filter((s) => s !== '');
  if (snis.length === 0) throw new Error('SNI 가 비어 있다');
  const priority = input.priority ?? 0;
  if (!Number.isInteger(priority) || priority < 0) {
    throw new Error('priority 가 0 이상 정수가 아니다');
  }
  return [{
    op: 'put',
    kind: 'passthroughRoute',
    key: input.key,
    body: {
      listener: input.listener,
      snis,
      priority,
      action: { kind: 'reject' },
    },
  }];
}

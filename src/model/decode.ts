/**
 * 런타임 해독기 — `unknown` → `Model` (DESIGN.md §4.9 · §9.1.1)
 *
 * **타입은 런타임 입력을 막지 못한다.** 이걸 두 번 배웠다.
 *
 *   4차: `protocol: 'https'` 가 평문 `listen 443;` 으로 렌더됐다.
 *   6차: 판별 유니온과 `RawModel`/`Model` 두 층을 만든 뒤에도 **같은 반례가 통과했다.**
 *
 * 유니온은 컴파일 타임에만 산다. `validateModel` 은 이미 `RawModel` 이라고 **가정한** 값을
 * 받으므로, JSON 이 들어오는 경계에는 아무 검사도 없었다. 의미 검증을 아무리 늘려도
 * 모르는 enum 값은 의미 검증 이전에 통과한다.
 *
 * 여기가 그 경계다. 세 가지를 지킨다.
 *
 *   1. **모르는 값은 거부한다.** enum 은 아는 것만 통과한다.
 *   2. **모르는 키도 거부한다.** 조용히 무시된 설정은 "저장은 됐는데 동작 안 함" 이 된다.
 *      오타 하나가 의도를 통째로 날린다.
 *   3. **강제 변환하지 않는다.** `"8080"` 은 8080 이 아니라 오류다. 변환은 의미를 바꾼다.
 */
import { validateHeaderName, validateHeaderValue } from '../validate/strings.js';

import type {
  AcmeIntent,
  EngineSettings,
  InboundProxyProtocol,
  Backend,
  Certificate,
  HttpAction,
  HeaderRule,
  HeaderRules,
  HttpProfile,
  ProxyLimits,
  RateLimit,
  HttpRoute,
  Listener,
  Model,
  PassthroughAction,
  PassthroughRoute,
  Pool,
  HealthCheck,
  HstsPolicy,
  SniCertificateBinding,
  SniOutcome,
  TlsPolicy,
  TlsVersion,
} from './provisional.js';
import { validateModel, type ModelIssue, type ValidationCapabilities } from '../validate/model.js';

export type DecodeResult =
  | { ok: true; model: Model }
  | { ok: false; issues: ModelIssue[] };

// ── 수집기 ───────────────────────────────────────────────────────────────

class Issues {
  readonly list: ModelIssue[] = [];

  add(code: ModelIssue['code'], path: string, message: string): void {
    this.list.push({ code, subjects: [path], message });
  }

  get failed(): boolean {
    return this.list.length > 0;
  }
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

// ── 원시 타입 ────────────────────────────────────────────────────────────

function str(iss: Issues, v: unknown, path: string): string | undefined {
  if (typeof v !== 'string') {
    iss.add('invalid_type', path, `문자열이어야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  return v;
}

function bool(iss: Issues, v: unknown, path: string): boolean | undefined {
  if (typeof v !== 'boolean') {
    iss.add('invalid_type', path, `참/거짓이어야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  return v;
}

/** 정수 범위 검사. **변환하지 않는다** — 문자열 숫자는 오류다. */
function int(iss: Issues, v: unknown, path: string, min: number, max: number): number | undefined {
  if (typeof v !== 'number') {
    iss.add('invalid_type', path, `숫자여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  if (!Number.isInteger(v) || v < min || v > max) {
    iss.add('out_of_range', path, `${min}~${max} 의 정수여야 한다 (받은 것: ${v})`);
    return undefined;
  }
  return v;
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return '배열';
  return typeof v;
}

function oneOf<T extends string | number>(
  iss: Issues,
  v: unknown,
  path: string,
  allowed: readonly T[],
): T | undefined {
  if (!(allowed as readonly unknown[]).includes(v)) {
    iss.add(
      'invalid_enum',
      path,
      `아는 값이 아니다: ${JSON.stringify(v)} — 가능한 것은 ${allowed.map((a) => JSON.stringify(a)).join(', ')}`,
    );
    return undefined;
  }
  return v as T;
}

/**
 * 아는 키만 남기고 나머지를 오류로 만든다.
 *
 * 모르는 키를 조용히 버리면 오타가 설정을 통째로 날린다. `defaultPoool` 이 무시되면
 * 기본 풀 없는 리스너가 되고, 그건 렌더에서 사라진다.
 */
function noExtraKeys(iss: Issues, obj: Record<string, unknown>, path: string, known: readonly string[]): void {
  for (const k of Object.keys(obj)) {
    if (!known.includes(k)) {
      iss.add('unknown_field', path, `모르는 필드 '${k}' — 오타이거나 지원하지 않는 설정이다`);
    }
  }
}

function arrayOf<T>(
  iss: Issues,
  v: unknown,
  path: string,
  each: (item: unknown, at: string) => T | undefined,
): T[] {
  if (!Array.isArray(v)) {
    iss.add('invalid_type', path, `배열이어야 한다 (받은 것: ${typeName(v)})`);
    return [];
  }
  const out: T[] = [];
  v.forEach((item, i) => {
    const decoded = each(item, `${path}[${i}]`);
    if (decoded !== undefined) out.push(decoded);
  });
  return out;
}

/** 있으면 해독하고 없으면 undefined. 키 자체가 없는 것과 `undefined` 를 같게 본다. */
function optional<T>(v: unknown, decode: () => T | undefined): T | undefined {
  return v === undefined ? undefined : decode();
}

// ── enum 목록 — **여기 없는 값은 존재하지 않는다** ───────────────────────

const LISTENER_PROTOCOLS = ['http', 'https', 'tls_passthrough', 'tcp', 'udp'] as const;
const TLS_VERSIONS = ['1.2', '1.3'] as const;
const SNI_HOST_MISMATCH = ['allow', 'reject_421'] as const;
const CIPHER_POLICIES = ['modern-2026', 'intermediate-2026'] as const;
const PROTOCOL_CLASSES = ['http', 'tcp', 'udp'] as const;
const ALGORITHMS = ['round_robin', 'source_ip_hash', 'hash', 'least_conn'] as const;
const UDP_PRESETS = ['dns', 'wireguard', 'game_generic', 'custom'] as const;
const REDIRECT_STATUSES = [301, 302, 307, 308] as const;
const REJECT_STATUSES = [403, 404, 444] as const;
const SEND_PROXY_PROTOCOL = ['v1'] as const;

const PORT_MIN = 1;
const PORT_MAX = 65535;

// ── 조각 ─────────────────────────────────────────────────────────────────

function decodeSniOutcome(iss: Issues, v: unknown, path: string): SniOutcome | undefined {
  if (v === 'reject') return 'reject';
  if (!isObject(v)) {
    iss.add('invalid_type', path, `'reject' 이거나 { pool } 이어야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  noExtraKeys(iss, v, path, ['pool']);
  const pool = str(iss, v['pool'], `${path}.pool`);
  return pool === undefined ? undefined : { pool };
}

function decodeHttpProfile(iss: Issues, v: unknown, path: string): HttpProfile | undefined {
  if (!isObject(v)) {
    iss.add('invalid_type', path, `객체여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  noExtraKeys(iss, v, path, ['defaultAction', 'limits', 'headers', 'rateLimit', 'strictPriority']);
  const action = optional(v['defaultAction'], () => decodeSniOutcome(iss, v['defaultAction'], `${path}.defaultAction`));
  const limits = optional(v['limits'], () => decodeProxyLimits(iss, v['limits'], `${path}.limits`));
  const headers = optional(v['headers'], () => decodeHeaderRules(iss, v['headers'], `${path}.headers`));
  const rateLimit = optional(v['rateLimit'], () => decodeRateLimit(iss, v['rateLimit'], `${path}.rateLimit`));
  // S10. **`false` 를 명시한 것과 안 정한 것을 구분하지 않는다** — 동작이 같다.
  const strictPriority = optional(v['strictPriority'], () => bool(iss, v['strictPriority'], `${path}.strictPriority`));
  return {
    ...(action === undefined ? {} : { defaultAction: action }),
    ...(limits === undefined ? {} : { limits }),
    ...(headers === undefined ? {} : { headers }),
    ...(rateLimit === undefined ? {} : { rateLimit }),
    ...(strictPriority === undefined ? {} : { strictPriority }),
  };
}

/**
 * 레이트리밋 (제안 #6).
 *
 * **저장은 되는데 렌더가 못 하는 조합을 만들지 않는다.** `burst`·`nodelay` 는
 * `limit_req` 의 인자라 zone 이 없으면 쓸 데가 없고, 빈 객체는 "안 적음" 과 같다.
 * 둘 다 여기서 막는다 — 안 막으면 저장은 성공하고 아무 일도 안 일어난다.
 */
function decodeRateLimit(iss: Issues, v: unknown, path: string): RateLimit | undefined {
  if (!isObject(v)) {
    iss.add('invalid_type', path, `객체여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  noExtraKeys(iss, v, path, ['requestsPerSecond', 'burst', 'nodelay', 'maxConnections', 'zoneKb']);
  const rps = optional(v['requestsPerSecond'],
    () => int(iss, v['requestsPerSecond'], `${path}.requestsPerSecond`, 1, 1_000_000));
  const burst = optional(v['burst'], () => int(iss, v['burst'], `${path}.burst`, 1, 1_000_000));
  const conns = optional(v['maxConnections'],
    () => int(iss, v['maxConnections'], `${path}.maxConnections`, 1, 1_000_000));
  // nginx 는 너무 작은 zone 을 거절한다. 하한을 주고, 상한은 터무니없는 값만 거른다.
  const zoneKb = optional(v['zoneKb'], () => int(iss, v['zoneKb'], `${path}.zoneKb`, 16, 1_048_576));
  const nodelay = optional(v['nodelay'], () => {
    if (typeof v['nodelay'] !== 'boolean') {
      iss.add('invalid_type', `${path}.nodelay`, `불리언이어야 한다 (받은 것: ${typeName(v['nodelay'])})`);
      return undefined;
    }
    return v['nodelay'];
  });

  if (rps === undefined && (burst !== undefined || nodelay !== undefined)) {
    iss.add('invalid_value', path,
      'burst·nodelay 는 requestsPerSecond 가 있어야 한다 — 무엇의 burst 인지가 없다');
    return undefined;
  }
  if (rps === undefined && conns === undefined) {
    iss.add('invalid_value', path,
      'requestsPerSecond 나 maxConnections 중 하나는 있어야 한다 — 아무것도 안 할 거면 안 적는 것과 같다');
    return undefined;
  }
  return {
    ...(rps === undefined ? {} : { requestsPerSecond: rps }),
    ...(burst === undefined ? {} : { burst }),
    ...(nodelay === undefined ? {} : { nodelay }),
    ...(conns === undefined ? {} : { maxConnections: conns }),
    ...(zoneKb === undefined ? {} : { zoneKb }),
  };
}

/**
 * 렌더러가 **이미 내고 있고 그 위에 다른 것이 서는** 요청 헤더 (제안 #7).
 *
 * 덮게 두면 조용히 끊긴다: `X-Forwarded-*` 는 백엔드가 신뢰하는 클라이언트 IP 사슬이고,
 * `Upgrade`·`Connection` 위에는 websocket 이 선다. 둘 다 증상이 "가끔 안 된다" 라
 * 원인을 못 찾는 종류다.
 *
 * **`Host` 는 없다.** 다른 Host 를 기대하는 백엔드로 프록시하는 것은 정당하고 흔하다 —
 * 막으면 되는 것을 못 쓰게 한다.
 */
const RESERVED_REQUEST_HEADERS = new Set(['x-forwarded-for', 'x-forwarded-proto', 'upgrade', 'connection']);

/** 모델에 자기 필드가 있는 응답 헤더. 출처가 둘이면 싸운다. */
const RESERVED_RESPONSE_HEADERS = new Set(['strict-transport-security']);

function decodeHeaderRules(iss: Issues, v: unknown, path: string): HeaderRules | undefined {
  if (!isObject(v)) {
    iss.add('invalid_type', path, `객체여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  noExtraKeys(iss, v, path, ['request', 'response']);
  const request = optional(v['request'],
    () => decodeHeaderList(iss, v['request'], `${path}.request`, RESERVED_REQUEST_HEADERS));
  const response = optional(v['response'],
    () => decodeHeaderList(iss, v['response'], `${path}.response`, RESERVED_RESPONSE_HEADERS));
  return {
    ...(request === undefined ? {} : { request }),
    ...(response === undefined ? {} : { response }),
  };
}

function decodeHeaderList(
  iss: Issues, v: unknown, path: string, reserved: ReadonlySet<string>,
): HeaderRule[] | undefined {
  if (!Array.isArray(v)) {
    iss.add('invalid_type', path, `배열이어야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  const out: HeaderRule[] = [];
  // **같은 이름을 두 번 적으면 거부한다.** nginx 는 마지막을 쓰지만, 모델이 그걸
  // 말하지 않으므로 "왜 첫 번째가 무시되나" 가 된다. 겹치는 것 자체를 막는다.
  const seen = new Set<string>();
  for (const [i, raw] of v.entries()) {
    const at = `${path}[${i}]`;
    if (!isObject(raw)) {
      iss.add('invalid_type', at, `객체여야 한다 (받은 것: ${typeName(raw)})`);
      continue;
    }
    noExtraKeys(iss, raw, at, ['name', 'value']);
    const name = str(iss, raw['name'], `${at}.name`);
    const value = str(iss, raw['value'], `${at}.value`);
    if (name === undefined || value === undefined) continue;

    const nameCheck = validateHeaderName(name);
    if (!nameCheck.ok) {
      iss.add('invalid_value', `${at}.name`, nameCheck.message);
      continue;
    }
    const valueCheck = validateHeaderValue(value);
    if (!valueCheck.ok) {
      iss.add('invalid_value', `${at}.value`, valueCheck.message);
      continue;
    }
    const lower = name.toLowerCase();
    if (reserved.has(lower)) {
      iss.add('invalid_value', `${at}.name`,
        `'${name}' 은 렌더러가 이미 내고 그 위에 다른 것이 선다 — 덮으면 조용히 끊긴다`);
      continue;
    }
    if (seen.has(lower)) {
      iss.add('duplicate', `${at}.name`, `'${name}' 이 두 번 있다 — 어느 쪽이 이기는지 모델이 안 말한다`);
      continue;
    }
    seen.add(lower);
    out.push({ name, value });
  }
  return out;
}

/**
 * 프록시 한계값 (제안 #8).
 *
 * **상한이 nginx 의 것이다.** `proxy_connect_timeout` 은 75s 를 넘기면 조용히 무시되고,
 * 그러면 운영자는 자기가 정한 값이 왜 안 먹는지 영영 못 찾는다 — 저장 단계에서 막는다.
 * 나머지 둘에는 그런 하드 상한이 없으므로 "터무니없는 값" 만 거른다(24시간).
 *
 * 타임아웃 `0` 은 거부한다 — nginx 가 안 받는다. `clientMaxBodyBytes` 의 `0` 은 반대로
 * **의미가 있다**(무제한). 같은 숫자가 두 자리에서 다른 뜻이라 하한을 따로 준다.
 */
function decodeProxyLimits(iss: Issues, v: unknown, path: string): ProxyLimits | undefined {
  if (!isObject(v)) {
    iss.add('invalid_type', path, `객체여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  noExtraKeys(iss, v, path, [
    'connectTimeoutMs', 'readTimeoutMs', 'sendTimeoutMs', 'clientMaxBodyBytes',
  ]);
  const DAY_MS = 86_400_000;
  const connect = optional(v['connectTimeoutMs'],
    () => int(iss, v['connectTimeoutMs'], `${path}.connectTimeoutMs`, 1, 75_000));
  const read = optional(v['readTimeoutMs'],
    () => int(iss, v['readTimeoutMs'], `${path}.readTimeoutMs`, 1, DAY_MS));
  const send = optional(v['sendTimeoutMs'],
    () => int(iss, v['sendTimeoutMs'], `${path}.sendTimeoutMs`, 1, DAY_MS));
  // **`0` 이 무제한이라 하한이 0 이다.** 상한은 nginx 가 부호 있는 크기로 다루는 범위.
  const body = optional(v['clientMaxBodyBytes'],
    () => int(iss, v['clientMaxBodyBytes'], `${path}.clientMaxBodyBytes`, 0, 2 ** 31 - 1));
  return {
    ...(connect === undefined ? {} : { connectTimeoutMs: connect }),
    ...(read === undefined ? {} : { readTimeoutMs: read }),
    ...(send === undefined ? {} : { sendTimeoutMs: send }),
    ...(body === undefined ? {} : { clientMaxBodyBytes: body }),
  };
}

function decodeHttpAction(iss: Issues, v: unknown, path: string): HttpAction | undefined {
  if (!isObject(v)) {
    iss.add('invalid_type', path, `객체여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  const kind = oneOf(iss, v['kind'], `${path}.kind`, ['proxy', 'redirect', 'reject'] as const);
  if (kind === undefined) return undefined;

  if (kind === 'proxy') {
    noExtraKeys(iss, v, path, ['kind', 'pool', 'websocket']);
    const pool = str(iss, v['pool'], `${path}.pool`);
    const websocket = bool(iss, v['websocket'], `${path}.websocket`);
    return pool === undefined || websocket === undefined ? undefined : { kind, pool, websocket };
  }
  if (kind === 'redirect') {
    noExtraKeys(iss, v, path, ['kind', 'to', 'status']);
    const to = str(iss, v['to'], `${path}.to`);
    const status = oneOf(iss, v['status'], `${path}.status`, REDIRECT_STATUSES);
    return to === undefined || status === undefined ? undefined : { kind, to, status };
  }
  noExtraKeys(iss, v, path, ['kind', 'status']);
  const status = oneOf(iss, v['status'], `${path}.status`, REJECT_STATUSES);
  return status === undefined ? undefined : { kind, status };
}

function decodePassthroughAction(iss: Issues, v: unknown, path: string): PassthroughAction | undefined {
  if (!isObject(v)) {
    iss.add('invalid_type', path, `객체여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  const kind = oneOf(iss, v['kind'], `${path}.kind`, ['proxy', 'reject'] as const);
  if (kind === undefined) return undefined;
  if (kind === 'reject') {
    noExtraKeys(iss, v, path, ['kind']);
    return { kind };
  }
  noExtraKeys(iss, v, path, ['kind', 'pool']);
  const pool = str(iss, v['pool'], `${path}.pool`);
  return pool === undefined ? undefined : { kind, pool };
}

// ── 리스너 — 프로토콜별로 아는 필드가 다르다 ───────────────────────────

const LISTENER_BASE = ['key', 'protocol', 'bind', 'port', 'enabled'] as const;

/**
 * 인바운드 PROXY 수신 (§4.7).
 *
 * **불리언을 안 받는다.** 옛 모양(`acceptProxyProtocol: true`)을 관대하게 받아 주면 그
 * 편의가 곧 기본값이 되고, 신뢰 경계 없는 설정이 그대로 굳는다. 명시적으로 거부하고
 * 무엇으로 바꿔야 하는지 말해 준다.
 */
function decodeInboundProxyProtocol(
  iss: Issues, v: unknown, path: string,
): InboundProxyProtocol | undefined {
  if (typeof v === 'boolean') {
    iss.add('invalid_type', path,
      'PROXY 수신은 켜고 끄는 값이 아니다. `{ "trustedCidrs": ["10.0.0.0/8"] }` 처럼 '
      + '**믿어 줄 앞단**을 적어야 한다 — 신뢰 경계가 없으면 클라이언트가 자기 IP 를 정한다');
    return undefined;
  }
  if (!isObject(v)) {
    iss.add('invalid_type', path, `객체여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  noExtraKeys(iss, v, path, ['trustedCidrs']);
  if (v['trustedCidrs'] === undefined) {
    iss.add('missing_field', `${path}.trustedCidrs`, '필수다 — 비어 있을 수 없다 (§4.7)');
    return undefined;
  }
  const cidrs = arrayOf(iss, v['trustedCidrs'], `${path}.trustedCidrs`,
    (item, at) => str(iss, item, at));
  if (cidrs.length === 0) {
    iss.add('out_of_range', `${path}.trustedCidrs`,
      '비어 있을 수 없다 — 아무도 안 믿을 거면 PROXY 수신을 켜지 않는다');
    return undefined;
  }
  return { trustedCidrs: cidrs };
}

function decodeListener(iss: Issues, v: unknown, path: string): Listener | undefined {
  if (!isObject(v)) {
    iss.add('invalid_type', path, `객체여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  const protocol = oneOf(iss, v['protocol'], `${path}.protocol`, LISTENER_PROTOCOLS);
  if (protocol === undefined) return undefined;

  const key = required(iss, v, 'key', path, () => str(iss, v['key'], `${path}.key`));
  const bind = required(iss, v, 'bind', path, () => str(iss, v['bind'], `${path}.bind`));
  const port = required(iss, v, 'port', path, () => int(iss, v['port'], `${path}.port`, PORT_MIN, PORT_MAX));
  const enabled = required(iss, v, 'enabled', path, () => bool(iss, v['enabled'], `${path}.enabled`));
  if (key === undefined || bind === undefined || port === undefined || enabled === undefined) return undefined;
  const head = { key, bind, port, enabled };

  switch (protocol) {
    case 'http': {
      noExtraKeys(iss, v, path, [...LISTENER_BASE, 'acceptProxyProtocol', 'http']);
      const accept = optional(v['acceptProxyProtocol'], () => decodeInboundProxyProtocol(iss, v['acceptProxyProtocol'], `${path}.acceptProxyProtocol`));
      const http = optional(v['http'], () => decodeHttpProfile(iss, v['http'], `${path}.http`));
      return {
        ...head, protocol,
        ...(accept === undefined ? {} : { acceptProxyProtocol: accept }),
        ...(http === undefined ? {} : { http }),
      };
    }
    case 'https': {
      noExtraKeys(iss, v, path, [...LISTENER_BASE, 'acceptProxyProtocol', 'http', 'tls', 'http2']);
      const accept = optional(v['acceptProxyProtocol'], () => decodeInboundProxyProtocol(iss, v['acceptProxyProtocol'], `${path}.acceptProxyProtocol`));
      const http = optional(v['http'], () => decodeHttpProfile(iss, v['http'], `${path}.http`));
      // **`tls` 는 필수다.** 없으면 렌더러가 인증서를 지어내거나 평문으로 내야 한다 —
      // v3 이 정확히 그렇게 깨졌다. 여기서 막는다.
      const tls = required(iss, v, 'tls', path, () => decodeTlsBinding(iss, v['tls'], `${path}.tls`));
      const http2 = optional(v['http2'], () => bool(iss, v['http2'], `${path}.http2`));
      if (tls === undefined) return undefined;
      return {
        ...head, protocol, tls,
        ...(accept === undefined ? {} : { acceptProxyProtocol: accept }),
        ...(http === undefined ? {} : { http }),
        ...(http2 === undefined ? {} : { http2 }),
      };
    }
    case 'tls_passthrough': {
      noExtraKeys(iss, v, path, [...LISTENER_BASE, 'acceptProxyProtocol', 'onUnmatchedSni', 'onNoSni', 'prereadTimeoutS']);
      const accept = optional(v['acceptProxyProtocol'], () => decodeInboundProxyProtocol(iss, v['acceptProxyProtocol'], `${path}.acceptProxyProtocol`));
      const sni = optional(v['onUnmatchedSni'], () => decodeSniOutcome(iss, v['onUnmatchedSni'], `${path}.onUnmatchedSni`));
      const noSni = optional(v['onNoSni'], () => decodeSniOutcome(iss, v['onNoSni'], `${path}.onNoSni`));
      const preread = optional(v['prereadTimeoutS'], () => int(iss, v['prereadTimeoutS'], `${path}.prereadTimeoutS`, 1, 3600));
      return {
        ...head, protocol,
        ...(accept === undefined ? {} : { acceptProxyProtocol: accept }),
        ...(sni === undefined ? {} : { onUnmatchedSni: sni }),
        ...(noSni === undefined ? {} : { onNoSni: noSni }),
        ...(preread === undefined ? {} : { prereadTimeoutS: preread }),
      };
    }
    case 'tcp': {
      noExtraKeys(iss, v, path, [...LISTENER_BASE, 'acceptProxyProtocol', 'defaultPool']);
      const accept = optional(v['acceptProxyProtocol'], () => decodeInboundProxyProtocol(iss, v['acceptProxyProtocol'], `${path}.acceptProxyProtocol`));
      // 라우트가 없는 리스너는 기본 풀이 **필수**다. 없으면 렌더에서 통째로 빠진다.
      const defaultPool = required(iss, v, 'defaultPool', path, () => str(iss, v['defaultPool'], `${path}.defaultPool`));
      if (defaultPool === undefined) return undefined;
      return { ...head, protocol, defaultPool, ...(accept === undefined ? {} : { acceptProxyProtocol: accept }) };
    }
    case 'udp': {
      noExtraKeys(iss, v, path, [...LISTENER_BASE, 'defaultPool', 'udp']);
      const defaultPool = required(iss, v, 'defaultPool', path, () => str(iss, v['defaultPool'], `${path}.defaultPool`));
      // 프로필이 없으면 렌더러가 `custom` 기본값으로 **의미를 만들어 낸다.** 명시를 요구한다.
      const udpRaw = required(iss, v, 'udp', path, () => v['udp']);
      if (defaultPool === undefined || udpRaw === undefined) return undefined;
      if (!isObject(udpRaw)) {
        iss.add('invalid_type', `${path}.udp`, `객체여야 한다 (받은 것: ${typeName(udpRaw)})`);
        return undefined;
      }
      noExtraKeys(iss, udpRaw, `${path}.udp`, ['preset']);
      const preset = oneOf(iss, udpRaw['preset'], `${path}.udp.preset`, UDP_PRESETS);
      return preset === undefined ? undefined : { ...head, protocol, defaultPool, udp: { preset } };
    }
  }
}

/** 없으면 `missing_field`, 있으면 해독. */
function required<T>(
  iss: Issues,
  obj: Record<string, unknown>,
  field: string,
  path: string,
  decode: () => T | undefined,
): T | undefined {
  if (obj[field] === undefined) {
    iss.add('missing_field', path, `'${field}' 가 없다`);
    return undefined;
  }
  return decode();
}

// ── 나머지 ───────────────────────────────────────────────────────────────

function decodePool(iss: Issues, v: unknown, path: string): Pool | undefined {
  if (!isObject(v)) {
    iss.add('invalid_type', path, `객체여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  noExtraKeys(iss, v, path,
    ['key', 'protocolClass', 'algorithm', 'hashKey', 'sendProxyProtocol', 'healthCheck']);
  const key = required(iss, v, 'key', path, () => str(iss, v['key'], `${path}.key`));
  const protocolClass = required(iss, v, 'protocolClass', path, () =>
    oneOf(iss, v['protocolClass'], `${path}.protocolClass`, PROTOCOL_CLASSES));
  const algorithm = required(iss, v, 'algorithm', path, () =>
    oneOf(iss, v['algorithm'], `${path}.algorithm`, ALGORITHMS));
  const hashKey = optional(v['hashKey'], () => str(iss, v['hashKey'], `${path}.hashKey`));
  const send = optional(v['sendProxyProtocol'], () =>
    oneOf(iss, v['sendProxyProtocol'], `${path}.sendProxyProtocol`, SEND_PROXY_PROTOCOL));
  const healthCheck = optional(v['healthCheck'], () =>
    decodeHealthCheck(iss, v['healthCheck'], `${path}.healthCheck`));
  if (key === undefined || protocolClass === undefined || algorithm === undefined) return undefined;
  return {
    key, protocolClass, algorithm,
    ...(hashKey === undefined ? {} : { hashKey }),
    ...(send === undefined ? {} : { sendProxyProtocol: send }),
    ...(healthCheck === undefined ? {} : { healthCheck }),
  };
}

/**
 * HTTP 헬스체크 (검수 B-07).
 *
 * **`expectStatus` 는 비어 있을 수 없다.** 빈 배열은 "아무 상태도 산 것이 아니다" 가 되어
 * 그 풀이 영원히 죽는다 — 조용히 통과시키면 원인이 안 보이는 장애가 된다.
 */
function decodeHealthCheck(iss: Issues, v: unknown, path: string): HealthCheck | undefined {
  if (!isObject(v)) {
    iss.add('invalid_type', path, `객체여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  noExtraKeys(iss, v, path, ['path', 'expectStatus', 'expectBody']);
  const p = optional(v['path'], () => str(iss, v['path'], `${path}.path`));
  const expectBody = optional(v['expectBody'], () => str(iss, v['expectBody'], `${path}.expectBody`));
  const expectStatus = optional(v['expectStatus'], () => {
    const list = arrayOf(iss, v['expectStatus'], `${path}.expectStatus`,
      (s, at) => int(iss, s, at, 100, 599));
    if (list.length === 0) {
      iss.add('out_of_range', `${path}.expectStatus`,
        '비어 있을 수 없다 — 아무 상태도 산 것이 아니면 그 풀은 영원히 죽는다');
      return undefined;
    }
    return list;
  });
  return {
    ...(p === undefined ? {} : { path: p }),
    ...(expectStatus === undefined ? {} : { expectStatus }),
    ...(expectBody === undefined ? {} : { expectBody }),
  };
}

function decodeBackend(iss: Issues, v: unknown, path: string): Backend | undefined {
  if (!isObject(v)) {
    iss.add('invalid_type', path, `객체여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  noExtraKeys(iss, v, path, ['key', 'pool', 'host', 'port', 'weight']);
  const key = required(iss, v, 'key', path, () => str(iss, v['key'], `${path}.key`));
  const pool = required(iss, v, 'pool', path, () => str(iss, v['pool'], `${path}.pool`));
  const host = required(iss, v, 'host', path, () => str(iss, v['host'], `${path}.host`));
  const port = required(iss, v, 'port', path, () => int(iss, v['port'], `${path}.port`, PORT_MIN, PORT_MAX));
  const weight = required(iss, v, 'weight', path, () => int(iss, v['weight'], `${path}.weight`, 0, 1_000_000));
  if (key === undefined || pool === undefined || host === undefined || port === undefined || weight === undefined) {
    return undefined;
  }
  return { key, pool, host, port, weight };
}

function decodeHttpRoute(iss: Issues, v: unknown, path: string): HttpRoute | undefined {
  if (!isObject(v)) {
    iss.add('invalid_type', path, `객체여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  noExtraKeys(iss, v, path, ['key', 'listener', 'hosts', 'priority', 'pathPrefix', 'action']);
  const key = required(iss, v, 'key', path, () => str(iss, v['key'], `${path}.key`));
  const listener = required(iss, v, 'listener', path, () => str(iss, v['listener'], `${path}.listener`));
  const hosts = required(iss, v, 'hosts', path, () =>
    arrayOf(iss, v['hosts'], `${path}.hosts`, (h, at) => str(iss, h, at)));
  const priority = required(iss, v, 'priority', path, () =>
    int(iss, v['priority'], `${path}.priority`, 0, 1_000_000));
  const pathPrefix = optional(v['pathPrefix'], () => str(iss, v['pathPrefix'], `${path}.pathPrefix`));
  const action = required(iss, v, 'action', path, () => decodeHttpAction(iss, v['action'], `${path}.action`));
  if (key === undefined || listener === undefined || hosts === undefined || priority === undefined || action === undefined) {
    return undefined;
  }
  return { key, listener, hosts, priority, action, ...(pathPrefix === undefined ? {} : { pathPrefix }) };
}

function decodePassthroughRoute(iss: Issues, v: unknown, path: string): PassthroughRoute | undefined {
  if (!isObject(v)) {
    iss.add('invalid_type', path, `객체여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  noExtraKeys(iss, v, path, ['key', 'listener', 'snis', 'priority', 'action']);
  const key = required(iss, v, 'key', path, () => str(iss, v['key'], `${path}.key`));
  const listener = required(iss, v, 'listener', path, () => str(iss, v['listener'], `${path}.listener`));
  const snis = required(iss, v, 'snis', path, () =>
    arrayOf(iss, v['snis'], `${path}.snis`, (h, at) => str(iss, h, at)));
  const priority = required(iss, v, 'priority', path, () =>
    int(iss, v['priority'], `${path}.priority`, 0, 1_000_000));
  const action = required(iss, v, 'action', path, () => decodePassthroughAction(iss, v['action'], `${path}.action`));
  if (key === undefined || listener === undefined || snis === undefined || priority === undefined || action === undefined) {
    return undefined;
  }
  return { key, listener, snis, priority, action };
}

function decodeTlsBinding(
  iss: Issues, v: unknown, path: string,
): { policy: string; defaultCertificate: string } | undefined {
  if (!isObject(v)) {
    iss.add('invalid_type', path, `객체여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  noExtraKeys(iss, v, path, ['policy', 'defaultCertificate']);
  const policy = required(iss, v, 'policy', path, () => str(iss, v['policy'], `${path}.policy`));
  const defaultCertificate = required(iss, v, 'defaultCertificate', path, () =>
    str(iss, v['defaultCertificate'], `${path}.defaultCertificate`));
  if (policy === undefined || defaultCertificate === undefined) return undefined;
  return { policy, defaultCertificate };
}

/**
 * 인증서 **메타데이터**를 해독한다.
 *
 * **`fullchain`·`privkey` 라는 키는 여기 없다.** `noExtraKeys` 가 그런 입력을 거절한다 —
 * 자료는 SecretStore 로만 들어가고(§4.8), 모델을 통해 들어오는 경로를 만들지 않는다.
 * 실수로 넣으면 조용히 무시되는 게 아니라 **에러가 난다.**
 */
function decodeCertificate(iss: Issues, v: unknown, path: string): Certificate | undefined {
  if (!isObject(v)) {
    iss.add('invalid_type', path, `객체여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  noExtraKeys(iss, v, path, ['key', 'materialRef', 'chainDigest', 'keyDigest', 'acme']);
  const key = required(iss, v, 'key', path, () => str(iss, v['key'], `${path}.key`));
  const materialRef = optional(v['materialRef'], () => str(iss, v['materialRef'], `${path}.materialRef`));
  const chainDigest = optional(v['chainDigest'], () => str(iss, v['chainDigest'], `${path}.chainDigest`));
  const keyDigest = optional(v['keyDigest'], () => str(iss, v['keyDigest'], `${path}.keyDigest`));
  const acme = optional(v['acme'], () => decodeAcmeIntent(iss, v['acme'], `${path}.acme`));
  if (key === undefined) return undefined;

  // **자료는 셋이 함께 온다.** 참조만 있고 digest 가 없으면 세대 결박을 검증할 수 없고,
  // digest 만 있고 참조가 없으면 무엇의 digest 인지 알 수 없다. 반쪽을 허용하면 그
  // 반쪽이 언젠가 들어온다.
  const parts = [materialRef, chainDigest, keyDigest].filter((x) => x !== undefined).length;
  if (parts !== 0 && parts !== 3) {
    iss.add('missing_field', path,
      'materialRef·chainDigest·keyDigest 는 셋 다 있거나 셋 다 없어야 한다');
    return undefined;
  }
  // 자료도 없고 ACME 의도도 없으면 이 인증서는 **아무것도 아니다.**
  if (parts === 0 && acme === undefined) {
    iss.add('missing_field', path,
      '자료(materialRef)도 ACME 의도(acme)도 없다 — 이 인증서는 아무 일도 못 한다');
    return undefined;
  }

  return {
    key,
    ...(materialRef === undefined ? {} : { materialRef }),
    ...(chainDigest === undefined ? {} : { chainDigest }),
    ...(keyDigest === undefined ? {} : { keyDigest }),
    ...(acme === undefined ? {} : { acme }),
  };
}

function decodeAcmeIntent(iss: Issues, v: unknown, path: string): AcmeIntent | undefined {
  if (!isObject(v)) {
    iss.add('invalid_type', path, `객체여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  noExtraKeys(iss, v, path, ['account', 'domains']);
  const account = required(iss, v, 'account', path, () => str(iss, v['account'], `${path}.account`));
  const domains = required(iss, v, 'domains', path, () =>
    arrayOf(iss, v['domains'], `${path}.domains`, (d, at) => str(iss, d, at)));
  if (account === undefined || domains === undefined) return undefined;
  return { account, domains };
}

function decodeTlsPolicy(iss: Issues, v: unknown, path: string): TlsPolicy | undefined {
  if (!isObject(v)) {
    iss.add('invalid_type', path, `객체여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  noExtraKeys(iss, v, path,
    ['key', 'minVersion', 'maxVersion', 'sniHostMismatch', 'cipherPolicy', 'hsts']);
  const key = required(iss, v, 'key', path, () => str(iss, v['key'], `${path}.key`));
  const minVersion = required(iss, v, 'minVersion', path, () =>
    oneOf(iss, v['minVersion'], `${path}.minVersion`, TLS_VERSIONS));
  const maxVersion = optional(v['maxVersion'], () =>
    oneOf(iss, v['maxVersion'], `${path}.maxVersion`, TLS_VERSIONS));
  const mismatch = optional(v['sniHostMismatch'], () =>
    oneOf(iss, v['sniHostMismatch'], `${path}.sniHostMismatch`, SNI_HOST_MISMATCH));
  const cipherPolicy = optional(v['cipherPolicy'], () =>
    oneOf(iss, v['cipherPolicy'], `${path}.cipherPolicy`, CIPHER_POLICIES));
  const hsts = optional(v['hsts'], () => decodeHsts(iss, v['hsts'], `${path}.hsts`));
  if (key === undefined || minVersion === undefined) return undefined;
  return {
    key, minVersion,
    ...(maxVersion === undefined ? {} : { maxVersion }),
    ...(mismatch === undefined ? {} : { sniHostMismatch: mismatch }),
    ...(cipherPolicy === undefined ? {} : { cipherPolicy }),
    ...(hsts === undefined ? {} : { hsts }),
  };
}

function decodeHsts(iss: Issues, v: unknown, path: string): HstsPolicy | undefined {
  if (!isObject(v)) {
    iss.add('invalid_type', path, `객체여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  noExtraKeys(iss, v, path, ['maxAgeSeconds', 'includeSubdomains', 'preload']);
  // **상한을 둔다.** 2 년을 넘기면 실수로 적은 숫자와 구분이 안 되고, 되돌릴 수 없는
  // 설정에서 오타는 비싸다.
  const maxAgeSeconds = required(iss, v, 'maxAgeSeconds', path, () =>
    int(iss, v['maxAgeSeconds'], `${path}.maxAgeSeconds`, 0, 63_072_000));
  const includeSubdomains = optional(v['includeSubdomains'], () =>
    bool(iss, v['includeSubdomains'], `${path}.includeSubdomains`));
  const preload = optional(v['preload'], () => bool(iss, v['preload'], `${path}.preload`));
  if (maxAgeSeconds === undefined) return undefined;
  return {
    maxAgeSeconds,
    ...(includeSubdomains === undefined ? {} : { includeSubdomains }),
    ...(preload === undefined ? {} : { preload }),
  };
}

function decodeSniBinding(iss: Issues, v: unknown, path: string): SniCertificateBinding | undefined {
  if (!isObject(v)) {
    iss.add('invalid_type', path, `객체여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  noExtraKeys(iss, v, path, ['key', 'listener', 'hosts', 'certificate', 'override']);
  const key = required(iss, v, 'key', path, () => str(iss, v['key'], `${path}.key`));
  const listener = required(iss, v, 'listener', path, () => str(iss, v['listener'], `${path}.listener`));
  const hosts = required(iss, v, 'hosts', path, () =>
    arrayOf(iss, v['hosts'], `${path}.hosts`, (h, at) => str(iss, h, at)));
  const certificate = required(iss, v, 'certificate', path, () => str(iss, v['certificate'], `${path}.certificate`));
  const override = optional(v['override'], () => decodeTlsOverride(iss, v['override'], `${path}.override`));
  if (key === undefined || listener === undefined || hosts === undefined || certificate === undefined) {
    return undefined;
  }
  return { key, listener, hosts, certificate, ...(override === undefined ? {} : { override }) };
}

function decodeTlsOverride(
  iss: Issues, v: unknown, path: string,
): { minVersion?: TlsVersion; maxVersion?: TlsVersion } | undefined {
  if (!isObject(v)) {
    iss.add('invalid_type', path, `객체여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  noExtraKeys(iss, v, path, ['minVersion', 'maxVersion']);
  const minVersion = optional(v['minVersion'], () => oneOf(iss, v['minVersion'], `${path}.minVersion`, TLS_VERSIONS));
  const maxVersion = optional(v['maxVersion'], () => oneOf(iss, v['maxVersion'], `${path}.maxVersion`, TLS_VERSIONS));
  return {
    ...(minVersion === undefined ? {} : { minVersion }),
    ...(maxVersion === undefined ? {} : { maxVersion }),
  };
}

// ── 입구 ─────────────────────────────────────────────────────────────────

const MODEL_KEYS = [
  'engine',
  'listeners', 'httpRoutes', 'passthroughRoutes', 'pools', 'backends',
  'certificates', 'tlsPolicies', 'sniBindings',
] as const;

function decodeEngineSettings(iss: Issues, v: unknown, path: string): EngineSettings | undefined {
  if (!isObject(v)) {
    iss.add('invalid_type', path, `객체여야 한다 (받은 것: ${typeName(v)})`);
    return undefined;
  }
  noExtraKeys(iss, v, path,
    ['workerShutdownTimeoutS', 'membershipDictKb', 'acmeDictKb']);
  // **상한을 둔다.** 하루를 넘기는 값은 "무한" 과 구분이 안 되고, 그럴 거면 안 적는 것이
  // 정직하다.
  const t = optional(v['workerShutdownTimeoutS'], () =>
    int(iss, v['workerShutdownTimeoutS'], `${path}.workerShutdownTimeoutS`, 1, 86_400));
  // **하한이 있다.** nginx 는 너무 작은 dict 를 아예 거절하고, 그 실패는 apply 시점에
  // 난다. 상한은 1 GiB — 그보다 큰 값은 오타와 구분이 안 된다 (검수 B-12).
  const membership = optional(v['membershipDictKb'], () =>
    int(iss, v['membershipDictKb'], `${path}.membershipDictKb`, 64, 1_048_576));
  const acme = optional(v['acmeDictKb'], () =>
    int(iss, v['acmeDictKb'], `${path}.acmeDictKb`, 32, 1_048_576));
  return {
    ...(t === undefined ? {} : { workerShutdownTimeoutS: t }),
    ...(membership === undefined ? {} : { membershipDictKb: membership }),
    ...(acme === undefined ? {} : { acmeDictKb: acme }),
  };
}

/**
 * `unknown` 을 `Model` 로 해독한다. **모양과 타입만** 본다 — 참조 무결성 같은 의미
 * 검증은 `validateModel` 의 몫이다. 둘 다 필요하면 `parseModel` 을 쓴다.
 */
export function decodeModel(input: unknown): DecodeResult {
  const iss = new Issues();
  if (!isObject(input)) {
    iss.add('invalid_type', 'model', `객체여야 한다 (받은 것: ${typeName(input)})`);
    return { ok: false, issues: iss.list };
  }
  noExtraKeys(iss, input, 'model', MODEL_KEYS);

  const model: Model = {
    ...(input['engine'] === undefined ? {} : (() => {
      const e = decodeEngineSettings(iss, input['engine'], 'engine');
      return e === undefined ? {} : { engine: e };
    })()),
    listeners: arrayOf(iss, input['listeners'] ?? [], 'listeners', (v, at) => decodeListener(iss, v, at)),
    httpRoutes: arrayOf(iss, input['httpRoutes'] ?? [], 'httpRoutes', (v, at) => decodeHttpRoute(iss, v, at)),
    passthroughRoutes: arrayOf(iss, input['passthroughRoutes'] ?? [], 'passthroughRoutes', (v, at) =>
      decodePassthroughRoute(iss, v, at)),
    pools: arrayOf(iss, input['pools'] ?? [], 'pools', (v, at) => decodePool(iss, v, at)),
    backends: arrayOf(iss, input['backends'] ?? [], 'backends', (v, at) => decodeBackend(iss, v, at)),
    certificates: arrayOf(iss, input['certificates'] ?? [], 'certificates', (v, at) => decodeCertificate(iss, v, at)),
    tlsPolicies: arrayOf(iss, input['tlsPolicies'] ?? [], 'tlsPolicies', (v, at) => decodeTlsPolicy(iss, v, at)),
    sniBindings: arrayOf(iss, input['sniBindings'] ?? [], 'sniBindings', (v, at) => decodeSniBinding(iss, v, at)),
  };

  return iss.failed ? { ok: false, issues: iss.list } : { ok: true, model };
}

/**
 * 해독 + 의미 검증. **저장 경로는 이걸 쓴다.**
 *
 * 해독이 실패하면 의미 검증을 돌리지 않는다. 모양이 깨진 값에 참조 무결성을 물어 봐야
 * 어차피 쓰레기가 나오고, 진짜 원인이 오류 더미에 묻힌다.
 */
export function parseModel(
  input: unknown,
  caps: ValidationCapabilities = { streamRealip: false },
): DecodeResult {
  const decoded = decodeModel(input);
  if (!decoded.ok) return decoded;
  const issues = validateModel(decoded.model, caps);
  return issues.length > 0 ? { ok: false, issues } : decoded;
}

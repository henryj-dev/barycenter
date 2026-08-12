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
import type {
  Backend,
  HttpAction,
  HttpProfile,
  HttpRoute,
  Listener,
  Model,
  PassthroughAction,
  PassthroughRoute,
  Pool,
  SniOutcome,
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

const LISTENER_PROTOCOLS = ['http', 'tls_passthrough', 'tcp', 'udp'] as const;
const PROTOCOL_CLASSES = ['http', 'tcp', 'udp'] as const;
const ALGORITHMS = ['round_robin', 'source_ip_hash', 'hash'] as const;
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
  noExtraKeys(iss, v, path, ['defaultAction']);
  const action = optional(v['defaultAction'], () => decodeSniOutcome(iss, v['defaultAction'], `${path}.defaultAction`));
  return action === undefined ? {} : { defaultAction: action };
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
      const accept = optional(v['acceptProxyProtocol'], () => bool(iss, v['acceptProxyProtocol'], `${path}.acceptProxyProtocol`));
      const http = optional(v['http'], () => decodeHttpProfile(iss, v['http'], `${path}.http`));
      return {
        ...head, protocol,
        ...(accept === undefined ? {} : { acceptProxyProtocol: accept }),
        ...(http === undefined ? {} : { http }),
      };
    }
    case 'tls_passthrough': {
      noExtraKeys(iss, v, path, [...LISTENER_BASE, 'acceptProxyProtocol', 'onUnmatchedSni', 'prereadTimeoutS']);
      const accept = optional(v['acceptProxyProtocol'], () => bool(iss, v['acceptProxyProtocol'], `${path}.acceptProxyProtocol`));
      const sni = optional(v['onUnmatchedSni'], () => decodeSniOutcome(iss, v['onUnmatchedSni'], `${path}.onUnmatchedSni`));
      const preread = optional(v['prereadTimeoutS'], () => int(iss, v['prereadTimeoutS'], `${path}.prereadTimeoutS`, 1, 3600));
      return {
        ...head, protocol,
        ...(accept === undefined ? {} : { acceptProxyProtocol: accept }),
        ...(sni === undefined ? {} : { onUnmatchedSni: sni }),
        ...(preread === undefined ? {} : { prereadTimeoutS: preread }),
      };
    }
    case 'tcp': {
      noExtraKeys(iss, v, path, [...LISTENER_BASE, 'acceptProxyProtocol', 'defaultPool']);
      const accept = optional(v['acceptProxyProtocol'], () => bool(iss, v['acceptProxyProtocol'], `${path}.acceptProxyProtocol`));
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
  noExtraKeys(iss, v, path, ['key', 'protocolClass', 'algorithm', 'hashKey', 'sendProxyProtocol']);
  const key = required(iss, v, 'key', path, () => str(iss, v['key'], `${path}.key`));
  const protocolClass = required(iss, v, 'protocolClass', path, () =>
    oneOf(iss, v['protocolClass'], `${path}.protocolClass`, PROTOCOL_CLASSES));
  const algorithm = required(iss, v, 'algorithm', path, () =>
    oneOf(iss, v['algorithm'], `${path}.algorithm`, ALGORITHMS));
  const hashKey = optional(v['hashKey'], () => str(iss, v['hashKey'], `${path}.hashKey`));
  const send = optional(v['sendProxyProtocol'], () =>
    oneOf(iss, v['sendProxyProtocol'], `${path}.sendProxyProtocol`, SEND_PROXY_PROTOCOL));
  if (key === undefined || protocolClass === undefined || algorithm === undefined) return undefined;
  return {
    key, protocolClass, algorithm,
    ...(hashKey === undefined ? {} : { hashKey }),
    ...(send === undefined ? {} : { sendProxyProtocol: send }),
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

// ── 입구 ─────────────────────────────────────────────────────────────────

const MODEL_KEYS = ['listeners', 'httpRoutes', 'passthroughRoutes', 'pools', 'backends'] as const;

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
    listeners: arrayOf(iss, input['listeners'] ?? [], 'listeners', (v, at) => decodeListener(iss, v, at)),
    httpRoutes: arrayOf(iss, input['httpRoutes'] ?? [], 'httpRoutes', (v, at) => decodeHttpRoute(iss, v, at)),
    passthroughRoutes: arrayOf(iss, input['passthroughRoutes'] ?? [], 'passthroughRoutes', (v, at) =>
      decodePassthroughRoute(iss, v, at)),
    pools: arrayOf(iss, input['pools'] ?? [], 'pools', (v, at) => decodePool(iss, v, at)),
    backends: arrayOf(iss, input['backends'] ?? [], 'backends', (v, at) => decodeBackend(iss, v, at)),
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

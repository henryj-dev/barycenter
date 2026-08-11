/**
 * 사용자 문자열 문법 계약 — DESIGN.md §4.9
 *
 * 원칙: 어떤 사용자 문자열도 raw nginx 디렉티브로 흘러들지 않는다.
 * 여기서 통과한 값만 conf AST 의 리터럴이 될 수 있고, 이스케이프는 직렬화가 맡는다 (src/conf/ast.ts).
 *
 * 방어는 두 겹이다.
 *   1) 입력 문자셋을 좁게 잡아 애초에 위험한 문자를 들이지 않는다 (여기)
 *   2) 그래도 남는 것은 직렬화가 인용·이스케이프한다 (ast.ts)
 * 한 겹만으로는 부족하다 — 1 은 실수로 넓어질 수 있고, 2 는 값이 아닌 위치엔 못 쓴다.
 */
import { err, ok, type Result } from './result.js';
import type { ProtocolClass } from '../model/provisional.js';

/** 호스트 원문에 허용하는 문자: ASCII 영숫자 · 하이픈 · 점 · 그리고 비-ASCII(IDNA 대상). */
const HOST_RAW_ALLOWED = /^[A-Za-z0-9.\-\u0080-\uFFFF]+$/;
const LDH_LABEL = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/;

/** RFC 9110 token */
const TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** 헤더 값에서 참조를 허용하는 nginx 변수. 화이트리스트 밖은 전부 거부한다. */
const ALLOWED_VARIABLES = new Set([
  'host',
  'scheme',
  'request_uri',
  'remote_addr',
  'remote_port',
  'server_addr',
  'server_port',
  'server_name',
  'http_upgrade',
  'connection_upgrade',
  'proxy_add_x_forwarded_for',
  'proxy_protocol_addr',
  'ssl_preread_server_name',
  'ssl_preread_protocol',
]);

/**
 * 호스트를 정본 형태로 정규화한다: 소문자 · trailing dot 제거 · IDNA A-label.
 * 정규화에 실패하거나 LDH 규칙을 벗어나면 거부한다.
 */
export function normalizeHost(input: string): Result<string> {
  if (input.length === 0) return err('invalid_host', '호스트가 비어 있다');
  if (!HOST_RAW_ALLOWED.test(input)) {
    return err('invalid_host', `허용되지 않은 문자가 있다: ${JSON.stringify(input)}`);
  }

  let host = input.toLowerCase();
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0) return err('invalid_host', '호스트가 점 하나뿐이다');

  // IDNA — WHATWG URL 파서가 A-label 변환을 해준다.
  let ascii: string;
  try {
    const u = new URL(`http://${host}`);
    ascii = u.hostname;
  } catch {
    return err('invalid_host', `IDNA 변환에 실패했다: ${JSON.stringify(input)}`);
  }
  // URL 파서가 경로·포트 등을 떼어냈다면 원본이 호스트가 아니었다는 뜻이다.
  if (ascii.length === 0) return err('invalid_host', '호스트를 해석할 수 없다');

  if (ascii.length > 253) return err('invalid_host', `전체 길이 253자를 넘었다 (${ascii.length})`);

  const labels = ascii.split('.');
  for (const label of labels) {
    if (label.length === 0) return err('invalid_host', '빈 라벨이 있다');
    if (label.length > 63) return err('invalid_host', `라벨이 63자를 넘었다: ${label}`);
    if (!LDH_LABEL.test(label)) return err('invalid_host', `LDH 라벨이 아니다: ${label}`);
  }

  return ok(ascii);
}

export type HostPattern =
  | { kind: 'exact'; host: string }
  | { kind: 'wildcard'; suffix: string };

/**
 * 호스트 패턴을 판별 유니온으로 만든다.
 *
 * v0 은 **정확일치와 선두 1라벨 와일드카드만** 노출한다. nginx 자체는 `mail.*` 도, 다중 라벨을
 * 삼키는 `*.a.b` 도 지원하지만(tests/engine E22.2), X.509 와일드카드는 한 라벨만 보장하므로
 * 그대로 인증서 선택에 쓰면 SAN 이 커버하지 않는 인증서를 제시하게 된다.
 */
export function parseHostPattern(input: string): Result<HostPattern> {
  if (input.length === 0) return err('invalid_host_pattern', '패턴이 비어 있다');

  const starCount = (input.match(/\*/g) ?? []).length;
  if (starCount === 0) {
    const r = normalizeHost(input);
    return r.ok ? ok({ kind: 'exact', host: r.value }) : r;
  }
  if (starCount > 1) {
    return err('invalid_host_pattern', `와일드카드는 하나만 쓸 수 있다: ${input}`);
  }
  if (!input.startsWith('*.')) {
    return err('invalid_host_pattern', `와일드카드는 선두 '*.' 형태만 허용한다: ${input}`);
  }

  const suffix = input.slice(2);
  if (suffix.length === 0) return err('invalid_host_pattern', '와일드카드 접미사가 비어 있다');
  const r = normalizeHost(suffix);
  if (!r.ok) return err('invalid_host_pattern', r.message);
  return ok({ kind: 'wildcard', suffix: r.value });
}

export function validateHeaderName(input: string): Result<string> {
  if (!TOKEN.test(input)) {
    return err('invalid_header_name', `RFC 9110 token 이 아니다: ${JSON.stringify(input)}`);
  }
  return ok(input);
}

/**
 * 헤더 값. 공백은 정당하고(AST 가 인용한다), 헤더 분리를 만드는 CR/LF/NUL 만 막는다.
 * 변수 참조는 화이트리스트 밖이면 거부한다.
 */
export function validateHeaderValue(input: string): Result<string> {
  if (/[\u0000-\u001F\u007F]/.test(input)) {
    return err('invalid_header_value', '제어 문자는 쓸 수 없다 (헤더 분리)');
  }
  for (const m of input.matchAll(/\$\{?([A-Za-z0-9_]+)\}?/g)) {
    const name = m[1]!;
    if (!ALLOWED_VARIABLES.has(name)) {
      return err('invalid_header_value', `허용되지 않은 변수 참조: $${name}`);
    }
  }
  return ok(input);
}

export type HashKey =
  | { kind: 'remote_addr' }
  | { kind: 'request_uri' }
  | { kind: 'header'; name: string }
  | { kind: 'cookie'; name: string };

/**
 * 해시 키. **자유 문자열을 받지 않는다** — 화이트리스트된 형태만 파싱한다.
 *
 * stream 서브시스템에는 요청·헤더·쿠키 개념이 없으므로 `remote_addr` 만 허용한다.
 */
export function parseHashKey(protocolClass: ProtocolClass, spec: string): Result<HashKey> {
  const streamOnly = protocolClass !== 'http';

  if (spec === 'remote_addr') return ok({ kind: 'remote_addr' });
  if (streamOnly) {
    return err('invalid_hash_key', `${protocolClass} 풀은 remote_addr 만 해시 키로 쓸 수 있다`);
  }
  if (spec === 'request_uri') return ok({ kind: 'request_uri' });

  const m = /^(header|cookie)\(([^()]*)\)$/.exec(spec);
  if (!m) return err('invalid_hash_key', `알 수 없는 해시 키: ${JSON.stringify(spec)}`);

  const kind = m[1] as 'header' | 'cookie';
  const name = m[2]!;
  const nameCheck = validateHeaderName(name);
  if (!nameCheck.ok) return err('invalid_hash_key', `${kind} 이름이 token 이 아니다: ${name}`);
  return ok({ kind, name });
}

/**
 * 소켓 예약과 겹침 검증 — DESIGN.md §4.5
 *
 * 엔진 근거 (tests/engine):
 *   E12 — TCP 와 UDP 는 같은 포트 번호를 공존시킬 수 있다.
 *   §4.5 — http / https / tls_passthrough 는 전부 transport=tcp 다. 그래서 http 컨텍스트 443 과
 *          stream 컨텍스트 443 이 충돌하는데, 프로토콜 enum 만 비교하면 이 충돌을 놓친다.
 *
 * 단순 유일 제약으로는 부족하다 — 와일드카드 대 특정 주소는 "동등"이 아니라 "겹침"이다.
 * PostgreSQL 의 일반 CHECK 는 다른 행을 참조할 수 없으므로(§4.0), 이 판정은 커밋 트랜잭션
 * 안에서 advisory lock 과 함께 도는 검증기의 몫이다.
 */
import { isIP } from 'node:net';
import { err, ok, type Result } from './result.js';
import type { ListenerProtocol } from '../model/provisional.js';

export type Transport = 'tcp' | 'udp';

export type BindAddress = {
  family: 'v4' | 'v6';
  addr: string;
  wildcard: boolean;
};

export type SocketReservation = {
  key: string;
  protocol: ListenerProtocol;
  bind: string;
  port: number;
};

export type SocketConflict = { a: string; b: string; reason: string };

/** L7 프로토콜은 전부 TCP 위에 있다. 이 접힘이 http:443 ↔ stream:443 충돌을 드러낸다. */
export function transportOf(protocol: ListenerProtocol): Transport {
  return protocol === 'udp' ? 'udp' : 'tcp';
}

const V4_MAPPED = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

export function normalizeBind(input: string): Result<BindAddress> {
  if (input.length === 0) return err('invalid_bind_address', '바인드 주소가 비어 있다');

  // IPv4-mapped IPv6 는 v4 로 접는다. 접지 않으면 같은 소켓을 다른 것으로 본다.
  const mapped = V4_MAPPED.exec(input);
  const candidate = mapped ? mapped[1]! : input;

  const version = isIP(candidate);
  if (version === 4) {
    return ok({ family: 'v4', addr: candidate, wildcard: candidate === '0.0.0.0' });
  }
  if (version === 6) {
    // WHATWG URL 파서가 압축·소문자 정규형을 준다.
    let canonical: string;
    try {
      canonical = new URL(`http://[${candidate}]`).hostname.slice(1, -1);
    } catch {
      return err('invalid_bind_address', `IPv6 주소를 정규화할 수 없다: ${input}`);
    }
    return ok({ family: 'v6', addr: canonical, wildcard: canonical === '::' });
  }
  return err('invalid_bind_address', `IP 주소가 아니다: ${JSON.stringify(input)}`);
}

/**
 * 두 예약이 같은 소켓을 두고 다투는가.
 *
 * IPv6 와일드카드는 `ipv6only=off` 기본에서 IPv4 까지 덮는다. 이걸 겹침으로 보지 않으면
 * `nginx -t` 는 통과하고 HUP 에서 bind 가 실패한다 — E23 이 보여준 최악의 경로다.
 */
export function socketsOverlap(a: SocketReservation, b: SocketReservation): boolean {
  if (a.key === b.key) return false;
  if (a.port !== b.port) return false;
  if (transportOf(a.protocol) !== transportOf(b.protocol)) return false;

  const na = normalizeBind(a.bind);
  const nb = normalizeBind(b.bind);
  if (!na.ok || !nb.ok) return false; // 주소 자체의 오류는 별도 검증이 잡는다

  const x = na.value;
  const y = nb.value;

  if (x.wildcard && y.wildcard) return true;
  if (x.wildcard) return x.family === 'v6' || y.family === 'v4';
  if (y.wildcard) return y.family === 'v6' || x.family === 'v4';
  return x.family === y.family && x.addr === y.addr;
}

/** 결과는 입력 순서와 무관하게 결정적이다 — plan diff 가 흔들리면 안 된다. */
export function findSocketConflicts(reservations: SocketReservation[]): SocketConflict[] {
  const sorted = [...reservations].sort((p, q) => (p.key < q.key ? -1 : p.key > q.key ? 1 : 0));
  const out: SocketConflict[] = [];

  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      const a = sorted[i]!;
      const b = sorted[j]!;
      if (socketsOverlap(a, b)) {
        out.push({
          a: a.key,
          b: b.key,
          reason: `${transportOf(a.protocol)}/${a.port} 에서 ${a.bind} 와 ${b.bind} 가 겹친다`,
        });
      }
    }
  }
  return out;
}

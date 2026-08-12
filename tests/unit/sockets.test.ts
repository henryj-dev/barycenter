/**
 * M6 — 소켓 겹침 검증 (DESIGN.md §4.5)
 *
 * 엔진 근거:
 *   E12  — TCP 와 UDP 는 같은 포트 번호를 공존시킬 수 있다 (실측 확인)
 *   §4.5 — http/https/tls_passthrough 는 전부 transport=tcp 라서 서로 충돌한다
 *
 * 단순 유일 제약으로는 안 된다. 와일드카드 대 특정 주소는 "동등"이 아니라 "겹침"이다.
 */
import { describe, expect, it } from 'vitest';
import {
  transportOf,
  normalizeBind,
  socketsOverlap,
  findSocketConflicts,
  type SocketReservation,
} from '../../src/validate/sockets.js';

const res = (
  protocol: SocketReservation['protocol'],
  bind: string,
  port: number,
  key = `${protocol}-${bind}-${port}`,
): SocketReservation => ({ key, protocol, bind, port });

describe('transportOf', () => {
  it('L7 프로토콜은 전부 tcp 로 접힌다', () => {
    expect(transportOf('http')).toBe('tcp');
    expect(transportOf('tls_passthrough')).toBe('tcp');
    expect(transportOf('tcp')).toBe('tcp');
  });

  it('udp 만 udp 다', () => {
    expect(transportOf('udp')).toBe('udp');
  });
});

describe('normalizeBind', () => {
  it('IPv4 와일드카드를 정규화한다', () => {
    const r = normalizeBind('0.0.0.0');
    expect(r.ok && r.value).toEqual({ family: 'v4', addr: '0.0.0.0', wildcard: true });
  });

  it('IPv6 와일드카드를 정규화한다', () => {
    const r = normalizeBind('::');
    expect(r.ok && r.value).toEqual({ family: 'v6', addr: '::', wildcard: true });
  });

  it('IPv6 표기를 압축·소문자화한다', () => {
    const a = normalizeBind('2001:0DB8:0000:0000:0000:0000:0000:0001');
    const b = normalizeBind('2001:db8::1');
    expect(a.ok && b.ok && a.value.addr).toBe(b.ok ? b.value.addr : '<b-failed>');
  });

  it('IPv4-mapped IPv6 를 v4 로 접는다 (M1.7)', () => {
    const r = normalizeBind('::ffff:10.0.0.5');
    expect(r.ok && r.value.family).toBe('v4');
    expect(r.ok && r.value.addr).toBe('10.0.0.5');
  });

  it('주소가 아닌 것을 거부한다', () => {
    for (const bad of ['not-an-ip', '10.0.0.256', '', '10.0.0.5;']) {
      expect(normalizeBind(bad).ok, bad).toBe(false);
    }
  });
});

describe('socketsOverlap — M6', () => {
  it('M6.1 http:443 과 tls_passthrough:443 은 충돌한다 — 둘 다 transport=tcp', () => {
    expect(socketsOverlap(res('http', '0.0.0.0', 443), res('tls_passthrough', '0.0.0.0', 443))).toBe(true);
  });

  it('M6.2 tcp:9999 와 udp:9999 는 공존한다 (E12)', () => {
    expect(socketsOverlap(res('tcp', '0.0.0.0', 9999), res('udp', '0.0.0.0', 9999))).toBe(false);
  });

  it('M6.3 와일드카드는 특정 주소와 겹친다', () => {
    expect(socketsOverlap(res('http', '0.0.0.0', 8080), res('http', '10.0.0.5', 8080))).toBe(true);
  });

  it('서로 다른 특정 주소는 겹치지 않는다', () => {
    expect(socketsOverlap(res('http', '10.0.0.5', 8080), res('http', '10.0.0.6', 8080))).toBe(false);
  });

  it('포트가 다르면 겹치지 않는다', () => {
    expect(socketsOverlap(res('http', '0.0.0.0', 8080), res('http', '0.0.0.0', 8081))).toBe(false);
  });

  // E30 으로 실측: nginx 의 ipv6only 기본값은 on 이라 두 소켓은 공존한다.
  // v2 는 이걸 겹침으로 봤고 테스트가 그 오류를 고정하고 있었다.
  it('M6.4 [::] 와 0.0.0.0 은 겹치지 않는다 — ipv6only 기본값이 on (E30)', () => {
    expect(socketsOverlap(res('http', '::', 8080), res('http', '0.0.0.0', 8080))).toBe(false);
  });

  it('v6 와일드카드는 같은 family 의 특정 주소를 덮는다', () => {
    expect(socketsOverlap(res('http', '::', 8080), res('http', '2001:db8::1', 8080))).toBe(true);
  });

  it('v4 와일드카드는 v6 특정 주소를 덮지 않는다', () => {
    expect(socketsOverlap(res('http', '0.0.0.0', 8080), res('http', '2001:db8::1', 8080))).toBe(false);
  });

  it('IPv6 특정 주소는 IPv4 특정 주소와 겹치지 않는다', () => {
    expect(socketsOverlap(res('http', '2001:db8::1', 8080), res('http', '10.0.0.5', 8080))).toBe(false);
  });

  it('자기 자신과는 겹침으로 보고하지 않는다 (같은 key)', () => {
    const a = res('http', '0.0.0.0', 8080, 'same');
    expect(socketsOverlap(a, a)).toBe(false);
  });
});

describe('findSocketConflicts', () => {
  it('충돌 쌍을 전부 찾는다', () => {
    const conflicts = findSocketConflicts([
      res('http', '0.0.0.0', 443, 'web'),
      res('tls_passthrough', '0.0.0.0', 443, 'passthru'),
      res('tcp', '0.0.0.0', 9999, 'game-tcp'),
      res('udp', '0.0.0.0', 9999, 'game-udp'),
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.a).toBe('passthru');
    expect(conflicts[0]!.b).toBe('web');
  });

  it('충돌이 없으면 빈 배열', () => {
    expect(
      findSocketConflicts([res('http', '0.0.0.0', 80, 'a'), res('http', '0.0.0.0', 443, 'b')]),
    ).toEqual([]);
  });

  it('결과가 결정적이다 — 입력 순서와 무관', () => {
    const a = res('http', '0.0.0.0', 443, 'web');
    const b = res('tls_passthrough', '0.0.0.0', 443, 'passthru');
    expect(findSocketConflicts([a, b])).toEqual(findSocketConflicts([b, a]));
  });
});

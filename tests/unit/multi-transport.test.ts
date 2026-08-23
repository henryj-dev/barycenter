/**
 * §4.5 가 **다중 전송을 표현한다** — h3 의 선결 조건 (S20)
 *
 * S20 은 7/8 이고, 떨어지는 하나가 이것이다:
 *
 * > `S20.udp_conflict` — **한쪽이 조용히 진다.** 엔진도 conf 검사도 아무 말을 안 한다.
 * > 운영자는 설정한 것이 사라진 이유를 알 수 없다. **검증기가 반드시 막아야 한다.**
 *
 * 같은 스파이크가 그 앞줄에서 원인을 쟀다: `listen 443 quic` 은 그 포트를 **UDP 로도**
 * 점유한다(`S20.udp_occupancy` — udp=1, tcp=1). 그런데 §4.5 의 예약은 프로토콜마다
 * 전송을 **하나**만 줬다(`transportOf(): Transport`). https 는 tcp 뿐이니, h3 를 켠
 * https 와 `stream { listen 443 udp; }` 가 겹쳐도 검증기가 못 본다.
 *
 * 그래서 §12.0 이 h3 를 **모델에서 뺐다** — "표현하면 안 걸리는 설정이 된다".
 *
 * ── 이 파일이 지키는 것
 *
 * 이제 예약이 전송 **집합**을 낸다. 겹침은 전송이 **하나라도** 겹치면 성립한다.
 * 그러면 h3 를 여는 날 `transportsOf` 에 `udp` 를 더하는 것 하나로 그 겹침이 잡히고,
 * 검증기·렌더·모델은 다시 안 만진다.
 *
 * **지금은 어느 프로토콜도 둘을 안 낸다.** 그게 맞다 — 없는 것을 있는 척하지 않는다.
 * 바뀐 것은 "표현할 수 있는가" 이고, 아래 마지막 묶음이 그 문이 실제로 열렸는지를
 * `transportSetsOverlap` 에 `['tcp','udp']` 를 직접 넣어 확인한다.
 */
import { describe, expect, it } from 'vitest';
import {
  findSocketConflicts, sharesTransport, socketsOverlap, transportOf, transportsOf,
  transportSetsOverlap, type SocketReservation,
} from '../../src/validate/sockets.js';
import type { ListenerProtocol } from '../../src/model/provisional.js';

const R = (key: string, protocol: ListenerProtocol, port: number, bind = '0.0.0.0'): SocketReservation =>
  ({ key, protocol, bind, port });

describe('전송 집합', () => {
  it('L7 은 전부 TCP 하나다', () => {
    for (const p of ['http', 'https', 'tls_passthrough', 'tcp'] as ListenerProtocol[]) {
      expect(transportsOf(p), p).toEqual(['tcp']);
    }
    expect(transportsOf('udp')).toEqual(['udp']);
  });

  it('옛 이름은 집합의 첫 원소를 준다 — 전송이 하나인 동안은 같은 답이다', () => {
    for (const p of ['http', 'https', 'tls_passthrough', 'tcp', 'udp'] as ListenerProtocol[]) {
      expect(transportOf(p), p).toBe(transportsOf(p)[0]);
    }
  });

  it('공유 판정은 교집합이다', () => {
    expect(sharesTransport('http', 'tcp')).toBe(true);
    expect(sharesTransport('https', 'tls_passthrough')).toBe(true);
    expect(sharesTransport('http', 'udp')).toBe(false);
    expect(sharesTransport('udp', 'udp')).toBe(true);
  });
});

describe('겹침 판정이 안 바뀐다', () => {
  it('http:443 과 stream tcp:443 은 다툰다 — 서브시스템이 달라도 같은 소켓이다', () => {
    expect(socketsOverlap(R('a', 'http', 443), R('b', 'tcp', 443))).toBe(true);
  });

  it('tcp:443 과 udp:443 은 공존한다', () => {
    expect(socketsOverlap(R('a', 'tcp', 443), R('b', 'udp', 443))).toBe(false);
  });

  it('family 를 넘는 겹침은 없다 — ipv6only=on (E30)', () => {
    expect(socketsOverlap(R('a', 'http', 80, '0.0.0.0'), R('b', 'http', 80, '::'))).toBe(false);
  });

  it('같은 family 의 와일드카드는 전부 덮는다', () => {
    expect(socketsOverlap(R('a', 'http', 80, '0.0.0.0'), R('b', 'http', 80, '10.0.0.1'))).toBe(true);
  });
});

/**
 * **문이 실제로 열렸는지** 본다. 지금 모델의 프로토콜은 전부 전송이 하나라, 위 검사만
 * 두면 "집합으로 바꿨다" 는 것이 실제로 무엇을 가능하게 했는지 아무것도 안 지킨다.
 *
 * 그래서 전송 둘짜리 집합을 직접 넣는다. h3 가 들어오는 날의 모양이 정확히 이것이다 —
 * `transportsOf('https')` 가 `['tcp','udp']` 를 내는 것.
 */
describe('다중 전송이 실제로 잡힌다 (h3 가 들어오는 날의 모양)', () => {
  /**
   * **제품 함수를 직접 부른다.** 처음엔 교집합을 테스트 안에서 다시 구현했는데,
   * 그러면 재는 것이 제품이 아니라 테스트다 — 제품이 등호로 되돌아가도 초록이다.
   * `transportSetsOverlap` 이 그래서 집합을 받는다.
   */
  const H3: readonly ('tcp' | 'udp')[] = ['tcp', 'udp'];

  it('전송 둘을 내는 프로토콜은 tcp 쪽과도 udp 쪽과도 다툰다', () => {
    expect(transportSetsOverlap(H3, transportsOf('http')), 'tcp 쪽을 못 잡는다').toBe(true);
    expect(transportSetsOverlap(H3, transportsOf('udp')), 'udp 쪽을 못 잡는다').toBe(true);
    // 대칭이어야 한다 — 어느 쪽을 먼저 놓든 같은 답이다.
    expect(transportSetsOverlap(transportsOf('udp'), H3)).toBe(true);
  });

  it('전송 하나짜리끼리는 여전히 안 겹친다 — 넓어진 것이 아니라 표현이 는 것이다', () => {
    expect(transportSetsOverlap(transportsOf('http'), transportsOf('udp'))).toBe(false);
    expect(transportSetsOverlap([], H3), '빈 집합은 아무것과도 안 겹친다').toBe(false);
  });

  /**
   * `findSocketConflicts` 가 전송 교집합을 쓰는지 — 등호가 아니라. 등호로 남아 있으면
   * h3 를 켠 https(`['tcp','udp']`)가 udp 리스너와 **다르다**고 판정되어 조용히 통과한다.
   */
  it('충돌 목록이 교집합 규칙을 쓴다', () => {
    const conflicts = findSocketConflicts([
      R('web', 'https', 443),
      R('dns', 'udp', 443),
      R('raw', 'tcp', 443),
    ]);
    // 지금은 https↔tcp 하나만 나온다. udp 는 전송이 안 겹친다.
    expect(conflicts.map((c) => [c.a, c.b].sort().join('~'))).toEqual(['raw~web']);
  });

  it('결과는 입력 순서와 무관하다 — plan diff 가 흔들리면 안 된다', () => {
    const a = findSocketConflicts([R('web', 'http', 80), R('raw', 'tcp', 80)]);
    const b = findSocketConflicts([R('raw', 'tcp', 80), R('web', 'http', 80)]);
    expect(a).toEqual(b);
  });
});

/**
 * `ipVersion` 은 `net.isIP` 와 **같은 답을 내야 한다** — 차분 검증.
 *
 * 노드 내장을 순수 구현으로 갈아 끼우는 변경이라, 재는 방법이 하나뿐이다: 원본을
 * 오라클로 두고 같은 입력에 같은 답이 나오는지 본다. 규칙을 문서에서 베껴 적고
 * "맞을 것이다" 로 두면 미묘하게 다른 판정이 하나 더 생긴다.
 *
 * **테스트는 노드에서 돈다** — 여기서 `node:net` 을 쓰는 것은 문제가 아니다.
 * 브라우저로 가는 것은 `src/` 쪽이고, 그건 `gui-browser-safe.test.ts` 가 지킨다.
 */
import { isIP } from 'node:net';

import { describe, expect, it } from 'vitest';

import { ipVersion } from '../../src/validate/ip.js';

/** 경계는 손으로 고른다 — 무작위는 이런 것을 거의 안 만든다. */
const CORPUS = [
  // v4
  '1.2.3.4', '0.0.0.0', '255.255.255.255', '10.0.0.11',
  '256.1.1.1', '1.2.3', '1.2.3.4.5', '01.2.3.4', '1.2.3.04', '1.2.3.4 ', ' 1.2.3.4',
  '1.2.3.-4', '1.2.3.+4', '1.2.3.4a', '..', '1..2.3',
  // v6
  '::', '::1', 'fe80::1', 'FE80::ABCD', '2001:db8::1',
  '2001:0db8:0000:0000:0000:0000:0000:0001', '0:0:0:0:0:0:0:0', '1:2:3:4:5:6:7:8',
  '1::', 'a:b:c:d:e:f::', '::0:0:0:0:0:0:0', '1:2:3:4:5:6:7::', '0000::1',
  // v6 — 임베디드 v4
  '::ffff:1.2.3.4', '::FFFF:1.2.3.4', '::1.2.3.4', '1:2:3:4:5:6:1.2.3.4',
  '::ffff:0:255.255.255.255', '::ffff:1.2.3', '::ffff:255.255.255.256',
  '1:2:3:4:5:6:7:1.2.3.4', '1.2.3.4::', '::1.2.3.4.5',
  // v6 — 존 ID
  'fe80::1%eth0', '::%eth0', 'fe80:0:0:0:0:0:0:1%2', 'fe80::1%', 'fe80::1%eth0%x',
  '1.2.3.4%eth0', '%eth0',
  // v6 — 깨진 것
  '2001:db8:::1', '1::2::3', '2001:db8::1:', ':2001:db8::1', '12345::', '00000::1',
  'g::1', '[::1]', '1:::', '::1::', '0:0:0:0:0:0:0', '1:2:3:4:5:6:7:8:9',
  '1:2:3:4:5:6:7::8', '', ':', ':::', 'localhost', 'example.com', '1.2.3.4:80',
];

describe('ipVersion — net.isIP 와 같은 답', () => {
  it('경계 입력에서 오라클과 일치한다', () => {
    const mismatch = CORPUS.filter((c) => ipVersion(c) !== isIP(c))
      .map((c) => `${JSON.stringify(c)}: 우리=${ipVersion(c)} 오라클=${isIP(c)}`);
    expect(mismatch).toEqual([]);
  });

  it('무작위로 지어낸 입력에서도 일치한다', () => {
    // **결정적으로 만든다.** `Math.random` 이면 빨간 회차를 재현할 수 없다.
    let seed = 20260823;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const alphabet = [...'0123456789abcdefABCDEF.:%xg '];
    const mismatch: string[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      const len = 1 + Math.floor(next() * 24);
      let s = '';
      for (let j = 0; j < len; j += 1) {
        s += alphabet[Math.floor(next() * alphabet.length)]!;
      }
      if (ipVersion(s) !== isIP(s)) mismatch.push(`${JSON.stringify(s)}: 우리=${ipVersion(s)} 오라클=${isIP(s)}`);
    }
    expect(mismatch.slice(0, 5)).toEqual([]);
  });

  it('IP 처럼 생긴 것을 더 자주 만드는 생성기로도 일치한다', () => {
    // 위 생성기는 유효한 IP 를 거의 못 만든다 — 그러면 "전부 0" 을 맞히고 통과한다.
    let seed = 7;
    const next = (): number => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      return seed / 0x7fffffff;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;
    const octets = ['0', '1', '10', '99', '255', '256', '00', '01', '999'];
    const hextets = ['0', '1', 'a', 'ffff', '0000', '00000', 'g', ''];
    const mismatch: string[] = [];
    for (let i = 0; i < 20_000; i += 1) {
      let s: string;
      if (next() < 0.4) {
        const n = 2 + Math.floor(next() * 4);
        s = Array.from({ length: n }, () => pick(octets)).join('.');
      } else {
        const n = 1 + Math.floor(next() * 9);
        s = Array.from({ length: n }, () => pick(hextets)).join(':');
        if (next() < 0.4) s = s.replace(':', '::');
        if (next() < 0.2) s += `:${pick(octets)}.${pick(octets)}.${pick(octets)}.${pick(octets)}`;
        if (next() < 0.15) s += `%${pick(['eth0', '2', ''])}`;
      }
      if (ipVersion(s) !== isIP(s)) mismatch.push(`${JSON.stringify(s)}: 우리=${ipVersion(s)} 오라클=${isIP(s)}`);
    }
    expect(mismatch.slice(0, 5)).toEqual([]);
  });
});

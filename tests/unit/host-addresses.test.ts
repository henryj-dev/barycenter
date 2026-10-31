/**
 * 이 서버에 할당된 IP — 리스너 바인드의 후보 (2026-10-31).
 *
 * 바인드는 수신할 소켓의 주소다. 할당 안 된 주소는 nginx 가 못 연다(web-01 은 `ip_nonlocal_bind = 0`).
 * 재는 것: 인터페이스 표를 읽는 규칙, 「이 서버가 열 수 있는가」 판정, GUI 선택지가 같은 규칙을 따르는가.
 */
import { describe, expect, it } from 'vitest';

import { bindIsLocal, hostAddressesFrom, type InterfaceTable } from '../../src/engine/host-addresses.js';
import { CUSTOM_BIND, bindError, bindOptions } from '../../src/web/bind.js';

// web-01 의 실제 모양 (`ip -br addr`).
const WEB01: InterfaceTable = {
  lo: [
    { address: '127.0.0.1', family: 'IPv4', internal: true },
    { address: '::1', family: 'IPv6', internal: true },
  ],
  enp1s0: [
    { address: '64.176.226.52', family: 'IPv4', internal: false },
    { address: '2401:c080:1c02:1141:5400:6ff:fef9:6885', family: 'IPv6', internal: false },
    { address: 'fe80::5400:6ff:fef9:6885', family: 'IPv6', internal: false },
  ],
  enp8s0: [{ address: '10.253.65.250', family: 4, internal: false }],
};
const OFF = { v4: false, v6: false };

describe('할당된 주소 읽기', () => {
  it('링크 로컬을 빼고 인터페이스 이름 순으로 낸다', () => {
    const f = hostAddressesFrom(WEB01, OFF);
    expect(f.addresses.map((a) => a.address)).toEqual([
      '64.176.226.52', '2401:c080:1c02:1141:5400:6ff:fef9:6885', '10.253.65.250', '127.0.0.1', '::1',
    ]);
    expect(f.addresses.find((a) => a.address === '10.253.65.250')).toEqual({
      address: '10.253.65.250', family: 'v4', interface: 'enp8s0', internal: false,
    });
  });

  it('169.254 · 같은 주소 두 번은 뺀다', () => {
    const f = hostAddressesFrom({
      a: [{ address: '169.254.1.1', family: 'IPv4', internal: false }, { address: '10.0.0.1', family: 'IPv4', internal: false }],
      b: [{ address: '10.0.0.1', family: 'IPv4', internal: false }],
    }, OFF);
    expect(f.addresses.map((a) => `${a.interface}:${a.address}`)).toEqual(['a:10.0.0.1']);
  });
});

describe('이 서버가 열 수 있는 바인드인가', () => {
  const f = hostAddressesFrom(WEB01, OFF);

  it('와일드카드와 할당된 주소는 연다', () => {
    for (const b of ['0.0.0.0', '::', '10.253.65.250', '127.0.0.1', '2401:C080:1C02:1141:5400:6FF:FEF9:6885']) {
      expect(bindIsLocal(b, f), b).toBe(true);
    }
  });

  it('할당 안 된 주소는 못 연다', () => {
    expect(bindIsLocal('10.253.65.251', f)).toBe(false);
    expect(bindIsLocal('2001:db8::1', f)).toBe(false);
  });

  it('ip_nonlocal_bind 가 켜진 계열은 막지 않는다 (VIP)', () => {
    const vip = hostAddressesFrom(WEB01, { v4: true, v6: false });
    expect(bindIsLocal('10.253.65.251', vip)).toBe(true);
    expect(bindIsLocal('2001:db8::1', vip)).toBe(false);
  });
});

describe('GUI 선택지', () => {
  const f = hostAddressesFrom(WEB01, OFF);

  it('와일드카드 둘과 할당된 주소만 낸다 — 직접 입력은 없다', () => {
    const values = bindOptions(f, '0.0.0.0').map((o) => o.value);
    expect(values).toEqual(['0.0.0.0', '::', ...f.addresses.map((a) => a.address)]);
    expect(values).not.toContain(CUSTOM_BIND);
  });

  it('지금 값이 서버에 없으면 「이 서버에 없음」 으로 보이고 오류를 낸다', () => {
    const opts = bindOptions(f, '10.9.9.9');
    expect(opts.at(-1)).toEqual({ value: '10.9.9.9', hint: '이 서버에 없음' });
    expect(bindError('10.9.9.9', f)).toMatch(/할당된 주소가 아니에요/);
    expect(bindError('10.253.65.250', f)).toBeUndefined();
  });

  it('nonlocal 이 켜지면 「직접 입력…」 을 열고 그 계열은 오류를 안 낸다', () => {
    const vip = hostAddressesFrom(WEB01, { v4: true, v6: false });
    expect(bindOptions(vip, '0.0.0.0').map((o) => o.value)).toContain(CUSTOM_BIND);
    expect(bindError('10.9.9.9', vip)).toBeUndefined();
  });

  it('주소를 못 읽었으면 판단하지 않는다', () => {
    expect(bindError('10.9.9.9', undefined)).toBeUndefined();
  });
});

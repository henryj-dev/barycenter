/**
 * 이 서버에 할당된 IP — 리스너의 바인드가 될 수 있는 것 (2026-10-31).
 *
 * 바인드는 **수신할 소켓의 주소**다. 할당되지 않은 주소로는 nginx 가 소켓을 못 연다
 * (`bind() … Cannot assign requested address`). 전에는 그것을 apply 의 nginx 실패로만 알았다.
 *
 * **예외: `ip_nonlocal_bind = 1`.** keepalived 같은 VIP 를 쓰는 서버는 아직 안 붙은 주소에도 바인드한다.
 * 그 커널 설정을 그 계열(v4 · v6)마다 읽어 함께 낸다 — 켜져 있으면 그 계열은 막지 않는다.
 *
 * 빼는 것: 링크 로컬(`fe80::/10`, `169.254.0.0/16`). 인터페이스를 함께 적지 않으면 바인드할 수 없다.
 */
import { readFileSync } from 'node:fs';
import { networkInterfaces } from 'node:os';

import { normalizeBind } from '../validate/sockets.js';

export type HostAddress = { address: string; family: 'v4' | 'v6'; interface: string; internal: boolean };
export type HostAddressFacts = {
  addresses: HostAddress[];
  /** 그 계열에서 할당 안 된 주소에도 바인드할 수 있는가 (`net.ipv{4,6}.ip_nonlocal_bind`). */
  nonlocalBind: { v4: boolean; v6: boolean };
};

const linkLocal = (family: 'v4' | 'v6', addr: string): boolean =>
  family === 'v4' ? addr.startsWith('169.254.') : /^fe[89ab]/i.test(addr);

/** `os.networkInterfaces()` 의 모양 — 테스트가 넣는다. */
export type InterfaceTable = Record<string, { address: string; family: string | number; internal: boolean }[] | undefined>;

export function hostAddressesFrom(
  table: InterfaceTable,
  nonlocalBind: { v4: boolean; v6: boolean },
): HostAddressFacts {
  const out: HostAddress[] = [];
  for (const name of Object.keys(table).sort()) {
    for (const a of table[name] ?? []) {
      const family = a.family === 'IPv4' || a.family === 4 ? 'v4' : a.family === 'IPv6' || a.family === 6 ? 'v6' : undefined;
      if (family === undefined) continue;
      const n = normalizeBind(a.address);
      if (!n.ok || n.value.wildcard) continue;
      if (linkLocal(family, n.value.addr)) continue;
      if (out.some((x) => x.address === n.value.addr)) continue;
      out.push({ address: n.value.addr, family, interface: name, internal: a.internal });
    }
  }
  return { addresses: out, nonlocalBind };
}

const sysctlOn = (path: string): boolean => {
  try { return readFileSync(path, 'utf8').trim() === '1'; } catch { return false; }
};

/** 지금 이 서버의 사실. 부를 때마다 읽는다 — 주소는 운영 중에 바뀐다(DHCP · VIP). */
export function hostAddresses(): HostAddressFacts {
  return hostAddressesFrom(networkInterfaces() as InterfaceTable, {
    v4: sysctlOn('/proc/sys/net/ipv4/ip_nonlocal_bind'),
    v6: sysctlOn('/proc/sys/net/ipv6/ip_nonlocal_bind'),
  });
}

/**
 * 이 바인드를 이 서버가 열 수 있는가. 와일드카드(`0.0.0.0` · `::`)는 언제나 된다.
 * 모양이 잘못된 바인드는 여기서 판단하지 않는다 — 검증기가 따로 막는다.
 */
export function bindIsLocal(bind: string, facts: HostAddressFacts): boolean {
  const n = normalizeBind(bind);
  if (!n.ok || n.value.wildcard) return true;
  if (facts.nonlocalBind[n.value.family]) return true;
  return facts.addresses.some((a) => a.address === n.value.addr);
}

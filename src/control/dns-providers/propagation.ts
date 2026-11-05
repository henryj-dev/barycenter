/**
 * 전파 대기 — TXT 를 놓은 뒤, **그 영역의 권한 이름서버 전부**가 그 값을 답할 때까지 기다린다.
 *
 * 공급자 API 가 200 을 준 것과 CA 가 TXT 를 볼 수 있는 것은 다르다. 기다리지 않고 챌린지를 수락하면 CA 가 아직 없는
 * TXT 를 보고 주문이 `invalid` 가 된다(Let's Encrypt 는 실패한 검증도 레이트리밋에 센다).
 *
 * 재귀 해석기(캐시)를 묻지 않는다 — 권한 이름서버에 직접 묻는다. 기존 러너는 이 단계가 없었다(놓자마자 수락).
 *
 * **던지지 않는다.** 시간이 다 되면 `propagation-timeout` 이다. 그것을 실패로 볼지는 호출자가 정한다.
 */
import { lookup, Resolver } from 'node:dns/promises';

import { fail, OK, zoneCandidates, type DnsResult } from './provider.js';

export interface TxtResolver {
  /** `name` 을 담는 영역의 권한 이름서버 주소들(IP). 못 찾으면 빈 배열. */
  authoritative(name: string): Promise<string[]>;
  /** 그 서버가 답하는 `name` 의 TXT 값들(조각을 이은 것). 없으면 빈 배열. 닿지 못하면 던진다. */
  txt(server: string, name: string): Promise<string[]>;
}

export type PropagationOptions = {
  timeoutMs: number;
  intervalMs: number;
  resolver?: TxtResolver;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
};

export const systemTxtResolver: TxtResolver = {
  async authoritative(name) {
    const sys = new Resolver({ timeout: 3000, tries: 2 });
    for (const zone of [name.toLowerCase(), ...zoneCandidates(name)]) {
      let hosts: string[];
      try {
        hosts = await sys.resolveNs(zone);
      } catch {
        continue;
      }
      if (hosts.length === 0) continue;
      const ips: string[] = [];
      for (const h of hosts) {
        try {
          for (const a of await lookup(h, { all: true })) ips.push(a.address);
        } catch {
          // 그 서버 이름을 못 풀었다 — 나머지로 본다.
        }
      }
      return [...new Set(ips)];
    }
    return [];
  },
  async txt(server, name) {
    const r = new Resolver({ timeout: 3000, tries: 1 });
    r.setServers([server]);
    try {
      return (await r.resolveTxt(name)).map((chunks) => chunks.join(''));
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOTFOUND' || code === 'ENODATA') return [];
      throw e;
    }
  },
};

export async function waitForTxt(name: string, value: string, o: PropagationOptions): Promise<DnsResult> {
  const resolver = o.resolver ?? systemTxtResolver;
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = o.now ?? Date.now;
  const deadline = now() + o.timeoutMs;
  let servers: string[] = [];
  let last = '';
  for (;;) {
    try {
      if (servers.length === 0) servers = await resolver.authoritative(name);
      if (servers.length === 0) {
        last = '권한 이름서버를 찾지 못했다';
      } else {
        const missing: string[] = [];
        for (const s of servers) {
          try {
            if (!(await resolver.txt(s, name)).includes(value)) missing.push(s);
          } catch (e) {
            missing.push(`${s}(${(e as Error).message})`);
          }
        }
        if (missing.length === 0) return OK;
        last = `아직 안 보이는 서버: ${missing.join(', ')}`;
      }
    } catch (e) {
      last = (e as Error).message;
    }
    if (now() + o.intervalMs > deadline) {
      return fail('propagation-timeout', `${Math.round(o.timeoutMs / 1000)}초 안에 ${name} TXT 가 퍼지지 않았다 — ${last}`);
    }
    await sleep(o.intervalMs);
  }
}

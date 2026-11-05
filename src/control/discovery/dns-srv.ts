/**
 * DNS SRV 출처 — Node `dns.resolveSrv` (2026-11-05).
 *
 * `query` 는 SRV 이름(`_http._tcp.api.internal`)이다. 우선순위(priority)가 **가장 낮은 무리만** 쓴다 — RFC 2782 에서
 * 높은 값은 예비다. 가중치(weight)는 쓰지 않는다(백엔드 가중치는 1 — 출처가 바뀔 때마다 가중치가 흔들리지 않게).
 * target 이름은 A · AAAA 로 푼다(슬롯은 IP 다). target 이 `.` 이면 「서비스 없음」 이다(RFC 2782) — 빈 목록이다.
 *
 * 실패의 뜻: NXDOMAIN · NODATA → `not-found`, 시간 초과 · 서버 실패 → `unavailable`.
 */
import { promises as dns } from 'node:dns';
import { isIP } from 'node:net';

import type { DiscoveredAddress, DiscoveryResult, DiscoverySource } from './source.js';
import { normalizeEndpoints } from './source.js';

export type SrvRecord = { name: string; port: number; priority: number; weight: number };

export type DnsLookups = {
  resolveSrv(name: string): Promise<SrvRecord[]>;
  resolve4(name: string): Promise<string[]>;
  resolve6(name: string): Promise<string[]>;
};

export type DnsSrvOptions = {
  /** 물을 서버(IP). 없으면 시스템 설정이다. */
  servers?: string[];
  timeoutMs?: number;
  /** 시험이 주입한다. */
  lookups?: DnsLookups;
};

const NOT_FOUND = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

export function dnsSrvSource(o: DnsSrvOptions = {}): DiscoverySource {
  const lookups = o.lookups ?? systemLookups(o);
  return {
    kind: 'dns-srv',
    resolve: async (query) => {
      try {
        return await resolveSrv(lookups, query);
      } catch (e) {
        return { ok: false, reason: 'unavailable', detail: `SRV ${query}: ${e instanceof Error ? e.message : String(e)}` };
      }
    },
  };
}

function systemLookups(o: DnsSrvOptions): DnsLookups {
  const r = new dns.Resolver({ timeout: o.timeoutMs ?? 5_000, tries: 2 });
  if (o.servers !== undefined && o.servers.length > 0) r.setServers(o.servers);
  return {
    resolveSrv: (n) => r.resolveSrv(n),
    resolve4: (n) => r.resolve4(n),
    resolve6: (n) => r.resolve6(n),
  };
}

const codeOf = (e: unknown): string => String((e as { code?: unknown } | null)?.code ?? '');

async function resolveSrv(l: DnsLookups, query: string): Promise<DiscoveryResult> {
  let records: SrvRecord[];
  try {
    records = await l.resolveSrv(query);
  } catch (e) {
    const code = codeOf(e);
    if (NOT_FOUND.has(code)) return { ok: false, reason: 'not-found', detail: `SRV ${query} 가 없다 (${code})` };
    return { ok: false, reason: 'unavailable', detail: `SRV ${query} 를 묻지 못했다 (${code || String(e)})` };
  }
  const live = records.filter((r) => r.name !== '' && r.name !== '.');
  if (live.length === 0) return { ok: true, endpoints: [] };
  const best = Math.min(...live.map((r) => r.priority));
  const out: DiscoveredAddress[] = [];
  for (const r of live.filter((x) => x.priority === best)) {
    const target = r.name.replace(/\.$/, '');
    if (isIP(target) !== 0) {
      out.push({ host: target, port: r.port });
      continue;
    }
    // 한 target 이 A 도 AAAA 도 없으면 **그 답 전체가 실패다** — 반쪽 목록으로 바꾸면 그 사이 트래픽이 한쪽에 몰린다.
    const v4 = await l.resolve4(target).catch((e: unknown) => (NOT_FOUND.has(codeOf(e)) ? [] : Promise.reject(e)));
    const v6 = await l.resolve6(target).catch((e: unknown) => (NOT_FOUND.has(codeOf(e)) ? [] : Promise.reject(e)));
    if (v4.length + v6.length === 0) {
      return { ok: false, reason: 'invalid', detail: `SRV ${query} 의 target ${target} 에 A · AAAA 가 없다` };
    }
    for (const ip of [...v4, ...v6]) out.push({ host: ip, port: r.port });
  }
  return normalizeEndpoints(out, `SRV ${query}`);
}

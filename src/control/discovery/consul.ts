/**
 * Consul 출처 — HTTP health API `GET {base}/v1/health/service/{name}?passing=true` (2026-11-05).
 *
 * **통과(passing) 인스턴스만** 받는다 — Consul 이 이미 죽었다고 아는 것을 슬롯에 넣지 않는다. 주소는
 * `Service.Address` 이고, 비었으면 `Node.Address` 다(Consul 의 규칙). 토큰은 `X-Consul-Token` 헤더로 보낸다 —
 * 파일에서 **부를 때마다** 읽는다(회전하는 토큰이 데몬 재기동 없이 바뀌게).
 *
 * 실패의 뜻은 `sources/fetch.ts` 와 같다. 403 은 ACL 이 이 토큰에 그 서비스를 안 보여 준 것이다(`unauthorized`).
 * 없는 서비스는 Consul 이 200 + 빈 배열로 답한다 — 빈 목록이다(풀의 `emptyMeans` 가 정한다).
 */
import { httpsGetJson, type FetchLike } from '../sources/fetch.js';
import type { DiscoveredAddress, DiscoverySource } from './source.js';
import { MAX_DISCOVERY_RESPONSE_BYTES, normalizeEndpoints } from './source.js';

export type ConsulOptions = {
  /** `https://consul.internal:8501`. https 가 아니면 묻지 않는다. */
  baseUrl: string;
  /** 토큰을 읽는다(파일). 없으면 토큰 없이 묻는다. */
  token?: () => string;
  fetch?: FetchLike;
  timeoutMs?: number;
};

export function consulSource(o: ConsulOptions): DiscoverySource {
  return {
    kind: 'consul',
    resolve: async (query) => {
      const url = `${o.baseUrl.replace(/\/+$/, '')}/v1/health/service/${encodeURIComponent(query)}?passing=true`;
      let token: string | undefined;
      try {
        token = o.token?.().trim();
      } catch (e) {
        return { ok: false, reason: 'unconfigured', detail: `Consul 토큰 파일을 읽지 못했다: ${e instanceof Error ? e.message : String(e)}` };
      }
      const r = await httpsGetJson(url, {
        ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
        headers: token === undefined || token === '' ? {} : { 'x-consul-token': token },
        timeoutMs: o.timeoutMs ?? 5_000,
        maxBytes: MAX_DISCOVERY_RESPONSE_BYTES,
      });
      if (!r.ok) return r;
      if (!Array.isArray(r.json)) return { ok: false, reason: 'invalid', detail: `Consul ${query}: 배열이 아니다` };
      const out: DiscoveredAddress[] = [];
      for (const entry of r.json as unknown[]) {
        const e = (entry ?? {}) as { Node?: { Address?: unknown }; Service?: { Address?: unknown; Port?: unknown } };
        const svc = typeof e.Service?.Address === 'string' ? e.Service.Address : '';
        const host = svc !== '' ? svc : (typeof e.Node?.Address === 'string' ? e.Node.Address : '');
        out.push({ host, port: typeof e.Service?.Port === 'number' ? e.Service.Port : Number.NaN });
      }
      return normalizeEndpoints(out, `Consul ${query}`);
    },
  };
}

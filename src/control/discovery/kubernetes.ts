/**
 * Kubernetes 출처 — EndpointSlice API (2026-11-05).
 *
 *   GET {base}/apis/discovery.k8s.io/v1/namespaces/{ns}/endpointslices?labelSelector=kubernetes.io/service-name={svc}
 *
 * `query` 는 `네임스페이스/서비스` 다. **준비된(ready) 주소만** 받는다 — `conditions.ready` 가 `false` 인 것은 뺀다
 * (없으면 준비된 것으로 본다 — API 의 규칙). 포트는 슬라이스의 첫 포트다. 포트가 여럿인 서비스는 풀의
 * `discovery.port` 로 고른다(러너가 덮는다).
 *
 * 자격: 서비스 계정 토큰(Bearer)과 API 서버 CA. 클러스터 안이면 기본 경로
 * (`/var/run/secrets/kubernetes.io/serviceaccount/{token,ca.crt}`)다 — `registry.ts` 가 정한다. 토큰은 **부를 때마다**
 * 읽는다 — 투영된(projected) 토큰은 한 시간마다 바뀐다. 필요한 권한은 그 네임스페이스의 `endpointslices` `list` 다.
 */
import { httpsGetJson, type FetchLike } from '../sources/fetch.js';
import type { DiscoveredAddress, DiscoverySource } from './source.js';
import { MAX_DISCOVERY_RESPONSE_BYTES, normalizeEndpoints } from './source.js';

export type KubernetesOptions = {
  /** `https://kubernetes.default.svc`. */
  baseUrl: string;
  token: () => string;
  /** CA 를 정한 fetch(`fetchWithCa`). 없으면 시스템 신뢰 저장소다. */
  fetch?: FetchLike;
  timeoutMs?: number;
};

export function kubernetesSource(o: KubernetesOptions): DiscoverySource {
  return {
    kind: 'kubernetes',
    resolve: async (query) => {
      const [ns, svc] = query.split('/');
      if (ns === undefined || svc === undefined || ns === '' || svc === '') {
        return { ok: false, reason: 'invalid', detail: `query 는 네임스페이스/서비스 다: ${query}` };
      }
      let token: string;
      try {
        token = o.token().trim();
      } catch (e) {
        return { ok: false, reason: 'unconfigured', detail: `서비스 계정 토큰을 읽지 못했다: ${e instanceof Error ? e.message : String(e)}` };
      }
      const selector = encodeURIComponent(`kubernetes.io/service-name=${svc}`);
      const url = `${o.baseUrl.replace(/\/+$/, '')}/apis/discovery.k8s.io/v1/namespaces/${encodeURIComponent(ns)}/endpointslices?labelSelector=${selector}`;
      const r = await httpsGetJson(url, {
        ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
        headers: { authorization: `Bearer ${token}` },
        timeoutMs: o.timeoutMs ?? 5_000,
        maxBytes: MAX_DISCOVERY_RESPONSE_BYTES,
      });
      if (!r.ok) return r;
      const items = (r.json as { items?: unknown } | null)?.items;
      if (!Array.isArray(items)) return { ok: false, reason: 'invalid', detail: `Kubernetes ${query}: items 가 없다` };
      const out: DiscoveredAddress[] = [];
      for (const raw of items as unknown[]) {
        const slice = (raw ?? {}) as {
          addressType?: unknown;
          ports?: { port?: unknown }[] | null;
          endpoints?: { addresses?: unknown; conditions?: { ready?: unknown } }[] | null;
        };
        // FQDN 슬라이스는 IP 가 아니다 — 슬롯에 못 싣는다. 건너뛰지 않고 실패로 둔다(반쪽 목록을 만들지 않는다).
        if (slice.addressType === 'FQDN') {
          return { ok: false, reason: 'invalid', detail: `Kubernetes ${query}: FQDN EndpointSlice 는 받지 않는다 (IP 만)` };
        }
        const port = slice.ports?.[0]?.port;
        for (const ep of slice.endpoints ?? []) {
          if (ep.conditions?.ready === false) continue;
          const addrs = Array.isArray(ep.addresses) ? ep.addresses : [];
          for (const a of addrs) {
            out.push({ host: typeof a === 'string' ? a : '', port: typeof port === 'number' ? port : Number.NaN });
          }
        }
      }
      return normalizeEndpoints(out, `Kubernetes ${query}`);
    },
  };
}

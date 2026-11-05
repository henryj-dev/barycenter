/**
 * 주소 집합 출처 구현 다섯 (2026-11-05). 모두 공개 목록이라 자격이 없다 — 설정할 것은 주기뿐이다.
 *
 *   cloudflare  https://www.cloudflare.com/ips-v4/ · ips-v6/ (한 줄에 하나). **둘 다** 받아야 성공이다
 *               (CLI `--cloudflare` 와 같은 규칙 — v6 만 빠진 반쪽 목록으로 바꾸면 그 절반이 조용히 막힌다)
 *   aws         https://ip-ranges.amazonaws.com/ip-ranges.json — `prefixes[].ip_prefix` · `ipv6_prefixes[].ipv6_prefix`,
 *               `services`(예: CLOUDFRONT) · `regions`(예: ap-northeast-2, GLOBAL) 로 거른다
 *   gcp         https://www.gstatic.com/ipranges/cloud.json — `prefixes[].ipv4Prefix | ipv6Prefix`,
 *               `services`(예: Google Cloud) · `regions`(= `scope`, 예: asia-northeast3) 로 거른다
 *   fastly      https://api.fastly.com/public-ip-list — `addresses` · `ipv6_addresses`
 *   url         `sourceOptions.url` (https 만). `jsonPath` 가 있으면 JSON 의 그 자리(배열은 펼친다), 없으면 한 줄에 하나
 *               (`#` 뒤는 주석)
 *
 * `family` 는 모든 출처가 받는다(`ipv4` | `ipv6`).
 */
import { httpsGetJson, httpsGetText, type FetchLike } from '../sources/fetch.js';
import {
  ADDRESS_TIMEOUT_MS, MAX_ADDRESS_RESPONSE_BYTES, matches, normalizeCidrs,
  type AddressSource,
} from './source.js';

export type ProviderOptions = { fetch?: FetchLike; timeoutMs?: number };

const get = (p: ProviderOptions) => ({
  ...(p.fetch === undefined ? {} : { fetch: p.fetch }),
  timeoutMs: p.timeoutMs ?? ADDRESS_TIMEOUT_MS,
  maxBytes: MAX_ADDRESS_RESPONSE_BYTES,
});

const lines = (text: string): string[] =>
  text.split('\n').map((l) => l.replace(/#.*$/, '').trim()).filter((l) => l !== '');

export const CLOUDFLARE_V4 = 'https://www.cloudflare.com/ips-v4/';
export const CLOUDFLARE_V6 = 'https://www.cloudflare.com/ips-v6/';

export function cloudflareSource(p: ProviderOptions = {}): AddressSource {
  return {
    kind: 'cloudflare',
    fetch: async (o) => {
      const urls = o.family === 'ipv4' ? [CLOUDFLARE_V4] : o.family === 'ipv6' ? [CLOUDFLARE_V6] : [CLOUDFLARE_V4, CLOUDFLARE_V6];
      const all: string[] = [];
      for (const url of urls) {
        const r = await httpsGetText(url, get(p));
        if (!r.ok) return r;
        const got = lines(r.text);
        if (got.length === 0) return { ok: false, reason: 'invalid', detail: `${url} 가 비었다 — 집합을 바꾸지 않는다` };
        all.push(...got);
      }
      return normalizeCidrs(all, o, 'Cloudflare');
    },
  };
}

export const AWS_IP_RANGES = 'https://ip-ranges.amazonaws.com/ip-ranges.json';

export function awsSource(p: ProviderOptions = {}): AddressSource {
  return {
    kind: 'aws',
    fetch: async (o) => {
      const r = await httpsGetJson(AWS_IP_RANGES, get(p));
      if (!r.ok) return r;
      const j = (r.json ?? {}) as { prefixes?: unknown; ipv6_prefixes?: unknown };
      if (!Array.isArray(j.prefixes) || !Array.isArray(j.ipv6_prefixes)) {
        return { ok: false, reason: 'invalid', detail: 'AWS ip-ranges.json 에 prefixes · ipv6_prefixes 가 없다' };
      }
      const pick = (list: unknown[], field: string): string[] => list.flatMap((x) => {
        const e = (x ?? {}) as Record<string, unknown>;
        if (!matches(o.services, e['service']) || !matches(o.regions, e['region'])) return [];
        return [typeof e[field] === 'string' ? e[field] : ''];
      });
      return normalizeCidrs([...pick(j.prefixes, 'ip_prefix'), ...pick(j.ipv6_prefixes, 'ipv6_prefix')], o, 'AWS');
    },
  };
}

export const GCP_CLOUD_JSON = 'https://www.gstatic.com/ipranges/cloud.json';

export function gcpSource(p: ProviderOptions = {}): AddressSource {
  return {
    kind: 'gcp',
    fetch: async (o) => {
      const r = await httpsGetJson(GCP_CLOUD_JSON, get(p));
      if (!r.ok) return r;
      const list = (r.json as { prefixes?: unknown } | null)?.prefixes;
      if (!Array.isArray(list)) return { ok: false, reason: 'invalid', detail: 'GCP cloud.json 에 prefixes 가 없다' };
      const raw = (list as unknown[]).flatMap((x) => {
        const e = (x ?? {}) as Record<string, unknown>;
        if (!matches(o.services, e['service']) || !matches(o.regions, e['scope'])) return [];
        const c = e['ipv4Prefix'] ?? e['ipv6Prefix'];
        return [typeof c === 'string' ? c : ''];
      });
      return normalizeCidrs(raw, o, 'GCP');
    },
  };
}

export const FASTLY_PUBLIC_IPS = 'https://api.fastly.com/public-ip-list';

export function fastlySource(p: ProviderOptions = {}): AddressSource {
  return {
    kind: 'fastly',
    fetch: async (o) => {
      const r = await httpsGetJson(FASTLY_PUBLIC_IPS, get(p));
      if (!r.ok) return r;
      const j = (r.json ?? {}) as { addresses?: unknown; ipv6_addresses?: unknown };
      if (!Array.isArray(j.addresses)) return { ok: false, reason: 'invalid', detail: 'Fastly 목록에 addresses 가 없다' };
      const strs = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : '')) : []);
      return normalizeCidrs([...strs(j.addresses), ...strs(j.ipv6_addresses)], o, 'Fastly');
    },
  };
}

export function urlSource(p: ProviderOptions = {}): AddressSource {
  return {
    kind: 'url',
    fetch: async (o) => {
      const url = o.url;
      if (url === undefined) return { ok: false, reason: 'unconfigured', detail: 'url 출처에 sourceOptions.url 이 없다' };
      if (o.jsonPath === undefined) {
        const r = await httpsGetText(url, get(p));
        if (!r.ok) return r;
        return normalizeCidrs(lines(r.text), o, url);
      }
      const r = await httpsGetJson(url, get(p));
      if (!r.ok) return r;
      const found = walk(r.json, o.jsonPath.split('.'));
      if (found === undefined) return { ok: false, reason: 'invalid', detail: `${url}: ${o.jsonPath} 자리에 값이 없다` };
      return normalizeCidrs(found.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))), o, url);
    },
  };
}

/** 점 경로를 따라간다. 배열을 만나면 원소마다 나머지 경로를 따라가 펼친다. 끝이 문자열이나 문자열 배열이어야 한다. */
function walk(v: unknown, path: readonly string[]): unknown[] | undefined {
  if (Array.isArray(v)) {
    const parts = v.map((x) => walk(x, path));
    if (parts.some((x) => x === undefined)) return undefined;
    return parts.flat() as unknown[];
  }
  if (path.length === 0) return [v];
  if (typeof v !== 'object' || v === null || !Object.hasOwn(v, path[0]!)) return undefined;
  return walk((v as Record<string, unknown>)[path[0]!], path.slice(1));
}

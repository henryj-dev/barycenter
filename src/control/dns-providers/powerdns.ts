/**
 * dns-01 — PowerDNS 권한 서버 HTTP API (`/api/v1/servers/{server}/zones/{zone}`).
 *
 * API 키는 `X-API-Key` 헤더(파일에서 읽는다). PowerDNS 는 rrset 을 통째로 바꾼다(`REPLACE`) — 같은 이름의
 * 다른 값을 지우지 않게 먼저 지금 값을 읽고 합친다.
 *
 *   읽기    GET   …/zones/{zone}?rrset_name={name.}&rrset_type=TXT
 *   쓰기    PATCH …/zones/{zone}  {rrsets:[{name, type:TXT, ttl:60, changetype:REPLACE|DELETE, records}]}  → 204
 *
 * 영역을 안 주면 위쪽 이름을 차례로 `GET …/zones/{후보.}` 해서 처음 있는 것을 쓴다.
 */
import { excerpt, httpRequest, jsonOf, type HttpResult } from '../../outbound/http.js';
import { fail, OK, zoneCandidates, type Dns01Provider, type DnsResult } from './provider.js';

const MAX_BYTES = 1024 * 1024;

export type PowerDnsOptions = {
  /** `https://pdns.example:8081` */
  apiUrl: string;
  apiKey: string;
  /** 기본 `localhost`(PowerDNS 의 기본 서버 id). */
  server?: string;
  zone?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

type Rrset = { name?: string; type?: string; ttl?: number; records?: { content?: string; disabled?: boolean }[] };

const dot = (n: string): string => (n.endsWith('.') ? n : `${n}.`);

export function powerDns01(o: PowerDnsOptions): Dns01Provider {
  const base = `${o.apiUrl.replace(/\/+$/, '')}/api/v1/servers/${encodeURIComponent(o.server ?? 'localhost')}/zones`;
  const zones = new Map<string, string>();

  const call = (method: 'GET' | 'PATCH', path: string, body?: unknown): Promise<HttpResult> => httpRequest({
    method, url: `${base}${path}`,
    headers: { 'x-api-key': o.apiKey, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
    ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
    maxBytes: MAX_BYTES,
  });

  const bad = (r: HttpResult & { ok: true }, what: string): DnsResult => {
    const said = (jsonOf(r.text) as { error?: string } | undefined)?.error ?? excerpt(r.text);
    if (r.status === 401 || r.status === 403) return fail('auth', `${what}: PowerDNS 가 API 키를 거절했다 (${r.status})`);
    if (r.status === 404) return fail('zone-not-found', `${what}: 영역이 없다 (${said})`);
    if (r.status === 429 || r.status >= 500) return fail('unavailable', `${what}: PowerDNS 가 ${r.status} 로 답했다 (${said})`);
    return fail('rejected', `${what}: PowerDNS 가 거절했다 (${r.status} ${said})`);
  };
  const unreached = (r: HttpResult & { ok: false }, what: string): DnsResult =>
    fail(r.reason === 'insecure' ? 'insecure' : 'unavailable', `${what}: ${r.detail}`);

  const zoneFor = async (name: string): Promise<{ ok: true; zone: string } | { ok: false; result: DnsResult }> => {
    const cached = zones.get(name);
    if (cached !== undefined) return { ok: true, zone: cached };
    if (o.zone !== undefined) return { ok: true, zone: dot(o.zone) };
    const candidates = zoneCandidates(name);
    for (const z of candidates) {
      const r = await call('GET', `/${encodeURIComponent(dot(z))}?rrsets=false`);
      if (!r.ok) return { ok: false, result: unreached(r, `영역 ${z} 찾기`) };
      if (r.status === 200) {
        zones.set(name, dot(z));
        return { ok: true, zone: dot(z) };
      }
      // 없는 영역은 404(오래된 판은 422).
      if (r.status !== 404 && r.status !== 422) return { ok: false, result: bad(r, `영역 ${z} 찾기`) };
    }
    return { ok: false, result: fail('zone-not-found', `${name} 을 담는 PowerDNS 영역이 없다 (본 것: ${candidates.join(', ')})`) };
  };

  const current = async (zone: string, name: string): Promise<{ ok: true; values: string[] } | { ok: false; result: DnsResult }> => {
    const r = await call('GET', `/${encodeURIComponent(zone)}?rrset_name=${encodeURIComponent(dot(name))}&rrset_type=TXT`);
    if (!r.ok) return { ok: false, result: unreached(r, `TXT ${name} 읽기`) };
    if (r.status !== 200) return { ok: false, result: bad(r, `TXT ${name} 읽기`) };
    const rrsets = ((jsonOf(r.text) as { rrsets?: Rrset[] } | undefined)?.rrsets) ?? [];
    // 걸러 주지 않는 판이 있다 — 이름 · 형식으로 다시 거른다.
    const mine = rrsets.find((s) => s.type === 'TXT' && s.name?.toLowerCase() === dot(name).toLowerCase());
    return { ok: true, values: (mine?.records ?? []).map((x) => String(x.content).replace(/^"|"$/g, '')) };
  };

  const write = async (zone: string, name: string, values: string[]): Promise<DnsResult> => {
    const rrset = values.length === 0
      ? { name: dot(name), type: 'TXT', changetype: 'DELETE' }
      : { name: dot(name), type: 'TXT', ttl: 60, changetype: 'REPLACE', records: values.map((v) => ({ content: `"${v}"`, disabled: false })) };
    const r = await call('PATCH', `/${encodeURIComponent(zone)}`, { rrsets: [rrset] });
    if (!r.ok) return unreached(r, `TXT ${name} 쓰기`);
    if (r.status !== 204 && r.status !== 200) return bad(r, `TXT ${name} 쓰기`);
    return OK;
  };

  return {
    kind: 'powerdns',
    async addTxt(name, value) {
      const z = await zoneFor(name);
      if (!z.ok) return z.result;
      const now = await current(z.zone, name);
      if (!now.ok) return now.result;
      if (now.values.includes(value)) return OK;
      return write(z.zone, name, [...now.values, value]);
    },
    async removeTxt(name, value) {
      const z = await zoneFor(name);
      if (!z.ok) return z.result;
      const now = await current(z.zone, name);
      if (!now.ok) return now.result;
      if (!now.values.includes(value)) return OK;
      return write(z.zone, name, now.values.filter((v) => v !== value));
    },
  };
}

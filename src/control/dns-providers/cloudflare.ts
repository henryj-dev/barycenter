/**
 * dns-01 — Cloudflare API v4 (`https://api.cloudflare.com/client/v4`).
 *
 * 토큰은 「Zone · DNS · Edit」 권한의 API 토큰(파일에서 읽는다). 영역은 id(32자 hex) 또는 이름으로 준다.
 * 안 주면 TXT 이름의 위쪽 이름들을 차례로 찾아 처음 맞는 영역을 쓴다.
 *
 *   더하기  POST   /zones/{id}/dns_records  {type:TXT, name, content, ttl:60}   (이미 있음 81058 = 성공)
 *   지우기  GET    /zones/{id}/dns_records?type=TXT&name=…&content=…  → 맞는 것마다 DELETE
 */
import { excerpt, httpRequest, jsonOf, type HttpResult } from '../../outbound/http.js';
import { fail, OK, zoneCandidates, type Dns01Provider, type DnsResult } from './provider.js';

export const CLOUDFLARE_API = 'https://api.cloudflare.com/client/v4';
const MAX_BYTES = 512 * 1024;

export type CloudflareOptions = {
  token: string;
  /** 영역 id(32자 hex) 또는 이름. 없으면 찾는다. */
  zone?: string;
  apiBase?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

type CfBody = { success?: boolean; errors?: { code?: number; message?: string }[]; result?: unknown };

export function cloudflareDns01(o: CloudflareOptions): Dns01Provider {
  const base = (o.apiBase ?? CLOUDFLARE_API).replace(/\/+$/, '');
  const zoneIds = new Map<string, string>();

  const call = (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<HttpResult> => httpRequest({
    method, url: `${base}${path}`,
    headers: { authorization: `Bearer ${o.token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
    ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
    maxBytes: MAX_BYTES,
  });

  /** 상태코드 · 본문의 뜻. 성공이면 본문을 돌려준다. */
  const judge = (r: HttpResult, what: string): { ok: true; body: CfBody } | { ok: false; result: DnsResult } => {
    if (!r.ok) return { ok: false, result: fail(r.reason === 'insecure' ? 'insecure' : 'unavailable', `${what}: ${r.detail}`) };
    const body = (jsonOf(r.text) ?? {}) as CfBody;
    const said = body.errors?.map((e) => `${e.code ?? '?'} ${e.message ?? ''}`.trim()).join('; ') ?? excerpt(r.text);
    if (r.status === 401 || r.status === 403) return { ok: false, result: fail('auth', `${what}: Cloudflare 가 토큰을 거절했다 (${r.status} ${said})`) };
    if (r.status === 429 || r.status >= 500) return { ok: false, result: fail('unavailable', `${what}: Cloudflare 가 ${r.status} 로 답했다 (${said})`) };
    if (r.status === 404) return { ok: false, result: fail('zone-not-found', `${what}: 영역이 없다 (${said})`) };
    if (r.status < 200 || r.status >= 300 || body.success !== true) {
      return { ok: false, result: fail('rejected', `${what}: Cloudflare 가 거절했다 (${r.status} ${said})`) };
    }
    return { ok: true, body };
  };

  const zoneIdByName = async (zone: string): Promise<{ id?: string; result?: DnsResult }> => {
    const j = judge(await call('GET', `/zones?name=${encodeURIComponent(zone)}`), `영역 ${zone} 찾기`);
    if (!j.ok) return { result: j.result };
    const list = Array.isArray(j.body.result) ? j.body.result as { id?: unknown; name?: unknown }[] : [];
    const hit = list.find((z) => typeof z.id === 'string' && String(z.name).toLowerCase() === zone);
    return hit === undefined ? {} : { id: String(hit.id) };
  };

  const zoneFor = async (name: string): Promise<{ ok: true; id: string } | { ok: false; result: DnsResult }> => {
    const cached = zoneIds.get(name);
    if (cached !== undefined) return { ok: true, id: cached };
    if (o.zone !== undefined && /^[0-9a-f]{32}$/.test(o.zone)) return { ok: true, id: o.zone };
    const candidates = o.zone !== undefined ? [o.zone.toLowerCase().replace(/\.$/, '')] : zoneCandidates(name);
    for (const z of candidates) {
      const found = await zoneIdByName(z);
      if (found.result !== undefined) return { ok: false, result: found.result };
      if (found.id !== undefined) {
        zoneIds.set(name, found.id);
        return { ok: true, id: found.id };
      }
    }
    return { ok: false, result: fail('zone-not-found', `${name} 을 담는 Cloudflare 영역이 없다 (본 것: ${candidates.join(', ')})`) };
  };

  return {
    kind: 'cloudflare',
    async addTxt(name, value) {
      const z = await zoneFor(name);
      if (!z.ok) return z.result;
      const r = await call('POST', `/zones/${z.id}/dns_records`, { type: 'TXT', name, content: value, ttl: 60 });
      // 같은 레코드가 이미 있다(81058) — 재시도에서 다시 놓는 것이다. 성공으로 본다.
      if (r.ok && (jsonOf(r.text) as CfBody | undefined)?.errors?.some((e) => e.code === 81058) === true) return OK;
      const j = judge(r, `TXT ${name} 더하기`);
      return j.ok ? OK : j.result;
    },
    async removeTxt(name, value) {
      const z = await zoneFor(name);
      if (!z.ok) return z.result;
      const q = `type=TXT&name=${encodeURIComponent(name)}&content=${encodeURIComponent(value)}`;
      const j = judge(await call('GET', `/zones/${z.id}/dns_records?${q}`), `TXT ${name} 찾기`);
      if (!j.ok) return j.result;
      const list = Array.isArray(j.body.result) ? j.body.result as { id?: unknown; content?: unknown }[] : [];
      for (const rec of list) {
        // 따옴표를 붙여 저장하는 계정이 있다 — 값으로만 대조한다.
        if (typeof rec.id !== 'string' || String(rec.content).replace(/^"|"$/g, '') !== value) continue;
        const d = judge(await call('DELETE', `/zones/${z.id}/dns_records/${encodeURIComponent(rec.id)}`), `TXT ${name} 지우기`);
        if (!d.ok) return d.result;
      }
      return OK;
    },
  };
}

/**
 * dns-01 — Amazon Route 53 (`https://route53.amazonaws.com/2013-04-01`). SDK 없이 SigV4 로 직접 서명한다.
 *
 * 호스팅 영역 id 를 꼭 준다(`Z…`). Route 53 도 rrset 을 통째로 바꾼다 — 먼저 지금 값을 읽고 합친다.
 *
 *   읽기    GET  /hostedzone/{id}/rrset?name={name}&type=TXT&maxitems=1
 *   쓰기    POST /hostedzone/{id}/rrset   ChangeResourceRecordSetsRequest (UPSERT · 마지막 값이면 DELETE)
 *
 * 바꾼 것이 모든 Route 53 서버에 퍼지는 것(INSYNC)은 기다리지 않는다 — 공통 전파 대기(`propagation.ts`)가
 * 권한 이름서버에서 직접 본다.
 */
import { excerpt, httpRequest, type HttpResult } from '../../outbound/http.js';
import { signV4, type AwsCredentials } from '../../outbound/sigv4.js';
import { fail, OK, type Dns01Provider, type DnsResult } from './provider.js';

export const ROUTE53_API = 'https://route53.amazonaws.com/2013-04-01';
const MAX_BYTES = 256 * 1024;

export type Route53Options = {
  hostedZoneId: string;
  credentials: AwsCredentials;
  apiBase?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
  now?: () => Date;
};

const xmlEscape = (s: string): string => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const tag = (xml: string, name: string): string | undefined => new RegExp(`<${name}>([^<]*)</${name}>`).exec(xml)?.[1];

export function route53Dns01(o: Route53Options): Dns01Provider {
  const base = (o.apiBase ?? ROUTE53_API).replace(/\/+$/, '');
  const zone = o.hostedZoneId.replace(/^\/?hostedzone\//, '');

  const call = (method: 'GET' | 'POST', url: string, body = ''): Promise<HttpResult> => httpRequest({
    method, url,
    headers: signV4({
      method, url, body, region: 'us-east-1', service: 'route53', credentials: o.credentials, now: o.now?.() ?? new Date(),
      headers: body === '' ? {} : { 'content-type': 'text/xml' },
    }),
    ...(body === '' ? {} : { body }),
    ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
    ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
    maxBytes: MAX_BYTES,
  });

  const judge = (r: HttpResult, what: string): DnsResult | undefined => {
    if (!r.ok) return fail(r.reason === 'insecure' ? 'insecure' : 'unavailable', `${what}: ${r.detail}`);
    if (r.status >= 200 && r.status < 300) return undefined;
    const code = tag(r.text, 'Code') ?? '';
    const said = `${r.status} ${code} ${tag(r.text, 'Message') ?? excerpt(r.text)}`.trim();
    if (r.status === 403 || code === 'SignatureDoesNotMatch' || code === 'InvalidClientTokenId' || code === 'AccessDenied') {
      return fail('auth', `${what}: Route 53 이 자격증명을 거절했다 (${said})`);
    }
    if (code === 'NoSuchHostedZone' || r.status === 404) return fail('zone-not-found', `${what}: 호스팅 영역 ${zone} 이 없다 (${said})`);
    if (r.status >= 500 || code === 'Throttling' || code === 'PriorRequestNotComplete') return fail('unavailable', `${what}: Route 53 이 ${said} 로 답했다`);
    return fail('rejected', `${what}: Route 53 이 거절했다 (${said})`);
  };

  const current = async (name: string): Promise<{ ok: true; values: string[]; ttl: number } | { ok: false; result: DnsResult }> => {
    const r = await call('GET', `${base}/hostedzone/${encodeURIComponent(zone)}/rrset?name=${encodeURIComponent(name)}&type=TXT&maxitems=1`);
    const bad = judge(r, `TXT ${name} 읽기`);
    if (bad !== undefined || !r.ok) return { ok: false, result: bad ?? fail('unavailable', '읽기 실패') };
    const set = /<ResourceRecordSet>([\s\S]*?)<\/ResourceRecordSet>/.exec(r.text)?.[1];
    // 목록은 「그 이름부터」 이다 — 첫 항목이 우리 이름 · TXT 일 때만 우리 것이다.
    if (set === undefined || tag(set, 'Name')?.toLowerCase().replace(/\.$/, '') !== name.toLowerCase() || tag(set, 'Type') !== 'TXT') {
      return { ok: true, values: [], ttl: 60 };
    }
    const values = [...set.matchAll(/<Value>([^<]*)<\/Value>/g)].map((m) => (m[1] ?? '').replace(/&quot;/g, '"').replace(/^"|"$/g, ''));
    return { ok: true, values, ttl: Number(tag(set, 'TTL') ?? 60) };
  };

  const change = async (action: 'UPSERT' | 'DELETE', name: string, values: string[], ttl: number): Promise<DnsResult> => {
    const records = values.map((v) => `<ResourceRecord><Value>"${xmlEscape(v)}"</Value></ResourceRecord>`).join('');
    const body = '<?xml version="1.0" encoding="UTF-8"?>'
      + '<ChangeResourceRecordSetsRequest xmlns="https://route53.amazonaws.com/doc/2013-04-01/"><ChangeBatch>'
      + `<Comment>barycenter dns-01</Comment><Changes><Change><Action>${action}</Action><ResourceRecordSet>`
      + `<Name>${xmlEscape(name)}</Name><Type>TXT</Type><TTL>${ttl}</TTL><ResourceRecords>${records}</ResourceRecords>`
      + '</ResourceRecordSet></Change></Changes></ChangeBatch></ChangeResourceRecordSetsRequest>';
    return judge(await call('POST', `${base}/hostedzone/${encodeURIComponent(zone)}/rrset`, body), `TXT ${name} ${action}`) ?? OK;
  };

  return {
    kind: 'route53',
    async addTxt(name, value) {
      const now = await current(name);
      if (!now.ok) return now.result;
      if (now.values.includes(value)) return OK;
      return change('UPSERT', name, [...now.values, value], 60);
    },
    async removeTxt(name, value) {
      const now = await current(name);
      if (!now.ok) return now.result;
      if (!now.values.includes(value)) return OK;
      const rest = now.values.filter((v) => v !== value);
      // DELETE 는 지금 값 · TTL 과 정확히 같아야 한다.
      return rest.length === 0 ? change('DELETE', name, now.values, now.ttl) : change('UPSERT', name, rest, now.ttl);
    },
  };
}

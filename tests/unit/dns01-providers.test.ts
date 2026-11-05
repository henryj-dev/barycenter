/**
 * dns-01 공급자 어댑터 · 등록부 · 전파 대기 · 배치기.
 *
 * 공급자 API 는 주입한 `fetch` 가 흉내 낸다(실제 망 없음). 토큰 · 키는 실행 중에 만든 가짜 값이다.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { cleanupPlacedChallenges } from '../../src/control/acme-runner.js';
import type { ChallengeRow } from '../../src/control/acme-store.js';
import { cloudflareDns01 } from '../../src/control/dns-providers/cloudflare.js';
import { Dns01Placer } from '../../src/control/dns-providers/placer.js';
import { waitForTxt, type TxtResolver } from '../../src/control/dns-providers/propagation.js';
import { powerDns01 } from '../../src/control/dns-providers/powerdns.js';
import { zoneCandidates, type Dns01Provider } from '../../src/control/dns-providers/provider.js';
import { dns01FromEnv } from '../../src/control/dns-providers/registry.js';
import { rfc2136Dns01, type Runner } from '../../src/control/dns-providers/rfc2136.js';
import { route53Dns01 } from '../../src/control/dns-providers/route53.js';
import { FileDns01 } from '../../src/control/dns01.js';
import { setSink } from '../../src/obs/log.js';

const fakeToken = ['fake', 'dns', 'token'].join('-');
const VALUE = 'a'.repeat(43);
const NAME = '_acme-challenge.www.example.com';

type Call = { method: string; url: string; headers: Record<string, string>; body: string | undefined };
function fakeFetch(answer: (c: Call) => Response | Promise<Response>): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  const f = (async (url: string | URL, init?: RequestInit) => {
    const c: Call = {
      method: init?.method ?? 'GET', url: String(url),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: typeof init?.body === 'string' ? init.body : undefined,
    };
    calls.push(c);
    expect(init?.redirect).toBe('error');
    return answer(c);
  }) as typeof fetch;
  return { fetch: f, calls };
}
const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('zoneCandidates', () => {
  it('긴 것부터, 첫 라벨과 최상위 하나만 남은 것은 뺀다', () => {
    expect(zoneCandidates(NAME)).toEqual(['www.example.com', 'example.com']);
  });
});

describe('cloudflare', () => {
  it('영역을 이름으로 찾고 TXT 를 더한다 — Bearer 토큰 · ttl 60', async () => {
    const { fetch, calls } = fakeFetch((c) => {
      if (c.url.includes('/zones?name=www.example.com')) return json(200, { success: true, result: [] });
      if (c.url.includes('/zones?name=example.com')) return json(200, { success: true, result: [{ id: 'z1', name: 'example.com' }] });
      return json(200, { success: true, result: { id: 'r1' } });
    });
    const p = cloudflareDns01({ token: fakeToken, fetch });
    expect(await p.addTxt(NAME, VALUE)).toEqual({ ok: true });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('https://api.cloudflare.com/client/v4/zones/z1/dns_records');
    expect(JSON.parse(post.body!)).toEqual({ type: 'TXT', name: NAME, content: VALUE, ttl: 60 });
    expect(post.headers['authorization']).toBe(`Bearer ${fakeToken}`);
  });

  it('이미 있는 레코드(81058)는 성공', async () => {
    const { fetch } = fakeFetch(() => json(400, { success: false, errors: [{ code: 81058, message: 'An identical record already exists.' }] }));
    expect(await cloudflareDns01({ token: fakeToken, zone: 'f'.repeat(32), fetch }).addTxt(NAME, VALUE)).toEqual({ ok: true });
  });

  it('지울 때 그 값의 레코드만 지운다', async () => {
    const { fetch, calls } = fakeFetch((c) => (c.method === 'GET'
      ? json(200, { success: true, result: [{ id: 'mine', content: VALUE }, { id: 'other', content: 'b'.repeat(43) }] })
      : json(200, { success: true, result: { id: 'mine' } })));
    expect(await cloudflareDns01({ token: fakeToken, zone: 'f'.repeat(32), fetch }).removeTxt(NAME, VALUE)).toEqual({ ok: true });
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.url.split('/').pop())).toEqual(['mine']);
  });

  it('상태코드의 뜻 — 403 auth · 429 unavailable · 400 rejected · 없는 영역', async () => {
    const at = (status: number, body: unknown = { success: false, errors: [{ code: 1, message: 'x' }] }): Promise<unknown> =>
      cloudflareDns01({ token: fakeToken, zone: 'f'.repeat(32), fetch: fakeFetch(() => json(status, body)).fetch }).addTxt(NAME, VALUE);
    expect(await at(403)).toMatchObject({ ok: false, reason: 'auth' });
    expect(await at(429)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(await at(400)).toMatchObject({ ok: false, reason: 'rejected' });
    const none = await cloudflareDns01({ token: fakeToken, fetch: fakeFetch(() => json(200, { success: true, result: [] })).fetch }).addTxt(NAME, VALUE);
    expect(none).toMatchObject({ ok: false, reason: 'zone-not-found' });
  });

  it('http API 주소는 거절 · 큰 답은 끊는다', async () => {
    const { fetch, calls } = fakeFetch(() => json(200, {}));
    expect(await cloudflareDns01({ token: fakeToken, zone: 'f'.repeat(32), apiBase: 'http://api.test', fetch }).addTxt(NAME, VALUE)).toMatchObject({ ok: false, reason: 'insecure' });
    expect(calls).toHaveLength(0);
    const big = fakeFetch(() => new Response('x'.repeat(600 * 1024))).fetch;
    expect(await cloudflareDns01({ token: fakeToken, zone: 'f'.repeat(32), fetch: big }).addTxt(NAME, VALUE)).toMatchObject({ ok: false, reason: 'unavailable', detail: expect.stringContaining('넘는다') });
  });
});

describe('powerdns', () => {
  it('지금 값과 합쳐 REPLACE — 다른 값을 덮지 않는다 · X-API-Key', async () => {
    const other = 'b'.repeat(43);
    const { fetch, calls } = fakeFetch((c) => (c.method === 'GET'
      ? json(200, { rrsets: [{ name: `${NAME}.`, type: 'TXT', records: [{ content: `"${other}"` }] }] })
      : new Response(null, { status: 204 })));
    const p = powerDns01({ apiUrl: 'https://pdns.test:8081', apiKey: fakeToken, zone: 'example.com', fetch });
    expect(await p.addTxt(NAME, VALUE)).toEqual({ ok: true });
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.url).toBe('https://pdns.test:8081/api/v1/servers/localhost/zones/example.com.');
    expect(patch.headers['x-api-key']).toBe(fakeToken);
    expect(JSON.parse(patch.body!).rrsets[0]).toMatchObject({ changetype: 'REPLACE', records: [{ content: `"${other}"` }, { content: `"${VALUE}"` }] });
  });

  it('마지막 값을 지우면 DELETE · 영역을 찾을 때 404 면 위로', async () => {
    const { fetch, calls } = fakeFetch((c) => {
      if (c.url.includes('/zones/www.example.com.?rrsets=false')) return json(404, { error: 'Could not find domain' });
      if (c.url.includes('/zones/example.com.?rrsets=false')) return json(200, {});
      if (c.method === 'GET') return json(200, { rrsets: [{ name: `${NAME}.`, type: 'TXT', records: [{ content: `"${VALUE}"` }] }] });
      return new Response(null, { status: 204 });
    });
    expect(await powerDns01({ apiUrl: 'https://pdns.test', apiKey: fakeToken, fetch }).removeTxt(NAME, VALUE)).toEqual({ ok: true });
    expect(JSON.parse(calls.find((c) => c.method === 'PATCH')!.body!).rrsets[0]).toMatchObject({ changetype: 'DELETE' });
  });

  it('401 은 auth · 422 쓰기는 rejected', async () => {
    expect(await powerDns01({ apiUrl: 'https://pdns.test', apiKey: fakeToken, zone: 'example.com', fetch: fakeFetch(() => json(401, {})).fetch }).addTxt(NAME, VALUE)).toMatchObject({ ok: false, reason: 'auth' });
    const f = fakeFetch((c) => (c.method === 'GET' ? json(200, { rrsets: [] }) : json(422, { error: 'bad' }))).fetch;
    expect(await powerDns01({ apiUrl: 'https://pdns.test', apiKey: fakeToken, zone: 'example.com', fetch: f }).addTxt(NAME, VALUE)).toMatchObject({ ok: false, reason: 'rejected' });
  });
});

describe('route53', () => {
  const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: ['fake', 'aws', 'secret'].join('-') };
  const listXml = (values: string[]): string => `<?xml version="1.0"?><ListResourceRecordSetsResponse><ResourceRecordSets>${values.length === 0 ? ''
    : `<ResourceRecordSet><Name>${NAME}.</Name><Type>TXT</Type><TTL>60</TTL><ResourceRecords>${values.map((v) => `<ResourceRecord><Value>&quot;${v}&quot;</Value></ResourceRecord>`).join('')}</ResourceRecords></ResourceRecordSet>`}</ResourceRecordSets></ListResourceRecordSetsResponse>`;

  it('SigV4 로 서명하고 UPSERT 에 기존 값을 함께 싣는다', async () => {
    const other = 'b'.repeat(43);
    const { fetch, calls } = fakeFetch((c) => new Response(c.method === 'GET' ? listXml([other]) : '<ChangeInfo/>', { status: 200 }));
    expect(await route53Dns01({ hostedZoneId: 'Z123', credentials, fetch, now: () => new Date('2026-11-05T00:00:00Z') }).addTxt(NAME, VALUE)).toEqual({ ok: true });
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.url).toBe('https://route53.amazonaws.com/2013-04-01/hostedzone/Z123/rrset');
    expect(post.headers['authorization']).toMatch(/^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20261105\/us-east-1\/route53\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
    expect(post.body).toContain('<Action>UPSERT</Action>');
    expect(post.body).toContain(`<Value>"${other}"</Value>`);
    expect(post.body).toContain(`<Value>"${VALUE}"</Value>`);
  });

  it('마지막 값이면 DELETE · 403 은 auth · NoSuchHostedZone', async () => {
    const del = fakeFetch((c) => new Response(c.method === 'GET' ? listXml([VALUE]) : '', { status: 200 }));
    expect(await route53Dns01({ hostedZoneId: 'Z1', credentials, fetch: del.fetch }).removeTxt(NAME, VALUE)).toEqual({ ok: true });
    expect(del.calls.find((c) => c.method === 'POST')!.body).toContain('<Action>DELETE</Action>');
    const denied = fakeFetch(() => new Response('<ErrorResponse><Error><Code>SignatureDoesNotMatch</Code><Message>no</Message></Error></ErrorResponse>', { status: 403 })).fetch;
    expect(await route53Dns01({ hostedZoneId: 'Z1', credentials, fetch: denied }).addTxt(NAME, VALUE)).toMatchObject({ ok: false, reason: 'auth' });
    const nozone = fakeFetch(() => new Response('<ErrorResponse><Error><Code>NoSuchHostedZone</Code></Error></ErrorResponse>', { status: 404 })).fetch;
    expect(await route53Dns01({ hostedZoneId: 'Z1', credentials, fetch: nozone }).addTxt(NAME, VALUE)).toMatchObject({ ok: false, reason: 'zone-not-found' });
  });
});

describe('rfc2136 (nsupdate)', () => {
  it('쉘 없이 -k 키파일로 부르고, 명령은 표준입력으로 — 비밀은 인자 · 입력에 없다', async () => {
    const seen: { cmd: string; args: string[]; stdin: string }[] = [];
    const run: Runner = async (cmd, args, stdin) => { seen.push({ cmd, args, stdin }); return { code: 0, stdout: '', stderr: '' }; };
    const p = rfc2136Dns01({ server: 'ns1.example.com:5353', keyFile: '/etc/bary/tsig.key', zone: 'example.com', run });
    expect(await p.addTxt(NAME, VALUE)).toEqual({ ok: true });
    expect(await p.removeTxt(NAME, VALUE)).toEqual({ ok: true });
    expect(seen[0]).toMatchObject({ cmd: 'nsupdate', args: ['-k', '/etc/bary/tsig.key'] });
    expect(seen[0]!.stdin).toBe(`server ns1.example.com 5353\nzone example.com\nupdate add ${NAME}. 60 IN TXT "${VALUE}"\nsend\nquit\n`);
    expect(seen[1]!.stdin).toContain(`update delete ${NAME}. IN TXT "${VALUE}"`);
  });

  it('줄바꿈이 섞인 이름은 보내지 않는다 · 서버 형식 거절', async () => {
    let ran = false;
    const p = rfc2136Dns01({ server: '192.0.2.1', keyFile: '/k', run: async () => { ran = true; return { code: 0, stdout: '', stderr: '' }; } });
    expect(await p.addTxt('_acme-challenge.a.test\nupdate delete a.test', VALUE)).toMatchObject({ ok: false, reason: 'rejected' });
    expect(ran).toBe(false);
    expect(() => rfc2136Dns01({ server: 'ns1;rm -rf /', keyFile: '/k' })).toThrow();
  });

  it('출력으로 사유를 가른다 — TSIG · NOTZONE · REFUSED · 없는 nsupdate', async () => {
    const at = (r: Awaited<ReturnType<Runner>>): Promise<unknown> => rfc2136Dns01({ server: '192.0.2.1', keyFile: '/k', run: async () => r }).addTxt(NAME, VALUE);
    expect(await at({ code: 2, stdout: '', stderr: '; TSIG error with server: tsig verify failure' })).toMatchObject({ reason: 'auth' });
    expect(await at({ code: 2, stdout: '', stderr: 'update failed: NOTZONE' })).toMatchObject({ reason: 'zone-not-found' });
    expect(await at({ code: 2, stdout: '', stderr: 'update failed: REFUSED' })).toMatchObject({ reason: 'rejected' });
    expect(await at({ code: null, stdout: '', stderr: '', error: 'ENOENT' })).toMatchObject({ reason: 'unavailable', detail: expect.stringContaining('nsupdate') });
  });
});

describe('전파 대기', () => {
  const clock = (): { now: () => number; sleep: (ms: number) => Promise<void> } => {
    let t = 0;
    return { now: () => t, sleep: async (ms) => { t += ms; } };
  };

  it('권한 서버 전부가 값을 답하면 끝난다', async () => {
    let round = 0;
    const resolver: TxtResolver = {
      authoritative: async () => ['192.0.2.1', '192.0.2.2'],
      txt: async (s) => (s === '192.0.2.2' && round++ < 2 ? [] : [VALUE]),
    };
    expect(await waitForTxt(NAME, VALUE, { timeoutMs: 60_000, intervalMs: 5_000, resolver, ...clock() })).toEqual({ ok: true });
  });

  it('시간이 다 되면 propagation-timeout(어느 서버가 늦는지 사유에)', async () => {
    const resolver: TxtResolver = { authoritative: async () => ['192.0.2.9'], txt: async () => [] };
    expect(await waitForTxt(NAME, VALUE, { timeoutMs: 20_000, intervalMs: 5_000, resolver, ...clock() }))
      .toMatchObject({ ok: false, reason: 'propagation-timeout', detail: expect.stringContaining('192.0.2.9') });
  });
});

describe('Dns01Placer', () => {
  const ok = { ok: true } as const;
  const provider = (over: Partial<Dns01Provider> = {}): Dns01Provider & { added: string[]; removed: string[] } => {
    const p = { kind: 'fake', added: [] as string[], removed: [] as string[],
      addTxt: async (n: string, v: string) => { p.added.push(`${n}=${v}`); return ok; },
      removeTxt: async (n: string, v: string) => { p.removed.push(`${n}=${v}`); return ok; }, ...over };
    return p;
  };

  it('와일드카드는 apex 이름으로 놓고, 지울 때 값을 넘긴다', async () => {
    const p = provider();
    const placer = new Dns01Placer(p);
    await placer.place('*.example.com', 't', VALUE);
    await placer.remove('*.example.com', 't', VALUE);
    expect(p.added).toEqual([`_acme-challenge.example.com=${VALUE}`]);
    expect(p.removed).toEqual([`_acme-challenge.example.com=${VALUE}`]);
  });

  it('놓기 실패는 던진다(러너가 주문 실패로 적는다) — 사유를 싣는다', async () => {
    const placer = new Dns01Placer(provider({ addTxt: async () => ({ ok: false, reason: 'auth', detail: '토큰 거절' }) }));
    await expect(placer.place('a.example.com', 't', VALUE)).rejects.toThrow(/fake · auth.*토큰 거절/);
  });

  it('전파 시간이 다 돼도 수락은 진행한다(경고만)', async () => {
    const lines: string[] = [];
    setSink((l) => lines.push(l));
    try {
      let t = 0;
      const placer = new Dns01Placer(provider(), {
        timeoutMs: 10_000, intervalMs: 5_000, now: () => t, sleep: async (ms) => { t += ms; },
        resolver: { authoritative: async () => ['192.0.2.1'], txt: async () => [] },
      });
      await placer.place('a.example.com', 't', VALUE);
      expect(lines.some((l) => l.includes('acme.dns01.propagation_timeout'))).toBe(true);
    } finally {
      setSink((l) => process.stdout.write(`${l}\n`));
    }
  });

  it('지우기 실패는 발급을 막지 않는다 — 경고, 원장은 「안 치움」 으로 남는다', async () => {
    const lines: string[] = [];
    setSink((l) => lines.push(l));
    try {
      const placer = new Dns01Placer(provider({ removeTxt: async () => ({ ok: false, reason: 'unavailable', detail: '503' }) }));
      const row: ChallengeRow = { id: 'c1', orderId: 'o1', domain: 'a.example.com', type: 'dns-01', token: 't', value: VALUE,
        authzUrl: 'https://ca/authz', challengeUrl: 'https://ca/ch', placedAt: '2026-11-05T00:00:00Z', cleanedAt: undefined };
      const cleaned: string[] = [];
      const n = await cleanupPlacedChallenges([row], (r) => placer.remove(r.domain, r.token, r.value), async (id) => { cleaned.push(id); });
      expect(n).toBe(0);
      expect(cleaned).toEqual([]);
      expect(lines.some((l) => l.includes('acme.dns01.remove_failed') && l.includes('_acme-challenge.a.example.com'))).toBe(true);
    } finally {
      setSink((l) => process.stdout.write(`${l}\n`));
    }
  });
});

describe('등록부 (BARY_DNS01_KIND)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bary-dns01-'));
  const tokenFile = join(dir, 'token');
  writeFileSync(tokenFile, `${fakeToken}\n`);

  it('설정이 없으면 끈다 — 지금과 같다', () => {
    expect(dns01FromEnv({})).toBeUndefined();
  });

  it('BARY_DNS01_DIR 만 있으면 file — 지금과 같은 FileDns01', async () => {
    const s = dns01FromEnv({ BARY_DNS01_DIR: join(dir, 'txt') })!;
    expect(s.kind).toBe('file');
    expect(s.placer).toBeInstanceOf(FileDns01);
    await s.placer.place('a.example.com', 't', VALUE);
    expect(readFileSync(join(dir, 'txt', '_acme-challenge.a.example.com'), 'utf8')).toBe(`${VALUE}\n`);
  });

  it('모르는 이름은 던진다', () => {
    expect(() => dns01FromEnv({ BARY_DNS01_KIND: 'godaddy' })).toThrow(/모르는 dns-01 공급자: godaddy/);
  });

  it('반만 설정이면 거부 — 필요한 값 없음 · 종류 없이 변수만 · 다른 종류 변수 섞임', () => {
    expect(() => dns01FromEnv({ BARY_DNS01_KIND: 'cloudflare' })).toThrow(/BARY_DNS01_CLOUDFLARE_TOKEN_FILE/);
    expect(() => dns01FromEnv({ BARY_DNS01_CLOUDFLARE_TOKEN_FILE: tokenFile })).toThrow(/BARY_DNS01_KIND 가 없다/);
    expect(() => dns01FromEnv({ BARY_DNS01_KIND: 'cloudflare', BARY_DNS01_CLOUDFLARE_TOKEN_FILE: tokenFile, BARY_DNS01_DIR: dir })).toThrow(/쓰지 않는 변수/);
    expect(() => dns01FromEnv({ BARY_DNS01_KIND: 'route53', BARY_DNS01_ZONE: 'Z1', BARY_DNS01_AWS_ACCESS_KEY_ID: 'AKIDEXAMPLE' })).toThrow(/SECRET_ACCESS_KEY_FILE/);
    expect(() => dns01FromEnv({ BARY_DNS01_KIND: 'powerdns', BARY_DNS01_POWERDNS_URL: 'http://pdns.test', BARY_DNS01_POWERDNS_API_KEY_FILE: tokenFile })).toThrow(/https/);
    expect(() => dns01FromEnv({ BARY_DNS01_KIND: 'cloudflare', BARY_DNS01_CLOUDFLARE_TOKEN_FILE: join(dir, 'missing') })).toThrow(/읽지 못했다/);
  });

  it('API 공급자는 Dns01Placer + 기본 전파 대기 60초 · 0 이면 끈다', () => {
    const s = dns01FromEnv({ BARY_DNS01_KIND: 'cloudflare', BARY_DNS01_CLOUDFLARE_TOKEN_FILE: tokenFile })!;
    expect(s.placer).toBeInstanceOf(Dns01Placer);
    expect(s.propagation).toEqual({ timeoutMs: 60_000, intervalMs: 5_000 });
    expect(dns01FromEnv({ BARY_DNS01_KIND: 'cloudflare', BARY_DNS01_CLOUDFLARE_TOKEN_FILE: tokenFile, BARY_DNS01_PROPAGATION_TIMEOUT_S: '0' })!.propagation).toBeUndefined();
    expect(dns01FromEnv({ BARY_DNS01_KIND: 'rfc2136', BARY_DNS01_RFC2136_SERVER: '192.0.2.1', BARY_DNS01_RFC2136_KEY_FILE: tokenFile })!.kind).toBe('rfc2136');
  });
});

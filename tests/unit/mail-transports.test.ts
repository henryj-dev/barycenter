/**
 * 메일 전송 어댑터(SES · Mailgun · SendGrid · log) · 등록부(BARY_MAIL_KIND).
 *
 * 서비스 API 는 주입한 `fetch` 가 흉내 낸다. 키는 실행 중에 만든 가짜 값이다.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { mailgunTransport, sendgridTransport, sesTransport } from '../../src/accounts/mail-transport/http-services.js';
import { logTransport } from '../../src/accounts/mail-transport/log.js';
import { mailFromEnv } from '../../src/accounts/mail-transport/registry.js';
import { maskAddress, mailerOf, type MailTransport } from '../../src/accounts/mail-transport/transport.js';
import { mailText } from '../../src/accounts/mail.js';
import { setSink } from '../../src/obs/log.js';

const fakeKey = ['fake', 'mail', 'key'].join('-');
const MSG = { from: 'barycenter <noreply@example.com>', to: 'alice@example.org', subject: '제목', text: '본문 https://bary.example/x' };

type Call = { url: string; headers: Record<string, string>; body: string };
function fakeFetch(res: () => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (async (url: string | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body) });
      return res();
    }) as typeof fetch,
  };
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  setSink((l) => lines.push(l));
  return { lines, restore: () => setSink((l) => process.stdout.write(`${l}\n`)) };
}

describe('SES', () => {
  const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: ['fake', 'aws', 'secret'].join('-') };
  it('v2 outbound-emails 에 SigV4(ses) 로 보낸다', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(JSON.stringify({ MessageId: 'm-1' }), { status: 200 }));
    expect(await sesTransport({ region: 'ap-northeast-2', credentials, fetch }).deliver(MSG)).toEqual({ ok: true, id: 'm-1' });
    expect(calls[0]!.url).toBe('https://email.ap-northeast-2.amazonaws.com/v2/email/outbound-emails');
    expect(calls[0]!.headers['authorization']).toMatch(/\/ap-northeast-2\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=/);
    expect(JSON.parse(calls[0]!.body)).toMatchObject({ FromEmailAddress: MSG.from, Destination: { ToAddresses: [MSG.to] } });
  });
  it('403 auth · 400 rejected · 429 rate-limited', async () => {
    const at = (s: number): Promise<unknown> => sesTransport({ region: 'us-east-1', credentials, fetch: fakeFetch(() => new Response('{"message":"x"}', { status: s })).fetch }).deliver(MSG);
    expect(await at(403)).toMatchObject({ ok: false, reason: 'auth' });
    expect(await at(400)).toMatchObject({ ok: false, reason: 'rejected' });
    expect(await at(429)).toMatchObject({ ok: false, reason: 'rate-limited' });
  });
});

describe('Mailgun', () => {
  it('Basic api:key · form 본문 · eu 지역 주소', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(JSON.stringify({ id: '<x@mg>' }), { status: 200 }));
    expect(await mailgunTransport({ domain: 'mg.example.com', apiKey: fakeKey, region: 'eu', fetch }).deliver(MSG)).toEqual({ ok: true, id: '<x@mg>' });
    expect(calls[0]!.url).toBe('https://api.eu.mailgun.net/v3/mg.example.com/messages');
    expect(calls[0]!.headers['authorization']).toBe(`Basic ${Buffer.from(`api:${fakeKey}`).toString('base64')}`);
    expect(new URLSearchParams(calls[0]!.body).get('to')).toBe(MSG.to);
  });
  it('401 auth · 5xx unavailable', async () => {
    expect(await mailgunTransport({ domain: 'mg.example.com', apiKey: fakeKey, fetch: fakeFetch(() => new Response('Forbidden', { status: 401 })).fetch }).deliver(MSG)).toMatchObject({ reason: 'auth' });
    expect(await mailgunTransport({ domain: 'mg.example.com', apiKey: fakeKey, fetch: fakeFetch(() => new Response('', { status: 502 })).fetch }).deliver(MSG)).toMatchObject({ reason: 'unavailable' });
  });
});

describe('SendGrid', () => {
  it('Bearer · 202 는 성공 · 보내는 사람 이름을 가른다', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 202, headers: { 'x-message-id': 'sg-1' } }));
    expect(await sendgridTransport({ apiKey: fakeKey, fetch }).deliver(MSG)).toEqual({ ok: true, id: 'sg-1' });
    expect(calls[0]!.headers['authorization']).toBe(`Bearer ${fakeKey}`);
    expect(JSON.parse(calls[0]!.body).from).toEqual({ email: 'noreply@example.com', name: 'barycenter' });
  });
  it('http 주소 거절 · 큰 답은 끊는다', async () => {
    const f = fakeFetch(() => new Response(''));
    expect(await sendgridTransport({ apiKey: fakeKey, apiBase: 'http://sg.test', fetch: f.fetch }).deliver(MSG)).toMatchObject({ ok: false, reason: 'insecure' });
    expect(f.calls).toHaveLength(0);
    const big = fakeFetch(() => new Response('x'.repeat(100 * 1024), { status: 400 })).fetch;
    expect(await sendgridTransport({ apiKey: fakeKey, fetch: big }).deliver(MSG)).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});

describe('log 전송', () => {
  it('링크 · 토큰 · 본문을 로그에 남기지 않는다 — 받는 사람은 가린다', async () => {
    const cap = captureLogs();
    try {
      const link = `https://bary.example/invite#${['tok', 'secret', 'value'].join('-')}`;
      const [subject, text] = mailText.invite(link, 'operator', 48);
      await mailerOf(logTransport(), 'noreply@example.com').send('alice@example.org', subject, text);
      const all = cap.lines.join('\n');
      expect(all).toContain('mail.log.delivered');
      expect(all).toContain('"hasLink":true');
      expect(all).not.toContain('tok-secret-value');
      expect(all).not.toContain('bary.example');
      expect(all).not.toContain('alice@');
      expect(all).toContain(maskAddress('alice@example.org'));
    } finally {
      cap.restore();
    }
  });
});

describe('mailerOf', () => {
  it('실패는 로그(가림)와 거절 — 머리글 주입은 보내지 않는다', async () => {
    const cap = captureLogs();
    try {
      let delivered = 0;
      const t: MailTransport = { kind: 'fake', deliver: async () => { delivered += 1; return { ok: false, reason: 'auth', detail: '키 거절' }; } };
      const m = mailerOf(t, 'noreply@example.com');
      await expect(m.send('bob@example.org', 's', 't')).rejects.toThrow(/fake · auth/);
      await expect(m.send('bob@example.org\r\nBcc: x@evil.test', 's', 't')).rejects.toThrow(/invalid-message/);
      expect(delivered).toBe(1);
      expect(cap.lines.join('\n')).not.toContain('bob@');
    } finally {
      cap.restore();
    }
  });
});

describe('등록부 (BARY_MAIL_KIND)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bary-mail-'));
  const keyFile = join(dir, 'key');
  writeFileSync(keyFile, `${fakeKey}\n`);

  it('설정이 없으면 끈다 · SMTP_URL + FROM 이면 지금처럼 smtp', () => {
    expect(mailFromEnv({})).toBeUndefined();
    expect(mailFromEnv({ BARY_SMTP_URL: 'smtp://127.0.0.1:2525', BARY_MAIL_FROM: 'noreply@example.com' })!.kind).toBe('smtp');
  });

  it('비밀번호가 든 SMTP URL 을 파일로 받는다', () => {
    const f = join(dir, 'smtp-url');
    writeFileSync(f, 'smtp://127.0.0.1:2525\n');
    expect(mailFromEnv({ BARY_SMTP_URL_FILE: f, BARY_MAIL_FROM: 'noreply@example.com' })!.kind).toBe('smtp');
    expect(() => mailFromEnv({ BARY_SMTP_URL_FILE: f, BARY_SMTP_URL: 'smtp://x', BARY_MAIL_FROM: 'noreply@example.com' })).toThrow(/하나만/);
  });

  it('모르는 이름은 던진다', () => {
    expect(() => mailFromEnv({ BARY_MAIL_KIND: 'postmark', BARY_MAIL_FROM: 'noreply@example.com' })).toThrow(/모르는 메일 전송: postmark/);
  });

  it('반만 설정이면 거부 — FROM 없음 · URL 없음 · 키 없음 · 다른 전송 변수 섞임', () => {
    expect(() => mailFromEnv({ BARY_SMTP_URL: 'smtp://127.0.0.1:2525' })).toThrow(/BARY_MAIL_FROM/);
    expect(() => mailFromEnv({ BARY_MAIL_FROM: 'noreply@example.com' })).toThrow(/BARY_SMTP_URL/);
    expect(() => mailFromEnv({ BARY_MAIL_KIND: 'sendgrid', BARY_MAIL_FROM: 'noreply@example.com' })).toThrow(/SENDGRID_API_KEY_FILE/);
    expect(() => mailFromEnv({ BARY_MAIL_KIND: 'sendgrid', BARY_MAIL_FROM: 'noreply@example.com', BARY_MAIL_SENDGRID_API_KEY_FILE: keyFile, BARY_SMTP_URL: 'smtp://x' })).toThrow(/쓰지 않는 변수/);
    expect(() => mailFromEnv({ BARY_MAIL_MAILGUN_DOMAIN: 'mg.example.com' })).toThrow(/BARY_MAIL_KIND 가 없다/);
  });

  it('API 전송은 Mailer 로 묶여 나온다', () => {
    expect(mailFromEnv({ BARY_MAIL_KIND: 'mailgun', BARY_MAIL_FROM: 'noreply@example.com', BARY_MAIL_MAILGUN_DOMAIN: 'mg.example.com', BARY_MAIL_MAILGUN_API_KEY_FILE: keyFile })!.kind).toBe('mailgun');
    expect(mailFromEnv({ BARY_MAIL_KIND: 'log', BARY_MAIL_FROM: 'noreply@example.com' })!.mailer.send).toBeTypeOf('function');
  });
});

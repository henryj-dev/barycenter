/**
 * HTTP API 로 보내는 메일 전송 셋 — Amazon SES(v2) · Mailgun · SendGrid. SDK 없이 fetch 로 부른다.
 *
 *   ses       POST https://email.{region}.amazonaws.com/v2/email/outbound-emails   SigV4(service=ses) → 200 {MessageId}
 *   mailgun   POST https://api.mailgun.net/v3/{domain}/messages (eu: api.eu.mailgun.net)  Basic api:{key}, form → 200 {id}
 *   sendgrid  POST https://api.sendgrid.com/v3/mail/send   Bearer {key}, JSON → 202
 */
import { excerpt, httpRequest, jsonOf, type HttpResult } from '../../outbound/http.js';
import { signV4, type AwsCredentials } from '../../outbound/sigv4.js';
import { mailStatus, parseAddress, type MailResult, type MailTransport } from './transport.js';

const MAX_BYTES = 64 * 1024;

type Common = { fetch?: typeof fetch; timeoutMs?: number; apiBase?: string };

const unreached = (service: string, r: HttpResult & { ok: false }): MailResult =>
  ({ ok: false, reason: r.reason === 'insecure' ? 'insecure' : 'unavailable', detail: `${service}: ${r.detail}` });

const opts = (c: Common): { fetch?: typeof fetch; timeoutMs?: number } =>
  ({ ...(c.fetch === undefined ? {} : { fetch: c.fetch }), ...(c.timeoutMs === undefined ? {} : { timeoutMs: c.timeoutMs }) });

export type SesOptions = Common & { region: string; credentials: AwsCredentials; now?: () => Date };

export function sesTransport(o: SesOptions): MailTransport {
  if (!/^[a-z]{2}(-[a-z]+)+-\d$/.test(o.region)) throw new Error(`SES 지역 이름 형식이 아니다: ${JSON.stringify(o.region)}`);
  const url = `${(o.apiBase ?? `https://email.${o.region}.amazonaws.com`).replace(/\/+$/, '')}/v2/email/outbound-emails`;
  return {
    kind: 'ses',
    async deliver(m) {
      const body = JSON.stringify({
        FromEmailAddress: m.from,
        Destination: { ToAddresses: [m.to] },
        Content: { Simple: { Subject: { Data: m.subject, Charset: 'UTF-8' }, Body: { Text: { Data: m.text, Charset: 'UTF-8' } } } },
      });
      const headers = signV4({
        method: 'POST', url, body, region: o.region, service: 'ses', credentials: o.credentials,
        now: o.now?.() ?? new Date(), headers: { 'content-type': 'application/json' },
      });
      const r = await httpRequest({ method: 'POST', url, headers, body, maxBytes: MAX_BYTES, ...opts(o) });
      if (!r.ok) return unreached('SES', r);
      const j = jsonOf(r.text) as { MessageId?: string; message?: string; Message?: string } | undefined;
      if (r.status === 200) return j?.MessageId === undefined ? { ok: true } : { ok: true, id: j.MessageId };
      return mailStatus('SES', r.status, j?.message ?? j?.Message ?? excerpt(r.text));
    },
  };
}

export type MailgunOptions = Common & { domain: string; apiKey: string; region?: 'us' | 'eu' };

export function mailgunTransport(o: MailgunOptions): MailTransport {
  if (!/^[A-Za-z0-9.-]+$/.test(o.domain)) throw new Error(`Mailgun 도메인 형식이 아니다: ${JSON.stringify(o.domain)}`);
  const host = o.apiBase ?? (o.region === 'eu' ? 'https://api.eu.mailgun.net' : 'https://api.mailgun.net');
  const url = `${host.replace(/\/+$/, '')}/v3/${o.domain}/messages`;
  const auth = `Basic ${Buffer.from(`api:${o.apiKey}`).toString('base64')}`;
  return {
    kind: 'mailgun',
    async deliver(m) {
      const body = new URLSearchParams({ from: m.from, to: m.to, subject: m.subject, text: m.text }).toString();
      const r = await httpRequest({
        method: 'POST', url, body, maxBytes: MAX_BYTES, ...opts(o),
        headers: { authorization: auth, 'content-type': 'application/x-www-form-urlencoded' },
      });
      if (!r.ok) return unreached('Mailgun', r);
      const j = jsonOf(r.text) as { id?: string; message?: string } | undefined;
      if (r.status === 200) return j?.id === undefined ? { ok: true } : { ok: true, id: j.id };
      return mailStatus('Mailgun', r.status, j?.message ?? excerpt(r.text));
    },
  };
}

export type SendgridOptions = Common & { apiKey: string };

export function sendgridTransport(o: SendgridOptions): MailTransport {
  const url = `${(o.apiBase ?? 'https://api.sendgrid.com').replace(/\/+$/, '')}/v3/mail/send`;
  return {
    kind: 'sendgrid',
    async deliver(m) {
      const body = JSON.stringify({
        personalizations: [{ to: [{ email: m.to }] }],
        from: parseAddress(m.from),
        subject: m.subject,
        content: [{ type: 'text/plain', value: m.text }],
      });
      const r = await httpRequest({
        method: 'POST', url, body, maxBytes: MAX_BYTES, ...opts(o),
        headers: { authorization: `Bearer ${o.apiKey}`, 'content-type': 'application/json' },
      });
      if (!r.ok) return unreached('SendGrid', r);
      if (r.status === 202 || r.status === 200) {
        const id = r.headers.get('x-message-id');
        return id === null ? { ok: true } : { ok: true, id };
      }
      const j = jsonOf(r.text) as { errors?: { message?: string }[] } | undefined;
      return mailStatus('SendGrid', r.status, j?.errors?.map((e) => e.message).join('; ') ?? excerpt(r.text));
    },
  };
}

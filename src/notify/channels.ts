/**
 * 알림 통로 셋 — 웹훅(HMAC 서명) · Slack incoming webhook · 메일.
 *
 * 웹훅 서명: `x-barycenter-signature: t=<유닉스초>,v1=<hex>` 이고 hex = HMAC-SHA256(비밀, `<t>.<본문>`).
 * 받는 쪽은 같은 값을 계산해 상수시간 비교하고, `t` 가 너무 오래됐으면(예: 5분) 버린다(재전송 방지).
 */
import { createHmac } from 'node:crypto';

import type { Mailer } from '../accounts/mail.js';
import { excerpt, httpRequest, type HttpResult } from '../outbound/http.js';
import { notifyStatus, plainText, type Notifier, type NotifyEvent, type NotifyResult } from './notifier.js';

const MAX_BYTES = 16 * 1024;

const unreached = (service: string, r: HttpResult & { ok: false }): NotifyResult =>
  ({ ok: false, reason: r.reason === 'insecure' ? 'insecure' : 'unavailable', detail: `${service}: ${r.detail}` });

export function signWebhook(secret: string, timestamp: number, body: string): string {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`, 'utf8').digest('hex')}`;
}

export type WebhookOptions = { url: string; secret: string; fetch?: typeof fetch; timeoutMs?: number; now?: () => number };

export function webhookNotifier(o: WebhookOptions): Notifier {
  return {
    kind: 'webhook',
    async send(e) {
      const body = JSON.stringify({ version: 1, ...e });
      const ts = Math.floor((o.now?.() ?? Date.now()) / 1000);
      const r = await httpRequest({
        method: 'POST', url: o.url, body, maxBytes: MAX_BYTES,
        headers: {
          'content-type': 'application/json',
          'x-barycenter-event': e.kind,
          'x-barycenter-signature': signWebhook(o.secret, ts, body),
        },
        ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
        ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
      });
      if (!r.ok) return unreached('웹훅', r);
      if (r.status >= 200 && r.status < 300) return { ok: true };
      return notifyStatus('웹훅', r.status, excerpt(r.text));
    },
  };
}

export type SlackOptions = { url: string; fetch?: typeof fetch; timeoutMs?: number };

export function slackNotifier(o: SlackOptions): Notifier {
  return {
    kind: 'slack',
    async send(e) {
      const r = await httpRequest({
        method: 'POST', url: o.url, maxBytes: MAX_BYTES,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: plainText(e) }),
        ...(o.fetch === undefined ? {} : { fetch: o.fetch }),
        ...(o.timeoutMs === undefined ? {} : { timeoutMs: o.timeoutMs }),
      });
      if (!r.ok) return unreached('Slack', r);
      if (r.status === 200) return { ok: true };
      // Slack 은 사유를 본문 한 단어로 준다(`invalid_token` · `no_service` · `channel_is_archived` …).
      // 없는 · 폐기된 웹훅(404 · 410)은 URL 이 죽은 것이다 — 자격증명 문제로 본다.
      if (r.status === 404 || r.status === 410) return { ok: false, reason: 'auth', detail: `Slack 웹훅이 없다 (${r.status} ${excerpt(r.text)})` };
      return notifyStatus('Slack', r.status, excerpt(r.text));
    },
  };
}

export type MailNotifierOptions = { mailer: Mailer; to: readonly string[] };

export function mailNotifier(o: MailNotifierOptions): Notifier {
  return {
    kind: 'mail',
    async send(e) {
      const failed: string[] = [];
      for (const to of o.to) {
        try {
          await o.mailer.send(to, `[barycenter] ${e.title}`, `${plainText(e)}\n`);
        } catch (err) {
          failed.push((err as Error).message);
        }
      }
      // 사유는 전송 쪽 로그(`mail.send_failed`)에 받는 사람을 가려서 남는다. 여기서는 몇 통이 실패했는지만.
      if (failed.length === 0) return { ok: true };
      return { ok: false, reason: 'unavailable', detail: `${o.to.length}통 중 ${failed.length}통 실패: ${failed[0]}` };
    },
  };
}

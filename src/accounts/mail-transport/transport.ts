/**
 * 메일 **전송**의 어댑터 계약 — 받는 사람 · 제목 · 본문을 만드는 쪽(`mailText` · `AccountService`)은 그대로이고,
 * 어떻게 보내느냐(SMTP · SES · Mailgun · SendGrid · 로그)만 바뀐다.
 *
 * 다른 전송을 붙이려면 이 인터페이스의 구현 하나와 `registry.ts` 의 등록 한 줄이면 된다.
 *
 * **실패를 예외로 던지지 않는다** — 결과 객체다. `AccountService` 가 쓰는 `Mailer` 는 실패를 거절(reject)로 받으므로,
 * `mailerOf` 가 사유를 로그에 남기고 거절로 바꾼다(받는 사람은 가려서).
 */
import { log } from '../../obs/log.js';
import { count } from '../../obs/metrics.js';
import type { Mailer } from '../mail.js';

export type MailFailure =
  /** 전송 서비스가 우리 자격증명을 거절했다(401 · 403). 배포 문제다. */
  | 'auth'
  /** 서비스가 이 메일을 거절했다(보내는 주소 미인증 · 형식). */
  | 'rejected'
  /** 시도 제한(429). */
  | 'rate-limited'
  /** 닿지 못했거나 5xx · 알 수 없는 답. */
  | 'unavailable'
  /** https 가 아닌 주소. 보내지 않았다. */
  | 'insecure'
  /** 받는 사람 · 제목에 줄바꿈 등 — 보내지 않았다. */
  | 'invalid-message';

export type MailResult = { ok: true; id?: string } | { ok: false; reason: MailFailure; detail: string };

export type MailMessage = { from: string; to: string; subject: string; text: string };

export interface MailTransport {
  readonly kind: string;
  deliver(m: MailMessage): Promise<MailResult>;
}

/** `ab***@example.com` — 로그에는 받는 사람을 가려서 싣는다. */
export function maskAddress(addr: string): string {
  const at = addr.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${addr.slice(0, Math.min(2, at))}***${addr.slice(at)}`;
}

/** `이름 <a@b>` 또는 `a@b` → 주소 · 이름. */
export function parseAddress(s: string): { email: string; name?: string } {
  const m = /^\s*(.*?)\s*<([^<>\s]+)>\s*$/.exec(s);
  if (m !== null) {
    const name = m[1]!.replace(/^"|"$/g, '');
    return name === '' ? { email: m[2]! } : { email: m[2]!, name };
  }
  return { email: s.trim() };
}

const EMAIL = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/;

/** 머리글에 들어가는 값 검사 — 줄바꿈이 섞이면 머리글 주입이다. */
export function messageProblem(m: MailMessage): string | undefined {
  if (/[\r\n]/.test(m.to) || /[\r\n]/.test(m.subject) || /[\r\n]/.test(m.from)) return '받는 사람 · 제목 · 보내는 사람에 줄바꿈이 있다';
  if (!EMAIL.test(m.to)) return '받는 사람 주소 형식이 아니다';
  if (!EMAIL.test(parseAddress(m.from).email)) return '보내는 사람 주소 형식이 아니다';
  return undefined;
}

/** HTTP 상태코드의 공통 뜻. 2xx 는 호출자가 본다. */
export function mailStatus(service: string, status: number, said: string): MailResult {
  if (status === 401 || status === 403) return { ok: false, reason: 'auth', detail: `${service} 가 자격증명을 거절했다 (${status} ${said})` };
  if (status === 429) return { ok: false, reason: 'rate-limited', detail: `${service} 가 시도를 제한했다 (${said})` };
  if (status >= 500) return { ok: false, reason: 'unavailable', detail: `${service} 가 ${status} 로 답했다 (${said})` };
  return { ok: false, reason: 'rejected', detail: `${service} 가 거절했다 (${status} ${said})` };
}

/** `AccountService` 가 쓰는 `Mailer` 로. 실패는 로그(받는 사람 가림)를 남기고 거절한다. */
export function mailerOf(t: MailTransport, from: string): Mailer {
  return {
    async send(to, subject, text) {
      const m = { from, to, subject, text };
      const bad = messageProblem(m);
      const r: MailResult = bad === undefined ? await t.deliver(m) : { ok: false, reason: 'invalid-message', detail: bad };
      if (r.ok) {
        count(`bary_mail_total{transport="${t.kind}",outcome="sent"}`);
        return;
      }
      count(`bary_mail_total{transport="${t.kind}",outcome="${r.reason}"}`);
      log.warn('mail.send_failed', { transport: t.kind, to: maskAddress(to), reason: r.reason, detail: r.detail });
      throw new Error(`메일을 보내지 못했다 (${t.kind} · ${r.reason})`);
    },
  };
}

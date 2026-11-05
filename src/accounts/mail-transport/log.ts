/**
 * 개발용 전송 — 메일을 보내지 않고 「보냈다」 는 사실만 로그에 남긴다.
 *
 * **본문 · 링크 · 토큰을 로그에 남기지 않는다.** 초대 · 재설정 링크는 그것을 가진 사람이 곧 그 계정이 되는 값이다.
 * 로그에는 받는 사람(가림) · 제목 · 링크가 있었는지 · 본문 크기만 싣는다. 링크가 필요하면 호스트 CLI
 * (`barycenterd account recovery-link`)를 쓴다.
 */
import { log } from '../../obs/log.js';
import { maskAddress, type MailTransport } from './transport.js';

export function logTransport(): MailTransport {
  return {
    kind: 'log',
    async deliver(m) {
      log.info('mail.log.delivered', {
        to: maskAddress(m.to),
        subject: m.subject,
        hasLink: /https?:\/\//.test(m.text),
        bytes: Buffer.byteLength(m.text, 'utf8'),
        note: '보내지 않았다(BARY_MAIL_KIND=log) — 본문은 남기지 않는다',
      });
      return { ok: true };
    },
  };
}

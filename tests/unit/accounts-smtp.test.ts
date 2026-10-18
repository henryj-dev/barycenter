/**
 * 계정 메일의 **실제 SMTP 경로** (계획 C) — nodemailer 가 SMTP 서버에 실제로 넣는가.
 *
 * 다른 테스트는 가짜 우편함(`Mailer`)을 쓴다. 여기서는 `smtpMailer` 를 그대로 쓰고, 받는 쪽은 `node:net` 으로 만든
 * 최소 SMTP 수신기다(EHLO·MAIL·RCPT·DATA·QUIT). 외부 서비스·컨테이너가 필요 없다.
 */
import { createServer, type Server, type Socket } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { mailText, smtpMailer } from '../../src/accounts/mail.js';

type Received = { from: string; to: string[]; data: string };
const inbox: Received[] = [];
let server: Server;
let port = 0;

function session(sock: Socket): void {
  let cur: Received = { from: '', to: [], data: '' };
  let inData = false;
  let buf = '';
  sock.write('220 test smtp\r\n');
  sock.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    let at: number;
    while ((at = buf.indexOf('\r\n')) !== -1) {
      const line = buf.slice(0, at);
      buf = buf.slice(at + 2);
      if (inData) {
        if (line === '.') { inData = false; inbox.push(cur); cur = { from: '', to: [], data: '' }; sock.write('250 queued\r\n'); }
        else cur.data += `${line.startsWith('..') ? line.slice(1) : line}\n`;
        continue;
      }
      const cmd = line.slice(0, 4).toUpperCase();
      if (cmd === 'EHLO' || cmd === 'HELO') sock.write('250 test\r\n');
      else if (cmd === 'MAIL') { cur.from = line; sock.write('250 ok\r\n'); }
      else if (cmd === 'RCPT') { cur.to.push(line); sock.write('250 ok\r\n'); }
      else if (cmd === 'DATA') { inData = true; sock.write('354 go\r\n'); }
      else if (cmd === 'QUIT') { sock.write('221 bye\r\n'); sock.end(); }
      else if (cmd === 'RSET' || cmd === 'NOOP') sock.write('250 ok\r\n');
      else sock.write('502 no\r\n');
    }
  });
}

/** 본문을 사람이 읽는 글로 — quoted-printable 이든 base64 든. */
function bodyText(raw: string): string {
  const [head = '', ...rest] = raw.split('\n\n');
  const body = rest.join('\n\n');
  if (/content-transfer-encoding:\s*base64/i.test(head)) return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
  if (/content-transfer-encoding:\s*quoted-printable/i.test(head)) {
    const bytes = body.replace(/=\n/g, '').replace(/=([0-9A-F]{2})/gi, (_, h: string) => String.fromCharCode(parseInt(h, 16)));
    return Buffer.from(bytes, 'latin1').toString('utf8');
  }
  return body;
}

beforeAll(async () => {
  server = createServer(session);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as { port: number }).port;
});
afterAll(() => { server.close(); });

describe('smtpMailer', () => {
  it('**초대 메일이 SMTP 서버에 실제로 들어가고 링크가 온전하다**', async () => {
    const mailer = smtpMailer(`smtp://127.0.0.1:${port}`, 'barycenter <noreply@bary.test>');
    const link = 'https://bary.test/invite#AbC_123-xyz';
    const [subject, text] = mailText.invite(link, 'operator', 72);
    await mailer.send('op@example.com', subject, text);
    const got = inbox.at(-1)!;
    expect(got.from).toContain('noreply@bary.test');
    expect(got.to.join(' ')).toContain('op@example.com');
    expect(bodyText(got.data)).toContain(link);
    expect(bodyText(got.data)).toContain('operator 역할로 초대');
  });

  it('smtp:// · smtps:// 가 아니면 기동에서 거절한다', () => {
    expect(() => smtpMailer('http://127.0.0.1:25', 'x@y')).toThrow(/smtp/);
  });
});

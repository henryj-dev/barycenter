/**
 * 계정 메일 — 초대·비밀번호 재설정·이메일 변경 (계획 B1, nodemailer).
 *
 * **보내는 쪽은 사실만 쓴다.** 링크와 만료, 그리고 「요청하지 않았으면 무시해도 된다」. 받는 사람의
 * 계정 상태(있다·없다·잠김)를 본문에 싣지 않는다 — 메일도 열거 경로가 될 수 있다.
 */
import nodemailer from 'nodemailer';

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

/** `BARY_SMTP_URL`(`smtps://user:pass@host:465` 또는 `smtp://…:587`, STARTTLS 는 nodemailer 가 고른다). */
export function smtpMailer(url: string, from: string): Mailer {
  const u = new URL(url);
  if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:') throw new Error('BARY_SMTP_URL 은 smtp:// 또는 smtps:// 다');
  const transport = nodemailer.createTransport(url);
  return {
    async send(to, subject, text) {
      await transport.sendMail({ from, to, subject, text });
    },
  };
}

export const mailText = {
  invite: (link: string, role: string, hours: number): [string, string] => [
    'barycenter 초대',
    `barycenter 에 ${role} 역할로 초대받았다.\n\n아래 링크에서 아이디와 비밀번호를 정한다 (${hours}시간 안, 한 번만):\n${link}\n\n모르는 초대면 무시해도 된다.\n`,
  ],
  reset: (link: string, minutes: number): [string, string] => [
    'barycenter 비밀번호 재설정',
    `비밀번호 재설정을 요청받았다.\n\n아래 링크에서 새 비밀번호를 정한다 (${minutes}분 안, 한 번만):\n${link}\n\n인증 앱 코드는 그대로 필요하다.\n요청하지 않았으면 무시해도 된다 — 비밀번호는 바뀌지 않는다.\n`,
  ],
  emailChange: (link: string, hours: number): [string, string] => [
    'barycenter 이메일 확인',
    `이 주소를 barycenter 계정의 이메일로 쓰겠다는 요청을 받았다.\n\n맞으면 아래 링크를 연다 (${hours}시간 안):\n${link}\n\n요청하지 않았으면 무시해도 된다.\n`,
  ],
  emailChangedNotice: (newEmail: string): [string, string] => [
    'barycenter 이메일 변경 요청',
    `계정 이메일을 ${newEmail} 으로 바꾸겠다는 요청이 들어왔다. 새 주소에서 확인해야 바뀐다.\n본인이 아니면 관리자에게 알린다.\n`,
  ],
};

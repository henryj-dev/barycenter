/**
 * 메일 전송 등록부 — `BARY_MAIL_KIND` 의 이름으로 고른다.
 *
 *   (없음)    `BARY_SMTP_URL` 이나 `BARY_MAIL_FROM` 이 있으면 smtp, 둘 다 없으면 메일을 끈다 — **지금 동작 그대로**.
 *   smtp      nodemailer(`BARY_SMTP_URL` 또는 비밀번호가 든 URL 을 파일로 `BARY_SMTP_URL_FILE`).
 *   ses       Amazon SES v2 (SigV4 직접) — 지역 · 접근 키 id · 비밀 키 파일.
 *   mailgun   도메인 · API 키 파일 · 지역(us|eu).
 *   sendgrid  API 키 파일.
 *   log       개발용 — 보내지 않고 사실만 로그(본문 · 링크는 남기지 않는다).
 *
 * 다른 전송을 붙이려면: `MailTransport` 를 구현한 파일 하나 + 아래 `TRANSPORTS` 에 한 줄.
 *
 * **반만 설정하면 기동을 거부한다.** 보내는 주소(`BARY_MAIL_FROM`)는 어느 종류든 필요하다.
 */
import { envOf, readFileUtf8, readSecretFile, required, type ReadFile } from '../../outbound/secret-file.js';
import { smtpMailer, type Mailer } from '../mail.js';
import { mailgunTransport, sendgridTransport, sesTransport } from './http-services.js';
import { logTransport } from './log.js';
import { mailerOf, parseAddress, type MailTransport } from './transport.js';

export type MailDeps = { readFile?: ReadFile; fetch?: typeof fetch };

type Spec = { vars: readonly string[]; make: (env: NodeJS.ProcessEnv, d: Required<Pick<MailDeps, 'readFile'>> & MailDeps) => MailTransport };

const why = (kind: string): string => `BARY_MAIL_KIND=${kind}`;
const fetchOf = (d: MailDeps): { fetch?: typeof fetch } => (d.fetch === undefined ? {} : { fetch: d.fetch });

const TRANSPORTS: Readonly<Record<string, Spec>> = {
  ses: {
    vars: ['BARY_MAIL_SES_REGION', 'BARY_MAIL_AWS_ACCESS_KEY_ID', 'BARY_MAIL_AWS_SECRET_ACCESS_KEY_FILE'],
    make: (env, d) => sesTransport({
      region: required(env, 'BARY_MAIL_SES_REGION', why('ses')),
      credentials: {
        accessKeyId: required(env, 'BARY_MAIL_AWS_ACCESS_KEY_ID', why('ses')),
        secretAccessKey: readSecretFile('BARY_MAIL_AWS_SECRET_ACCESS_KEY_FILE', required(env, 'BARY_MAIL_AWS_SECRET_ACCESS_KEY_FILE', why('ses')), d.readFile),
      },
      ...fetchOf(d),
    }),
  },
  mailgun: {
    vars: ['BARY_MAIL_MAILGUN_DOMAIN', 'BARY_MAIL_MAILGUN_API_KEY_FILE', 'BARY_MAIL_MAILGUN_REGION'],
    make: (env, d) => {
      const region = envOf(env, 'BARY_MAIL_MAILGUN_REGION') ?? 'us';
      if (region !== 'us' && region !== 'eu') throw new Error(`BARY_MAIL_MAILGUN_REGION 은 us 또는 eu 다: ${JSON.stringify(region)}`);
      return mailgunTransport({
        domain: required(env, 'BARY_MAIL_MAILGUN_DOMAIN', why('mailgun')),
        apiKey: readSecretFile('BARY_MAIL_MAILGUN_API_KEY_FILE', required(env, 'BARY_MAIL_MAILGUN_API_KEY_FILE', why('mailgun')), d.readFile),
        region, ...fetchOf(d),
      });
    },
  },
  sendgrid: {
    vars: ['BARY_MAIL_SENDGRID_API_KEY_FILE'],
    make: (env, d) => sendgridTransport({
      apiKey: readSecretFile('BARY_MAIL_SENDGRID_API_KEY_FILE', required(env, 'BARY_MAIL_SENDGRID_API_KEY_FILE', why('sendgrid')), d.readFile),
      ...fetchOf(d),
    }),
  },
  log: { vars: [], make: () => logTransport() },
};

const SMTP_VARS = ['BARY_SMTP_URL', 'BARY_SMTP_URL_FILE'];
const COMMON_VARS = ['BARY_MAIL_KIND', 'BARY_MAIL_FROM'];

export function mailKinds(): string[] {
  return ['smtp', ...Object.keys(TRANSPORTS)];
}

export type MailSetup = { kind: string; from: string; mailer: Mailer };

/** env 에서 메일 전송을 만든다. 끄는 설정이면 `undefined`. 반만 설정이면 던진다. */
export function mailFromEnv(env: NodeJS.ProcessEnv = process.env, deps: MailDeps = {}): MailSetup | undefined {
  const d = { readFile: deps.readFile ?? readFileUtf8, ...fetchOf(deps) };
  const set = Object.keys(env).filter((k) => (k.startsWith('BARY_MAIL_') || k.startsWith('BARY_SMTP_')) && envOf(env, k) !== undefined);
  const smtpSet = SMTP_VARS.some((k) => envOf(env, k) !== undefined);
  const kind = envOf(env, 'BARY_MAIL_KIND') ?? (smtpSet || envOf(env, 'BARY_MAIL_FROM') !== undefined ? 'smtp' : undefined);

  if (kind === undefined) {
    if (set.length > 0) throw new Error(`메일 변수(${set.join(', ')})를 적었지만 BARY_MAIL_KIND 가 없다 (${mailKinds().join(' | ')})`);
    return undefined;
  }
  if (kind !== 'smtp' && !Object.hasOwn(TRANSPORTS, kind)) {
    throw new Error(`모르는 메일 전송: ${kind} (쓸 수 있는 것: ${mailKinds().join(', ')})`);
  }
  const allowed = new Set([...COMMON_VARS, ...(kind === 'smtp' ? SMTP_VARS : TRANSPORTS[kind]!.vars)]);
  const stray = set.filter((k) => !allowed.has(k));
  if (stray.length > 0) throw new Error(`BARY_MAIL_KIND=${kind} 에 쓰지 않는 변수가 있다: ${stray.join(', ')} — 다른 전송의 설정이 섞였나 본다`);

  const from = required(env, 'BARY_MAIL_FROM', `메일(${kind})을 켜려면 보내는 주소가 있어야 한다`);
  if (/[\r\n]/.test(from) || !parseAddress(from).email.includes('@')) throw new Error(`BARY_MAIL_FROM 형식이 아니다: ${JSON.stringify(from)}`);

  if (kind === 'smtp') {
    const inline = envOf(env, 'BARY_SMTP_URL');
    const file = envOf(env, 'BARY_SMTP_URL_FILE');
    if (inline !== undefined && file !== undefined) throw new Error('BARY_SMTP_URL 과 BARY_SMTP_URL_FILE 은 하나만 쓴다');
    const url = file !== undefined ? readSecretFile('BARY_SMTP_URL_FILE', file, d.readFile)
      : required(env, 'BARY_SMTP_URL', '메일(smtp)을 켜려면 BARY_SMTP_URL 또는 BARY_SMTP_URL_FILE 이 필요하다');
    return { kind, from, mailer: smtpMailer(url, from) };
  }
  return { kind, from, mailer: mailerOf(TRANSPORTS[kind]!.make(env, d), from) };
}

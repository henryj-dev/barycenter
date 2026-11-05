/**
 * 알림 통로 등록부 — `BARY_NOTIFY=webhook,slack,mail` 처럼 여럿을 함께 고른다.
 *
 *   webhook  `BARY_NOTIFY_WEBHOOK_URL`(https) · `BARY_NOTIFY_WEBHOOK_SECRET_FILE`(HMAC 비밀)
 *   slack    `BARY_NOTIFY_SLACK_URL_FILE` (incoming webhook URL 자체가 비밀이다)
 *   mail     `BARY_NOTIFY_MAIL_TO`(쉼표로) — 전송은 계정 메일과 같은 `BARY_MAIL_*` 설정을 쓴다
 *
 *   공통     `BARY_NOTIFY_REPEAT_S`(같은 사건 재알림 간격, 기본 21600=6시간) · `BARY_NOTIFY_CERT_DAYS`(기본 14)
 *            `BARY_NOTIFY_INTERVAL_S`(상태 보기 주기, 기본 60) · `BARY_NOTIFY_QUEUE`(큐 상한, 기본 100)
 *
 * 다른 통로를 붙이려면: `Notifier` 를 구현하고 아래 `CHANNELS` 에 한 줄.
 *
 * **없으면 알림이 꺼진다 — 지금과 같다.** 반만 설정이면 기동을 거부한다.
 */
import type { MailSetup } from '../accounts/mail-transport/registry.js';
import { insecureReason } from '../outbound/http.js';
import { envOf, readFileUtf8, readSecretFile, required, type ReadFile } from '../outbound/secret-file.js';
import type { TickResult } from '../control/acme-runner.js';
import { envInt } from '../validate/env.js';
import { mailNotifier, slackNotifier, webhookNotifier } from './channels.js';
import { NotifyHub, type NotifyInput } from './hub.js';
import type { Notifier } from './notifier.js';

export type NotifyDeps = { readFile?: ReadFile; fetch?: typeof fetch; mail?: () => MailSetup | undefined };

type Spec = { vars: readonly string[]; make: (env: NodeJS.ProcessEnv, d: Required<Pick<NotifyDeps, 'readFile'>> & NotifyDeps) => Notifier };

const fetchOf = (d: NotifyDeps): { fetch?: typeof fetch } => (d.fetch === undefined ? {} : { fetch: d.fetch });
const https = (name: string, url: string): string => {
  const bad = insecureReason(url);
  if (bad !== undefined) throw new Error(`${name}: ${bad}`);
  return url;
};

const CHANNELS: Readonly<Record<string, Spec>> = {
  webhook: {
    vars: ['BARY_NOTIFY_WEBHOOK_URL', 'BARY_NOTIFY_WEBHOOK_SECRET_FILE'],
    make: (env, d) => webhookNotifier({
      url: https('BARY_NOTIFY_WEBHOOK_URL', required(env, 'BARY_NOTIFY_WEBHOOK_URL', 'BARY_NOTIFY=webhook')),
      secret: readSecretFile('BARY_NOTIFY_WEBHOOK_SECRET_FILE', required(env, 'BARY_NOTIFY_WEBHOOK_SECRET_FILE', 'BARY_NOTIFY=webhook(서명 비밀)'), d.readFile),
      ...fetchOf(d),
    }),
  },
  slack: {
    vars: ['BARY_NOTIFY_SLACK_URL_FILE'],
    make: (env, d) => slackNotifier({
      url: https('BARY_NOTIFY_SLACK_URL_FILE', readSecretFile('BARY_NOTIFY_SLACK_URL_FILE', required(env, 'BARY_NOTIFY_SLACK_URL_FILE', 'BARY_NOTIFY=slack'), d.readFile)),
      ...fetchOf(d),
    }),
  },
  mail: {
    vars: ['BARY_NOTIFY_MAIL_TO'],
    make: (env, d) => {
      const to = required(env, 'BARY_NOTIFY_MAIL_TO', 'BARY_NOTIFY=mail').split(',').map((s) => s.trim()).filter((s) => s !== '');
      if (to.length === 0 || to.length > 20) throw new Error('BARY_NOTIFY_MAIL_TO 는 받는 주소 1~20개다');
      const bad = to.find((a) => !/^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/.test(a));
      if (bad !== undefined) throw new Error(`BARY_NOTIFY_MAIL_TO 에 주소 형식이 아닌 것이 있다: ${JSON.stringify(bad)}`);
      const mail = d.mail?.();
      if (mail === undefined) throw new Error('BARY_NOTIFY=mail — 메일 전송 설정(BARY_MAIL_KIND · BARY_MAIL_FROM …)이 없다');
      return mailNotifier({ mailer: mail.mailer, to });
    },
  },
};

const COMMON_VARS = ['BARY_NOTIFY', 'BARY_NOTIFY_REPEAT_S', 'BARY_NOTIFY_CERT_DAYS', 'BARY_NOTIFY_INTERVAL_S', 'BARY_NOTIFY_QUEUE'];

export function notifyKinds(): string[] {
  return Object.keys(CHANNELS);
}

export type NotifySetup = { hub: NotifyHub; certDays: number; intervalMs: number };

export function notifyFromEnv(node: string, env: NodeJS.ProcessEnv = process.env, deps: NotifyDeps = {}): NotifySetup | undefined {
  const d = { ...deps, readFile: deps.readFile ?? readFileUtf8 };
  const set = Object.keys(env).filter((k) => k.startsWith('BARY_NOTIFY') && envOf(env, k) !== undefined);
  const raw = envOf(env, 'BARY_NOTIFY');
  if (raw === undefined) {
    if (set.length > 0) throw new Error(`알림 변수(${set.join(', ')})를 적었지만 BARY_NOTIFY 가 없다 (${notifyKinds().join(',')} 중 쉼표로)`);
    return undefined;
  }
  const kinds = raw.split(',').map((s) => s.trim()).filter((s) => s !== '');
  const unknown = kinds.filter((k) => !Object.hasOwn(CHANNELS, k));
  if (unknown.length > 0) throw new Error(`모르는 알림 통로: ${unknown.join(', ')} (쓸 수 있는 것: ${notifyKinds().join(', ')})`);
  if (kinds.length === 0) throw new Error('BARY_NOTIFY 가 비었다');
  if (new Set(kinds).size !== kinds.length) throw new Error(`BARY_NOTIFY 에 같은 통로가 두 번 있다: ${raw}`);

  const allowed = new Set([...COMMON_VARS, ...kinds.flatMap((k) => CHANNELS[k]!.vars)]);
  const stray = set.filter((k) => !allowed.has(k));
  if (stray.length > 0) throw new Error(`BARY_NOTIFY=${raw} 에 쓰지 않는 변수가 있다: ${stray.join(', ')} — 통로를 빠뜨렸나 본다`);

  const notifiers = kinds.map((k) => CHANNELS[k]!.make(env, d));
  const hub = new NotifyHub(notifiers, {
    node,
    repeatMs: envInt('BARY_NOTIFY_REPEAT_S', 21_600, { min: 60, max: 30 * 86_400 }, env) * 1000,
    maxQueue: envInt('BARY_NOTIFY_QUEUE', 100, { min: 1, max: 10_000 }, env),
  });
  return {
    hub,
    certDays: envInt('BARY_NOTIFY_CERT_DAYS', 14, { min: 1, max: 365 }, env),
    intervalMs: envInt('BARY_NOTIFY_INTERVAL_S', 60, { min: 5, max: 86_400 }, env) * 1000,
  };
}

/** ACME 러너의 진행 사건 → 알림(실패만). 키는 주문 — 백오프 재시도마다 다시 보내지 않는다. */
export function acmeFailure(e: TickResult): NotifyInput | undefined {
  if (e.error === undefined || e.order === undefined) return undefined;
  return {
    kind: 'acme.failed', severity: e.to === 'abandoned' ? 'critical' : 'warning', key: `acme.failed:${e.order}:${e.to ?? ''}`,
    title: e.to === 'abandoned' ? 'ACME 주문을 포기했다' : 'ACME 발급 · 갱신이 실패했다(다시 시도한다)',
    detail: e.error,
    facts: { order: e.order, ...(e.from === undefined ? {} : { from: e.from }), ...(e.to === undefined ? {} : { state: e.to }) },
  };
}

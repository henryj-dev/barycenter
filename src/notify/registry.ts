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
 * **환경 변수는 첫 값이다** (2026-11-20). 데몬이 처음 뜰 때 DB(`notify_settings` · `notify_channels`)가 비어 있으면 이
 * 값을 옮겨 넣는다(`settings.ts` 의 `seed`). 그 뒤로는 **DB 가 정본이다** — 화면에서 고치고, 환경 변수는 보지 않는다.
 * 반만 설정이면 첫 기동을 거부한다(전과 같다).
 */
import type { MailSetup } from '../accounts/mail-transport/registry.js';
import { insecureReason } from '../outbound/http.js';
import { envOf, readFileUtf8, readSecretFile, required, type ReadFile } from '../outbound/secret-file.js';
import type { TickResult } from '../control/acme-runner.js';
import { envInt } from '../validate/env.js';
import type { NotifyInput } from './hub.js';

export type NotifyDeps = { readFile?: ReadFile; fetch?: typeof fetch; mail?: () => MailSetup | undefined };

/**
 * 환경 변수가 말하는 통로 하나 — **값만** 든다(보내는 객체가 아니다). DB 에 씨를 뿌릴 때(`settings.ts` 의 `seed`)와
 * 이미 씨를 뿌린 뒤 「환경 변수가 다르다」 를 볼 때(`runtime.ts`) 쓴다. `secret` 은 비밀이다 — 로그 · 응답에 싣지 않는다.
 */
export type EnvChannel =
  | { kind: 'webhook'; url: string; secret: string }
  | { kind: 'slack'; secret: string }
  | { kind: 'mail'; to: string[] };

export type NotifyKnobs = { repeatS: number; certDays: number; intervalS: number; queue: number };

export type NotifyEnv = { channels: EnvChannel[]; knobs: NotifyKnobs };

const https = (name: string, url: string): string => {
  const bad = insecureReason(url);
  if (bad !== undefined) throw new Error(`${name}: ${bad}`);
  return url;
};

/** 받는 메일 주소 목록의 모양. 화면 · 환경 변수가 같은 규칙을 쓴다. */
export const MAIL_ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

type Spec = { vars: readonly string[]; read: (env: NodeJS.ProcessEnv, d: Required<Pick<NotifyDeps, 'readFile'>> & NotifyDeps) => EnvChannel };

const CHANNELS: Readonly<Record<string, Spec>> = {
  webhook: {
    vars: ['BARY_NOTIFY_WEBHOOK_URL', 'BARY_NOTIFY_WEBHOOK_SECRET_FILE'],
    read: (env, d) => ({
      kind: 'webhook',
      url: https('BARY_NOTIFY_WEBHOOK_URL', required(env, 'BARY_NOTIFY_WEBHOOK_URL', 'BARY_NOTIFY=webhook')),
      secret: readSecretFile('BARY_NOTIFY_WEBHOOK_SECRET_FILE', required(env, 'BARY_NOTIFY_WEBHOOK_SECRET_FILE', 'BARY_NOTIFY=webhook(서명 비밀)'), d.readFile),
    }),
  },
  slack: {
    vars: ['BARY_NOTIFY_SLACK_URL_FILE'],
    read: (env, d) => ({
      kind: 'slack',
      secret: https('BARY_NOTIFY_SLACK_URL_FILE', readSecretFile('BARY_NOTIFY_SLACK_URL_FILE', required(env, 'BARY_NOTIFY_SLACK_URL_FILE', 'BARY_NOTIFY=slack'), d.readFile)),
    }),
  },
  mail: {
    vars: ['BARY_NOTIFY_MAIL_TO'],
    read: (env, d) => {
      const to = required(env, 'BARY_NOTIFY_MAIL_TO', 'BARY_NOTIFY=mail').split(',').map((s) => s.trim()).filter((s) => s !== '');
      if (to.length === 0 || to.length > 20) throw new Error('BARY_NOTIFY_MAIL_TO 는 받는 주소 1~20개다');
      const bad = to.find((a) => !MAIL_ADDRESS.test(a));
      if (bad !== undefined) throw new Error(`BARY_NOTIFY_MAIL_TO 에 주소 형식이 아닌 것이 있다: ${JSON.stringify(bad)}`);
      if (d.mail?.() === undefined) throw new Error('BARY_NOTIFY=mail — 메일 전송 설정(BARY_MAIL_KIND · BARY_MAIL_FROM …)이 없다');
      return { kind: 'mail', to };
    },
  },
};

const COMMON_VARS = ['BARY_NOTIFY', 'BARY_NOTIFY_REPEAT_S', 'BARY_NOTIFY_CERT_DAYS', 'BARY_NOTIFY_INTERVAL_S', 'BARY_NOTIFY_QUEUE'];

/** 공통 값의 범위 — 화면 · 환경 변수 · DB CHECK(036)가 같다. */
export const KNOB_RANGES: Readonly<Record<keyof NotifyKnobs, { min: number; max: number; default: number }>> = {
  repeatS: { min: 60, max: 30 * 86_400, default: 21_600 },
  certDays: { min: 1, max: 365, default: 14 },
  intervalS: { min: 5, max: 86_400, default: 60 },
  queue: { min: 1, max: 10_000, default: 100 },
};

export function notifyKinds(): string[] {
  return Object.keys(CHANNELS);
}

/** 환경 변수의 공통 값. 알림이 꺼져 있어도 읽는다 — 기본값이 DB 의 첫 값이 된다. */
export function knobsFromEnv(env: NodeJS.ProcessEnv = process.env): NotifyKnobs {
  return {
    repeatS: envInt('BARY_NOTIFY_REPEAT_S', KNOB_RANGES.repeatS.default, KNOB_RANGES.repeatS, env),
    certDays: envInt('BARY_NOTIFY_CERT_DAYS', KNOB_RANGES.certDays.default, KNOB_RANGES.certDays, env),
    intervalS: envInt('BARY_NOTIFY_INTERVAL_S', KNOB_RANGES.intervalS.default, KNOB_RANGES.intervalS, env),
    queue: envInt('BARY_NOTIFY_QUEUE', KNOB_RANGES.queue.default, KNOB_RANGES.queue, env),
  };
}

/**
 * 환경 변수를 읽어 **값으로** 돌려준다. 없으면 `undefined`(알림이 꺼져 있다). **반만 설정이면 던진다** — 전과 같다.
 */
export function readNotifyEnv(env: NodeJS.ProcessEnv = process.env, deps: NotifyDeps = {}): NotifyEnv | undefined {
  const d = { ...deps, readFile: deps.readFile ?? readFileUtf8 };
  const set = Object.keys(env).filter((k) => k.startsWith('BARY_NOTIFY') && !k.startsWith('BARY_NOTIFY_DELIVERY_') && envOf(env, k) !== undefined);
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

  return { channels: kinds.map((k) => CHANNELS[k]!.read(env, d)), knobs: knobsFromEnv(env) };
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

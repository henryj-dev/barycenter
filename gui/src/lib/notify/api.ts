/**
 * 알림 설정 API (`/api/v1/notify…`, 036). 화면은 이 모듈만 부른다 — 경로 · 본문 모양을 여기 한 곳에 둔다.
 *
 * 지역마다 따로다. 전역 화면은 이 경로를 중계하지 않으므로 지역 GUI 에서만 쓴다.
 * 비밀(웹훅 서명 비밀 · Slack 웹훅 URL)은 보내기만 한다 — 서버는 `secretSet` 만 돌려준다.
 * 비밀을 바꾸는 쓰기 · 지우기는 민감 작업이다. 서버가 MFA 를 다시 물으면 한 번 받고 다시 보낸다(계정 화면과 같다).
 */
import { needsStepUp, stepUp } from '#lib/account/step-up.svelte';
import type { Result } from '#lib/account/api';

export type ChannelKind = 'webhook' | 'slack' | 'mail';
export type Severity = 'info' | 'warning' | 'critical';

export type ChannelSettings = { url?: string; to?: string[]; kinds?: string[]; minSeverity: Severity };

export type Channel = {
  name: string; kind: ChannelKind; enabled: boolean; settings: ChannelSettings;
  secretSet: boolean; updatedAt: string; updatedBy: string;
};

export type Knobs = { repeatS: number; certDays: number; intervalS: number; queue: number };

export type NotifyView = {
  seeded: boolean;
  seededFrom?: 'env' | 'default';
  version?: number;
  settings?: Knobs;
  updatedAt?: string;
  updatedBy?: string;
  channels: Channel[];
  status: { active: string[]; problems: { channel: string; problem: string }[]; mailAvailable: boolean };
  kinds: string[];
  severities: Severity[];
  channelKinds: ChannelKind[];
  ranges: Record<keyof Knobs, { min: number; max: number; default: number }>;
};

export type ChannelBody = {
  kind: ChannelKind; enabled: boolean; url?: string; to?: string[]; kinds?: string[]; minSeverity: Severity; secret?: string;
};

export type Delivery = {
  id: string; at: string; channel?: string; kind: string; severity: Severity; key: string;
  outcome: string; detail?: string; test: boolean; node: string;
};

export type TestResult = { outcome: string; detail?: string };

async function call<T>(token: string, method: string, path: string, body?: unknown, retried = false): Promise<Result<T>> {
  let r: Response;
  try {
    r = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: {
        ...(token === '' ? {} : { authorization: `Bearer ${token}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch (e) {
    return { ok: false, status: 0, message: e instanceof Error ? e.message : String(e) };
  }
  const text = await r.text();
  let parsed: unknown = undefined;
  try { parsed = text === '' ? undefined : JSON.parse(text); } catch { /* 본문이 JSON 이 아니다 */ }
  if (!r.ok) {
    const { message, code } = (parsed ?? {}) as { message?: unknown; code?: unknown };
    if (!retried && needsStepUp(r.status, code) && await stepUp.request()) return call<T>(token, method, path, body, true);
    return {
      ok: false, status: r.status, ...(typeof code === 'string' ? { code } : {}),
      message: typeof message === 'string' ? message : `${method} ${path} → ${r.status}`,
    };
  }
  return { ok: true, data: parsed as T };
}

const enc = encodeURIComponent;

export const notifyApi = {
  view: (token: string) => call<NotifyView>(token, 'GET', '/api/v1/notify'),
  putKnobs: (token: string, k: Knobs) => call<{ settings: Knobs }>(token, 'PUT', '/api/v1/notify/settings', k),
  putChannel: (token: string, name: string, body: ChannelBody) => call<Channel>(token, 'PUT', `/api/v1/notify/channels/${enc(name)}`, body),
  deleteChannel: (token: string, name: string) => call<{ deleted: string }>(token, 'DELETE', `/api/v1/notify/channels/${enc(name)}`),
  test: (token: string, name: string) => call<TestResult>(token, 'POST', `/api/v1/notify/channels/${enc(name)}/test`),
  deliveries: (token: string, o: { limit?: number; before?: string; channel?: string } = {}) => {
    const q = new URLSearchParams();
    q.set('limit', String(o.limit ?? 50));
    if (o.before !== undefined) q.set('before', o.before);
    if (o.channel !== undefined) q.set('channel', o.channel);
    return call<{ items: Delivery[]; next?: string }>(token, 'GET', `/api/v1/notify/deliveries?${q.toString()}`);
  },
};

// ── 화면 문구 ───────────────────────────────────────────────────────────

export const KIND_LABEL: Record<ChannelKind, string> = { webhook: '웹훅', slack: 'Slack', mail: '메일' };

export const SEVERITY_LABEL: Record<Severity, string> = { info: '정보부터', warning: '경고부터', critical: '심각만' };

/** 사건 종류의 사람 말. 모르는 종류는 이름 그대로 보인다. */
export const EVENT_LABEL: Record<string, string> = {
  'apply.failed': '적용 실패',
  'transition.incomplete': '끝나지 않은 전환',
  'acme.failed': 'ACME 발급 · 갱신 실패',
  'cert.expiring': '인증서 만료 임박',
  'leader.changed': '리더 교체',
  'region.unreachable': '지역 연락 끊김',
  'backup.failed': '백업 실패',
  'notify.test': '시험 전송',
};

/** 보낸 결과의 사람 말과 색. */
export const OUTCOME: Record<string, { tone: 'ok' | 'warn' | 'danger' | 'neutral'; label: string }> = {
  sent: { tone: 'ok', label: '보냄' },
  dropped: { tone: 'warn', label: '큐 넘침' },
  suppressed: { tone: 'neutral', label: '되풀이' },
  auth: { tone: 'danger', label: '인증 거절' },
  rejected: { tone: 'danger', label: '거절' },
  'rate-limited': { tone: 'warn', label: '제한' },
  unavailable: { tone: 'danger', label: '닿지 못함' },
  insecure: { tone: 'danger', label: 'https 아님' },
};

/** 받을 사람 주소 한 줄의 모양(서버와 같다). */
export const MAIL_ADDRESS = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
/** 통로 이름(서버와 같다). */
export const CHANNEL_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;

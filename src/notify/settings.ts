/**
 * 알림 설정의 정본 — 설정 DB 의 `notify_settings` · `notify_channels` · `notify_deliveries` (036, 2026-11-20).
 *
 *   공통 값    한 행. 재알림 간격 · 만료 임박 기준 · 상태 보기 주기 · 큐 상한. 바뀔 때마다 `version` 이 오른다.
 *   통로       이름이 있는 행. 종류(webhook · slack · mail) · 켜짐 · 받을 사건 · 최소 심각도 · 대상(웹훅 URL · 메일 주소).
 *   비밀       웹훅 서명 비밀 · Slack 웹훅 URL 은 **시크릿 저장소**(`opaque://`)에 두고 참조만 적는다. 응답은
 *              `secretSet: true` 만 낸다 — 한 번 넣은 비밀은 다시 보이지 않는다. 값을 바꾸면 옛 버전을 지운다.
 *   씨 뿌리기  행이 없으면(첫 기동) 환경 변수(`BARY_NOTIFY_*`)를 옮겨 넣는다. 그 뒤로는 DB 가 이긴다.
 *   기록       보낸 결과 · 시험 전송. 비밀 값이 사유 문장에 섞이면 가린다.
 *
 * 쓰기 규칙(이름 · 종류 · 주소 모양)은 `decodeChannel` 한 곳에 있다 — API 와 씨 뿌리기가 같은 것을 쓴다.
 */
import { createHash } from 'node:crypto';

import type { SecretStore } from '../dp/secrets.js';
import { log } from '../obs/log.js';
import { insecureReason } from '../outbound/http.js';
import { byDialect, dialectOf, type Database, type Queryable } from '../store/db.js';
import { mailNotifier, slackNotifier, webhookNotifier } from './channels.js';
import type { ChannelNotifier, Delivery } from './hub.js';
import type { NotifyEvent, NotifyKind, NotifyResult, Severity } from './notifier.js';
import { KNOB_RANGES, MAIL_ADDRESS, type NotifyDeps, type NotifyEnv, type NotifyKnobs } from './registry.js';

/** 사건 종류 전부 — 화면의 「받을 사건」 칸이 이 순서로 보인다. */
export const NOTIFY_KINDS: readonly NotifyKind[] = [
  'apply.failed', 'transition.incomplete', 'acme.failed', 'cert.expiring', 'leader.changed', 'region.unreachable', 'backup.failed',
];
export const SEVERITIES: readonly Severity[] = ['info', 'warning', 'critical'];
export const CHANNEL_KINDS = ['webhook', 'slack', 'mail'] as const;
export type ChannelKind = (typeof CHANNEL_KINDS)[number];

/** 통로 이름. DB CHECK(036)와 같다. */
export const CHANNEL_NAME = /^[a-z0-9][a-z0-9_-]{0,62}$/;
/** 웹훅 서명 비밀의 최소 길이. `openssl rand -hex 32` 는 64 자다. */
export const WEBHOOK_SECRET_MIN = 16;

/** 통로의 비밀 아닌 값 — `notify_channels.settings`. */
export type ChannelSettings = {
  /** 웹훅만. https. */
  url?: string;
  /** 메일만. 1~20 개. */
  to?: string[];
  /** 받을 사건 종류. 없으면 전부. */
  kinds?: NotifyKind[];
  /** 이것보다 낮은 심각도는 안 보낸다. */
  minSeverity: Severity;
};

export type ChannelRow = {
  name: string;
  kind: ChannelKind;
  enabled: boolean;
  settings: ChannelSettings;
  secretRef?: string;
  updatedAt: string;
  updatedBy: string;
};

export type NotifyConfig = {
  knobs: NotifyKnobs;
  version: number;
  seededFrom: 'env' | 'default';
  updatedAt: string;
  updatedBy: string;
  channels: ChannelRow[];
};

/** API 가 내보내는 통로 — 비밀은 `secretSet` 하나로만. */
export type ChannelView = Omit<ChannelRow, 'secretRef'> & { secretSet: boolean };

export class NotifySettingsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) {
    super(message);
  }
}

const bad = (message: string): NotifySettingsError => new NotifySettingsError(400, 'invalid_notify', message);

const SEVERITY_RANK: Readonly<Record<Severity, number>> = { info: 0, warning: 1, critical: 2 };

/** 이 통로가 이 사건을 받나. */
export function accepts(s: ChannelSettings, e: Pick<NotifyEvent, 'kind' | 'severity'>): boolean {
  if (SEVERITY_RANK[e.severity] < SEVERITY_RANK[s.minSeverity]) return false;
  return s.kinds === undefined || s.kinds.includes(e.kind);
}

export function viewOf(r: ChannelRow): ChannelView {
  const { secretRef, ...rest } = r;
  return { ...rest, secretSet: secretRef !== undefined };
}

// ── 해독 ───────────────────────────────────────────────────────────────

/** 들어온 통로 하나. `secret` 은 쓰기 전용이다 — 없으면 있던 값을 그대로 둔다. */
export type ChannelInput = { kind: ChannelKind; enabled: boolean; settings: ChannelSettings; secret?: string };

const ALLOWED_KEYS = new Set(['kind', 'enabled', 'url', 'to', 'kinds', 'minSeverity', 'secret']);

/**
 * API 본문 → 통로 값. `existing` 은 같은 이름의 지금 행이다(고치기). 종류는 바꿀 수 없다 — 비밀의 뜻이 바뀐다.
 * 비밀이 필요한 종류를 처음 만들 때는 비밀이 있어야 한다.
 */
export function decodeChannel(name: string, body: unknown, existing?: ChannelRow): ChannelInput {
  if (!CHANNEL_NAME.test(name)) throw bad(`통로 이름 '${name}' 는 소문자 · 숫자로 시작하고 소문자 · 숫자 · '_' · '-' 만 쓴다(63 자까지)`);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('본문은 객체여야 한다');
  const b = body as Record<string, unknown>;
  const stray = Object.keys(b).filter((k) => !ALLOWED_KEYS.has(k));
  if (stray.length > 0) throw bad(`모르는 칸: ${stray.join(', ')}`);

  const kind = b['kind'];
  if (typeof kind !== 'string' || !(CHANNEL_KINDS as readonly string[]).includes(kind)) {
    throw bad(`kind 는 ${CHANNEL_KINDS.join(' · ')} 중 하나다`);
  }
  if (existing !== undefined && existing.kind !== kind) {
    throw new NotifySettingsError(409, 'kind_immutable', `통로 '${name}' 의 종류는 ${existing.kind} 다 — 바꾸려면 지우고 새로 만든다`);
  }
  if (typeof b['enabled'] !== 'boolean') throw bad('enabled 는 참 · 거짓이다');

  const minSeverity = b['minSeverity'] ?? 'info';
  if (typeof minSeverity !== 'string' || !(SEVERITIES as readonly string[]).includes(minSeverity)) {
    throw bad(`minSeverity 는 ${SEVERITIES.join(' · ')} 중 하나다`);
  }
  const settings: ChannelSettings = { minSeverity: minSeverity as Severity };

  if (b['kinds'] !== undefined && b['kinds'] !== null) {
    const ks = b['kinds'];
    if (!Array.isArray(ks) || ks.length === 0) throw bad('kinds 는 비지 않은 목록이다(전부 받으려면 칸을 뺀다)');
    const unknown = ks.filter((k) => typeof k !== 'string' || !(NOTIFY_KINDS as readonly string[]).includes(k));
    if (unknown.length > 0) throw bad(`모르는 사건 종류: ${unknown.map(String).join(', ')}`);
    if (new Set(ks).size !== ks.length) throw bad('kinds 에 같은 종류가 두 번 있다');
    settings.kinds = NOTIFY_KINDS.filter((k) => ks.includes(k));
  }

  const secret = b['secret'];
  if (secret !== undefined && (typeof secret !== 'string' || secret === '')) throw bad('secret 은 비지 않은 문자열이다');

  switch (kind as ChannelKind) {
    case 'webhook': {
      const url = b['url'];
      if (typeof url !== 'string' || url === '' || url.length > 2048) throw bad('웹훅에는 url(https, 2048 자까지)이 있어야 한다');
      const insecure = insecureReason(url);
      if (insecure !== undefined) throw bad(`url: ${insecure}`);
      if (b['to'] !== undefined) throw bad('웹훅에는 to 가 없다');
      if (typeof secret === 'string' && secret.length < WEBHOOK_SECRET_MIN) throw bad(`웹훅 서명 비밀은 ${WEBHOOK_SECRET_MIN} 자 이상이다`);
      if (secret === undefined && existing?.secretRef === undefined) throw bad('새 웹훅에는 서명 비밀(secret)이 있어야 한다');
      settings.url = url;
      break;
    }
    case 'slack': {
      if (b['url'] !== undefined || b['to'] !== undefined) throw bad('Slack 의 웹훅 URL 은 비밀이다 — url 이 아니라 secret 칸에 넣는다');
      if (typeof secret === 'string') {
        const insecure = insecureReason(secret);
        if (insecure !== undefined) throw bad(`Slack 웹훅 URL: ${insecure}`);
      }
      if (secret === undefined && existing?.secretRef === undefined) throw bad('새 Slack 통로에는 웹훅 URL(secret)이 있어야 한다');
      break;
    }
    case 'mail': {
      if (b['url'] !== undefined) throw bad('메일에는 url 이 없다');
      if (secret !== undefined) throw bad('메일에는 비밀이 없다 — 전송 설정은 BARY_MAIL_* 이다');
      const to = b['to'];
      if (!Array.isArray(to) || to.length === 0 || to.length > 20) throw bad('메일에는 받는 주소 to(1~20 개)가 있어야 한다');
      const wrong = to.find((a) => typeof a !== 'string' || !MAIL_ADDRESS.test(a.trim()));
      if (wrong !== undefined) throw bad(`주소 형식이 아니다: ${JSON.stringify(wrong)}`);
      const trimmed = (to as string[]).map((a) => a.trim());
      if (new Set(trimmed).size !== trimmed.length) throw bad('to 에 같은 주소가 두 번 있다');
      settings.to = trimmed;
      break;
    }
  }
  return { kind: kind as ChannelKind, enabled: b['enabled'], settings, ...(typeof secret === 'string' ? { secret } : {}) };
}

/** API 본문 → 공통 값. 네 칸 모두 있어야 한다. */
export function decodeKnobs(body: unknown): NotifyKnobs {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('본문은 객체여야 한다');
  const b = body as Record<string, unknown>;
  const names = Object.keys(KNOB_RANGES) as (keyof NotifyKnobs)[];
  const stray = Object.keys(b).filter((k) => !(names as string[]).includes(k));
  if (stray.length > 0) throw bad(`모르는 칸: ${stray.join(', ')}`);
  const out = {} as NotifyKnobs;
  for (const n of names) {
    const v = b[n];
    const r = KNOB_RANGES[n];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < r.min || v > r.max) throw bad(`${n} 는 ${r.min}~${r.max} 의 정수다`);
    out[n] = v;
  }
  return out;
}

// ── 행 ─────────────────────────────────────────────────────────────────

const iso = (v: unknown): string => new Date(v as string | Date).toISOString();
const jsonOf = (v: unknown): unknown => (typeof v === 'string' ? JSON.parse(v) : v);
const boolOf = (v: unknown): boolean => v === true || v === 1 || v === '1';

function rowOf(r: Record<string, unknown>): ChannelRow {
  return {
    name: String(r['name']),
    kind: String(r['kind']) as ChannelKind,
    enabled: boolOf(r['enabled']),
    settings: jsonOf(r['settings']) as ChannelSettings,
    ...(r['secret_ref'] === null || r['secret_ref'] === undefined ? {} : { secretRef: String(r['secret_ref']) }),
    updatedAt: iso(r['updated_at']),
    updatedBy: String(r['updated_by']),
  };
}

/** 시크릿 저장소의 이름 — 통로마다 하나. */
export const secretNameOf = (channel: string): string => `notify.${channel}`;

/** 기록 한 줄(API 가 내보내는 모양). */
export type DeliveryRow = {
  id: string;
  at: string;
  channel?: string;
  kind: string;
  severity: Severity;
  key: string;
  outcome: string;
  detail?: string;
  test: boolean;
  node: string;
};

/** 기록의 사유 문장 상한. */
const DETAIL_MAX = 500;

/** 사유 문장에서 비밀 값을 가린다. 비밀이 URL 이면(Slack) 경로 부분만 섞여도 가린다. */
export function scrub(detail: string, secrets: readonly string[]): string {
  let out = detail;
  for (const s of secrets) {
    if (s.length < 4) continue;
    out = out.split(s).join('***');
    try {
      const u = new URL(s);
      if (u.pathname.length > 8) out = out.split(u.pathname).join('/***');
    } catch { /* URL 이 아니다 */ }
  }
  return out.length > DETAIL_MAX ? `${out.slice(0, DETAIL_MAX)}…` : out;
}

export class NotifySettingsStore {
  constructor(private readonly db: Database, private readonly secrets?: SecretStore) {}

  /** 설정 전부. 아직 씨를 안 뿌렸으면 `undefined`. */
  async load(q: Queryable = this.db): Promise<NotifyConfig | undefined> {
    const s = (await q.query(
      'SELECT repeat_s, cert_days, interval_s, queue, version, seeded_from, updated_at, updated_by FROM notify_settings')).rows[0];
    if (s === undefined) return undefined;
    const channels = (await q.query(
      'SELECT name, kind, enabled, settings, secret_ref, updated_at, updated_by FROM notify_channels ORDER BY name')).rows.map(rowOf);
    return {
      knobs: { repeatS: Number(s['repeat_s']), certDays: Number(s['cert_days']), intervalS: Number(s['interval_s']), queue: Number(s['queue']) },
      version: Number(s['version']),
      seededFrom: String(s['seeded_from']) as 'env' | 'default',
      updatedAt: iso(s['updated_at']),
      updatedBy: String(s['updated_by']),
      channels,
    };
  }

  /** 바뀌었는지만 본다 — 다른 노드가 주기마다 이것을 묻는다. */
  async version(): Promise<number | undefined> {
    const r = (await this.db.query('SELECT version FROM notify_settings')).rows[0];
    return r === undefined ? undefined : Number(r['version']);
  }

  /**
   * 첫 기동 — 행이 없으면 환경 변수를 옮긴다. 이미 있으면 아무것도 안 하고 `false`.
   *
   * 비밀은 트랜잭션 **앞에서** 저장소에 넣는다(내용 주소라 다시 넣어도 같은 참조다). 두 노드가 함께 떠도 설정 행의
   * 유일 키가 한쪽만 이기게 한다 — 진 쪽은 통로를 넣지 않는다.
   */
  async seed(spec: NotifyEnv | undefined, knobs: NotifyKnobs, by = 'system'): Promise<boolean> {
    if ((await this.version()) !== undefined) return false;
    const refs = new Map<string, string>();
    for (const c of spec?.channels ?? []) {
      if (c.kind === 'mail') continue;
      if (this.secrets === undefined) throw new Error('알림 비밀을 둘 시크릿 저장소가 없다');
      refs.set(c.kind, (await this.secrets.putOpaque(secretNameOf(c.kind), c.secret)).ref);
    }
    const k = spec?.knobs ?? knobs;
    return this.db.tx(async (q) => {
      const ins = await q.query(byDialect(q, {
        postgres: `INSERT INTO notify_settings (repeat_s, cert_days, interval_s, queue, seeded_from, updated_by)
          VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (only_one) DO NOTHING`,
        sqlite: `INSERT INTO notify_settings (repeat_s, cert_days, interval_s, queue, seeded_from, updated_by)
          VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (only_one) DO NOTHING`,
        mysql: `INSERT IGNORE INTO notify_settings (repeat_s, cert_days, interval_s, queue, seeded_from, updated_by)
          VALUES ($1, $2, $3, $4, $5, $6)`,
      }), [k.repeatS, k.certDays, k.intervalS, k.queue, spec === undefined ? 'default' : 'env', by]);
      if ((ins.rowCount ?? 0) === 0) return false;
      for (const c of spec?.channels ?? []) {
        const settings: ChannelSettings = { minSeverity: 'info',
          ...(c.kind === 'webhook' ? { url: c.url } : {}), ...(c.kind === 'mail' ? { to: c.to } : {}) };
        await q.query(
          `INSERT INTO notify_channels (name, kind, enabled, settings, secret_ref, updated_by) VALUES ($1, $2, $3, $4, $5, $6)`,
          [c.kind, c.kind, true, JSON.stringify(settings), refs.get(c.kind) ?? null, by]);
      }
      return true;
    });
  }

  async putKnobs(k: NotifyKnobs, by: string): Promise<void> {
    const out = await this.db.query(
      `UPDATE notify_settings SET repeat_s = $1, cert_days = $2, interval_s = $3, queue = $4,
         version = version + 1, updated_at = now(), updated_by = $5`,
      [k.repeatS, k.certDays, k.intervalS, k.queue, by]);
    if ((out.rowCount ?? 0) === 0) throw new NotifySettingsError(409, 'not_seeded', '알림 설정이 아직 없다 — 데몬이 처음 뜰 때 만든다');
  }

  /** 통로를 만들거나 고친다. 비밀을 바꾸면 옛 버전을 지운다. 만들었으면 `true`. */
  async putChannel(name: string, body: unknown, by: string): Promise<{ created: boolean; channel: ChannelRow }> {
    const existing = (await this.load())?.channels.find((c) => c.name === name);
    const input = decodeChannel(name, body, existing);
    let ref = existing?.secretRef;
    if (input.secret !== undefined) {
      if (this.secrets === undefined) throw new NotifySettingsError(501, 'no_secret_store', '알림 비밀을 둘 시크릿 저장소가 없다');
      ref = (await this.secrets.putOpaque(secretNameOf(name), input.secret)).ref;
    }
    const created = await this.db.tx(async (q) => {
      if ((await q.query('SELECT version FROM notify_settings')).rows[0] === undefined) {
        throw new NotifySettingsError(409, 'not_seeded', '알림 설정이 아직 없다 — 데몬이 처음 뜰 때 만든다');
      }
      const upd = await q.query(
        `UPDATE notify_channels SET enabled = $2, settings = $3, secret_ref = $4, updated_at = now(), updated_by = $5 WHERE name = $1`,
        [name, input.enabled, JSON.stringify(input.settings), ref ?? null, by]);
      let made = false;
      if ((upd.rowCount ?? 0) === 0) {
        await q.query(
          `INSERT INTO notify_channels (name, kind, enabled, settings, secret_ref, updated_by) VALUES ($1, $2, $3, $4, $5, $6)`,
          [name, input.kind, input.enabled, JSON.stringify(input.settings), ref ?? null, by]);
        made = true;
      }
      await bump(q, by);
      return made;
    });
    if (existing?.secretRef !== undefined && existing.secretRef !== ref) await this.#forget(existing.secretRef);
    const channel = (await this.load())!.channels.find((c) => c.name === name)!;
    return { created, channel };
  }

  async deleteChannel(name: string, by: string): Promise<boolean> {
    const existing = (await this.load())?.channels.find((c) => c.name === name);
    if (existing === undefined) return false;
    await this.db.tx(async (q) => {
      await q.query('DELETE FROM notify_channels WHERE name = $1', [name]);
      await bump(q, by);
    });
    if (existing.secretRef !== undefined) await this.#forget(existing.secretRef);
    return true;
  }

  /** 통로의 비밀을 읽는다(보내는 객체를 만들 때만). */
  async secretOf(c: ChannelRow): Promise<string | undefined> {
    if (c.secretRef === undefined) return undefined;
    if (this.secrets === undefined) throw new Error('알림 비밀을 둘 시크릿 저장소가 없다');
    return this.secrets.getOpaque(c.secretRef);
  }

  async #forget(ref: string): Promise<void> {
    try {
      await this.secrets?.removeOpaque(ref);
    } catch (e) {
      // 못 지운 옛 비밀은 남을 뿐이다 — 아무도 참조하지 않는다. 설정 변경을 실패로 돌리지 않는다.
      log.warn('notify.secret_forget_failed', { error: (e as Error).message });
    }
  }

  async recordDelivery(d: Delivery & { test?: boolean; node: string }, secrets: readonly string[] = []): Promise<void> {
    await this.db.query(
      `INSERT INTO notify_deliveries (channel, kind, severity, event_key, outcome, detail, test, node)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [d.channel ?? null, d.event.kind, d.event.severity, d.event.key.slice(0, 500), d.outcome,
        d.detail === undefined ? null : scrub(d.detail, secrets), d.test === true, d.node]);
  }

  /** 기록 — 새것부터. `before` 는 앞 쪽의 마지막 `id` 다. */
  async deliveries(o: { limit: number; before?: string; channel?: string }): Promise<{ items: DeliveryRow[]; next?: string }> {
    const where: string[] = [];
    const args: unknown[] = [];
    if (o.before !== undefined) {
      args.push(o.before);
      where.push(byDialect(this.db, {
        postgres: `id < $${args.length}::bigint`, sqlite: `id < CAST($${args.length} AS INTEGER)`, mysql: `id < $${args.length}`,
      }));
    }
    if (o.channel !== undefined) {
      args.push(o.channel);
      where.push(`channel = $${args.length}`);
    }
    args.push(dialectOf(this.db).name === 'mysql' ? o.limit + 1 : String(o.limit + 1));
    const lim = byDialect(this.db, {
      postgres: `$${args.length}::int`, sqlite: `CAST($${args.length} AS INTEGER)`, mysql: `$${args.length}`,
    });
    const rows = (await this.db.query(
      `SELECT id, at, channel, kind, severity, event_key, outcome, detail, test, node FROM notify_deliveries
        ${where.length === 0 ? '' : `WHERE ${where.join(' AND ')}`} ORDER BY id DESC LIMIT ${lim}`, args)).rows;
    const items = rows.slice(0, o.limit).map((r): DeliveryRow => ({
      id: String(r['id']),
      at: iso(r['at']),
      ...(r['channel'] === null ? {} : { channel: String(r['channel']) }),
      kind: String(r['kind']),
      severity: String(r['severity']) as Severity,
      key: String(r['event_key']),
      outcome: String(r['outcome']),
      ...(r['detail'] === null ? {} : { detail: String(r['detail']) }),
      test: boolOf(r['test']),
      node: String(r['node']),
    }));
    return { items, ...(rows.length > o.limit ? { next: items[items.length - 1]!.id } : {}) };
  }
}

async function bump(q: Queryable, by: string): Promise<void> {
  await q.query('UPDATE notify_settings SET version = version + 1, updated_at = now(), updated_by = $1', [by]);
}

// ── 보내는 객체 ────────────────────────────────────────────────────────

export type BuiltChannels = {
  notifiers: ChannelNotifier[];
  /** 켜져 있지만 만들지 못한 통로와 그 까닭(예: 메일 전송 설정이 없다). */
  problems: { channel: string; problem: string }[];
  /** 사유 문장에서 가릴 값들. */
  secrets: string[];
};

/** 켜진 통로마다 보내는 객체를 만든다. 하나가 실패해도 나머지는 만든다. */
export async function buildChannels(
  config: NotifyConfig, store: Pick<NotifySettingsStore, 'secretOf'>, deps: NotifyDeps = {},
): Promise<BuiltChannels> {
  const out: BuiltChannels = { notifiers: [], problems: [], secrets: [] };
  for (const c of config.channels) {
    if (!c.enabled) continue;
    try {
      const secret = await store.secretOf(c);
      if (secret !== undefined) out.secrets.push(secret);
      out.notifiers.push(notifierFor(c, secret, deps));
    } catch (e) {
      out.problems.push({ channel: c.name, problem: (e as Error).message });
    }
  }
  return out;
}

/** 행 하나 → 보내는 객체(이름 · 거르기를 단다). 시험 전송도 이것을 쓴다. */
export function notifierFor(c: ChannelRow, secret: string | undefined, deps: NotifyDeps = {}): ChannelNotifier {
  const fetchOf = deps.fetch === undefined ? {} : { fetch: deps.fetch };
  let n;
  switch (c.kind) {
    case 'webhook':
      if (c.settings.url === undefined || secret === undefined) throw new Error('웹훅 URL 이나 서명 비밀이 없다');
      n = webhookNotifier({ url: c.settings.url, secret, ...fetchOf });
      break;
    case 'slack':
      if (secret === undefined) throw new Error('Slack 웹훅 URL 이 없다');
      n = slackNotifier({ url: secret, ...fetchOf });
      break;
    case 'mail': {
      const mail = deps.mail?.();
      if (mail === undefined) throw new Error('메일 전송 설정(BARY_MAIL_KIND · BARY_MAIL_FROM …)이 없다');
      if (c.settings.to === undefined) throw new Error('받는 주소가 없다');
      n = mailNotifier({ mailer: mail.mailer, to: c.settings.to });
      break;
    }
  }
  const send = n.send.bind(n);
  return { kind: n.kind, name: c.name, send, accepts: (e) => accepts(c.settings, e) };
}

/** 시험 사건 — 키가 매번 다르다(되풀이로 걸러지지 않게). */
export function testEvent(channel: string, node: string, at = new Date()): NotifyEvent {
  return {
    kind: 'notify.test', severity: 'info',
    key: `test:${channel}:${createHash('sha256').update(at.toISOString()).digest('hex').slice(0, 12)}`,
    title: '시험 알림이다 — 받았으면 통로가 맞다',
    detail: `barycenter 화면의 「시험 전송」 이 보낸 알림이다. 통로: ${channel}. 할 일은 없다.`,
    facts: { channel, test: true },
    at: at.toISOString(), node,
  };
}

export type TestOutcome = { outcome: 'sent' } | { outcome: Exclude<NotifyResult, { ok: true }>['reason']; detail: string };

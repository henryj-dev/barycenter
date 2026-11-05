/**
 * 알림 — 통로(webhook · slack · mail) · 허브(중복 억제 · 큐 상한 · 실패가 본 동작을 막지 않음) · 상태 보기 · 등록부.
 *
 * 비밀 · 웹훅 URL 은 실행 중에 만든 가짜 값이다.
 */
import { createHmac } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { mailNotifier, signWebhook, slackNotifier, webhookNotifier } from '../../src/notify/channels.js';
import { NotifyHub, type NotifyInput } from '../../src/notify/hub.js';
import type { Notifier, NotifyEvent } from '../../src/notify/notifier.js';
import { acmeFailure, notifyFromEnv } from '../../src/notify/registry.js';
import { NotifyWatch } from '../../src/notify/watch.js';
import { setSink } from '../../src/obs/log.js';

const fakeSecret = ['fake', 'hook', 'secret'].join('-');
const slackUrl = ['https://hooks.slack.test/services', 'T0', 'B0', 'fake'].join('/');

const EVENT: NotifyEvent = {
  kind: 'apply.failed', severity: 'critical', key: 'apply.failed:p1', title: '적용 실패', detail: 'nginx -t 실패',
  facts: { revision: 'r9' }, at: '2026-11-05T00:00:00.000Z', node: 'n1',
};

type Call = { url: string; headers: Record<string, string>; body: string };
function fakeFetch(res: () => Response): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  return {
    calls,
    fetch: (async (url: string | URL, init?: RequestInit) => {
      expect(init?.redirect).toBe('error');
      calls.push({ url: String(url), headers: Object.fromEntries(new Headers(init?.headers).entries()), body: String(init?.body) });
      return res();
    }) as typeof fetch,
  };
}

function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  setSink((l) => lines.push(l));
  return { lines, restore: () => setSink((l) => process.stdout.write(`${l}\n`)) };
}

describe('webhook', () => {
  it('JSON 본문에 HMAC-SHA256 서명 헤더(t=,v1=) — 받는 쪽이 같은 값을 계산할 수 있다', async () => {
    const { fetch, calls } = fakeFetch(() => new Response(null, { status: 204 }));
    const n = webhookNotifier({ url: 'https://hooks.example.test/bary', secret: fakeSecret, fetch, now: () => 1_762_300_800_000 });
    expect(await n.send(EVENT)).toEqual({ ok: true });
    const c = calls[0]!;
    expect(JSON.parse(c.body)).toMatchObject({ version: 1, kind: 'apply.failed', key: 'apply.failed:p1' });
    expect(c.headers['x-barycenter-event']).toBe('apply.failed');
    const expected = createHmac('sha256', fakeSecret).update(`1762300800.${c.body}`).digest('hex');
    expect(c.headers['x-barycenter-signature']).toBe(`t=1762300800,v1=${expected}`);
    expect(signWebhook(fakeSecret, 1762300800, c.body)).toBe(c.headers['x-barycenter-signature']);
    expect(c.body).not.toContain(fakeSecret);
  });

  it('상태코드의 뜻 · http 거절 · 큰 답', async () => {
    const at = (s: number): Promise<unknown> => webhookNotifier({ url: 'https://h.test', secret: fakeSecret, fetch: fakeFetch(() => new Response('no', { status: s })).fetch }).send(EVENT);
    expect(await at(401)).toMatchObject({ ok: false, reason: 'auth' });
    expect(await at(429)).toMatchObject({ ok: false, reason: 'rate-limited' });
    expect(await at(503)).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(await at(400)).toMatchObject({ ok: false, reason: 'rejected' });
    const f = fakeFetch(() => new Response(''));
    expect(await webhookNotifier({ url: 'http://h.test', secret: fakeSecret, fetch: f.fetch }).send(EVENT)).toMatchObject({ ok: false, reason: 'insecure' });
    expect(f.calls).toHaveLength(0);
    const big = fakeFetch(() => new Response('x'.repeat(64 * 1024))).fetch;
    expect(await webhookNotifier({ url: 'https://h.test', secret: fakeSecret, fetch: big }).send(EVENT)).toMatchObject({ ok: false, reason: 'unavailable' });
  });
});

describe('slack', () => {
  it('text 하나로 보낸다 · 404/410 은 죽은 웹훅(auth)', async () => {
    const { fetch, calls } = fakeFetch(() => new Response('ok'));
    expect(await slackNotifier({ url: slackUrl, fetch }).send(EVENT)).toEqual({ ok: true });
    expect(JSON.parse(calls[0]!.body).text).toContain('[critical] 적용 실패');
    expect(await slackNotifier({ url: slackUrl, fetch: fakeFetch(() => new Response('no_service', { status: 404 })).fetch }).send(EVENT)).toMatchObject({ reason: 'auth' });
    expect(await slackNotifier({ url: slackUrl, fetch: fakeFetch(() => new Response('invalid_payload', { status: 400 })).fetch }).send(EVENT)).toMatchObject({ reason: 'rejected' });
  });
});

describe('mail', () => {
  it('받는 사람마다 보내고, 일부 실패는 결과로', async () => {
    const sent: string[] = [];
    const mailer = { send: async (to: string) => { if (to.startsWith('bad')) throw new Error('x'); sent.push(to); } };
    expect(await mailNotifier({ mailer, to: ['a@example.com', 'b@example.com'] }).send(EVENT)).toEqual({ ok: true });
    expect(sent).toEqual(['a@example.com', 'b@example.com']);
    expect(await mailNotifier({ mailer, to: ['a@example.com', 'bad@example.com'] }).send(EVENT)).toMatchObject({ ok: false, detail: expect.stringContaining('2통 중 1통') });
  });
});

const INPUT: NotifyInput = { kind: 'cert.expiring', severity: 'warning', key: 'cert.expiring:web:x', title: 't', detail: 'd' };

function recorder(): Notifier & { got: NotifyEvent[] } {
  const r = { kind: 'rec', got: [] as NotifyEvent[], send: async (e: NotifyEvent) => { r.got.push(e); return { ok: true } as const; } };
  return r;
}

describe('NotifyHub', () => {
  it('같은 사건 키는 재알림 간격 안에 한 번만 · 간격이 지나면 다시', async () => {
    let t = 0;
    const rec = recorder();
    const hub = new NotifyHub([rec], { node: 'n1', repeatMs: 60_000, now: () => t });
    expect(hub.emit(INPUT)).toBe(true);
    expect(hub.emit(INPUT)).toBe(false);
    t = 59_999;
    expect(hub.emit(INPUT)).toBe(false);
    t = 60_000;
    expect(hub.emit(INPUT)).toBe(true);
    await hub.drain();
    expect(rec.got).toHaveLength(2);
    expect(rec.got[0]).toMatchObject({ node: 'n1', key: INPUT.key });
  });

  it('forget 하면 간격을 기다리지 않는다', async () => {
    const hub = new NotifyHub([recorder()], { node: 'n1', repeatMs: 60_000, now: () => 0 });
    hub.emit(INPUT);
    hub.forget(INPUT.key);
    expect(hub.emit(INPUT)).toBe(true);
  });

  it('emit 은 기다리지 않는다 — 통로가 멎어 있어도 바로 돌아오고, 큐는 상한에서 오래된 것을 버린다', async () => {
    const cap = captureLogs();
    try {
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => { release = r; });
      const sent: string[] = [];
      const slow: Notifier = { kind: 'slow', send: async (e) => { await gate; sent.push(e.key); return { ok: true }; } };
      const hub = new NotifyHub([slow], { node: 'n1', repeatMs: 1, maxQueue: 3, now: () => Date.now() });
      for (let i = 0; i < 10; i += 1) expect(hub.emit({ ...INPUT, key: `k${i}` })).toBe(true);
      expect(hub.queued).toBeLessThanOrEqual(3);
      expect(cap.lines.some((l) => l.includes('notify.queue_overflow'))).toBe(true);
      release();
      await hub.drain();
      // 첫 것은 이미 보내는 중이었고, 나머지는 최근 셋만 남았다.
      expect(sent).toEqual(['k0', 'k7', 'k8', 'k9']);
    } finally {
      cap.restore();
    }
  });

  it('통로 실패 · 던짐은 로그만 — 다른 통로는 받는다', async () => {
    const cap = captureLogs();
    try {
      const rec = recorder();
      const broken: Notifier = { kind: 'broken', send: async () => { throw new Error('boom'); } };
      const failing: Notifier = { kind: 'failing', send: async () => ({ ok: false, reason: 'auth', detail: '거절' }) };
      const hub = new NotifyHub([broken, failing, rec], { node: 'n1', repeatMs: 1000 });
      expect(() => hub.emit(INPUT)).not.toThrow();
      await hub.drain();
      expect(rec.got).toHaveLength(1);
      const warn = cap.lines.filter((l) => l.includes('notify.send_failed'));
      expect(warn.some((l) => l.includes('"notifier":"broken"'))).toBe(true);
      expect(warn.some((l) => l.includes('"notifier":"failing"') && l.includes('"reason":"auth"'))).toBe(true);
    } finally {
      cap.restore();
    }
  });
});

describe('ACME 실패 → 알림', () => {
  it('실패만 알린다 · 키는 주문(+상태)', () => {
    expect(acmeFailure({ order: 'o1', from: 'pending', to: 'validating' })).toBeUndefined();
    expect(acmeFailure({ order: 'o1', from: 'validating', to: 'failed', error: 'CA 가 거절했다' })).toMatchObject({ kind: 'acme.failed', key: 'acme.failed:o1:failed', severity: 'warning' });
    expect(acmeFailure({ order: 'o1', to: 'abandoned', error: 'x' })).toMatchObject({ severity: 'critical' });
  });
});

describe('NotifyWatch', () => {
  const setup = (src: Partial<ConstructorParameters<typeof NotifyWatch>[1]> & { leader?: () => boolean }): { watch: NotifyWatch; got: NotifyEvent[]; hub: NotifyHub; clock: { t: number } } => {
    const clock = { t: Date.parse('2026-11-05T00:00:00Z') };
    const rec = recorder();
    const hub = new NotifyHub([rec], { node: 'n1', repeatMs: 3_600_000, now: () => clock.t });
    const watch = new NotifyWatch(hub, { isLeader: src.leader ?? (() => true), ...src }, { certDays: 14, graceMs: 120_000, now: () => clock.t });
    return { watch, got: rec.got, hub, clock };
  };

  it('리더 교체 — 첫 관측은 사건이 아니고, 바뀌면 알린다', async () => {
    let leader = true;
    const { watch, got, hub } = setup({ leader: () => leader });
    await watch.tick();
    leader = false;
    await watch.tick();
    await hub.drain();
    expect(got.map((e) => e.kind)).toEqual(['leader.changed']);
    expect(got[0]!.title).toContain('잃었다');
  });

  it('적용 실패는 plan 마다 한 번', async () => {
    const { watch, got, hub } = setup({ failedApply: async () => ({ revision: 'r9', planId: 'p9', failure: 'nginx -t' }) });
    await watch.tick();
    await watch.tick();
    await hub.drain();
    expect(got.filter((e) => e.kind === 'apply.failed')).toHaveLength(1);
  });

  it('미완 전환은 유예(graceMs)를 넘게 남았을 때만', async () => {
    const { watch, got, hub, clock } = setup({ unfinished: async () => ({ operationId: 'op1' }) });
    await watch.tick();
    clock.t += 60_000;
    await watch.tick();
    expect(got).toHaveLength(0);
    clock.t += 60_000;
    await watch.tick();
    await hub.drain();
    expect(got.map((e) => e.key)).toEqual(['transition.incomplete:op1']);
  });

  it('인증서 만료 임박 — N일 안만, 3일 안은 critical', async () => {
    const day = 86_400_000;
    const base = Date.parse('2026-11-05T00:00:00Z');
    const { watch, got, hub } = setup({
      certificates: async () => [
        { key: 'far', notAfter: new Date(base + 40 * day).toISOString() },
        { key: 'soon', notAfter: new Date(base + 10 * day).toISOString() },
        { key: 'now', notAfter: new Date(base + 2 * day).toISOString() },
        { key: 'unknown' },
      ],
    });
    await watch.tick();
    await hub.drain();
    expect(got.map((e) => [e.facts?.['certificate'], e.severity])).toEqual([['soon', 'warning'], ['now', 'critical']]);
  });

  it('지역 연락 끊김 — 유예 뒤 알리고, 다시 닿으면 잊는다(다음 끊김은 바로 알린다)', async () => {
    let reachable = false;
    const { watch, got, hub, clock } = setup({ regions: async () => [{ name: 'icn', reachable, error: 'ECONNREFUSED' }] });
    await watch.tick();
    clock.t += 120_000;
    await watch.tick();
    reachable = true;
    await watch.tick();
    reachable = false;
    await watch.tick();
    clock.t += 120_000;
    await watch.tick();
    await hub.drain();
    expect(got.filter((e) => e.kind === 'region.unreachable')).toHaveLength(2);
  });

  it('리더가 아니면 리더 교체 말고는 보지 않는다 · 출처가 던져도 나머지는 본다', async () => {
    const cap = captureLogs();
    try {
      let asked = 0;
      const standby = setup({ leader: () => false, failedApply: async () => { asked += 1; return undefined; } });
      await standby.watch.tick();
      expect(asked).toBe(0);
      const { watch, got, hub } = setup({
        failedApply: async () => { throw new Error('db down'); },
        unfinished: async () => undefined,
        certificates: async () => [{ key: 'x', notAfter: '2026-11-06T00:00:00Z' }],
      });
      await watch.tick();
      await hub.drain();
      expect(got.map((e) => e.kind)).toEqual(['cert.expiring']);
      expect(cap.lines.some((l) => l.includes('notify.watch.source_failed') && l.includes('failedApply'))).toBe(true);
    } finally {
      cap.restore();
    }
  });
});

describe('등록부 (BARY_NOTIFY)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bary-notify-'));
  const secretFile = join(dir, 'secret');
  const slackFile = join(dir, 'slack');
  writeFileSync(secretFile, `${fakeSecret}\n`);
  writeFileSync(slackFile, `${slackUrl}\n`);

  it('없으면 끈다 — 지금과 같다', () => {
    expect(notifyFromEnv('n1', {})).toBeUndefined();
  });

  it('여럿을 함께 · 기본값', () => {
    const s = notifyFromEnv('n1', { BARY_NOTIFY: 'webhook,slack', BARY_NOTIFY_WEBHOOK_URL: 'https://h.test/x', BARY_NOTIFY_WEBHOOK_SECRET_FILE: secretFile, BARY_NOTIFY_SLACK_URL_FILE: slackFile })!;
    expect(s.hub.kinds).toEqual(['webhook', 'slack']);
    expect(s).toMatchObject({ certDays: 14, intervalMs: 60_000 });
  });

  it('모르는 이름 · 중복은 던진다', () => {
    expect(() => notifyFromEnv('n1', { BARY_NOTIFY: 'pagerduty' })).toThrow(/모르는 알림 통로: pagerduty/);
    expect(() => notifyFromEnv('n1', { BARY_NOTIFY: 'slack,slack', BARY_NOTIFY_SLACK_URL_FILE: slackFile })).toThrow(/두 번/);
  });

  it('반만 설정이면 거부 — 비밀 없음 · 통로 없이 변수만 · 고르지 않은 통로 변수 · http · 메일 설정 없음', () => {
    expect(() => notifyFromEnv('n1', { BARY_NOTIFY: 'webhook', BARY_NOTIFY_WEBHOOK_URL: 'https://h.test' })).toThrow(/SECRET_FILE/);
    expect(() => notifyFromEnv('n1', { BARY_NOTIFY_SLACK_URL_FILE: slackFile })).toThrow(/BARY_NOTIFY 가 없다/);
    expect(() => notifyFromEnv('n1', { BARY_NOTIFY: 'slack', BARY_NOTIFY_SLACK_URL_FILE: slackFile, BARY_NOTIFY_WEBHOOK_URL: 'https://h.test' })).toThrow(/쓰지 않는 변수/);
    expect(() => notifyFromEnv('n1', { BARY_NOTIFY: 'webhook', BARY_NOTIFY_WEBHOOK_URL: 'http://h.test', BARY_NOTIFY_WEBHOOK_SECRET_FILE: secretFile })).toThrow(/https/);
    expect(() => notifyFromEnv('n1', { BARY_NOTIFY: 'mail', BARY_NOTIFY_MAIL_TO: 'ops@example.com' }, { mail: () => undefined })).toThrow(/메일 전송 설정/);
  });

  it('mail 은 메일 전송 설정을 함께 쓴다', () => {
    const mailer = { send: async () => undefined };
    expect(notifyFromEnv('n1', { BARY_NOTIFY: 'mail', BARY_NOTIFY_MAIL_TO: 'ops@example.com, oncall@example.com' }, { mail: () => ({ kind: 'log', from: 'x@example.com', mailer }) })!.hub.kinds).toEqual(['mail']);
  });
});

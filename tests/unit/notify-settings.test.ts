/**
 * 알림 설정 — 해독 · 거르기 · 가리기 · 허브 다시 짜기 · 파일 시크릿 저장소의 `opaque` (036, 2026-11-20).
 *
 * DB 를 쓰는 경로(씨 뿌리기 · API · 기록 · 보존)는 `tests/store/notify-settings.test.ts` 가 방언마다 잰다.
 * 비밀 · URL 은 실행 중에 만든 가짜 값이다.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { getPath } from '../../src/cli/get.js';
import { sweepSecrets } from '../../src/dp/secret-gc.js';
import { RELAY_PATHS, RELAY_WRITES } from '../../src/global/relay.js';
import { FsSecretStore, parseOpaqueRef } from '../../src/dp/secrets.js';
import { NotifyHub, type ChannelNotifier, type Delivery } from '../../src/notify/hub.js';
import type { NotifyEvent } from '../../src/notify/notifier.js';
import { accepts, decodeChannel, decodeKnobs, scrub, viewOf, type ChannelRow } from '../../src/notify/settings.js';
import { NAV_GROUPS, PAGE_META } from '../../src/web/nav.js';
import { pageOf } from '../../src/web/page.js';

const secret = randomBytes(20).toString('hex');
const slackUrl = ['https://hooks.slack.test/services', 'T0', 'B0', randomBytes(6).toString('hex')].join('/');

const row = (over: Partial<ChannelRow> = {}): ChannelRow => ({
  name: 'hook', kind: 'webhook', enabled: true, settings: { url: 'https://h.test/x', minSeverity: 'info' },
  secretRef: 'opaque://notify.hook@' + 'a'.repeat(32), updatedAt: '2026-11-20T00:00:00.000Z', updatedBy: 't', ...over,
});

describe('통로 해독', () => {
  it('웹훅 — https · 비밀 길이 · 새로 만들면 비밀이 있어야 한다', () => {
    expect(decodeChannel('hook', { kind: 'webhook', enabled: true, url: 'https://h.test/x', secret })).toMatchObject({
      kind: 'webhook', settings: { url: 'https://h.test/x', minSeverity: 'info' }, secret,
    });
    expect(() => decodeChannel('hook', { kind: 'webhook', enabled: true, url: 'https://h.test/x' })).toThrow(/서명 비밀/);
    expect(() => decodeChannel('hook', { kind: 'webhook', enabled: true, url: 'http://h.test/x', secret })).toThrow(/url/);
    expect(() => decodeChannel('hook', { kind: 'webhook', enabled: true, url: 'https://h.test/x', secret: 'short' })).toThrow(/16 자/);
    // 고칠 때는 비밀을 빼도 된다 — 있던 값을 둔다.
    expect(decodeChannel('hook', { kind: 'webhook', enabled: false, url: 'https://h.test/y' }, row()).secret).toBeUndefined();
  });

  it('Slack — URL 은 비밀 칸에만', () => {
    expect(() => decodeChannel('s', { kind: 'slack', enabled: true, url: slackUrl })).toThrow(/secret 칸/);
    expect(decodeChannel('s', { kind: 'slack', enabled: true, secret: slackUrl }).secret).toBe(slackUrl);
    expect(() => decodeChannel('s', { kind: 'slack', enabled: true, secret: 'http://x.test/a' })).toThrow(/Slack 웹훅 URL/);
  });

  it('메일 — 주소 모양 · 개수 · 비밀 없음', () => {
    expect(decodeChannel('ops', { kind: 'mail', enabled: true, to: [' a@example.com', 'b@example.com'] }).settings.to)
      .toEqual(['a@example.com', 'b@example.com']);
    expect(() => decodeChannel('ops', { kind: 'mail', enabled: true, to: [] })).toThrow(/1~20/);
    expect(() => decodeChannel('ops', { kind: 'mail', enabled: true, to: ['nope'] })).toThrow(/주소 형식/);
    expect(() => decodeChannel('ops', { kind: 'mail', enabled: true, to: ['a@example.com'], secret })).toThrow(/비밀이 없다/);
  });

  it('이름 · 모르는 칸 · 종류 바꾸기 · 사건 종류', () => {
    expect(() => decodeChannel('Ops', { kind: 'mail', enabled: true, to: ['a@example.com'] })).toThrow(/소문자/);
    expect(() => decodeChannel('ops', { kind: 'mail', enabled: true, to: ['a@example.com'], extra: 1 })).toThrow(/모르는 칸/);
    expect(() => decodeChannel('hook', { kind: 'slack', enabled: true, secret: slackUrl }, row())).toThrow(/종류는 webhook/);
    expect(decodeChannel('ops', { kind: 'mail', enabled: true, to: ['a@example.com'], kinds: ['cert.expiring', 'apply.failed'] }).settings.kinds)
      .toEqual(['apply.failed', 'cert.expiring']);
    expect(() => decodeChannel('ops', { kind: 'mail', enabled: true, to: ['a@example.com'], kinds: ['nope'] })).toThrow(/모르는 사건/);
    expect(() => decodeChannel('ops', { kind: 'mail', enabled: true, to: ['a@example.com'], kinds: [] })).toThrow(/비지 않은/);
    expect(() => decodeChannel('ops', { kind: 'mail', enabled: true, to: ['a@example.com'], minSeverity: 'loud' })).toThrow(/minSeverity/);
  });

  it('공통 값 — 네 칸 · 범위', () => {
    expect(decodeKnobs({ repeatS: 60, certDays: 1, intervalS: 5, queue: 1 })).toEqual({ repeatS: 60, certDays: 1, intervalS: 5, queue: 1 });
    expect(() => decodeKnobs({ repeatS: 59, certDays: 1, intervalS: 5, queue: 1 })).toThrow(/repeatS/);
    expect(() => decodeKnobs({ repeatS: 60, certDays: 1, intervalS: 5 })).toThrow(/queue/);
    expect(() => decodeKnobs({ repeatS: 60, certDays: 1.5, intervalS: 5, queue: 1 })).toThrow(/certDays/);
  });

  it('응답 모양은 비밀 참조를 내지 않는다', () => {
    const v = viewOf(row());
    expect(v.secretSet).toBe(true);
    expect(JSON.stringify(v)).not.toContain('opaque://');
  });
});

describe('거르기 · 가리기', () => {
  it('받을 사건 · 최소 심각도', () => {
    const s = { minSeverity: 'warning' as const, kinds: ['apply.failed' as const] };
    expect(accepts(s, { kind: 'apply.failed', severity: 'critical' })).toBe(true);
    expect(accepts(s, { kind: 'apply.failed', severity: 'info' })).toBe(false);
    expect(accepts(s, { kind: 'cert.expiring', severity: 'critical' })).toBe(false);
    expect(accepts({ minSeverity: 'info' }, { kind: 'region.unreachable', severity: 'info' })).toBe(true);
  });

  it('사유 문장에서 비밀 · URL 경로를 가린다', () => {
    const said = `POST ${slackUrl} 가 404 — hook ${new URL(slackUrl).pathname} 없음 · ${secret}`;
    const out = scrub(said, [slackUrl, secret]);
    expect(out).not.toContain(slackUrl);
    expect(out).not.toContain(new URL(slackUrl).pathname);
    expect(out).not.toContain(secret);
    expect(scrub('x'.repeat(900), []).length).toBeLessThanOrEqual(501);
  });
});

describe('허브 — 거르기 · 기록 · 다시 짜기', () => {
  const EVENT = (over: Partial<NotifyEvent> = {}) => ({
    kind: 'apply.failed' as const, severity: 'critical' as const, key: `k-${Math.random()}`, title: 't', detail: 'd', ...over,
  });
  const chan = (name: string, ok: boolean, filter?: (e: NotifyEvent) => boolean): ChannelNotifier & { got: string[] } => {
    const got: string[] = [];
    return {
      kind: 'webhook', name, got,
      send: async (e) => { got.push(e.key); return ok ? { ok: true } : { ok: false, reason: 'auth', detail: 'nope' }; },
      ...(filter === undefined ? {} : { accepts: filter }),
    };
  };

  it('안 받는 통로에는 안 보내고, 결과마다 기록을 남긴다', async () => {
    const records: Delivery[] = [];
    const a = chan('a', true);
    const b = chan('b', false, (e) => e.severity === 'critical');
    const hub = new NotifyHub([a, b], { node: 'n1', repeatMs: 1, onDelivery: (d) => records.push(d) });
    hub.emit(EVENT({ key: 'one', severity: 'warning' }));
    hub.emit(EVENT({ key: 'two' }));
    await hub.drain();
    expect(a.got).toEqual(['one', 'two']);
    expect(b.got).toEqual(['two']);
    expect(records.map((r) => `${r.channel}:${r.event.key}:${r.outcome}`)).toEqual(['a:one:sent', 'a:two:sent', 'b:two:auth']);
  });

  it('다시 짜면 새 통로로 보낸다 — 이미 보낸 사건은 다시 안 보낸다', async () => {
    const a = chan('a', true);
    const c = chan('c', true);
    const hub = new NotifyHub([a], { node: 'n1', repeatMs: 60_000 });
    hub.emit(EVENT({ key: 'same' }));
    await hub.drain();
    hub.reconfigure([c], { repeatMs: 60_000, maxQueue: 10 });
    hub.emit(EVENT({ key: 'same' }));
    hub.emit(EVENT({ key: 'new' }));
    await hub.drain();
    expect(a.got).toEqual(['same']);
    expect(c.got).toEqual(['new']);
    expect(hub.channels).toEqual(['c']);
  });

  it('큐가 넘쳐 버린 것도 기록한다', async () => {
    const records: Delivery[] = [];
    let release = (): void => {};
    const gate = new Promise<void>((r) => { release = r; });
    const slow: ChannelNotifier = { kind: 'webhook', name: 'slow', send: async () => { await gate; return { ok: true }; } };
    const hub = new NotifyHub([slow], { node: 'n1', repeatMs: 1, maxQueue: 1, onDelivery: (d) => records.push(d) });
    for (const k of ['q1', 'q2', 'q3']) hub.emit(EVENT({ key: k }));
    release();
    await hub.drain();
    expect(records.filter((r) => r.outcome === 'dropped').map((r) => r.event.key)).toEqual(['q2']);
  });
});

describe('파일 시크릿 저장소의 opaque', () => {
  const root = mkdtempSync(join(tmpdir(), 'bary-opaque-'));
  afterAll(() => {
    try { execFileSync('chmod', ['-R', 'u+w', root]); } catch { /* 없으면 그만 */ }
    rmSync(root, { recursive: true, force: true });
  });

  it('넣고 읽고 지운다 · 파일은 0400 · 내용 주소', async () => {
    const s = new FsSecretStore(root);
    const a = await s.putOpaque('notify.hook', secret);
    expect(parseOpaqueRef(a.ref)).toEqual({ name: 'notify.hook', version: a.version });
    expect(await s.getOpaque(a.ref)).toBe(secret);
    expect((await s.putOpaque('notify.hook', secret)).ref).toBe(a.ref);
    const file = join(root, 'opaque', 'notify.hook', a.version, 'value');
    expect(statSync(file).mode & 0o777).toBe(0o400);
    expect(readFileSync(file, 'utf8')).toBe(secret);
    // 인증서 · 키 자리에 넣을 수 없다 — 스킴이 다르다.
    await expect(s.get(a.ref)).rejects.toThrow();
    await expect(s.getKey(a.ref)).rejects.toThrow();
    await s.removeOpaque(a.ref);
    expect(readdirSync(join(root, 'opaque', 'notify.hook'))).toEqual([]);
    await s.removeOpaque(a.ref);
  });

  it('청소 · listRefs 는 opaque 를 안 본다 · 그 이름의 인증서 시크릿은 막는다', async () => {
    const s = new FsSecretStore(root);
    const a = await s.putOpaque('notify.slack', slackUrl);
    expect(await s.listRefs()).not.toContain(a.ref);
    const out = sweepSecrets({ root, roots: [], keepPerName: 0, minAgeMs: 0 });
    expect(out.removed.some((r) => r.includes('opaque'))).toBe(false);
    expect(await s.getOpaque(a.ref)).toBe(slackUrl);
    await expect(s.put('opaque', { fullchain: '', privkey: '' })).rejects.toThrow(/예약/);
  });
});

describe('화면 · CLI 자리', () => {
  it('관리 › 알림 — 메뉴 · 제목 · 주소', () => {
    expect(NAV_GROUPS.find((g) => g.title === '관리')?.items.map((i) => i.place)).toContain('notify');
    expect(PAGE_META.notify.title).toBe('알림');
    expect(pageOf('/admin/notify')).toBe('notify');
  });

  it('bary get notify · notify/deliveries', () => {
    expect(getPath('notify')).toBe('/api/v1/notify');
    expect(getPath('notify/deliveries')).toBe('/api/v1/notify/deliveries');
  });

  it('전역 중계는 알림 경로를 넘기지 않는다 — 비밀이 전역을 지나지 않게(일부러 뺐다)', () => {
    expect([...RELAY_PATHS, ...RELAY_WRITES.map((w) => w.path)].filter((p) => p.startsWith('notify'))).toEqual([]);
  });

  it('전역 화면은 알림 메뉴를 숨기고, 화면은 비밀을 비워서 연다', () => {
    const gui = (p: string): string => readFileSync(join(import.meta.dirname, '../../gui/src', p), 'utf8');
    expect(gui('lib/shell/Sidebar.svelte')).toContain("i.place === 'notify'");
    expect(gui('lib/notify/ChannelDrawer.svelte')).toContain("let secret = $state('');");
    expect(gui('routes/admin/notify/+page.svelte')).toContain('notifyApi.view(token())');
  });
});

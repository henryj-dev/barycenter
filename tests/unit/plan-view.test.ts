/**
 * Plan·Impact 화면의 값 — 브라우저 없이 계약을 지킨다.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { TokenAuth, hashToken } from '../../src/api/auth.js';
import { createApi } from '../../src/api/server.js';
import type { ControlPlane } from '../../src/control/plane.js';
import type { LeaderElection } from '../../src/control/leader.js';
import type { ConfigStore } from '../../src/store/config-store.js';
import type { Db } from '../../src/store/pg.js';
import { pickPending, viewOfImpact } from '../../src/web/impact-view.js';
import { serveGui } from '../../src/web/serve-gui.js';
import { pullSse } from '../../src/web/sse-parse.js';

describe('SSE 해독', () => {
  it('스냅샷과 델타와 하트비트 주석을 가른다', () => {
    const { frames, rest } = pullSse(
      'event: snapshot\ndata: {"head":"7"}\n\n'
      + 'id: 1\nevent: revision\ndata: {"revision":"8"}\n\n'
      + ': hb\n\n'
      + 'event: apply\ndata: {"phase":"activated"}\n',
    );
    expect(rest).toBe('event: apply\ndata: {"phase":"activated"}\n');
    expect(frames).toEqual([
      { kind: 'event', event: 'snapshot', data: { head: '7' } },
      { kind: 'event', event: 'revision', data: { revision: '8' }, id: '1' },
      { kind: 'comment', text: 'hb' },
    ]);
  });
});

describe('영향 요약', () => {
  it('reload 가 필요한 적용을 영향으로 말한다 — diff 가 아니다', () => {
    const view = viewOfImpact(
      { planId: 'p1', revision: '4' },
      {
        requiresReload: true,
        affectedListeners: [{ key: 'front', protocol: 'http', bind: '0.0.0.0', port: 999 }],
        socketChanges: { added: ['tcp://0.0.0.0:999'], removed: [] },
        planes: ['http'],
      },
    );
    expect(view.headline).toMatch(/reload/);
    expect(view.listeners).toEqual(['front  http  0.0.0.0:999']);
    expect(view.socketsAdded).toEqual(['tcp://0.0.0.0:999']);
  });

  it('세션 영향과 인증서 교체를 문장으로 접는다', () => {
    const view = viewOfImpact(
      { planId: 'p1', revision: '9' },
      {
        requiresReload: true,
        topologyEpochChange: true,
        affectedListeners: [
          { key: 'secure', protocol: 'https', bind: '0.0.0.0', port: 443, change: 'changed' },
        ],
        sessionImpact: [
          { protocol: 'https', effect: 'may_reset', why: '소켓이 사라진다 (secure)' },
          { protocol: 'tcp', effect: 'none', why: '이 프로토콜의 리스너는 안 바뀐다' },
        ],
        certificateChanges: [
          { key: 'site', change: 'replaced', notAfter: '2026-06-01T00:00:00.000Z' },
          { key: 'old', change: 'removed' },
        ],
        socketChanges: { added: [], removed: ['tcp://0.0.0.0:443'] },
        routeOrderChanges: {
          moved: [{ listener: 'secure', key: 'r1', from: 1, to: 0 }],
          warnings: [{
            kind: 'priority_inversion', listener: 'secure', routes: ['a', 'b'],
            message: '매치 클래스가 priority 를 이긴다',
          }],
        },
        capabilityWarnings: [{ kind: 'no_http2', message: 'h2 를 못 낸다' }],
        planes: ['http'],
      },
    );
    // **끊기는 것을 먼저 말한다.** 화면이 접는 순서가 곧 읽는 순서다.
    expect(view.sessions[0]).toMatch(/https/);
    expect(view.sessions[0]).toMatch(/끊길/);
    // 영향 없는 프로토콜은 접어서 안 보여 준다 — 안 읽게 만드는 줄을 늘리지 않는다.
    expect(view.sessions.some((s) => s.includes('tcp'))).toBe(false);
    expect(view.certificates).toEqual(['site 교체 — 2026-06-01 만료', 'old 삭제']);
    expect(view.routeWarnings).toEqual(['매치 클래스가 priority 를 이긴다']);
    expect(view.capabilityWarnings).toEqual(['h2 를 못 낸다']);
  });

  it('옛 plan 에 없는 항목은 없는 대로 그린다', () => {
    // 이 회차 전에 만들어진 plan 은 JSONB 에 새 필드가 없다. 화면이 거기서
    // 깨지면 **옛 plan 을 적용하려던 사람이 화면을 못 연다.**
    const view = viewOfImpact(
      { planId: 'p0', revision: '1' },
      {
        requiresReload: false,
        affectedListeners: [],
        socketChanges: { added: [], removed: [] },
        planes: [],
      },
    );
    expect(view.sessions).toEqual([]);
    expect(view.certificates).toEqual([]);
    expect(view.routeWarnings).toEqual([]);
    expect(view.capabilityWarnings).toEqual([]);
  });

  it('lua 없는 엔진에서는 산출물이 같아도 세대가 선다고 말한다', () => {
    const view = viewOfImpact(
      { planId: 'p2', revision: '3' },
      {
        requiresReload: false,
        topologyEpochChange: true,
        affectedListeners: [],
        socketChanges: { added: [], removed: [] },
        planes: ['http'],
      },
    );
    // 전에는 무조건 "세대 전환 없이 반영된다" 였다. 멤버십 평면이 없는 배포에서
    // 그건 거짓이다 — 같은 변경이 거기서는 세대와 epoch 를 새로 만든다.
    expect(view.headline).not.toMatch(/세대 전환 없이/);
  });

  it('대기 열이 없으면 고를 것이 없다', () => {
    expect(pickPending([])).toBeUndefined();
    expect(pickPending([{ planId: 'a', revision: '1' }, { planId: 'b', revision: '2' }]))
      .toEqual({ planId: 'a', revision: '1' });
  });
});

describe('GUI 정적 파일', () => {
  it('루트 밖으로 나가지 않는다', () => {
    const root = mkdtempSync(join(tmpdir(), 'bary-gui-'));
    const outside = join(root, '..', `bary-gui-secret-${process.pid}.txt`);
    try {
      writeFileSync(join(root, 'index.html'), '<p>ok</p>');
      writeFileSync(outside, 'SECRET');
      const res = { writeHead: () => { throw new Error('루트 밖으로 나갔다'); } };
      expect(serveGui(res as never, `../${basename(outside)}`, root)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  });
});

describe('같은 출처에서 GUI', () => {
  let close: (() => Promise<void>) | undefined;
  let root: string | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
    if (root !== undefined) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  const listen = async (guiRoot?: string): Promise<string> => {
    const auth = new TokenAuth([
      { name: 'reader', hash: hashToken('gui-token'), scopes: ['read'] },
    ]);
    const election = { state: { isLeader: true, token: '1', holder: 't', since: '', reason: undefined } };
    const control = { status: async () => ({ head: '7' }) };
    const server: Server = createApi({
      db: {} as Db,
      store: {} as ConfigStore,
      control: control as unknown as ControlPlane,
      auth,
      election: election as unknown as LeaderElection,
      ...(guiRoot === undefined ? {} : { guiRoot }),
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const { port } = server.address() as AddressInfo;
    close = () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    });
    return `http://127.0.0.1:${port}`;
  };

  it('같은 출처에서 GUI 를 낸다 — CORS 를 열지 않는다', async () => {
    root = mkdtempSync(join(tmpdir(), 'bary-gui-'));
    writeFileSync(join(root, 'index.html'), '<title>이 적용이 하는 일</title>');
    mkdirSync(join(root, 'listeners'));
    writeFileSync(join(root, 'listeners', 'index.html'), '<title>열려 있는 포트</title>');
    const url = await listen(root);
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('이 적용이 하는 일');
    const kit = await fetch(`${url}/listeners`);
    expect(kit.status).toBe(200);
    expect(await kit.text()).toContain('열려 있는 포트');
    const missing = await fetch(`${url}/plan`);
    expect(missing.status).not.toBe(200);
  });

  it('API 는 토큰 없이 안 열린다 — 페이지와 계약을 섞지 않는다', async () => {
    root = mkdtempSync(join(tmpdir(), 'bary-gui-'));
    writeFileSync(join(root, 'index.html'), '<p>ok</p>');
    const url = await listen(root);
    const naked = await fetch(`${url}/api/v1/status`);
    expect(naked.status).toBe(401);
    const withTok = await fetch(`${url}/api/v1/status`, {
      headers: { authorization: 'Bearer gui-token' },
    });
    expect(withTok.status).toBe(200);
  });

  it('guiRoot 가 없으면 예전처럼 페이지도 토큰을 묻는다', async () => {
    const url = await listen();
    const page = await fetch(`${url}/`);
    expect(page.status).toBe(401);
  });
});

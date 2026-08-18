/**
 * GET /api/v1/events — 스냅샷 + 델타 + 하트비트. GUI 는 폴링하지 않는다.
 */
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { TokenAuth, hashToken } from '../../src/api/auth.js';
import { EventHub, writeHeartbeat, writeSse } from '../../src/api/events.js';
import { createApi } from '../../src/api/server.js';
import type { ControlPlane } from '../../src/control/plane.js';
import type { LeaderElection } from '../../src/control/leader.js';
import type { ConfigStore } from '../../src/store/config-store.js';
import type { Db } from '../../src/store/pg.js';

const TOKEN = 'sse-token';

const listen = async (hub: EventHub, heartbeatMs = 40): Promise<{ url: string; close: () => Promise<void> }> => {
  const auth = new TokenAuth([
    { name: 'reader', hash: hashToken(TOKEN), scopes: ['read'] },
  ]);
  const election = { state: { isLeader: true, token: '1', holder: 't', since: '', reason: undefined } };
  const control = { status: async () => ({ head: '7', engine: { probed: false } }) };
  const server: Server = createApi({
    db: {} as Db,
    store: {} as ConfigStore,
    control: control as unknown as ControlPlane,
    auth,
    election: election as unknown as LeaderElection,
    events: hub,
    heartbeatMs,
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => {
      server.closeAllConnections?.();
      server.close(() => r());
    }),
  };
};

const readUntil = async (
  reader: ReadableStreamDefaultReader<Uint8Array>,
  acc: { text: string },
  pred: (s: string) => boolean,
  ms = 1500,
): Promise<string> => {
  const dec = new TextDecoder();
  const timer = setTimeout(() => {
    void reader.cancel();
  }, ms);
  try {
    while (!pred(acc.text)) {
      const chunk = await reader.read();
      if (chunk.done) break;
      acc.text += dec.decode(chunk.value, { stream: true });
    }
    return acc.text;
  } finally {
    clearTimeout(timer);
  }
};

describe('SSE 프레임', () => {
  it('event/data/id 를 쓰고 하트비트는 주석이다', () => {
    const chunks: string[] = [];
    const res = { write: (s: string) => {
      chunks.push(s);
      return true;
    } };
    writeSse(res as never, { event: 'revision', data: { revision: '3' }, id: '1' });
    expect(chunks.join('')).toBe('id: 1\nevent: revision\ndata: {"revision":"3"}\n\n');
    chunks.length = 0;
    writeHeartbeat(res as never);
    expect(chunks.join('')).toBe(': hb\n\n');
  });
});

describe('EventHub', () => {
  it('구독자에게 번호를 매겨 보낸다. 끊으면 안 보낸다', () => {
    const hub = new EventHub();
    const got: string[] = [];
    const drop = hub.subscribe((e) => got.push(e.id ?? ''));
    hub.publish('revision', { revision: '1' });
    drop();
    hub.publish('revision', { revision: '2' });
    expect(got).toEqual(['1']);
    expect(hub.size).toBe(0);
  });
});

describe('GET /api/v1/events', () => {
  let close: (() => Promise<void>) | undefined;
  let ac: AbortController | undefined;

  afterEach(async () => {
    ac?.abort();
    ac = undefined;
    await close?.();
    close = undefined;
  });

  it('토큰 없이 401', async () => {
    const hub = new EventHub();
    const srv = await listen(hub);
    close = srv.close;
    const r = await fetch(`${srv.url}/api/v1/events`);
    expect(r.status).toBe(401);
  });

  it('열리면 스냅샷을 주고, publish 가 델타가 되며, 하트비트는 주석이다', async () => {
    const hub = new EventHub();
    const srv = await listen(hub, 30);
    close = srv.close;
    ac = new AbortController();
    const r = await fetch(`${srv.url}/api/v1/events`, {
      headers: { authorization: `Bearer ${TOKEN}` },
      signal: ac.signal,
    });
    expect(r.status).toBe(200);
    expect(r.headers.get('content-type')).toContain('text/event-stream');

    const reader = r.body?.getReader();
    if (reader === undefined) throw new Error('body 가 없다');
    const acc = { text: '' };
    const first = await readUntil(reader, acc, (s) => s.includes('"head":"7"') && s.includes('\n\n'));
    expect(first).toContain('event: snapshot');
    expect(first).toContain('"head":"7"');

    hub.publish('revision', { revision: '8' });
    const next = await readUntil(reader, acc, (s) => s.includes('event: revision') && s.includes('"8"'));
    expect(next).toContain('event: revision');

    const beat = await readUntil(reader, acc, (s) => s.includes(': hb'));
    expect(beat).toContain(': hb');

    ac.abort();
  });
});

/**
 * 열린 SSE 도 철회를 따른다 — 하트비트마다 `alive` 를 묻고 거짓·실패면 닫는다 (공통 회원정책 1차).
 */
import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';

import { EventHub, openEventStream } from '../../src/api/events.js';

function fakeRes(): ServerResponse & { chunks: string[]; ended: boolean } {
  const r = Object.assign(new EventEmitter(), {
    chunks: [] as string[], ended: false, destroyed: false, writableEnded: false, writableLength: 0,
    writeHead() { return r; },
    write(c: string) { r.chunks.push(c); return true; },
    end() { r.ended = true; r.writableEnded = true; return r; },
    destroy() { r.destroyed = true; return r; },
  });
  return r as unknown as ServerResponse & { chunks: string[]; ended: boolean };
}

describe('openEventStream alive', () => {
  for (const [name, alive] of [
    ['거짓이면', async () => false],
    ['못 물으면(던지면)', async () => { throw new Error('account pg down'); }],
  ] as const) {
    it(`${name} 다음 하트비트에 닫는다`, async () => {
      const res = fakeRes();
      const req = new EventEmitter();
      const done = openEventStream({ req, res, hub: new EventHub(), snapshot: async () => ({}), heartbeatMs: 10, alive });
      await done;
      expect(res.ended).toBe(true);
      expect(res.chunks.join('')).toContain('event: snapshot');
      expect(res.chunks.join('')).not.toContain(': hb');
    });
  }

  it('참이면 하트비트를 보낸다', async () => {
    const res = fakeRes();
    const req = new EventEmitter();
    void openEventStream({ req, res, hub: new EventHub(), snapshot: async () => ({}), heartbeatMs: 10, alive: async () => true });
    await new Promise((r) => setTimeout(r, 40));
    req.emit('close');
    expect(res.chunks.join('')).toContain(': hb');
  });
});

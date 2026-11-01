/**
 * 믿을 프록시 뒤의 보낸 사람 주소 (2026-11-01, web-01). GUI 를 barycenter 의 nginx 로 내면 모든 사람이 프록시
 * 주소 하나로 보였다. 한 사람이 틀린 토큰을 다섯 번 보내면 모든 사람이 429 였다.
 */
import type { IncomingMessage, Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';

import { TokenAuth, hashToken } from '../../src/api/auth.js';
import { createApi } from '../../src/api/server.js';
import { clientAddress, parseTrustedProxies, type TrustedProxies } from '../../src/api/client-address.js';
import type { ConfigStore } from '../../src/store/config-store.js';
import type { ControlPlane } from '../../src/control/plane.js';
import type { Db } from '../../src/store/pg.js';
import type { LeaderElection } from '../../src/control/leader.js';

function req(peer: string | undefined, xff?: string | string[]): IncomingMessage {
  return {
    socket: { remoteAddress: peer },
    headers: xff === undefined ? {} : { 'x-forwarded-for': xff },
  } as unknown as IncomingMessage;
}

const PROXY = parseTrustedProxies('10.253.65.250, 127.0.0.0/8 fd00::/8') as TrustedProxies;

describe('parseTrustedProxies', () => {
  it('빈 값은 끈다', () => {
    expect(parseTrustedProxies('')).toBeUndefined();
    expect(parseTrustedProxies(' , ')).toBeUndefined();
  });

  it('틀린 항목은 기동을 실패시킨다', () => {
    expect(() => parseTrustedProxies('10.0.0.1, proxy.local')).toThrow(/proxy\.local/);
    expect(() => parseTrustedProxies('10.0.0.0/33')).toThrow(/10\.0\.0\.0\/33/);
  });
});

describe('clientAddress', () => {
  it('목록이 없으면 헤더를 보지 않는다', () => {
    expect(clientAddress(req('10.253.65.250', '203.0.113.7'), undefined)).toBe('10.253.65.250');
  });

  it('접속 주소가 목록 밖이면 헤더를 보지 않는다 — 클라이언트가 남의 주소를 적을 수 없다', () => {
    expect(clientAddress(req('198.51.100.9', '203.0.113.7'), PROXY)).toBe('198.51.100.9');
  });

  it('믿을 프록시에서 오면 헤더의 맨 오른쪽 주소가 보낸 사람이다', () => {
    expect(clientAddress(req('10.253.65.250', '203.0.113.7'), PROXY)).toBe('203.0.113.7');
  });

  it('클라이언트가 적은 왼쪽 값은 쓰지 않는다', () => {
    expect(clientAddress(req('10.253.65.250', '1.1.1.1, 203.0.113.7'), PROXY)).toBe('203.0.113.7');
  });

  it('믿을 프록시를 여럿 지나면 그것들을 건너뛴다', () => {
    expect(clientAddress(req('127.0.0.1', '1.1.1.1, 203.0.113.7, 10.253.65.250'), PROXY)).toBe('203.0.113.7');
    expect(clientAddress(req('127.0.0.1', ['1.1.1.1, 203.0.113.7', '10.253.65.250']), PROXY)).toBe('203.0.113.7');
  });

  it('주소가 아닌 값에서 멈추고 마지막으로 믿은 홉을 쓴다', () => {
    expect(clientAddress(req('127.0.0.1', '203.0.113.7, unknown, 10.253.65.250'), PROXY)).toBe('10.253.65.250');
  });

  it('헤더가 없으면 프록시 주소를 쓴다', () => {
    expect(clientAddress(req('10.253.65.250'), PROXY)).toBe('10.253.65.250');
  });

  it('IPv4 를 담은 IPv6 와 존 ID 를 맞춘다', () => {
    expect(clientAddress(req('::ffff:10.253.65.250', '203.0.113.7'), PROXY)).toBe('203.0.113.7');
    expect(clientAddress(req('::ffff:198.51.100.9'), undefined)).toBe('198.51.100.9');
    expect(clientAddress(req('fd00::1%eth0', '2001:db8::7'), PROXY)).toBe('2001:db8::7');
  });

  it('접속 주소를 모르면 undefined', () => {
    expect(clientAddress(req(undefined, '203.0.113.7'), PROXY)).toBeUndefined();
  });
});

describe('API 의 인증 실패 제한', () => {
  let server: Server | undefined;
  afterEach(async () => {
    server?.closeAllConnections?.();
    if (server !== undefined) await new Promise<void>((resolve) => server!.close(() => resolve()));
    server = undefined;
  });

  async function listen(trustedProxies?: TrustedProxies): Promise<string> {
    server = createApi({
      db: {} as Db,
      store: { head: async () => ({ revision: '1', etag: 'e1' }) } as unknown as ConfigStore,
      control: {} as ControlPlane,
      auth: new TokenAuth([{ name: 'reader', hash: hashToken('known-token'), scopes: ['read'] }]),
      election: { state: { isLeader: true, token: '1', holder: 'test', since: '' } } as LeaderElection,
      ...(trustedProxies === undefined ? {} : { trustedProxies }),
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  }

  const wrongFrom = (ip: string) => ({ authorization: 'Bearer wrong-token', 'x-forwarded-for': ip });

  it('프록시 뒤에서 한 사람이 잠겨도 다른 사람은 잠기지 않는다', async () => {
    const url = await listen(PROXY);
    const a: number[] = [];
    for (let i = 0; i < 5; i += 1) a.push((await fetch(`${url}/api/v1/config/head`, { headers: wrongFrom('203.0.113.7') })).status);
    expect(a).toEqual([401, 401, 401, 401, 429]);
    expect((await fetch(`${url}/api/v1/config/head`, { headers: wrongFrom('203.0.113.8') })).status).toBe(401);
  });

  it('목록이 없으면 지금처럼 접속 주소 하나로 센다', async () => {
    const url = await listen();
    for (let i = 0; i < 5; i += 1) await fetch(`${url}/api/v1/config/head`, { headers: wrongFrom('203.0.113.7') });
    expect((await fetch(`${url}/api/v1/config/head`, { headers: wrongFrom('203.0.113.8') })).status).toBe(429);
  });
});

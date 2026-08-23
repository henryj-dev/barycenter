/**
 * 원격 `DataplaneDriver` — CP ↔ DP Agent 를 mTLS 로 잇는다 (§3.1 · §11.1)
 *
 * §11.1 이 오래 이렇게 적어 두었다:
 *
 * > CP ↔ DP Agent 의 **원격 전송(mTLS gRPC)은 아직 없다.** 계약(`DataplaneDriver`)은
 * > 서 있고 구현체가 로컬 하나뿐이다.
 *
 * ── 실측과 충돌하지 않는다
 *
 * 같은 절이 *"에이전트와 nginx 는 같은 파일시스템을 봐야 한다"* 고 실측했다. 그 제약은
 * **에이전트↔nginx** 의 것이지 CP↔에이전트의 것이 아니다 — 가르는 것은 뒤쪽이고,
 * 에이전트는 여전히 nginx 옆에 산다.
 *
 * ── 이 파일이 지키는 것
 *
 * **두 실패를 절대 안 섞는다.** 이 저장소가 반복해서 배운 것이 "관측하지 못한 것과
 * 관측해서 아니라고 한 것은 다르다" 이고(`observeRead` 의 `blind`), 원격에서는 그 구분이
 * 두 방향으로 산다:
 *
 *   `DpRejection`          에이전트가 **판정했다.** CP 는 전환을 닫는다
 *   `RemoteDpUnreachable`  **못 물었다.** 세계에 대해 아무 주장도 하지 않는다
 *
 * 섞으면 망 장애가 곧 전환 포기가 되거나, 낡은 리더가 거절을 일시적 장애로 읽고
 * 재시도한다. 아래 검사 넷이 그 경계를 지킨다.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { request as httpsRequest, type Server } from 'node:https';

import { createDpAgentServer } from '../../src/dp/agent-server.js';
import { RemoteDataplaneDriver, RemoteDpUnreachable } from '../../src/dp/remote.js';
import { DpRejection } from '../../src/dp/agent.js';
import type { DataplaneDriver } from '../../src/dp/driver.js';

let dir = '';
let server: Server;
let driver: RemoteDataplaneDriver;
let base = '';

/** 드라이버가 무엇을 받았는지. 직렬화가 인자를 안 잃는지 본다. */
const seen: { method: string; args: unknown[] }[] = [];
/** 다음 호출에서 던질 것. 실패 경로를 갈아 끼운다. */
let willThrow: unknown;

const fake: DataplaneDriver = {
  fence(leaderToken) {
    seen.push({ method: 'fence', args: [leaderToken] });
    if (willThrow !== undefined) { const e = willThrow; willThrow = undefined; throw e; }
    return Promise.resolve({ maxToken: `max-${leaderToken}` });
  },
  applyConfig(op) {
    seen.push({ method: 'applyConfig', args: [op] });
    if (willThrow !== undefined) { const e = willThrow; willThrow = undefined; throw e; }
    return Promise.resolve({
      phase: 'activated', progress: { http: undefined, stream: undefined },
      partialTransition: false,
    });
  },
  recoverConfig: () => Promise.resolve({
    phase: 'no_operation', progress: { http: undefined, stream: undefined },
    partialTransition: false,
  }),
  abortConfig(op) {
    seen.push({ method: 'abortConfig', args: [op] });
    return Promise.resolve();
  },
  applyMembership(op, plane, slots) {
    seen.push({ method: 'applyMembership', args: [op, plane, slots] });
    return Promise.resolve({
      plane, transitionId: 't', cached: false,
      activationEpoch: '1', membershipRevision: '2', payloadDigest: 'sha256:x',
    } as never);
  },
  pushMembershipDirect(plane, epoch, slots) {
    seen.push({ method: 'pushMembershipDirect', args: [plane, epoch, slots] });
    return Promise.resolve();
  },
  reconcileConfig: () => Promise.resolve({ kind: 'converged' } as never),
  status: () => Promise.resolve({
    maxLeaderToken: '7',
    planes: {
      http: { activationEpoch: '3', membershipRevision: '1', payloadDigest: 'h' },
      stream: { activationEpoch: '3', membershipRevision: '1', payloadDigest: 's' },
    },
    published: { kind: 'none' },
    lastEvidence: undefined,
    unfinished: undefined,
  } as never),
};

/** 자체서명 CA 하나로 서버·클라이언트 인증서를 낸다. */
function makeCerts(root: string): void {
  const run = (args: string[]): void => { execFileSync('openssl', args, { stdio: 'ignore' }); };
  const cnf = join(root, 'openssl.cnf');
  // `subjectAltName` 이 없으면 Node 가 hostname 검증에서 막는다.
  execFileSync('sh', ['-c',
    `printf '%s\\n' '[req]' 'distinguished_name=dn' '[dn]' '[ext]' \
     'subjectAltName=DNS:localhost,IP:127.0.0.1' 'basicConstraints=CA:FALSE' > ${cnf}`]);
  run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '2',
    '-subj', '/CN=bary-test-ca', '-keyout', join(root, 'ca.key'), '-out', join(root, 'ca.pem')]);
  for (const [name, cn] of [['server', 'localhost'], ['client', 'cp-1']] as const) {
    run(['req', '-newkey', 'rsa:2048', '-nodes', '-subj', `/CN=${cn}`,
      '-keyout', join(root, `${name}.key`), '-out', join(root, `${name}.csr`), '-config', cnf]);
    run(['x509', '-req', '-in', join(root, `${name}.csr`), '-days', '2',
      '-CA', join(root, 'ca.pem'), '-CAkey', join(root, 'ca.key'), '-CAcreateserial',
      '-out', join(root, `${name}.pem`), '-extfile', cnf, '-extensions', 'ext']);
  }
}

function opensslAvailable(): boolean {
  try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

beforeAll(async () => {
  if (!opensslAvailable()) throw new Error('openssl 이 없다 — 이 스위트는 실물 mTLS 를 태운다');
  dir = mkdtempSync(join(tmpdir(), 'bary-remote-'));
  makeCerts(dir);
  server = createDpAgentServer({
    driver: fake,
    cert: readFileSync(join(dir, 'server.pem')),
    key: readFileSync(join(dir, 'server.key')),
    ca: readFileSync(join(dir, 'ca.pem')),
    allowedClientNames: ['cp-1'],
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `https://localhost:${(server.address() as AddressInfo).port}`;
  driver = new RemoteDataplaneDriver({
    baseUrl: base,
    clientCertFile: join(dir, 'client.pem'),
    clientKeyFile: join(dir, 'client.key'),
    caFile: join(dir, 'ca.pem'),
    timeoutMs: 5_000,
  });
}, 120_000);

afterAll(async () => {
  driver?.close();
  await new Promise<void>((r) => server?.close(() => r()));
  if (dir !== '') rmSync(dir, { recursive: true, force: true });
});

/** 원시 mTLS 요청. 드라이버가 안 만드는 요청을 서버에 직접 던진다. */
function raw(path: string, method = 'POST'): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = httpsRequest(`${base}${path}`, {
      method,
      ca: readFileSync(join(dir, 'ca.pem')),
      cert: readFileSync(join(dir, 'client.pem')),
      key: readFileSync(join(dir, 'client.key')),
      timeout: 5_000,
    }, (r) => { r.resume(); resolve(r.statusCode ?? 0); });
    req.on('error', reject);
    req.end('{}');
  });
}

const OP = {
  leaderToken: '10', operationId: 'o1', transitionId: 't1',
  affectedPlanes: ['http'], targetGeneration: 'g1', generationDigest: 'sha256:g1',
  planes: {
    http: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: 'sha256:h',
    },
  },
} as never;

describe('원격 드라이버 — 여덟 메서드가 왕복한다', () => {
  it('fence', async () => {
    expect(await driver.fence('42')).toEqual({ maxToken: 'max-42' });
  });

  it('applyConfig — 봉투가 온전히 건너간다', async () => {
    seen.length = 0;
    const r = await driver.applyConfig(OP);
    expect(r.phase).toBe('activated');
    // **직렬화가 인자를 안 잃는지**가 이 검사의 요점이다. 좌표가 하나라도 빠지면
    // 에이전트의 펜싱 판정이 다른 튜플을 보게 된다.
    expect(seen[0]?.args[0]).toEqual(JSON.parse(JSON.stringify(OP)));
  });

  it('status — 좌표가 그대로 온다', async () => {
    const s = await driver.status();
    expect(s.maxLeaderToken).toBe('7');
    expect(s.planes.http.activationEpoch).toBe('3');
  });

  it('applyMembership — 슬롯이 온전히 건너간다', async () => {
    seen.length = 0;
    const slots = { pool_a: ['10.0.0.1:80', '10.0.0.2:80'] };
    const ack = await driver.applyMembership(OP, 'http', slots);
    expect(ack.plane).toBe('http');
    expect(seen[0]?.args[2]).toEqual(slots);
  });

  it('pushMembershipDirect — void 도 왕복한다', async () => {
    seen.length = 0;
    await driver.pushMembershipDirect('stream', '9', { pool_b: ['10.0.0.3:443'] });
    expect(seen[0]?.args).toEqual(['stream', '9', { pool_b: ['10.0.0.3:443'] }]);
  });

  it('reconcileConfig · recoverConfig', async () => {
    expect((await driver.reconcileConfig()).kind).toBe('converged');
    expect((await driver.recoverConfig()).phase).toBe('no_operation');
  });

  it('abortConfig', async () => {
    seen.length = 0;
    await driver.abortConfig(OP);
    expect(seen[0]?.method).toBe('abortConfig');
  });
});

describe('두 실패를 안 섞는다', () => {
  /**
   * **거절은 거절로 온다.** `kind` 와 `terminalState` 가 살아야 CP 가 전환을 닫는다 —
   * 문자열로 뭉개지면 "왜 거절당했는지" 가 사라지고, 그러면 낡은 리더와 이미 끝난
   * 전환을 구분할 수 없다.
   */
  it('DpRejection 이 kind 와 terminalState 를 갖고 건너온다', async () => {
    willThrow = new DpRejection('terminal', '이미 끝났다', 'activated');
    await expect(driver.fence('1')).rejects.toMatchObject({
      name: 'DpRejection', kind: 'terminal', terminalState: 'activated',
    });
  });

  it('stale_leader 도 그대로 온다', async () => {
    willThrow = new DpRejection('stale_leader', '낡았다');
    const e = await driver.fence('1').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DpRejection);
    expect((e as DpRejection).kind).toBe('stale_leader');
  });

  /**
   * **코드 결함은 거절이 아니다.** 여기서 아무 예외나 409 로 접으면 버그가 곧
   * "너는 낡았다" 로 둔갑하고, CP 가 멀쩡한 전환을 닫는다.
   */
  it('에이전트 쪽 일반 예외는 **거절이 아니라** 못 물었다로 온다', async () => {
    willThrow = new Error('널 포인터 같은 것');
    const e = await driver.fence('1').catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RemoteDpUnreachable);
    expect(e).not.toBeInstanceOf(DpRejection);
  });

  it('에이전트가 없으면 못 물었다 — 거절이 아니다', async () => {
    const dead = new RemoteDataplaneDriver({
      baseUrl: 'https://127.0.0.1:1',
      clientCertFile: join(dir, 'client.pem'),
      clientKeyFile: join(dir, 'client.key'),
      caFile: join(dir, 'ca.pem'),
      timeoutMs: 2_000,
    });
    try {
      const e = await dead.status().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RemoteDpUnreachable);
    } finally {
      dead.close();
    }
  }, 30_000);
});

describe('인증', () => {
  it('평문 URL 은 생성자가 막는다', () => {
    expect(() => new RemoteDataplaneDriver({
      baseUrl: 'http://dp-1:8443',
      clientCertFile: join(dir, 'client.pem'),
      clientKeyFile: join(dir, 'client.key'),
      caFile: join(dir, 'ca.pem'),
    })).toThrow(/https/);
  });

  /** **CN 목록이 비면 안 뜬다.** `undefined` 를 "아무나" 로 읽는 길을 안 만든다. */
  it('허용 CN 이 비면 창구를 안 연다', () => {
    expect(() => createDpAgentServer({
      driver: fake,
      cert: readFileSync(join(dir, 'server.pem')),
      key: readFileSync(join(dir, 'server.key')),
      ca: readFileSync(join(dir, 'ca.pem')),
      allowedClientNames: [],
    })).toThrow(/비어 있다/);
  });

  /**
   * 인증서는 맞는데 **CN 이 목록에 없다.** CA 를 나눠 쓰는 배포에서 "이 CA 의 아무
   * 인증서" 는 너무 넓다 — mTLS 신원 매핑에서 내린 것과 같은 판단이다.
   */
  it('모르는 CN 은 403 이다', async () => {
    const strict = createDpAgentServer({
      driver: fake,
      cert: readFileSync(join(dir, 'server.pem')),
      key: readFileSync(join(dir, 'server.key')),
      ca: readFileSync(join(dir, 'ca.pem')),
      allowedClientNames: ['someone-else'],
    });
    await new Promise<void>((r) => strict.listen(0, '127.0.0.1', r));
    const d = new RemoteDataplaneDriver({
      baseUrl: `https://localhost:${(strict.address() as AddressInfo).port}`,
      clientCertFile: join(dir, 'client.pem'),
      clientKeyFile: join(dir, 'client.key'),
      caFile: join(dir, 'ca.pem'),
      timeoutMs: 5_000,
    });
    try {
      const e = await d.status().catch((x: unknown) => x);
      expect(e).toBeInstanceOf(RemoteDpUnreachable);
      expect((e as RemoteDpUnreachable).status, '403 이 아니다').toBe(403);
    } finally {
      d.close();
      await new Promise<void>((r) => strict.close(() => r()));
    }
  }, 30_000);

  /**
   * **이름으로 아무 함수나 못 부른다.** 클라이언트는 화이트리스트 밖 이름을 안 만들지만,
   * 서버가 혼자 서야 한다 — 창구는 망에 열려 있고 클라이언트는 우리 것만 오지 않는다.
   * 그래서 원시 요청으로 직접 찔러 본다.
   */
  it('모르는 메서드 이름은 404 다', async () => {
    expect(await raw('/dp/close')).toBe(404);
    expect(await raw('/dp/constructor')).toBe(404);
    expect(await raw('/etc/passwd')).toBe(404);
  }, 30_000);

  it('GET 은 안 받는다 — 부작용 창구다', async () => {
    expect(await raw('/dp/status', 'GET')).toBe(405);
  }, 30_000);
});

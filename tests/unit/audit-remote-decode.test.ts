/**
 * 원격 창구에 해독기 — 검수 2026-08-24 N2
 *
 * ── 이 저장소의 규칙은 "타입은 런타임 입력을 막지 못한다" 다
 *
 * `decodeModel` 이 그 규칙을 실행한다. REST 로 들어오는 모델은 한 글자도 안 믿고
 * 해독을 지난다. **그런데 mTLS 뒤의 창구는 그 규칙 밖에 있다:**
 *
 *   driver.applyConfig(a['op'] as never)
 *
 * `as never` 는 타입 검사기에게 "그만 봐" 라고 말한 것이지 값이 그 모양이라는 증거가
 * 아니다. 인증서가 맞는 CP 라도 **버그가 있거나 낡은 CP** 일 수 있고, 그때 이 창구는
 * 아무 모양이나 상태기계 한복판에 넣는다.
 *
 * ── 무엇까지 갈 수 있나
 *
 * `targetGeneration` 은 `EffectsBoot` 에서 이렇게 쓰인다:
 *
 *   run('/bin/sh', ['-c', BARY_CONFIGTEST_CMD.replace(/\{generation\}/g, generation)])
 *
 * 지금은 `verifyGeneration` 이 앞에 서서 fail-closed 다 — 그러나 그 검사의 일은
 * **manifest 무결성**이지 셸 안전이 아니다. 방어가 「검사 순서」 하나에 매달려 있고,
 * 그 순서를 바꿀 이유는 언제든 생긴다. 이 저장소의 표현으로 *"경계에 해독기가 없다"* 다.
 *
 * ── 그리고 거절은 409 여야 한다
 *
 * 이 창구의 계약은 셋뿐이다: 200 · 409(판정) · 그 외(못 물었다). 못 읽는 봉투를
 * 500 으로 내면 CP 는 `RemoteDpUnreachable` 로 읽고 **영원히 재시도한다** — 고칠 수
 * 없는 것을 망 장애로 오해하는 것이다. 반대로 아무 예외나 409 로 접으면 코드 결함이
 * "너는 낡았다" 로 둔갑한다. 해독 실패는 **판정**이므로 409 다.
 *
 * ── 응답도 같은 대접이다
 *
 * `remote.ts` 는 200 본문을 `parsed as T` 로 넘긴다. DP 가 모르는 `phase` 를 답하면
 * 그것이 그대로 CP 의 상태기계에 들어간다.
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

/** 드라이버가 실제로 받은 인자. **여기까지 왔으면 해독기가 안 막은 것이다.** */
const seen: { method: string; args: unknown[] }[] = [];
/** 다음 200 응답으로 낼 것. 응답 쪽 해독을 재려고 갈아 끼운다. */
let willReturn: unknown;

const take = (): unknown => { const v = willReturn; willReturn = undefined; return v; };

const fake: DataplaneDriver = {
  fence(leaderToken) {
    seen.push({ method: 'fence', args: [leaderToken] });
    return Promise.resolve((take() ?? { maxToken: `max-${leaderToken}` }) as never);
  },
  applyConfig(op) {
    seen.push({ method: 'applyConfig', args: [op] });
    return Promise.resolve((take() ?? {
      phase: 'activated', progress: { http: undefined, stream: undefined },
      partialTransition: false,
    }) as never);
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

function makeCerts(root: string): void {
  const run = (args: string[]): void => { execFileSync('openssl', args, { stdio: 'ignore' }); };
  const cnf = join(root, 'openssl.cnf');
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
  dir = mkdtempSync(join(tmpdir(), 'bary-wire-'));
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

type Raw = { status: number; body: Record<string, unknown> };

/**
 * **타입 드라이버가 절대 안 만드는 요청**을 직접 던진다.
 *
 * 이것이 요점이다 — `RemoteDataplaneDriver` 를 지나면 TypeScript 가 모양을 지켜 주고,
 * 그러면 이 테스트는 "타입이 타입을 지킨다" 를 재게 된다. 낡거나 버그 있는 CP 는
 * 타입을 안 지나 온다.
 */
function raw(method: string, body: unknown): Promise<Raw> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = httpsRequest(`${base}/dp/${method}`, {
      method: 'POST',
      ca: readFileSync(join(dir, 'ca.pem')),
      cert: readFileSync(join(dir, 'client.pem')),
      key: readFileSync(join(dir, 'client.key')),
      timeout: 5_000,
      headers: { 'content-type': 'application/json' },
    }, (r) => {
      let text = '';
      r.setEncoding('utf8');
      r.on('data', (c: string) => { text += c; });
      r.on('end', () => {
        let parsed: unknown;
        try { parsed = JSON.parse(text); } catch { parsed = { raw: text }; }
        resolve({ status: r.statusCode ?? 0, body: parsed as Record<string, unknown> });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

/** 멀쩡한 봉투. 아래에서 한 군데씩만 망가뜨린다. */
const OP = {
  leaderToken: '10', operationId: 'o1', transitionId: 't1',
  affectedPlanes: ['http'], targetGeneration: 'r7-e3', generationDigest: 'sha256:g1',
  planes: {
    http: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: 'sha256:h',
    },
  },
};

const broken = (patch: Record<string, unknown>): unknown => ({ op: { ...OP, ...patch } });

describe('들어오는 봉투', () => {
  it('세대 이름이 경로 조각이 되기 전에 막힌다', async () => {
    seen.length = 0;
    // 이 값은 `BARY_CONFIGTEST_CMD` 의 `{generation}` 자리로 가고, 그 문자열은
    // `/bin/sh -c` 에 그대로 들어간다.
    const r = await raw('applyConfig', broken({ targetGeneration: 'g1; rm -rf /' }));
    expect(r.status).toBe(409);
    // **드라이버까지 안 갔다.** 상태기계가 이 값을 본 적이 없어야 한다.
    expect(seen).toEqual([]);
  });

  it('경로 탈출도 같은 자리에서 막힌다', async () => {
    const r = await raw('applyConfig', broken({ targetGeneration: '../../etc' }));
    expect(r.status).toBe(409);
  });

  it('`planes` 에 모르는 키가 있으면 거절한다', async () => {
    seen.length = 0;
    const r = await raw('applyConfig', {
      op: { ...OP, planes: { ...OP.planes, htp: OP.planes.http } },
    });
    expect(r.status).toBe(409);
    expect(seen).toEqual([]);
  });

  it('`affectedPlanes` 에 모르는 평면이 있으면 거절한다', async () => {
    const r = await raw('applyConfig', broken({ affectedPlanes: ['http', 'quic'] }));
    expect(r.status).toBe(409);
  });

  it('좌표가 빠지면 거절한다 — 펜싱이 `undefined` 를 좌표로 읽지 않는다', async () => {
    const r = await raw('applyConfig', broken({
      planes: { http: { target: { activationEpoch: '1', membershipRevision: '1' }, payloadDigest: 'x' } },
    }));
    expect(r.status).toBe(409);
  });

  it('`leaderToken` 이 없으면 문자열 "undefined" 로 안 간다', async () => {
    seen.length = 0;
    const r = await raw('fence', {});
    expect(r.status).toBe(409);
    expect(seen).toEqual([]);
  });

  it('멤버십 슬롯이 문자열 배열이 아니면 거절한다', async () => {
    const r = await raw('pushMembershipDirect', {
      plane: 'http', epoch: '3', slots: { pool_a: [{ host: '10.0.0.1' }] },
    });
    expect(r.status).toBe(409);
  });

  /**
   * **거절은 판정이지 장애가 아니다.** 500 으로 내면 CP 가 `RemoteDpUnreachable` 로
   * 읽고 고칠 수 없는 것을 영원히 재시도한다.
   */
  it('거절은 409 이고 `kind` 를 갖는다 — 500 이 아니다', async () => {
    const r = await raw('applyConfig', broken({ targetGeneration: 'g1; id' }));
    expect(r.status).toBe(409);
    expect(typeof r.body['kind']).toBe('string');
    expect(typeof r.body['message']).toBe('string');
  });

  it('CP 쪽에서 `DpRejection` 이지 `RemoteDpUnreachable` 이 아니다', async () => {
    const e = await driver
      .applyConfig({ ...OP, targetGeneration: 'g1; id' } as never)
      .catch((x: unknown) => x);
    expect(e).toBeInstanceOf(DpRejection);
    expect(e).not.toBeInstanceOf(RemoteDpUnreachable);
  });

  /** **되는 것을 못 쓰게 만들지 않는다.** 해독기가 좁으면 제품이 멈춘다. */
  it('멀쩡한 봉투는 그대로 지나간다 — 인자가 하나도 안 없어진다', async () => {
    seen.length = 0;
    const r = await raw('applyConfig', { op: OP });
    expect(r.status).toBe(200);
    expect(seen[0]?.args[0]).toEqual(OP);
  });

  it('멀쩡한 멤버십도 그대로 지나간다', async () => {
    seen.length = 0;
    const slots = { pool_a: ['10.0.0.1:80', '10.0.0.2:80'] };
    const r = await raw('applyMembership', { op: OP, plane: 'http', slots });
    expect(r.status).toBe(200);
    expect(seen[0]?.args).toEqual([OP, 'http', slots]);
  });
});

describe('돌아오는 응답', () => {
  /**
   * DP 가 모르는 `phase` 를 답하면 그것은 **답이 아니다.** `parsed as T` 로 넘기면
   * CP 의 상태기계가 그 값으로 분기하고, 어느 갈래에도 안 걸려 조용히 지나간다.
   */
  it('모르는 `phase` 는 답으로 안 받는다 — 못 물었다가 된다', async () => {
    willReturn = { phase: '거의-됐어요', progress: {}, partialTransition: false };
    const e = await driver.applyConfig(OP as never).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(RemoteDpUnreachable);
  });

  it('아는 `phase` 는 그대로 받는다', async () => {
    willReturn = undefined;
    expect((await driver.applyConfig(OP as never)).phase).toBe('activated');
  });
});

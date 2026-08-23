/**
 * DP 에이전트의 원격 창구 — `RemoteDataplaneDriver` 의 반대편 (DESIGN.md §3.1 · §11.1)
 *
 * `LocalDataplaneDriver` 를 mTLS 뒤에 세운다. **에이전트는 여전히 nginx 와 같은
 * 호스트에 산다** — §11.1 이 실측한 "에이전트와 nginx 는 같은 파일시스템을 봐야 한다"
 * 는 그대로다. 갈리는 것은 CP↔에이전트뿐이다.
 *
 * ── 이 파일의 계약은 **오직 셋**이다
 *
 *   200 + JSON   해냈다. 본문이 그 메서드의 반환값이다
 *   409 + {kind} **판정했다.** `DpRejection` 이고, CP 는 이걸 보고 전환을 닫는다
 *   그 외        **답을 못 줬다.** CP 쪽에서 `RemoteDpUnreachable` 이 된다
 *
 * 이 셋을 섞으면 이 저장소가 여러 번 물린 그 자리로 돌아간다 — "관측하지 못한 것" 과
 * "관측해서 아니라고 한 것" 이 같은 값이 되는 것. 특히 **5xx 를 거절로 읽으면 에이전트가
 * 잠깐 아픈 것이 전환 포기가 된다.**
 *
 * ── 인증
 *
 * `requestCert` + `rejectUnauthorized` 를 **함께** 켠다. 앞의 것만 켜면 인증서 없이도
 * handshake 가 끝나고, 그러면 이 창구가 그냥 열린 문이다. 그 위에 **CN 화이트리스트**를
 * 얹는다 — CA 를 나눠 쓰는 배포에서 "이 CA 의 아무 인증서" 는 너무 넓다.
 */
import { createServer, type Server } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';

import { DpRejection } from './agent.js';
import type { DataplaneDriver } from './driver.js';

export type DpAgentServerOptions = {
  driver: DataplaneDriver;
  /** PEM 바이트. 파일 읽기는 부르는 쪽이 한다 — 이 모듈은 파일시스템을 안 만진다. */
  cert: Buffer | string;
  key: Buffer | string;
  /** CP 를 검증할 CA. **필수다.** */
  ca: Buffer | string;
  /**
   * 받아 줄 클라이언트 CN 목록. **비어 있을 수 없다.**
   *
   * `undefined` 를 "아무나" 로 읽지 않는다 — 비면 생성자가 던진다. mTLS 신원 매핑에서
   * 내린 것과 같은 판단이다(인증서는 이름만 말하고, 누가 들어와도 되는지는 표가 정한다).
   */
  allowedClientNames: readonly string[];
  /** 요청 본문 상한. 기본 4MiB — 멤버십 슬롯이 제일 크다. */
  maxBodyBytes?: number;
};

const DEFAULT_MAX_BODY = 4 * 1024 * 1024;

/** 원격으로 여는 메서드. **여기 없는 이름은 404 다** — 이름으로 아무 함수나 못 부른다. */
const METHODS = [
  'fence', 'applyConfig', 'recoverConfig', 'abortConfig',
  'applyMembership', 'pushMembershipDirect', 'reconcileConfig', 'status',
] as const;
type MethodName = (typeof METHODS)[number];

const isMethod = (v: string): v is MethodName => (METHODS as readonly string[]).includes(v);

export function createDpAgentServer(opts: DpAgentServerOptions): Server {
  if (opts.allowedClientNames.length === 0) {
    throw new Error('allowedClientNames 가 비어 있다 — 아무나 받는 창구를 안 만든다');
  }
  const allowed = new Set(opts.allowedClientNames);
  const maxBody = opts.maxBodyBytes ?? DEFAULT_MAX_BODY;

  return createServer(
    {
      cert: opts.cert,
      key: opts.key,
      ca: opts.ca,
      // 둘을 **함께** 켠다. `requestCert` 만이면 인증서 없이도 handshake 가 끝난다.
      requestCert: true,
      rejectUnauthorized: true,
    },
    (req, res) => { void handle(req, res, opts.driver, allowed, maxBody); },
  );
}

async function handle(
  req: IncomingMessage, res: ServerResponse,
  driver: DataplaneDriver, allowed: ReadonlySet<string>, maxBody: number,
): Promise<void> {
  if (req.method !== 'POST') return send(res, 405, { message: 'POST 만 받는다' });

  const name = /^\/dp\/([A-Za-z]+)$/.exec(req.url ?? '')?.[1];
  if (name === undefined || !isMethod(name)) {
    return send(res, 404, { message: '모르는 메서드다' });
  }

  /**
   * **TLS 층이 검증한 것만 본다.** `rejectUnauthorized` 가 위에서 켜져 있지만, 그
   * 배선이 바뀌어도 이 판정이 혼자 서야 한다 — mTLS 신원 매핑에서 내린 것과 같다.
   */
  const sock = req.socket as TLSSocket;
  if (typeof sock.getPeerCertificate !== 'function' || sock.authorized !== true) {
    return send(res, 401, { message: '검증된 클라이언트 인증서가 없다' });
  }
  const cn = sock.getPeerCertificate().subject?.CN;
  if (typeof cn !== 'string' || !allowed.has(cn)) {
    return send(res, 403, { message: '허용되지 않은 클라이언트다' });
  }

  let body: unknown;
  try {
    body = await readJson(req, maxBody);
  } catch (e) {
    return send(res, 400, { message: e instanceof Error ? e.message : String(e) });
  }
  const a = (body ?? {}) as Record<string, unknown>;

  try {
    const out = await invoke(driver, name, a);
    // `void` 를 돌려주는 메서드는 빈 객체로 답한다 — 클라이언트가 JSON 을 기대한다.
    send(res, 200, out === undefined ? {} : out);
  } catch (e) {
    /**
     * **거절만 409 다.** `DpRejection` 은 에이전트의 판정이고, 그 외 모든 예외는
     * 500 이다 — CP 쪽에서 "못 물었다" 가 된다. 여기서 아무 예외나 409 로 접으면
     * 코드 결함이 곧 "너는 낡았다" 로 둔갑한다.
     */
    if (e instanceof DpRejection) {
      return send(res, 409, {
        kind: e.kind,
        message: e.message,
        ...(e.terminalState === undefined ? {} : { terminalState: e.terminalState }),
      });
    }
    send(res, 500, { message: e instanceof Error ? e.message : String(e) });
  }
}

/** 이름 → 드라이버 호출. **인자를 여기서 편다** — 클라이언트가 보낸 모양이 계약이다. */
function invoke(
  driver: DataplaneDriver, name: MethodName, a: Record<string, unknown>,
): Promise<unknown> {
  switch (name) {
    case 'fence':
      return driver.fence(String(a['leaderToken']));
    case 'applyConfig':
      return driver.applyConfig(a['op'] as never);
    case 'recoverConfig':
      return driver.recoverConfig();
    case 'abortConfig':
      return driver.abortConfig(a['op'] as never);
    case 'applyMembership':
      return driver.applyMembership(a['op'] as never, a['plane'] as never, a['slots'] as never);
    case 'pushMembershipDirect':
      return driver.pushMembershipDirect(
        a['plane'] as never, String(a['epoch']), a['slots'] as never,
      );
    case 'reconcileConfig':
      return driver.reconcileConfig();
    case 'status':
      return driver.status();
  }
}

function readJson(req: IncomingMessage, maxBody: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let text = '';
    let size = 0;
    req.setEncoding('utf8');
    req.on('data', (c: string) => {
      size += Buffer.byteLength(c);
      // **상한을 넘으면 즉시 끊는다.** 다 받고 나서 거절하면 그 사이 메모리를 먹는다.
      if (size > maxBody) {
        req.destroy();
        reject(new Error(`본문이 ${maxBody}바이트를 넘는다`));
        return;
      }
      text += c;
    });
    req.on('end', () => {
      if (text === '') return resolve({});
      try { resolve(JSON.parse(text) as unknown); } catch { reject(new Error('본문이 JSON 이 아니다')); }
    });
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(Buffer.byteLength(text)),
  });
  res.end(text);
}

/**
 * 원격 `DataplaneDriver` — CP ↔ DP Agent 를 mTLS 로 잇는다 (DESIGN.md §3.1 · §11.1)
 *
 * §11.1 이 오래 이렇게 적어 두었다:
 *
 * > 프로세스 분리(§3.1)는 논리로 선다. `DpAgent` 가 `/etc/barycenter` 의 유일한 writer
 * > 이고, 컨트롤 플레인은 `DataplaneDriver` 를 통해서만 그것을 만진다. 그 인터페이스가
 * > **원격 전송이 들어올 이음매**다 — 지금은 로컬 구현 하나만 꽂혀 있다.
 *
 * ── 이것이 §11.1 의 실측과 충돌하지 않는 이유
 *
 * 같은 절이 **에이전트와 nginx 는 같은 파일시스템을 봐야 한다**고 실측했다(호스트에서
 * 심볼릭 링크를 바꿨더니 컨테이너 쪽이 `Invalid argument` 로 터졌다). 그 제약은
 * **에이전트↔nginx** 의 것이지 **CP↔에이전트**의 것이 아니다. 이 모듈이 가르는 것은
 * 뒤쪽이고, 에이전트는 여전히 nginx 와 같은 호스트에 산다.
 *
 * ── 두 가지 실패를 절대 섞지 않는다
 *
 * 이 저장소가 반복해서 배운 것이 *"관측하지 못한 것과 관측해서 아니라고 한 것은 다르다"*
 * 이다(`observeRead` 의 `blind`, §6.3 의 증거 판정). 여기서 같은 구분이 두 방향으로 산다:
 *
 *   `DpRejection`  에이전트가 **판정했다.** "너는 낡았다" · "이미 끝났다" — 좌표를
 *                  움직이지 말라는 답이고, CP 는 이걸 보고 오퍼레이션을 닫는다.
 *   `RemoteDpUnreachable`  **못 물었다.** 망이 끊겼거나 인증서가 안 맞거나 5xx 다.
 *                  세계에 대해 아무 주장도 하지 않는다 — 다시 물어야 한다.
 *
 * 둘을 섞으면 **망 장애가 곧 전환 포기**가 되거나, 더 나쁘게는 낡은 리더가 거절을
 * 일시적 장애로 읽고 재시도한다. 그래서 거절은 `409` + 본문의 `kind` 로만 오고,
 * 그 외 모든 비-200 은 `RemoteDpUnreachable` 이다.
 */
import { Agent, request } from 'node:https';
import { readFileSync } from 'node:fs';

import {
  DpRejection, type PlaneAck, type RejectionKind, type TerminalKind,
} from './agent.js';
import type { DataplaneDriver, DriverStatus, ReconcileResult } from './driver.js';
import type { ApplyOperation, ApplyResult, Plane } from './operation.js';

/** 에이전트에 **못 물었다.** 세계에 대해 아무 주장도 하지 않는다. */
export class RemoteDpUnreachable extends Error {
  constructor(readonly method: string, message: string, readonly status?: number) {
    super(`DP 에이전트에 못 물었다 (${method}): ${message}`);
    this.name = 'RemoteDpUnreachable';
  }
}

export type RemoteDriverOptions = {
  /** `https://dp-1.internal:8443` — **https 만.** 평문은 안 받는다. */
  baseUrl: string;
  /** 클라이언트 인증서·키 파일 경로. CP 가 자기를 증명한다. */
  clientCertFile: string;
  clientKeyFile: string;
  /** 에이전트를 검증할 CA. **필수다** — 없으면 아무나 에이전트 행세를 한다. */
  caFile: string;
  /** 한 번의 왕복 상한. 기본 30초. */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 30_000;

/** 거절 본문. 에이전트가 이 모양으로만 거절한다. */
type RejectionBody = { kind: RejectionKind; message: string; terminalState?: TerminalKind };

const isRejectionBody = (v: unknown): v is RejectionBody =>
  typeof v === 'object' && v !== null
  && typeof (v as { kind?: unknown }).kind === 'string'
  && typeof (v as { message?: unknown }).message === 'string';

export class RemoteDataplaneDriver implements DataplaneDriver {
  readonly #base: string;
  readonly #agent: Agent;
  readonly #timeoutMs: number;

  constructor(opts: RemoteDriverOptions) {
    if (!opts.baseUrl.startsWith('https://')) {
      throw new Error(`원격 드라이버는 https 만 받는다: ${opts.baseUrl}`);
    }
    this.#base = opts.baseUrl.replace(/\/+$/, '');
    this.#timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    /**
     * **`rejectUnauthorized` 를 끄는 길을 안 만든다.** 옵션으로 두면 "개발 중이라" 로
     * 켜지고 그대로 배포된다 — 이 저장소가 PROXY protocol 의 `trustedCidrs` 에서
     * 내린 것과 같은 판단이다(표현 가능한 것은 언젠가 들어온다).
     */
    this.#agent = new Agent({
      ca: readFileSync(opts.caFile),
      cert: readFileSync(opts.clientCertFile),
      key: readFileSync(opts.clientKeyFile),
      rejectUnauthorized: true,
      keepAlive: true,
    });
  }

  async #call<T>(method: string, body: unknown): Promise<T> {
    const payload = JSON.stringify(body ?? {});
    const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
      const req = request(
        `${this.#base}/dp/${method}`,
        {
          method: 'POST',
          agent: this.#agent,
          timeout: this.#timeoutMs,
          headers: {
            'content-type': 'application/json',
            'content-length': String(Buffer.byteLength(payload)),
          },
        },
        (r) => {
          let text = '';
          r.setEncoding('utf8');
          r.on('data', (c: string) => { text += c; });
          r.on('end', () => resolve({ status: r.statusCode ?? 0, text }));
        },
      );
      req.on('timeout', () => {
        req.destroy(new Error(`${this.#timeoutMs}ms 안에 응답이 없다`));
      });
      req.on('error', reject);
      req.end(payload);
    }).catch((e: unknown) => {
      throw new RemoteDpUnreachable(method, e instanceof Error ? e.message : String(e));
    });

    /**
     * **409 만이 판정이다.** 그 외 비-200 은 전부 "못 물었다" 로 접는다 — 5xx 를
     * 거절로 읽으면 에이전트가 잠깐 아픈 것이 전환 포기가 된다.
     */
    if (res.status === 409) {
      const parsed = safeJson(res.text);
      if (!isRejectionBody(parsed)) {
        throw new RemoteDpUnreachable(method, `거절 본문을 못 읽는다: ${res.text.slice(0, 200)}`, 409);
      }
      throw new DpRejection(parsed.kind, parsed.message, parsed.terminalState);
    }
    if (res.status !== 200) {
      throw new RemoteDpUnreachable(method, `상태 ${res.status}: ${res.text.slice(0, 200)}`, res.status);
    }
    const parsed = safeJson(res.text);
    if (parsed === undefined) {
      throw new RemoteDpUnreachable(method, `본문이 JSON 이 아니다: ${res.text.slice(0, 200)}`, 200);
    }
    return parsed as T;
  }

  fence(leaderToken: string): Promise<{ maxToken: string }> {
    return this.#call('fence', { leaderToken });
  }

  applyConfig(op: ApplyOperation): Promise<ApplyResult> {
    return this.#call('applyConfig', { op });
  }

  recoverConfig(): Promise<ApplyResult> {
    return this.#call('recoverConfig', {});
  }

  abortConfig(op: ApplyOperation): Promise<void> {
    return this.#call('abortConfig', { op });
  }

  applyMembership(
    op: ApplyOperation, plane: Plane, slots: Record<string, string[]>,
  ): Promise<PlaneAck> {
    return this.#call('applyMembership', { op, plane, slots });
  }

  pushMembershipDirect(
    plane: Plane, epoch: string, slots: Record<string, string[]>,
  ): Promise<void> {
    return this.#call('pushMembershipDirect', { plane, epoch, slots });
  }

  reconcileConfig(): Promise<ReconcileResult> {
    return this.#call('reconcileConfig', {});
  }

  status(): Promise<DriverStatus> {
    return this.#call('status', {});
  }

  /** keep-alive 소켓을 놓는다. 안 부르면 프로세스가 안 끝난다. */
  close(): void {
    this.#agent.destroy();
  }
}

function safeJson(text: string): unknown {
  if (text === '') return {};
  try { return JSON.parse(text) as unknown; } catch { return undefined; }
}

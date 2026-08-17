/**
 * ACME 클라이언트 (RFC 8555) — DESIGN.md §8.2 · S18
 *
 * **§8.2 는 규범이 아니다.** v3 가 명시했다: *"§8.2 의 엔티티·상태·정책은 ADR-ACME 가
 * 확정하기 전까지 구속력이 없다."* 그 ADR 을 쓰려면 실물이 어떻게 동작하는지 알아야 하고,
 * 그게 S18 이다. 이 파일은 **그 실증에 쓰는 클라이언트**이고, 동시에 제품이 쓸 물건이다.
 *
 * 스파이크용으로 따로 던져 쓰는 코드를 안 만든 이유: 그러면 스파이크가 재는 것과 제품이
 * 쓰는 것이 달라진다. 이 저장소가 반복해서 배운 것이 *"흉내로 재면 흉내를 재게 된다"* 다.
 *
 * ── 의존성 0 ────────────────────────────────────────────────────────────
 *
 * JWS 도 CSR 도 직접 만든다 (§11.2 — 런타임 의존성은 `pg` 뿐). ES256 서명에서 한 가지가
 * 함정인데, **Node 의 기본 EC 서명은 DER 인코딩이고 JWS 는 raw R‖S 를 요구한다.**
 * `dsaEncoding: 'ieee-p1363'` 을 안 주면 CA 가 전부 `malformed` 로 거절한다.
 */
import { createHash, createSign, type KeyObject, createPublicKey } from 'node:crypto';

import { createCsr } from './der.js';

export const b64url = (b: Buffer | string): string =>
  Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

/** 공개 JWK. **키 순서가 계약이다** — thumbprint 가 정렬된 JSON 위에서 계산된다. */
export function publicJwk(key: KeyObject): { crv: string; kty: string; x: string; y: string } {
  const jwk = createPublicKey(key).export({ format: 'jwk' }) as { crv?: string; x?: string; y?: string };
  if (jwk.crv === undefined || jwk.x === undefined || jwk.y === undefined) {
    throw new Error('P-256 공개 JWK 를 뽑지 못했다');
  }
  return { crv: jwk.crv, kty: 'EC', x: jwk.x, y: jwk.y };
}

/**
 * JWK thumbprint (RFC 7638). key authorization 에 쓴다.
 *
 * **필드 순서와 공백이 결과를 바꾼다.** lexicographic 순서, 공백 없음 — 여기서 틀리면
 * 챌린지가 항상 실패하는데, CA 는 "틀린 값" 이라고만 말하지 왜인지 말해 주지 않는다.
 */
export function thumbprint(key: KeyObject): string {
  const jwk = publicJwk(key);
  const canonical = `{"crv":"${jwk.crv}","kty":"${jwk.kty}","x":"${jwk.x}","y":"${jwk.y}"}`;
  return b64url(createHash('sha256').update(canonical).digest());
}

/** `token.thumbprint` — http-01 이 그대로 서빙하고, dns-01 은 이것의 SHA-256 을 쓴다. */
export const keyAuthorization = (token: string, key: KeyObject): string =>
  `${token}.${thumbprint(key)}`;

/** dns-01 의 TXT 값 (RFC 8555 §8.4). */
export const dns01Value = (token: string, key: KeyObject): string =>
  b64url(createHash('sha256').update(keyAuthorization(token, key)).digest());

export type Directory = {
  newNonce: string;
  newAccount: string;
  newOrder: string;
  revokeCert?: string;
  keyChange?: string;
};

export type AcmeError = { type: string; detail?: string; status?: number };

export class AcmeHttpError extends Error {
  constructor(readonly status: number, readonly problem: AcmeError, readonly url: string) {
    super(`ACME ${status} ${problem.type}: ${problem.detail ?? '(detail 없음)'} (${url})`);
    this.name = 'AcmeHttpError';
  }
}

export type Order = {
  status: 'pending' | 'ready' | 'processing' | 'valid' | 'invalid';
  expires?: string;
  identifiers: { type: string; value: string }[];
  authorizations: string[];
  finalize: string;
  certificate?: string;
  error?: AcmeError;
};

export type Challenge = {
  type: string;
  url: string;
  token: string;
  status: 'pending' | 'processing' | 'valid' | 'invalid';
  error?: AcmeError;
};

export type Authorization = {
  status: 'pending' | 'valid' | 'invalid' | 'deactivated' | 'expired' | 'revoked';
  identifier: { type: string; value: string };
  wildcard?: boolean;
  challenges: Challenge[];
};

export type AcmeOptions = {
  directoryUrl: string;
  accountKey: KeyObject;
  /** 테스트 CA 의 자체서명 루트를 받아들이려면 필요하다. 실서비스에서는 안 쓴다. */
  fetchImpl?: typeof fetch;
  /**
   * `badNonce` 재시도 횟수. 기본 5.
   *
   * RFC 8555 §6.5 는 *"한 번은 반드시"* 재시도하라고 하는데, **그건 하한이지 운영값이
   * 아니다.** S18 이 실측했다 — Pebble 을 거부율 20% 로 두고 재시도를 1 회로 하면
   * 발급 한 바퀴(요청 15 개 남짓)가 절반 가까이 실패한다. 한 요청이 두 번 연속 거절될
   * 확률이 4% 이고, 그게 열댓 번 굴러가기 때문이다.
   *
   * 실서비스 CA 의 거부율은 이보다 낮지만, **한 바퀴에 요청이 많다는 성질은 같다.**
   */
  nonceRetries?: number;
};

/**
 * ACME 계정 하나로 주문을 처리한다.
 *
 * **상태를 안 든다** — 주문·챌린지의 durable 상태는 §8.2 가 DB 에 두기로 한 것이고, 그
 * 모양은 ADR-ACME 가 정한다. 여기서는 프로토콜만 말한다. 섞으면 ADR 이 정해지기 전에
 * 스키마가 굳는다.
 */
export class AcmeClient {
  #directory: Directory | undefined;
  #nonce: string | undefined;
  #kid: string | undefined;
  readonly #fetch: typeof fetch;
  readonly #nonceRetries: number;

  constructor(private readonly opts: AcmeOptions) {
    this.#fetch = opts.fetchImpl ?? fetch;
    this.#nonceRetries = opts.nonceRetries ?? 5;
  }

  get accountUrl(): string | undefined {
    return this.#kid;
  }

  async directory(): Promise<Directory> {
    if (this.#directory !== undefined) return this.#directory;
    const r = await this.#fetch(this.opts.directoryUrl);
    if (!r.ok) throw new Error(`디렉토리를 못 읽었다: ${r.status}`);
    this.#directory = (await r.json()) as Directory;
    return this.#directory;
  }

  /**
   * nonce 하나. 응답 헤더로 받은 것을 쟁여 두고, 없으면 `newNonce` 로 받는다.
   *
   * **재사용하면 `badNonce` 다.** 그래서 꺼낼 때 지운다 — 남겨 두면 두 요청이 같은 것을
   * 쓰고, 둘 중 하나는 반드시 실패한다.
   */
  async #takeNonce(): Promise<string> {
    const held = this.#nonce;
    if (held !== undefined) {
      this.#nonce = undefined;
      return held;
    }
    const dir = await this.directory();
    const r = await this.#fetch(dir.newNonce, { method: 'HEAD' });
    const n = r.headers.get('replay-nonce');
    if (n === null) throw new Error('newNonce 가 Replay-Nonce 를 안 줬다');
    return n;
  }

  #sign(url: string, nonce: string, payload: string): string {
    const header: Record<string, unknown> = { alg: 'ES256', nonce, url };
    // 계정을 만들기 전에는 `jwk`, 만든 뒤에는 `kid` 다. 둘을 함께 보내면 CA 가 거절한다.
    if (this.#kid === undefined) header['jwk'] = publicJwk(this.opts.accountKey);
    else header['kid'] = this.#kid;

    const protectedB64 = b64url(JSON.stringify(header));
    const signer = createSign('sha256');
    signer.update(`${protectedB64}.${payload}`);
    signer.end();
    // **raw R‖S 여야 한다.** Node 의 기본은 DER 이고, 그대로 보내면 전부 malformed 다.
    const signature = signer.sign({ key: this.opts.accountKey, dsaEncoding: 'ieee-p1363' });
    return JSON.stringify({
      protected: protectedB64, payload, signature: b64url(signature),
    });
  }

  /**
   * 서명된 POST. `payload === undefined` 면 **POST-as-GET** 이다 (RFC 8555 §6.3).
   *
   * ACME 에는 인증된 GET 이 없다 — 읽기도 빈 payload 로 POST 한다. 그냥 GET 하면 CA 에
   * 따라 401 이거나, 더 나쁘게는 **다른 사람의 주문을 읽는** 것이 된다.
   */
  async post(url: string, payload?: unknown): Promise<{ status: number; body: unknown; headers: Headers }> {
    const body = payload === undefined ? '' : b64url(JSON.stringify(payload));
    for (let attempt = 0; ; attempt += 1) {
      const nonce = await this.#takeNonce();
      const r = await this.#fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/jose+json' },
        body: this.#sign(url, nonce, body),
      });
      const fresh = r.headers.get('replay-nonce');
      if (fresh !== null) this.#nonce = fresh;

      const text = await r.text();
      const parsed: unknown = text === '' ? undefined
        : (r.headers.get('content-type') ?? '').includes('json') ? JSON.parse(text) : text;

      if (r.status >= 400) {
        const problem = (parsed ?? {}) as AcmeError;
        // **RFC 8555 §6.5 — `badNonce` 는 재시도해야 한다.** 이건 오류가 아니라 프로토콜의
        // 일부다. 재시도 안 하면 정상 운영 중에도 무작위로 실패한다.
        if (problem.type?.endsWith(':badNonce') === true && attempt < this.#nonceRetries) {
          this.#nonce = fresh ?? undefined;
          continue;
        }
        throw new AcmeHttpError(r.status, problem, url);
      }
      return { status: r.status, body: parsed, headers: r.headers };
    }
  }

  /** 계정을 만들거나(있으면) 찾는다. `kid` 를 기억한다. */
  async register(contact: readonly string[] = []): Promise<string> {
    const dir = await this.directory();
    const r = await this.post(dir.newAccount, {
      termsOfServiceAgreed: true,
      ...(contact.length > 0 ? { contact: [...contact] } : {}),
    });
    const location = r.headers.get('location');
    if (location === null) throw new Error('newAccount 가 Location 을 안 줬다');
    this.#kid = location;
    return location;
  }

  async newOrder(domains: readonly string[]): Promise<{ url: string; order: Order }> {
    const dir = await this.directory();
    const r = await this.post(dir.newOrder, {
      identifiers: domains.map((value) => ({ type: 'dns', value })),
    });
    const url = r.headers.get('location');
    if (url === null) throw new Error('newOrder 가 Location 을 안 줬다');
    return { url, order: r.body as Order };
  }

  async fetchOrder(url: string): Promise<Order> {
    return (await this.post(url)).body as Order;
  }

  async fetchAuthorization(url: string): Promise<Authorization> {
    return (await this.post(url)).body as Authorization;
  }

  /** 챌린지를 **준비했다고 알린다.** 빈 객체가 규격이다. */
  async acceptChallenge(url: string): Promise<Challenge> {
    return (await this.post(url, {})).body as Challenge;
  }

  /**
   * 주문이 목표 상태에 닿을 때까지 기다린다.
   *
   * **`invalid` 는 즉시 끝낸다.** 기다려도 안 바뀌는 상태를 예산 끝까지 기다리면, 진짜
   * 원인(챌린지 실패)이 타임아웃으로 보인다 — S7 이 reload 판정에서 배운 것과 같다.
   */
  async awaitOrder(url: string, want: Order['status'], opts: {
    attempts?: number; intervalMs?: number; sleep?: (ms: number) => Promise<void>;
  } = {}): Promise<Order> {
    const attempts = opts.attempts ?? 30;
    const intervalMs = opts.intervalMs ?? 500;
    const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    let last: Order | undefined;
    for (let i = 0; i < attempts; i += 1) {
      last = await this.fetchOrder(url);
      if (last.status === want) return last;
      if (last.status === 'invalid') return last;
      await sleep(intervalMs);
    }
    if (last === undefined) throw new Error('주문을 한 번도 못 읽었다');
    return last;
  }

  /** CSR 을 보내고 인증서 URL 이 붙기를 기다린다. */
  async finalize(order: Order, orderUrl: string, domains: readonly string[], certKey: KeyObject): Promise<Order> {
    const csr = createCsr(domains, certKey);
    await this.post(order.finalize, { csr: b64url(csr.der) });
    return this.awaitOrder(orderUrl, 'valid');
  }

  /** 인증서 체인 PEM. */
  async downloadCertificate(url: string): Promise<string> {
    const r = await this.post(url);
    if (typeof r.body !== 'string') throw new Error('인증서가 PEM 문자열이 아니다');
    return r.body;
  }
}

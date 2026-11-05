/**
 * Vault transit 봉인 — `POST {addr}/v1/{mount}/encrypt/{key}` · `…/decrypt/{key}`. SDK 없이 HTTP 로 직접 부른다.
 *
 * **키는 Vault 밖으로 나오지 않는다.** 여기는 평문을 보내 암호문(`vault:v<n>:…`)을 받고, 그 반대를 한다. 그 암호문이
 * 그대로 봉인값이다 — 앞머리 `vault:` 가 「이 값은 Vault 로 연다」를 말한다.
 *
 * **행에 묶기(aad)는 `context` 로 한다.** transit 키를 `derived=true` 로 만들면 Vault 가 context 로 키를 파생하므로,
 * 다른 행의 context 로는 안 열린다(로컬의 GCM aad 와 같은 뜻). 키가 파생형이 아니면 context 가 무시될 수 있다 —
 * 그래서 기동 때 `probe` 가 「다른 context 로는 안 열린다」를 실제로 잰다(`registry.ts`).
 *
 * 토큰은 **파일**에서 매 호출 읽는다 — Vault Agent 가 갱신해 쓰는 파일을 그대로 따라간다. env 값으로는 받지 않는다.
 *
 * 답의 뜻:
 *   200 + `data.ciphertext`/`data.plaintext`  성공. 200 이라도 그 필드가 없으면 `unavailable`
 *   400  decrypt 에서는 `integrity`(다른 키 · 다른 context · 깨진 값), encrypt 에서는 `unavailable`(설정 문제)
 *   401 · 403  `denied`(토큰 · 정책) · 그 밖 전부 `unavailable`
 *
 * **던지지 않는다.** 네트워크 · 읽기 · 해석 실패는 모두 결과다.
 */
import { randomBytes } from 'node:crypto';

import { readBoundedFile } from '../../dp/kek-source.js';
import type { OpenResult, SealResult, Sealer } from './provider.js';

/** transit 의 답은 수백 바이트다. 이만큼이면 넉넉하고, 더 오면 읽지 않는다(메모리를 상대가 정하지 않게). */
export const MAX_VAULT_RESPONSE_BYTES = 64 * 1024;
/** 토큰 파일 상한. */
const MAX_TOKEN_BYTES = 16 * 1024;
const TIMEOUT_MS = 5_000;

export const VAULT_PREFIX = 'vault:';

export type VaultTransitOptions = {
  /** `https://vault.example:8200`. https 가 아니면 보내지 않는다. */
  addr: string;
  /** transit 엔진의 마운트(기본 `transit`). */
  mount?: string;
  /** transit 키 이름 — `derived=true` 로 만든 것. */
  key: string;
  /** Vault 토큰 **파일**. 매 호출 읽는다. */
  tokenFile: string;
  /** Vault Enterprise 네임스페이스(있으면 `X-Vault-Namespace`). */
  namespace?: string;
  fetch?: typeof fetch;
  /** 토큰 파일을 읽는 창구. 시험이 갈아 끼운다. */
  readToken?: () => Promise<string>;
  timeoutMs?: number;
};

type Call = { ok: true; data: Record<string, unknown> } | { ok: false; reason: 'integrity' | 'denied' | 'unavailable'; detail: string };

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;

export class VaultTransitSealer implements Sealer {
  readonly kind = 'vault-transit';
  readonly prefix = VAULT_PREFIX;
  readonly #o: VaultTransitOptions;
  readonly #base: string;

  /** 설정이 틀리면 **던진다** — 기동 때 부른다. 호출 중에는 던지지 않는다. */
  constructor(o: VaultTransitOptions) {
    if (!o.addr.startsWith('https://')) throw new Error(`Vault 주소는 https 여야 한다 (${o.addr})`);
    const mount = o.mount ?? 'transit';
    if (!/^[A-Za-z0-9][A-Za-z0-9_./-]{0,127}$/.test(mount) || mount.includes('..')) {
      throw new Error(`Vault transit 마운트 이름이 이상하다 (${mount})`);
    }
    if (!NAME.test(o.key)) throw new Error(`Vault transit 키 이름이 이상하다 (${o.key})`);
    this.#o = o;
    this.#base = `${o.addr.replace(/\/+$/, '')}/v1/${mount.replace(/^\/+|\/+$/g, '')}`;
  }

  async seal(plain: Buffer, aad: string): Promise<SealResult> {
    const r = await this.#call('encrypt', { plaintext: plain.toString('base64'), context: ctx(aad) });
    if (!r.ok) {
      // encrypt 의 400 은 값의 문제가 아니라 설정(키가 파생형이 아닌데 context 를 줬다 등)이다.
      return { ok: false, reason: r.reason === 'integrity' ? 'unavailable' : r.reason, detail: r.detail };
    }
    const ct = r.data['ciphertext'];
    if (typeof ct !== 'string' || !ct.startsWith(VAULT_PREFIX)) {
      return { ok: false, reason: 'unavailable', detail: 'Vault 가 200 으로 답했지만 암호문이 없다' };
    }
    return { ok: true, sealed: ct };
  }

  async open(sealed: string, aad: string): Promise<OpenResult> {
    if (!/^vault:v[0-9]+:[A-Za-z0-9+/=]+$/.test(sealed)) {
      return { ok: false, reason: 'malformed', detail: 'Vault 봉인 형식(vault:v<n>:<base64>)이 아니다' };
    }
    const r = await this.#call('decrypt', { ciphertext: sealed, context: ctx(aad) });
    if (!r.ok) return r;
    const pt = r.data['plaintext'];
    if (typeof pt !== 'string') return { ok: false, reason: 'unavailable', detail: 'Vault 가 200 으로 답했지만 평문이 없다' };
    return { ok: true, plain: Buffer.from(pt, 'base64') };
  }

  /**
   * **행 묶기를 실제로 잰다.** 무작위 값을 context A 로 봉인해 A 로는 열리고 B 로는 안 열리는지 본다.
   * 키가 파생형이 아니어서 context 가 무시되면 B 로도 열린다 — 그 배포는 행 묶기가 없는 것이므로 거부한다.
   */
  async probe(): Promise<{ ok: true } | { ok: false; detail: string }> {
    const nonce = randomBytes(16).toString('hex');
    const s = await this.seal(Buffer.from('probe'), `probe:${nonce}:a`);
    if (!s.ok) return { ok: false, detail: `봉인 시험 실패 (${s.reason}): ${s.detail}` };
    const same = await this.open(s.sealed, `probe:${nonce}:a`);
    if (!same.ok) return { ok: false, detail: `열기 시험 실패 (${same.reason}): ${same.detail}` };
    const other = await this.open(s.sealed, `probe:${nonce}:b`);
    if (other.ok) {
      return { ok: false, detail: `transit 키 ${this.#o.key} 가 context 로 묶지 않는다 — derived=true 로 만든 키가 필요하다` };
    }
    if (other.reason !== 'integrity') return { ok: false, detail: `다른 context 열기 시험이 판정 없이 끝났다 (${other.reason}): ${other.detail}` };
    return { ok: true };
  }

  async #call(op: 'encrypt' | 'decrypt', body: Record<string, string>): Promise<Call> {
    try {
      return await this.#ask(op, body);
    } catch (e) {
      // `#ask` 는 스스로 던지지 않게 썼다. 그래도 빠져나온 것은 닫는다.
      return { ok: false, reason: 'unavailable', detail: e instanceof Error ? e.message : String(e) };
    }
  }

  async #ask(op: 'encrypt' | 'decrypt', body: Record<string, string>): Promise<Call> {
    let token: string;
    try {
      token = (await (this.#o.readToken ?? (() => readBoundedFile(this.#o.tokenFile, MAX_TOKEN_BYTES)))()).trim();
    } catch (e) {
      const code = (e as { code?: string }).code;
      return { ok: false, reason: 'denied', detail: `Vault 토큰 파일 (${this.#o.tokenFile}) 을 읽지 못했다 (${code ?? '알 수 없는 오류'})` };
    }
    if (token === '') return { ok: false, reason: 'denied', detail: `Vault 토큰 파일 (${this.#o.tokenFile}) 이 비었다` };

    let res: Response;
    try {
      res = await (this.#o.fetch ?? fetch)(`${this.#base}/${op}/${encodeURIComponent(this.#o.key)}`, {
        method: 'POST',
        headers: {
          'x-vault-token': token,
          'content-type': 'application/json',
          ...(this.#o.namespace === undefined || this.#o.namespace === '' ? {} : { 'x-vault-namespace': this.#o.namespace }),
        },
        body: JSON.stringify(body),
        redirect: 'error',
        signal: AbortSignal.timeout(this.#o.timeoutMs ?? TIMEOUT_MS),
      });
    } catch (e) {
      return { ok: false, reason: 'unavailable', detail: `Vault 에 닿지 못했다: ${e instanceof Error ? e.message : String(e)}` };
    }

    let text: string;
    try {
      text = await readBounded(res, MAX_VAULT_RESPONSE_BYTES);
    } catch (e) {
      return { ok: false, reason: 'unavailable', detail: `Vault 의 답을 읽지 못했다: ${e instanceof Error ? e.message : String(e)}` };
    }

    if (res.status === 200) {
      let data: unknown;
      try {
        data = (JSON.parse(text) as { data?: unknown } | null)?.data;
      } catch {
        data = undefined;
      }
      if (data === null || typeof data !== 'object') {
        return { ok: false, reason: 'unavailable', detail: 'Vault 가 200 으로 답했지만 data 가 없다' };
      }
      return { ok: true, data: data as Record<string, unknown> };
    }
    // 오류 본문(`errors`)은 Vault 의 문장이다 — 평문 · 토큰을 담지 않는다. 그래도 길이를 자른다.
    const why = vaultErrors(text);
    if (res.status === 400 && op === 'decrypt') {
      return { ok: false, reason: 'integrity', detail: `Vault 가 열기를 거절했다 — 다른 키 · 다른 행의 값이거나 깨졌다${why}` };
    }
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: 'denied', detail: `Vault 가 토큰 · 정책을 거절했다 (${res.status})${why}` };
    }
    return { ok: false, reason: 'unavailable', detail: `Vault 가 ${res.status} 로 답했다${why}` };
  }
}

/** context 는 base64 다. aad 가 빈 문자열이면 Vault 가 「context 없음」으로 읽으므로 앞머리를 붙인다. */
const ctx = (aad: string): string => Buffer.from(`bary:${aad}`, 'utf8').toString('base64');

function vaultErrors(text: string): string {
  try {
    const e = (JSON.parse(text) as { errors?: unknown } | null)?.errors;
    if (Array.isArray(e) && e.every((x) => typeof x === 'string')) {
      const s = e.join('; ').slice(0, 300);
      return s === '' ? '' : `: ${s}`;
    }
  } catch { /* 본문이 JSON 이 아니면 싣지 않는다 */ }
  return '';
}

/**
 * 세면서 읽는다 — `Content-Length` 는 주장일 뿐이라 선언이 넘으면 일찍 멈추고, 실제로도 넘는 순간 끊는다.
 * 넘으면 던진다(호출자가 `unavailable` 로 바꾼다).
 */
export async function readBounded(res: Response, limit: number): Promise<string> {
  const declared = res.headers.get('content-length');
  if (declared !== null && Number(declared) > limit) {
    void res.body?.cancel().catch(() => undefined);
    throw new Error(`답이 ${limit}바이트를 넘는다`);
  }
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      void reader.cancel().catch(() => undefined);
      throw new Error(`답이 ${limit}바이트를 넘는다`);
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

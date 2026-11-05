/**
 * 로컬 봉인 — AES-256-GCM. `seal.ts` 에 있던 것을 옮겼다(**바이트 그대로** — 기존 봉인값을 그대로 연다).
 *
 * 키(`BARY_ACCOUNTS_KEK`, 32바이트 base64)는 **계정 PG 에 없다.** 덤프를 가져간 상대는 암호문만 든다.
 * 형식: `v1.<iv>.<ct>.<tag>` (base64url). 판 표시를 붙여 두면 키·방식을 바꿀 때 옛 값을 가린다.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import type { KeySource } from '../../dp/kek-source.js';
import type { OpenResult, SealResult, Sealer } from './provider.js';

/**
 * 계정 KEK 의 읽는 규칙 — **예전 그대로다**(`Buffer.from(_, 'base64')` 가 32 바이트). 인증서 KEK 의 `readKek` 보다
 * 너그럽다(base64url · 패딩 없음 · 사이의 공백도 받는다). 운영에 이미 그렇게 적힌 키가 있을 수 있으니 좁히지 않는다.
 */
export function parseAccountsKek(raw: string): Buffer {
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32) throw new Error('BARY_ACCOUNTS_KEK 는 32바이트를 base64 로 적은 값이어야 한다');
  return key;
}

/** 계정 KEK 의 출처 — `BARY_ACCOUNTS_KEK` · `_FILE` · `_CMD`. 규칙은 인증서 KEK 와 같은 코드(`resolveKeyFrom`)다. */
export const ACCOUNTS_KEK_SOURCE: KeySource = {
  name: 'BARY_ACCOUNTS_KEK',
  file: true,
  parse: parseAccountsKek,
  needs: '계정 KEK 없이 사람 계정은 안 뜬다',
  shape: '32 바이트, base64',
  missing: 'BARY_ACCOUNTS_DSN 을 켰으면 BARY_ACCOUNTS_KEK(32바이트 base64) · BARY_ACCOUNTS_KEK_FILE · BARY_ACCOUNTS_KEK_CMD 중 하나가 필요하다',
};

export const LOCAL_PREFIX = 'v1.';

export class LocalSealer implements Sealer {
  readonly kind = 'local';
  readonly prefix = LOCAL_PREFIX;
  readonly #key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new Error('BARY_ACCOUNTS_KEK 는 32바이트를 base64 로 적은 값이어야 한다');
    this.#key = Buffer.from(key);
  }

  /** 동기판 — 옛 `Sealer.seal` 과 같다. 던지지 않는다(키 길이는 생성자가 봤다). */
  sealSync(plain: Buffer, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.#key, iv);
    // 행(사용자)에 묶는다 — 다른 사람의 행으로 옮겨 붙인 암호문은 안 풀린다.
    c.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return ['v1', iv, ct, c.getAuthTag()].map((x) => (typeof x === 'string' ? x : x.toString('base64url'))).join('.');
  }

  /** 동기판 — 옛 `Sealer.open` 과 같다. 형식이 틀리거나 무결성이 깨지면 던진다. */
  openSync(sealed: string, aad: string): Buffer {
    const [v, iv, ct, tag] = sealed.split('.');
    if (v !== 'v1' || iv === undefined || ct === undefined || tag === undefined) throw new Error('봉인 형식이 아니다');
    const d = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
  }

  async seal(plain: Buffer, aad: string): Promise<SealResult> {
    return { ok: true, sealed: this.sealSync(plain, aad) };
  }

  async open(sealed: string, aad: string): Promise<OpenResult> {
    const [v, iv, ct, tag] = sealed.split('.');
    if (v !== 'v1' || iv === undefined || ct === undefined || tag === undefined) {
      return { ok: false, reason: 'malformed', detail: '로컬 봉인 형식(v1.<iv>.<ct>.<tag>)이 아니다' };
    }
    try {
      return { ok: true, plain: this.openSync(sealed, aad) };
    } catch {
      // 원인 문장(노드 crypto)은 「무결성 실패」 하나뿐이다 — 키나 값의 조각을 싣지 않는다.
      return { ok: false, reason: 'integrity', detail: '로컬 봉인이 안 열린다 — 다른 KEK 이거나 다른 행의 값이다' };
    }
  }
}

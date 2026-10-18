/**
 * 계정 PG 에 두는 비밀(TOTP 비밀키)을 감싼다 — AES-256-GCM.
 *
 * 키(`BARY_ACCOUNTS_KEK`, 32바이트 base64)는 **계정 PG 에 없다.** 덤프를 가져간 상대는 암호문만 든다.
 * 형식: `v1.<iv>.<ct>.<tag>` (base64url). 판 표시를 붙여 두면 키·방식을 바꿀 때 옛 값을 가린다.
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export class Sealer {
  readonly #key: Buffer;

  constructor(keyB64: string) {
    const key = Buffer.from(keyB64, 'base64');
    if (key.length !== 32) throw new Error('BARY_ACCOUNTS_KEK 는 32바이트를 base64 로 적은 값이어야 한다');
    this.#key = key;
  }

  seal(plain: Buffer, aad: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.#key, iv);
    // 행(사용자)에 묶는다 — 다른 사람의 행으로 옮겨 붙인 암호문은 안 풀린다.
    c.setAAD(Buffer.from(aad, 'utf8'));
    const ct = Buffer.concat([c.update(plain), c.final()]);
    return ['v1', iv, ct, c.getAuthTag()].map((x) => (typeof x === 'string' ? x : x.toString('base64url'))).join('.');
  }

  open(sealed: string, aad: string): Buffer {
    const [v, iv, ct, tag] = sealed.split('.');
    if (v !== 'v1' || iv === undefined || ct === undefined || tag === undefined) throw new Error('봉인 형식이 아니다');
    const d = createDecipheriv('aes-256-gcm', this.#key, Buffer.from(iv, 'base64url'));
    d.setAAD(Buffer.from(aad, 'utf8'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([d.update(Buffer.from(ct, 'base64url')), d.final()]);
  }
}

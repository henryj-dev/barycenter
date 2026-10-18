/**
 * 계정의 기초 부품 — scrypt · TOTP(RFC 6238) · 봉인 (계획 A 단계).
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { hashPassword, needsRehash, passwordProblem, verifyPassword } from '../../src/accounts/password.js';
import { Sealer } from '../../src/accounts/seal.js';
import { base32Encode, hotp, otpauthUri, stepOf, verifyTotp } from '../../src/accounts/totp.js';

describe('scrypt 비밀번호', () => {
  it('맞는 비밀번호만 통과하고, 형식에 매개변수가 들어 있다', async () => {
    const h = await hashPassword('correct horse battery');
    expect(h).toMatch(/^scrypt\$15\$8\$1\$[\w-]+\$[\w-]+$/);
    expect(await verifyPassword('correct horse battery', h)).toBe(true);
    expect(await verifyPassword('correct horse batterz', h)).toBe(false);
    expect(needsRehash(h)).toBe(false);
  });

  it('**같은 비밀번호도 해시가 다르다** (salt)', async () => {
    expect(await hashPassword('same-password-12')).not.toBe(await hashPassword('same-password-12'));
  });

  it('깨진 저장값은 던지지 않고 거짓이다 — 500 으로 계정이 드러나지 않게', async () => {
    for (const bad of ['', 'plain', 'scrypt$15$8$1$abc', 'bcrypt$x$y$z$a$b', 'scrypt$99$8$1$AAAA$BBBB']) {
      expect(await verifyPassword('whatever-password', bad)).toBe(false);
    }
  });

  it('옛 매개변수는 재해시 대상이다', () => {
    expect(needsRehash('scrypt$14$8$1$AAAA$BBBB')).toBe(true);
  });

  it('길이 규칙: 12자 이상, 1024바이트 이하. 조합 규칙은 없다', () => {
    expect(passwordProblem('short')).toBeDefined();
    expect(passwordProblem('aaaaaaaaaaaa')).toBeUndefined();
    expect(passwordProblem('x'.repeat(1025))).toBeDefined();
  });
});

describe('TOTP (RFC 6238 부록 B, SHA-1)', () => {
  const secret = Buffer.from('12345678901234567890', 'ascii');
  // 부록 B 는 8자리다 — 6자리는 그 끝 6자리와 같다(mod 10^6).
  const vectors: [number, string][] = [
    [59, '287082'], [1111111109, '081804'], [1111111111, '050471'],
    [1234567890, '005924'], [2000000000, '279037'],
  ];

  it('공식 시험 벡터와 같다', () => {
    for (const [t, want] of vectors) expect(hotp(secret, Math.floor(t / 30))).toBe(want);
  });

  it('맞으면 창 번호를 돌려주고, **같은 창은 두 번 못 쓴다**', () => {
    const t = 1111111111 * 1000;
    const step = verifyTotp(secret, '050471', t, 0);
    expect(step).toBe(stepOf(t));
    expect(verifyTotp(secret, '050471', t, step!)).toBeUndefined();
  });

  it('±1 창까지만 봐 준다', () => {
    const t = 1111111111 * 1000;
    const prev = hotp(secret, stepOf(t) - 1);
    const far = hotp(secret, stepOf(t) - 3);
    expect(verifyTotp(secret, prev, t, 0)).toBe(stepOf(t) - 1);
    expect(verifyTotp(secret, far, t, 0)).toBeUndefined();
  });

  it('6자리 숫자가 아니면 거절한다', () => {
    expect(verifyTotp(secret, '12345', 59_000, 0)).toBeUndefined();
    expect(verifyTotp(secret, 'abcdef', 59_000, 0)).toBeUndefined();
  });

  it('base32 와 otpauth 주소', () => {
    expect(base32Encode(Buffer.from('12345678901234567890'))).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(otpauthUri(secret, 'alice', 'barycenter')).toMatch(/^otpauth:\/\/totp\/barycenter:alice\?secret=GEZD/);
  });
});

describe('봉인 (AES-256-GCM)', () => {
  const key = randomBytes(32).toString('base64');

  it('같은 행 표시로만 열린다 — 다른 사람 행에 옮겨 붙이면 안 풀린다', () => {
    const s = new Sealer(key);
    const sealed = s.seal(Buffer.from('totp-secret'), 'totp:alice');
    expect(s.open(sealed, 'totp:alice').toString()).toBe('totp-secret');
    expect(() => s.open(sealed, 'totp:bob')).toThrow();
  });

  it('다른 키로는 안 열린다, 키 길이가 틀리면 기동하지 않는다', () => {
    const sealed = new Sealer(key).seal(Buffer.from('x'), 'a');
    expect(() => new Sealer(randomBytes(32).toString('base64')).open(sealed, 'a')).toThrow();
    expect(() => new Sealer(randomBytes(16).toString('base64'))).toThrow();
  });
});

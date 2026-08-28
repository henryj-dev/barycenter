/**
 * KEK 읽기 (DESIGN.md §4.8.1)
 *
 * **여기서 죽는 것이 이 함수의 일이다.** KEK 가 없거나 키가 아닌 채로 `PgSecretStore`
 * 가 뜨면, 운영자는 「암호화된 줄 알았다」를 발급 한참 뒤에 알게 된다. 기동에서
 * 죽으면 그 순간에는 아직 아무 자료도 안 들어갔다.
 *
 * 제일 흔한 실수를 못 박는다: **32 자 암호 문자열은 32 바이트 키가 아니다.**
 * 길이만 보면 통과하므로 디코드를 되돌려 확인해야 한다.
 */
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { KEK_BYTES, readKek } from '../../src/dp/secrets-pg.js';

describe('readKek', () => {
  it('base64 32 바이트를 받는다', () => {
    const raw = randomBytes(KEK_BYTES);
    expect(readKek(raw.toString('base64')).equals(raw)).toBe(true);
  });

  it('hex 32 바이트도 받는다 — 사람이 둘 중 하나로 준다', () => {
    const raw = randomBytes(KEK_BYTES);
    expect(readKek(raw.toString('hex')).equals(raw)).toBe(true);
  });

  it('앞뒤 공백을 털어낸다 — env 파일에서 흔하다', () => {
    const raw = randomBytes(KEK_BYTES);
    expect(readKek(`  ${raw.toString('base64')}\n`).equals(raw)).toBe(true);
  });

  it('**빈 값은 던진다** — 없는 것을 지어내면 「암호화된 줄 알았다」가 돌아온다', () => {
    expect(() => readKek('')).toThrow(/KEK/);
    expect(() => readKek('   ')).toThrow(/KEK/);
  });

  it('**32 자 암호 문자열을 키로 안 읽는다** — 길이만 보면 통과하는 자리다', () => {
    // 32 글자다. base64 로 디코드하면 24 바이트고, hex 도 아니다.
    const passphrase = 'correct-horse-battery-staple-abc';
    expect(passphrase).toHaveLength(32);
    expect(() => readKek(passphrase)).toThrow(/32 바이트/);
  });

  it('짧은 키를 늘려 쓰지 않는다 — 강도가 이름과 달라진다', () => {
    expect(() => readKek(randomBytes(16).toString('base64'))).toThrow(/32 바이트/);
    expect(() => readKek(randomBytes(64).toString('hex'))).toThrow(/32 바이트/);
  });
});

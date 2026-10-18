/**
 * TOTP — RFC 6238 (HMAC-SHA1, 30초, 6자리). 인증 앱(Google Authenticator 등)이 기본으로 맞추는 값이다.
 *
 * **같은 시간창을 두 번 받지 않는다.** 검증이 성공하면 그 창 번호(`step`)를 돌려주고, 저장소는
 * 그보다 크지 않은 창을 다시 거절한다 — 엿본 코드를 30초 안에 한 번 더 쓰는 길을 막는다.
 * 시계 어긋남은 앞뒤 한 창(±30초)까지만 봐 준다.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const PERIOD = 30;
const DIGITS = 6;
const WINDOW = 1;
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

/** 160비트 — RFC 4226 이 권하는 길이. */
export function newTotpSecret(): Buffer {
  return randomBytes(20);
}

export function hotp(secret: Buffer, counter: number): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', secret).update(msg).digest();
  const off = mac[mac.length - 1]! & 0x0f;
  const bin = ((mac[off]! & 0x7f) << 24) | (mac[off + 1]! << 16) | (mac[off + 2]! << 8) | mac[off + 3]!;
  return String(bin % 10 ** DIGITS).padStart(DIGITS, '0');
}

export function stepOf(nowMs: number): number {
  return Math.floor(nowMs / 1000 / PERIOD);
}

/**
 * 코드가 맞으면 그 창 번호, 아니면 undefined. `lastStep` 이하의 창은 맞아도 거절한다.
 */
export function verifyTotp(secret: Buffer, code: string, nowMs: number, lastStep: number): number | undefined {
  const c = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(c)) return undefined;
  const now = stepOf(nowMs);
  for (let d = -WINDOW; d <= WINDOW; d++) {
    const step = now + d;
    if (step <= lastStep) continue;
    const want = Buffer.from(hotp(secret, step));
    if (timingSafeEqual(want, Buffer.from(c))) return step;
  }
  return undefined;
}

/** 인증 앱에 넣는 주소. issuer 는 화면에 보이는 이름이다. */
export function otpauthUri(secret: Buffer, account: string, issuer: string): string {
  const label = `${encodeURIComponent(issuer)}:${encodeURIComponent(account)}`;
  const q = new URLSearchParams({ secret: base32Encode(secret), issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(PERIOD) });
  return `otpauth://totp/${label}?${q.toString()}`;
}

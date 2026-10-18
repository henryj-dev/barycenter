/**
 * 비밀번호 해시 — `node:crypto` scrypt. 의존성을 더하지 않는다.
 *
 * 형식: `scrypt$<log2 N>$<r>$<p>$<salt b64url>$<key b64url>`. 매개변수가 저장값에 들어 있어서
 * 기본값을 올려도 옛 해시가 그대로 검증되고, 로그인이 성공한 순간 새 매개변수로 다시 해시한다
 * (`needsRehash`).
 *
 * ⚠️ 매개변수·길이 규칙의 **수치는 공통 정책에서 아직 미정**이다. 여기 값은 권장 기본이다.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const LOG_N = 15;
const R = 8;
const P = 1;
const KEY_LEN = 64;
const SALT_LEN = 16;
/** N=2^15·r=8 은 32MiB 를 쓴다. 기본 상한(32MiB)에 딱 걸리므로 여유를 준다. */
const MAXMEM = 128 * 1024 * 1024;

export const PASSWORD_MIN = 12;
/** 상한이 없으면 1MB 비밀번호 하나가 scrypt 를 오래 붙든다. */
export const PASSWORD_MAX = 1024;

function scrypt(password: string, salt: Buffer, logN: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFC'), salt, KEY_LEN, { N: 2 ** logN, r, p, maxmem: MAXMEM }, (e, key) => {
      if (e) reject(e);
      else resolve(key);
    });
  });
}

/** 정책 위반이면 이유를, 받아 줄 수 있으면 undefined. 조합 규칙은 두지 않는다. */
export function passwordProblem(password: string): string | undefined {
  const n = [...password.normalize('NFC')].length;
  if (n < PASSWORD_MIN) return `비밀번호는 ${PASSWORD_MIN}자 이상이어야 한다`;
  if (Buffer.byteLength(password, 'utf8') > PASSWORD_MAX) return `비밀번호가 너무 길다 (${PASSWORD_MAX}바이트 이하)`;
  return undefined;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const key = await scrypt(password, salt, LOG_N, R, P);
  return `scrypt$${LOG_N}$${R}$${P}$${salt.toString('base64url')}$${key.toString('base64url')}`;
}

/** 형식이 틀린 저장값은 **거짓**이다 — 던지면 로그인 경로가 500 이 되고 그 차이로 계정이 드러난다. */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [logN, r, p] = [Number(parts[1]), Number(parts[2]), Number(parts[3])];
  if (![logN, r, p].every((x) => Number.isInteger(x) && x > 0) || logN > 20) return false;
  const salt = Buffer.from(parts[4]!, 'base64url');
  const want = Buffer.from(parts[5]!, 'base64url');
  if (want.length !== KEY_LEN) return false;
  const got = await scrypt(password, salt, logN, r, p);
  return timingSafeEqual(got, want);
}

export function needsRehash(stored: string): boolean {
  const parts = stored.split('$');
  return parts[0] !== 'scrypt' || Number(parts[1]) < LOG_N || Number(parts[2]) !== R || Number(parts[3]) !== P;
}

/**
 * **없는 계정도 같은 시간을 쓴다.** 계정이 없을 때 바로 거절하면 응답 시간으로 계정 유무가
 * 드러난다(열거). 그래서 고정된 더미 해시를 한 번 검증한다.
 */
let dummy: string | undefined;
export async function burnPasswordTime(password: string): Promise<void> {
  dummy ??= await hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(password, dummy);
}

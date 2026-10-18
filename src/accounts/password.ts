/**
 * 비밀번호 해시 — `node:crypto` scrypt. 의존성을 더하지 않는다.
 *
 * 형식: `scrypt$<log2 N>$<r>$<p>$<salt b64url>$<key b64url>`. 매개변수가 저장값에 들어 있어서
 * 기본값을 올려도 옛 해시가 그대로 검증되고, 로그인이 성공한 순간 새 매개변수로 다시 해시한다
 * (`needsRehash`).
 *
 * 수치는 **회원 공통 수치 1차**(2026-10-18 사용자 결정, orc 경유)다 — 7개 제품이 같은 값을 쓴다.
 * scrypt N=2^16·r=8·p=2 는 Cloudflare Workers 의 상한(N×r×p ≤ 2^20, isolate 128MB) 안에서 고른 OWASP 동급
 * 조합이다. 옛 매개변수(N=2^15·p=1)의 해시는 그대로 검증되고 다음 로그인 때 새 값으로 다시 저장된다.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';

const LOG_N = 16;
const R = 8;
const P = 2;
const KEY_LEN = 64;
const SALT_LEN = 16;
/** N=2^16·r=8 은 64MiB 를 쓴다. Node 기본 상한(32MiB)으로는 거부되므로 넉넉히 준다. */
const MAXMEM = 128 * 1024 * 1024;

export const PASSWORD_MIN = 8;
/**
 * **최대 길이는 두지 않는다**(공통 수치 1차). 해시 부담 공격은 비밀번호 규칙이 아니라 요청 본문 상한
 * (로그인·가입·재설정 64 KiB, `src/api/server.ts` `PASSWORD_BODY_MAX`)으로 막는다.
 */
const CLASSES_NEEDED = 3;

function scrypt(password: string, salt: Buffer, logN: number, r: number, p: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCb(password.normalize('NFC'), salt, KEY_LEN, { N: 2 ** logN, r, p, maxmem: MAXMEM }, (e, key) => {
      if (e) reject(e);
      else resolve(key);
    });
  });
}

/**
 * 정책 위반이면 이유를, 받아 줄 수 있으면 undefined (공통 수치 1차).
 * NFC 로 정규화한 뒤 **8자 이상**, 그리고 영소문자·영대문자·숫자·특수문자 **4종류 중 3종류 이상**.
 * 특수문자는 영문자·숫자가 아닌 모든 문자다(공백·한글 포함). 유출 목록 차단·정기 변경 강제는 두지 않는다.
 */
export function passwordProblem(password: string): string | undefined {
  const p = password.normalize('NFC');
  if ([...p].length < PASSWORD_MIN) return `비밀번호는 ${PASSWORD_MIN}자 이상이어야 한다`;
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((re) => re.test(p)).length;
  if (kinds < CLASSES_NEEDED) {
    return `비밀번호는 영소문자·영대문자·숫자·특수문자 중 ${CLASSES_NEEDED}종류 이상을 섞어야 한다`;
  }
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

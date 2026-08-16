#!/usr/bin/env node
/**
 * API 토큰을 만든다.
 *
 *   node scripts/token.mjs                 무작위 토큰과 해시를 함께 낸다
 *   node scripts/token.mjs <평문>          그 평문의 해시만 낸다
 *
 * **설정에는 해시만 들어간다.** 평문을 설정에 두면 그 파일이 곧 비밀이 되고, 감사
 * 로그·에러 메시지·코어 덤프로 새는 경로가 늘어난다. `TokenAuth` 는 평문 형식을
 * 아예 받지 않는다 — 편의를 열어 두면 그게 기본값이 된다.
 */
import { createHash, randomBytes } from 'node:crypto';

const plain = process.argv[2] ?? randomBytes(24).toString('base64url');
const hash = `sha256:${createHash('sha256').update(plain, 'utf8').digest('hex')}`;

if (process.argv[2] === undefined) {
  console.log(`토큰(평문, 지금 한 번만 보인다): ${plain}`);
}
console.log(`해시: ${hash}`);
console.log('');
console.log('BARY_TOKENS 예시:');
console.log(JSON.stringify([{ name: 'ops', scopes: ['read', 'write', 'apply'], hash }]));

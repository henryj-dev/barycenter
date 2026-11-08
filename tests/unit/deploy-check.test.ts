/**
 * `deploy/check.sh` — 배포 뒤 점검. 운영 서버에서 root 로 돌므로 **토큰이 argv 에 실리면 안 된다**
 * (`ps` 로 다른 사용자가 본다). curl 설정 파일(0600)로만 넘긴다.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'deploy', 'check.sh');
const src = readFileSync(SCRIPT, 'utf8');

describe('deploy/check.sh', () => {
  it('sh 문법이 맞다', () => {
    execFileSync('sh', ['-n', SCRIPT]);
  });
  it('토큰을 curl 인자로 넘기지 않는다 — 설정 파일(-K)로만', () => {
    expect(src).not.toMatch(/-H\s+["']?Authorization/);
    expect(src).toMatch(/umask 077; printf 'header = "Authorization: Bearer %s"\\n'/);
    expect(src).toMatch(/-K "\$AUTH"/);
  });
  it('운영 호스트 이름 · 주소를 품지 않는다 — 인자로만 받는다', () => {
    expect(src).not.toMatch(/tinyuniver\.se|10\.253\./);
  });
});

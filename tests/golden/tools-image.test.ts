/**
 * **도구 이미지는 망 없이 선다** — `tools-image.ts` 의 약속을 실물로 잰다.
 *
 * 골든의 `docker run` 은 이제 망을 안 탄다. 그 말이 참인지 `--network none` 으로 본다:
 * 망이 아예 없어도 프로브 도구 셋이 다 돌아야 한다. 옛 방식(`apk add` 를 매번)은
 * 여기서 `curl: not found` 로 죽는다 — CI 41347907696 에서 진 모양 그대로다.
 *
 *   npm run test:golden     (도커 필요)
 */
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { toolsImage } from './tools-image.js';

describe('골든 도구 이미지', () => {
  it('망이 없어도 curl · openssl · socat 이 돈다', () => {
    const out = execFileSync('docker', [
      'run', '--rm', '--network', 'none', '--entrypoint', '/bin/sh', toolsImage(), '-c',
      'set -e; curl --version | head -1; openssl version; socat -V | grep -m1 version; '
      + '/usr/local/openresty/bin/openresty -v 2>&1',
    ], { encoding: 'utf8', timeout: 60_000 });
    expect(out).toMatch(/^curl /m);
    expect(out).toMatch(/^OpenSSL /m);
    expect(out).toMatch(/socat .*version/m);
    expect(out).toMatch(/openresty\//);
  }, 180_000);
});

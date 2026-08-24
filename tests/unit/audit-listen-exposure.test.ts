/**
 * 검수 2026-08-22 · S-05a — **루프백 밖에 묶으면 그 사실을 말한다**
 *
 * 제어 API 에는 TLS 가 없다. 그런데 이 API 로 **개인키 PEM 이 본문에 담겨** 올라가고
 * Bearer 토큰이 매 요청에 실린다. 애플리케이션 기본값은 `127.0.0.1:8088` 이라 안전하지만,
 * 배포 이미지는 `BARY_LISTEN=0.0.0.0:8088` 이다.
 *
 * ── 계획이 틀렸던 자리 ──────────────────────────────────────────────────
 *
 * 처음 계획은 "이미지 기본값을 루프백으로 되돌린다" 였다. **그건 틀렸다** — 컨테이너
 * 안에서 `127.0.0.1` 에 묶으면 도커의 포트 퍼블리시가 닿지 못해 API 가 아예 안 열린다.
 * 0.0.0.0 은 컨테이너에서 **필요한** 값이다.
 *
 * 그래서 바인드를 바꾸는 대신 **드러낸다.** compose 가 루프백으로만 퍼블리시하는 것은
 * 파일 하나 고치면 사라지는 보호이고, 지금은 그 사실을 아무도 안 말해 준다.
 * 진짜 답은 TLS(S-05b)이고 그건 별건이다 — 그때까지 이 경고가 자리를 지킨다.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { isLoopbackBind } from '../../src/validate/sockets.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('제어 API 노출 (검수 S-05a)', () => {
  it('루프백만 루프백이다', () => {
    expect(isLoopbackBind('127.0.0.1')).toBe(true);
    expect(isLoopbackBind('127.0.0.53')).toBe(true);   // 127/8 전부
    expect(isLoopbackBind('::1')).toBe(true);
    expect(isLoopbackBind('::ffff:127.0.0.1')).toBe(true);  // v4-mapped

    expect(isLoopbackBind('0.0.0.0')).toBe(false);
    expect(isLoopbackBind('::')).toBe(false);
    expect(isLoopbackBind('10.0.0.5')).toBe(false);
    // 주소가 아닌 것을 "루프백이다" 로 읽으면 경고가 조용히 사라진다.
    expect(isLoopbackBind('localhost')).toBe(false);
    expect(isLoopbackBind('')).toBe(false);
  });

  it('데몬이 루프백 밖 바인드를 경고한다', () => {
    const src = readFileSync(join(ROOT, 'src/bin/barycenterd.ts'), 'utf8');
    expect(src).toContain('isLoopbackBind(');
    expect(src).toContain('listen.exposed');
  });

  it('이미지가 0.0.0.0 을 쓰는 이유를 적어 둔다', () => {
    // 다음 사람이 "보안 문제네" 하고 되돌리면 API 가 안 열린다. 이유가 파일에 있어야 한다.
    const dockerfile = readFileSync(join(ROOT, 'deploy/Dockerfile'), 'utf8');
    expect(dockerfile).toContain('BARY_LISTEN=0.0.0.0:8088');
    expect(dockerfile).toContain('BARY_ALLOW_PLAINTEXT_EXPOSED=1');
    expect(dockerfile).toMatch(/포트 퍼블리시|publish/);
  });
});

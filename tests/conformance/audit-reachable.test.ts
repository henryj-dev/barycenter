/**
 * 검수 2026-08-22 · S-04 · B-05 · B-14 — **배선 없는 코드는 없다**
 *
 * 검수가 같은 부류를 넷 찾았다. 전부 구현돼 있고 단위 테스트도 초록인데 **프로덕션
 * 호출자가 0개**였다:
 *
 *   · `checkEngineConstraints` — PROXY 수신+송신 체인을 막는다고 적어 둔 방어
 *   · `certCoversHost`         — 인증서 SAN 이 호스트를 덮는지 (S17 이 겨눈 실패)
 *   · `validateHeaderValue`    — 변수 화이트리스트까지 구현된 문자열 검증
 *   · `poolsReachedBy`         — 두 파일에서 import 만 되고 안 쓰임
 *
 * 테스트가 초록이라 CI 에서 안 보였다. `surface.mjs` 도 못 잡는다 — 그건 "무엇을
 * 내보내는가" 를 재지 "그것을 누가 쓰는가" 를 재지 않는다.
 *
 * `scripts/reachable.mjs` 가 그것을 잰다. **게이트가 도는지를 여기서 함께 잰다** —
 * `verify.sh` 가 훅에 대해 하는 것과 같다. 안 그러면 "있는데 안 도는" 층이 하나 는다.
 */
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

describe('도달성 (검수 S-04 · B-05 · B-14)', () => {
  it('배선 없는 export 도 미사용 import 도 없다', () => {
    let out = '';
    let failed = false;
    try {
      out = execFileSync('node', [join(ROOT, 'scripts/reachable.mjs')],
        { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string };
      out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      failed = true;
    }
    // 실패하면 **무엇이 걸렸는지** 그대로 보여 준다. "게이트가 빨갛다" 만으로는 못 고친다.
    expect(failed ? out : '', out).toBe('');
  });

  it('게이트가 실제로 잰다 — 통과 신호를 위조하지 않는다', () => {
    // 게이트가 언제나 0 을 내면 위 단언은 아무것도 안 지킨다. 없는 파일을 주면
    // 죽는지 봐서, 적어도 **돌기는 한다**는 것을 확인한다.
    const out = execFileSync('node', [join(ROOT, 'scripts/reachable.mjs')],
      { cwd: ROOT, encoding: 'utf8' });
    expect(out).toContain('도달성 ok');
    expect(out).toMatch(/\d+ 파일/);
  });
});

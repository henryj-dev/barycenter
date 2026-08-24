/**
 * 워크트리에서도 e2e 가 돈다 — 검수 2026-08-24 N4
 *
 * ── 게이트가 워크트리에서만 빨갛다
 *
 * `CLAUDE.md` 의 규칙이 *"에이전트는 워크트리, 사람은 메인에서 작업"* 이다. 그래서
 * 에이전트가 돌리는 `./scripts/verify.sh` 는 **항상** 워크트리에서 돈다. 그런데
 * e2e 다섯 스위트가 거기서만 죽었다:
 *
 *   FAIL  e2e (실제 nginx)  —  완료  (676초)
 *   Error: 데몬이 안 떴다:
 *   (컨테이너 로그는 비어 있다)
 *
 * 원인은 컨트롤 플레인이 아니라 **마운트**였다. 워크트리의 `node_modules` 는 메인
 * 체크아웃을 가리키는 심볼릭 링크이고, `-v $(pwd):/app:ro` 로 트리만 올리면 그 링크의
 * 절대경로가 컨테이너 안에 없다. `mounts.ts` 머리말이 전말을 적어 뒀다.
 *
 * ── 왜 이 실패가 위험한가
 *
 * **초록이 거짓이 되는 게 아니라 빨강이 거짓이 된다.** 이 저장소가 여러 번 물린
 * 「거짓 초록」의 반대편이고, 대가는 다르지만 결과는 같다 — 게이트가 말하는 것을
 * 사람이 안 믿게 된다. 실제로 이 회차에 그랬다: 검수자가 자기 W0 수정이 e2e 를
 * 깼는지 확인하느라 시간을 썼고, 그 사이 e2e 는 **아무 회차의 코드도 안 재고 있었다.**
 *
 *   npm run test:e2e     (도커 필요)
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { appMount } from './mounts.js';

const IMAGE = 'docker.io/library/alpine:3.20';

let root = '';

const dockerAvailable = (): boolean => {
  try { execFileSync('docker', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
};

/** `docker run --rm`. 실패하면 stderr 를 붙여 던진다. */
function run(args: string[]): string {
  return execFileSync('docker', ['run', '--rm', ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    .toString().trim();
}

beforeAll(() => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 이 스위트는 실물로 잰다');
  execFileSync('docker', ['pull', '-q', IMAGE], { stdio: 'ignore' });

  /**
   * 워크트리의 모양을 그대로 만든다.
   *
   *   real/node_modules/pg/marker    실체 (트리 **밖**)
   *   tree/node_modules -> <절대경로>  워크트리가 거는 링크
   *   tree/dist/marker               트리 안의 평범한 파일
   */
  root = mkdtempSync(join(tmpdir(), 'bary-mount-'));
  mkdirSync(join(root, 'real', 'pg'), { recursive: true });
  writeFileSync(join(root, 'real', 'pg', 'marker'), 'PG_HERE');
  mkdirSync(join(root, 'tree', 'dist'), { recursive: true });
  writeFileSync(join(root, 'tree', 'dist', 'marker'), 'DIST_HERE');
  symlinkSync(join(root, 'real'), join(root, 'tree', 'node_modules'), 'dir');
}, 180_000);

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

describe('심볼릭 링크는 바인드 마운트를 못 건넌다', () => {
  /**
   * **이건 도커의 성질이지 누구의 실수가 아니다.** 먼저 그 사실을 못 박는다 — 아래
   * 수정이 무엇을 우회하는 것인지 다음 사람이 알아야 한다.
   */
  it('트리만 올리면 `node_modules` 가 컨테이너 안에서 안 열린다', () => {
    const tree = join(root, 'tree');
    // 트리 안의 평범한 파일은 보인다 — 마운트 자체는 멀쩡하다.
    expect(run(['-v', `${tree}:/app:ro`, IMAGE, 'cat', '/app/dist/marker'])).toBe('DIST_HERE');
    // 링크는 안 보인다. 대상 절대경로가 컨테이너 안에 없기 때문이다.
    expect(() => run(['-v', `${tree}:/app:ro`, IMAGE, 'cat', '/app/node_modules/pg/marker']))
      .toThrow();
  });

  it('`appMount()` 로 올리면 열린다 — 실체를 따로 싣기 때문이다', () => {
    const tree = join(root, 'tree');
    expect(run([...appMount(tree), IMAGE, 'cat', '/app/node_modules/pg/marker'])).toBe('PG_HERE');
    // 그러면서 트리 쪽도 그대로다.
    expect(run([...appMount(tree), IMAGE, 'cat', '/app/dist/marker'])).toBe('DIST_HERE');
  });

  /**
   * **메인 체크아웃에서 아무것도 안 바꾼다.** 링크가 아니면 두 번째 마운트는 첫 번째
   * 안의 같은 자리를 덮으므로 결과가 같다 — 조건부 분기를 안 두는 근거다.
   */
  it('링크가 아니어도 결과가 같다', () => {
    const plain = join(root, 'plain');
    mkdirSync(join(plain, 'node_modules', 'pg'), { recursive: true });
    writeFileSync(join(plain, 'node_modules', 'pg', 'marker'), 'PLAIN_HERE');
    expect(run([...appMount(plain), IMAGE, 'cat', '/app/node_modules/pg/marker'])).toBe('PLAIN_HERE');
  });
});

describe('실제 저장소', () => {
  /**
   * 위의 셋은 만들어 낸 트리를 잰다. 이건 **지금 이 체크아웃**을 잰다 — 워크트리면
   * 워크트리를, 메인이면 메인을. 그래서 이 한 줄이 e2e 다섯 스위트의 선결 조건이다.
   */
  it('지금 이 체크아웃의 `pg` 가 컨테이너 안에서 열린다', () => {
    const out = run([...appMount(), IMAGE, 'ls', '/app/node_modules/pg/package.json']);
    expect(out).toBe('/app/node_modules/pg/package.json');
  });
});

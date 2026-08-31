/**
 * `verify.yml` 의 `install` 잡이 **언제 도는가.**
 *
 * 다섯 배포판 컨테이너는 비싸서 모든 PR 에 안 건다 — 바뀐 것이 설치의 입력일 때만
 * 돈다(#23 의 결정). 그 판정이 정규식 하나에 얹혀 있고, **정규식은 아무도 안 재면
 * 반드시 썩는다.**
 *
 * 실제로 썩었다. 필터가 `deploy/`·`tests/install/`·그 워크플로 셋이던 때 #28 이
 * `gui/package.json` 한 줄(typescript 7)을 바꿨고, 하네스가 안 돌았고, **머지된 main 이
 * 새 호스트에 설치가 안 되는 상태**가 됐다.
 *
 * ⚠️ 왜 다른 잡이 못 잡았는지가 이 파일의 존재 이유다. `.nvmrc` 는 **24** 이고
 * `install.sh` 가 세우는 것은 **22** 다 — 그래서 CI 의 `build (dist·gui)` 는 npm 11 로
 * 돌아 통과했고, 설치 컨테이너의 npm 10.9 는 같은 트리에서 ERESOLVE 로 죽었다.
 * **설치가 쓰는 npm 으로 도는 곳은 그 하네스뿐이다.** 필터가 좁으면 그 사실을
 * 아무도 안 잰다.
 *
 * 여기서는 워크플로에서 **그 값을 읽어 `grep -E` 를 그대로 돌린다.** 정규식을 이
 * 파일에 다시 적으면 그 사본이 원본과 갈라지는 날 초록인 채로 아무것도 안 지킨다.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const WORKFLOW = join(root, '.github', 'workflows', 'verify.yml');

/** 워크플로에 적힌 `TARGETS` 를 그대로 꺼낸다. */
function targets(): string {
  const src = readFileSync(WORKFLOW, 'utf8');
  const m = /^\s*TARGETS: '(.+)'$/m.exec(src);
  expect(m, 'verify.yml 에 TARGETS 가 없다').not.toBeNull();
  return m![1]!;
}

/** CI 가 하는 것과 **같은 판정** — `grep -E` 에 그 정규식을 그대로 먹인다. */
function matches(path: string): boolean {
  const rc = execFileSync('sh', ['-c',
    'printf "%s\\n" "$2" | grep -Eq "$1" && echo y || echo n',
    'sh', targets(), path,
  ], { encoding: 'utf8' }).trim();
  return rc === 'y';
}

describe('install 잡 경로 필터', () => {
  /**
   * **설치의 입력이 바뀌면 돈다.** `gui/package.json` 이 이 목록의 이유다 — 거기서
   * 한 번 새어 나갔다.
   */
  it.each([
    'deploy/install.sh',
    'deploy/Dockerfile',
    'tests/install/run.sh',
    'scripts/build.sh',
    '.nvmrc',
    'package.json',
    'package-lock.json',
    'gui/package.json',
    'gui/package-lock.json',
    '.github/workflows/verify.yml',
  ])('%s 가 바뀌면 하네스가 돈다', (path) => {
    expect(matches(path)).toBe(true);
  });

  /**
   * **넓히면 뜻을 잃는다.** 모든 PR 에서 돌 거라면 필터가 없는 것과 같고, 그러면
   * 임계 경로가 다섯 배포판만큼 늘어난다 — #15 가 873초를 254초로 줄인 직후에 한
   * 결정이다.
   */
  it.each([
    'src/control/plane.ts',
    'tests/unit/install-filter.test.ts',
    'docs/runbook-upgrade.md',
    'STATUS.md',
    'gui/src/routes/+page.svelte',
    '.github/workflows/nightly.yml',
    'tsconfig.json',
  ])('%s 만 바뀌면 안 돈다', (path) => {
    expect(matches(path)).toBe(false);
  });

  /**
   * 앵커가 없으면 `vendor/deploy/x` 같은 것이 걸린다 — 필터가 넓어지는 흔한 경로다.
   */
  it('앵커가 살아 있다 — 경로 가운데서 걸리지 않는다', () => {
    expect(matches('vendor/deploy/install.sh')).toBe(false);
    expect(matches('tests/unit/package.json')).toBe(false);
  });
});

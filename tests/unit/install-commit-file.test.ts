/**
 * **git 체크아웃이 아닌 트리로 깔아도 판을 안다** (2026-11-01, web-01).
 *
 * web-01 은 `git archive` 로 받은 트리에서 설치하고, 받은 쪽이 `.commit` 에 커밋을 남긴다. 설치 스크립트는
 * `git rev-parse` 만 봐서 판이 늘 `(git 아님)` 이었고, 전역의 지역 목록이 판 차이를 못 알렸다.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = readFileSync(join(root, 'deploy', 'install.sh'), 'utf8');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

/** 스크립트의 `commit_of` 함수만 떼어 그 트리에 돌린다. */
function commitOf(commitFile: string | undefined): string {
  const at = src.indexOf('commit_of() {');
  expect(at).toBeGreaterThan(-1);
  const fn = src.slice(at, src.indexOf('\n}\n', at) + 3);
  const dir = mkdtempSync(join(tmpdir(), 'bary-commit-'));
  dirs.push(dir);
  if (commitFile !== undefined) writeFileSync(join(dir, '.commit'), commitFile);
  return execFileSync('sh', ['-c', `${fn}\ncommit_of "$1"`, 'sh', dir], { encoding: 'utf8' }).trim();
}

describe('설치 판 (commit_of)', () => {
  it('**체크아웃이 아니면 .commit 을 읽는다** — 짧은 커밋으로', () => {
    expect(commitOf('5a0029196042e56205eb80daa16981add3dc2577\n')).toBe('5a00291');
  });

  it('.commit 이 없거나 커밋 모양이 아니면 지금처럼 「git 아님」이다', () => {
    expect(commitOf(undefined)).toBe('(git 아님)');
    expect(commitOf('not-a-commit; rm -rf /\n')).toBe('(git 아님)');
    expect(commitOf('')).toBe('(git 아님)');
  });

  it('설치가 판을 이 함수로 정한다', () => {
    expect(src).toMatch(/^NEW_COMMIT=\$\(commit_of "\$REPO"\)$/m);
  });
});

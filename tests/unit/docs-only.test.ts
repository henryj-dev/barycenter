/**
 * **문서만 바뀐 PR 은 비싼 잡을 건너뛴다** — 그 판정이 `scripts/docs-only.sh` 하나에 있다.
 *
 * 건너뛰는 쪽이 틀리면 코드가 바뀌었는데 도커 조각 · CodeQL 없이 초록이 된다. 그래서
 * 「문서가 아닌 것이 하나라도 섞이면 다 돈다」 와 「빈 목록이면 다 돈다」 를 잰다.
 * 스크립트를 그대로 돌린다 — 판정을 이 파일에 다시 적으면 사본이 원본과 갈라진다.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(root, 'scripts', 'docs-only.sh');

function docsOnly(files: string[]): boolean {
  const r = spawnSync('sh', [SCRIPT], { input: files.length ? files.join('\n') + '\n' : '', encoding: 'utf8' });
  expect([0, 1], r.stderr).toContain(r.status);
  return r.status === 0;
}

describe('문서만 바뀌었나', () => {
  it.each([
    [['CHANGELOG.md']],
    [['README.md', 'docs/runbook-install.md']],
    [['DESIGN.md', 'STATUS.md', 'TESTS.md']],
  ])('**문서만이면 건너뛴다** — %j', (files) => {
    expect(docsOnly(files)).toBe(true);
  });

  it.each([
    [['CHANGELOG.md', 'src/conf/render.ts']],
    [['README.md', 'package.json']],
    [['docs/x.md', '.github/workflows/verify.yml']],
    [['LICENSE']],
    [['docs/diagram.svg']],
    [['scripts/docs-only.sh']],
    [['notes.md.bak']],
  ])('**문서가 아닌 것이 하나라도 섞이면 다 돈다** — %j', (files) => {
    expect(docsOnly(files)).toBe(false);
  });

  it('**빈 목록이면 다 돈다** — 무엇이 바뀌었는지 모르면 건너뛰지 않는다', () => {
    expect(docsOnly([])).toBe(false);
  });

  it('두 워크플로가 이 스크립트를 부른다 — 판정이 한 군데다', () => {
    for (const wf of ['verify.yml', 'codeql.yml']) {
      const src = readFileSync(join(root, '.github', 'workflows', wf), 'utf8');
      expect(src, wf).toContain('scripts/docs-only.sh');
    }
  });
});

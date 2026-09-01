/**
 * `scripts/rotate-kek.mjs` 가 **산출물을 어디서 찾나** (§4.8.3).
 *
 * ── 왜 이 파일이 따로 있나
 *
 * 회전 스크립트를 처음 낼 때 `../dist` 를 정적으로 import 했다. 개발 체크아웃에서는
 * 돌았고 실물 PG 재현물도 초록이었다 — **거기엔 `dist` 가 있었기 때문이다.**
 *
 * **실배포에서는 없다.** `install.sh` 는 저장소를 **읽기만** 하고 빌드는 임시 디렉터리에서
 * 해서 `$APP_DIR/dist` 에 놓는다. `scripts/` 도 `$APP_DIR` 에 안 넣는다. 그래서
 * `runbook-spof.md` 가 시킨 명령이 설치된 호스트에서 `ERR_MODULE_NOT_FOUND` 로 죽었다.
 *
 * **재현물이 있는데도 못 잡은 이유가 요점이다** — 그 재현물은 개발 체크아웃에서만 돌았다.
 * 여기서는 **`dist` 가 없는 자리**로 스크립트를 옮겨 놓고 잰다.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SCRIPT = join(ROOT, 'scripts', 'rotate-kek.mjs');

/**
 * 스크립트를 **`dist` 가 없는 디렉터리**로 옮겨 놓고 돌린다 — 설치된 호스트의 모양이다.
 * (저장소에서 그냥 돌리면 첫 후보가 항상 맞아 이 경로를 못 잰다.)
 */
function runDetached(env: Record<string, string> = {}): { out: string; code: number } {
  const dir = mkdtempSync(join(tmpdir(), 'bary-rot-'));
  try {
    mkdirSync(join(dir, 'scripts'));
    const copy = join(dir, 'scripts', 'rotate-kek.mjs');
    copyFileSync(SCRIPT, copy);
    try {
      const out = execFileSync('node', [copy, '--to', 'x'], {
        encoding: 'utf8', env: { ...process.env, BARY_APP_DIR: '', ...env },
      });
      return { out, code: 0 };
    } catch (e) {
      const err = e as { stdout?: string; stderr?: string; status?: number };
      return { out: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 };
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

describe('회전 스크립트의 산출물 탐색', () => {
  /**
   * **모듈 스택을 던지지 않는다.** `ERR_MODULE_NOT_FOUND` 는 운영자에게 아무것도 안
   * 알려 준다 — 어디를 봤는지와 무엇을 하면 되는지를 말해야 한다.
   */
  it('**산출물이 없으면 어디를 봤는지 말하고 죽는다**', () => {
    const r = runDetached();
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/산출물\(dist\)을 못 찾았다/);
    expect(r.out).toMatch(/BARY_APP_DIR/);
    expect(r.out).not.toMatch(/ERR_MODULE_NOT_FOUND/);
  });

  /**
   * **설치된 호스트에서 돈다.** `$APP_DIR/dist` 를 가리키면 import 가 서고, 그 다음
   * 인자 검사까지 간다.
   *
   * ⚠️ **진짜 `dist` 를 안 쓴다.** 처음엔 저장소의 것을 심링크했는데 CI 의 `unit`
   * 조각에는 `dist` 가 없어서(빌드가 뒤에 있다) 거기서만 빨갰다 — **이 파일이 고치려던
   * 실수와 똑같은 것**을 재현물이 다시 저질렀다. 여기서 재는 것은 *"경로를 어떻게
   * 고르나"* 이지 그 모듈들이 무엇을 하느냐가 아니므로, 이름만 맞는 스텁으로 충분하다.
   */
  it('`BARY_APP_DIR` 를 주면 import 가 선다 — 인자 검사까지 간다', () => {
    const app = mkdtempSync(join(tmpdir(), 'bary-app-'));
    try {
      mkdirSync(join(app, 'dist', 'store'), { recursive: true });
      mkdirSync(join(app, 'dist', 'dp'), { recursive: true });
      // ESM 은 링크 시점에 **이름**을 본다 — 그래서 스텁도 같은 이름을 내야 한다.
      writeFileSync(join(app, 'dist', 'store', 'pg.js'), 'export class Db {}\n');
      writeFileSync(join(app, 'dist', 'dp', 'kek-source.js'),
        'export async function resolveKek() { return Buffer.alloc(32); }\n');

      const r = runDetached({ BARY_APP_DIR: app, BARY_DSN: '' });
      // import 를 지났다는 증거: 모듈 오류가 아니라 **인자 오류**로 죽는다.
      expect(r.out).not.toMatch(/못 찾았다|ERR_MODULE_NOT_FOUND/);
      expect(r.out).toMatch(/BARY_DSN 이 필요하다/);
    } finally { rmSync(app, { recursive: true, force: true }); }
  });
});

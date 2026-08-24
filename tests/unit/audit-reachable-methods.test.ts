/**
 * 도달성 게이트 — **public 메서드까지 센다** (검수 2026-08-24 G6)
 *
 * ── 왜 이 축이 필요했나
 *
 * 검수가 `FsSecretStore.versions()` 를 **손으로** 찾았다. 호출자가 0 개인 public
 * 메서드였고, 그것이 시크릿 GC 의 root 수집이 필요로 하던 재료였다(D1) — 재료가
 * 있는데 아무도 안 쓰고 있다는 사실이 그 결함의 신호였다.
 *
 * 게이트는 못 봤다. **export 된 이름만** 세기 때문이다. 클래스는 export 돼 있고
 * 쓰이므로 초록이었고, 죽은 것은 그 안의 메서드 하나였다.
 *
 * ── 이 파일이 재는 것
 *
 * 게이트를 **픽스처 트리**에 대고 돌린다. 이 저장소의 `src/` 는 초록이어야 하므로
 * 거기서는 아무 신호도 안 나온다 — 잡는지 보려면 잡힐 것을 만들어야 한다.
 *
 * 네 방향을 본다. 셋은 **잡지 말아야 할 것**이다 — 게이트가 시끄러우면 사람이 그
 * 목록을 안 읽게 되고, 그러면 정말 잡았을 때도 안 읽는다.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const GATE = resolve(dirname(fileURLToPath(import.meta.url)), '../../scripts/reachable.mjs');

let root = '';

/** 픽스처 파일 하나. 경로는 `src/` 기준이다. */
function file(rel: string, body: string): void {
  const path = join(root, 'src', rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, 'utf8');
}

/** 게이트를 돌린다. `{ ok, out }` — 죽어도 안 던진다. */
function run(): { ok: boolean; out: string } {
  try {
    const out = execFileSync('node', [GATE], {
      encoding: 'utf8',
      env: { ...process.env, BARY_REACHABLE_ROOT: root },
    });
    return { ok: true, out };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    return { ok: false, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bary-reach-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  // 공개 표면. 비어 있어도 게이트가 읽는다 — 없으면 표면 판정이 통째로 빈다.
  file('index.ts', 'export {};\n');
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('호출자 없는 public 메서드', () => {
  it('**잡는다** — 클래스는 쓰이는데 그 안의 메서드가 죽어 있다', () => {
    file('store.ts', `
      export class Store {
        keep(): number { return 1; }
        /** 아무도 안 부른다 — D1 의 \`versions()\` 가 이 모양이었다. */
        versions(): string[] { return []; }
      }
    `);
    file('user.ts', `
      import { Store } from './store.js';
      const s = new Store();
      void s.keep();
    `);
    // 클래스와 `keep` 은 쓰인다 — 즉 ② 로는 안 잡힌다. 그것이 이 축의 이유다.
    const { ok, out } = run();
    expect(ok).toBe(false);
    expect(out).toContain('Store.versions');
    expect(out).not.toContain('Store.keep');
  });

  it('`this.` 로만 쓰이는 메서드는 **안 잡는다** — 자기 클래스 안에서 살아 있다', () => {
    file('store.ts', `
      export class Store {
        run(): number { return this.helper(); }
        helper(): number { return 1; }
      }
    `);
    file('user.ts', `
      import { Store } from './store.js';
      const s = new Store();
      void s.run();
    `);
    expect(run().ok).toBe(true);
  });

  it('`private` 와 `#이름` 은 **안 잡는다** — 밖에서 부를 수가 없다', () => {
    file('store.ts', `
      export class Store {
        private hidden(): number { return 1; }
        #alsoHidden(): number { return 2; }
        run(): number { return this.hidden() + this.#alsoHidden(); }
      }
    `);
    file('user.ts', `
      import { Store } from './store.js';
      const s = new Store();
      void s.run();
    `);
    expect(run().ok).toBe(true);
  });

  it('공개 표면의 클래스는 **안 잡는다** — 밖의 소비자가 여기 안 보인다', () => {
    file('index.ts', `export { Store } from './store.js';\n`);
    file('store.ts', `
      export class Store {
        nobodyHereCallsThis(): number { return 1; }
      }
    `);
    expect(run().ok).toBe(true);
  });

  it('선언은 사용이 아니다 — 인터페이스에만 있는 이름으로 안 살아난다', () => {
    file('store.ts', `
      export interface Shape { versions(): string[]; }
      export class Store implements Shape {
        versions(): string[] { return []; }
        run(): number { return 1; }
      }
    `);
    file('user.ts', `
      import { Store } from './store.js';
      import type { Shape } from './store.js';
      const s: Shape & Store = new Store();
      void s.run();
    `);
    // `Shape.versions` 선언이 있다고 `Store.versions` 가 불리는 것은 아니다.
    // ② 가 한때 물렸던 함정("선언 자체가 사용으로 보인다")의 메서드 판이다.
    const { ok, out } = run();
    expect(ok).toBe(false);
    expect(out).toContain('Store.versions');
  });
});

/**
 * **DB 드라이버는 그 방언의 구현 파일에만 있다** (docs/adr-multi-db.md 「접근」)
 *
 * 경계(`src/store/db.ts`)를 세워도 드라이버를 아무 데서나 가져오면 경계는 이름뿐이다 —
 * 그 자리는 다음 방언을 더할 때 보이지 않는 PG 전용 경로로 남는다. 리더 선출이 정확히
 * 그랬다(`src/control/leader.ts` 가 `pg` 를 직접 썼다).
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '..', '..');
const SRC = join(ROOT, 'src');

/** 드라이버 패키지 → 그것을 가져와도 되는 파일. */
const DRIVERS: Record<string, RegExp> = {
  pg: /^src\/store\/pg(-[a-z-]+)?\.ts$/,
  mysql2: /^src\/store\/mysql(-[a-z-]+)?\.ts$/,
  'better-sqlite3': /^src\/store\/sqlite(-[a-z-]+)?\.ts$/,
  'node:sqlite': /^src\/store\/sqlite(-[a-z-]+)?\.ts$/,
};

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((d) =>
    d.isDirectory() ? walk(join(dir, d.name)) : d.name.endsWith('.ts') ? [join(dir, d.name)] : []);
}

describe('DB 드라이버의 자리', () => {
  it('**pg 는 src/store/pg*.ts 밖에서 가져오지 않는다** — 리더 선출도 경계 뒤에 있다', () => {
    const bad: string[] = [];
    for (const file of walk(SRC)) {
      const rel = relative(ROOT, file).split('\\').join('/');
      const text = readFileSync(file, 'utf8');
      for (const [pkg, allowed] of Object.entries(DRIVERS)) {
        const re = new RegExp(String.raw`(?:from|import)\s*\(?\s*['"]${escape(pkg)}['"]`);
        if (re.test(text) && !allowed.test(rel)) bad.push(`${rel} → ${pkg}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

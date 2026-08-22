/**
 * 검수 2026-08-22 · B-16(절반) — **종료할 때 durable store 락을 놓는다**
 *
 * `FileStore` 는 프로세스 간 단일 writer 를 락 파일로 지킨다. 그런데 `barycenterd` 의
 * SIGTERM 경로는 `election.release()` 만 부르고 **store 는 안 놓았다.**
 *
 * 리눅스에서는 `/proc/<pid>/stat` 의 시작 시각으로 죽은 주인을 가려내 회수되지만,
 * 그건 **폴백에 기대는 것**이다. 그 파일을 못 읽는 플랫폼에서는 `stillHolding` 이
 * "살아 있는 쪽으로" 틀리므로(안전한 방향이다) pid 가 재사용되면 다음 기동이 막힌다.
 * 깨끗하게 물러났으면 그 사실을 남기는 것이 맞다 — `election.release()` 가 `released_at`
 * 을 적는 것과 같은 이유다.
 *
 * ── B-16 의 나머지 절반은 여기 없다 ────────────────────────────────────
 *
 * `LeaderElection.tryAcquire` 가 재획득 때 옛 `pg.Client` 를 `end()` 하지 않는 것은
 * 고치지 않았다. **재현물을 못 썼기 때문이다** — "끊긴 것으로 관측됐는데 서버 세션은
 * 살아 있는" 상태를 밖에서 결정적으로 만들 방법이 없다(백엔드를 종료시키면 세션도
 * 함께 사라져 두 구현이 같은 결과를 낸다). 계획 §7.3 의 규칙대로 방어적으로 고치지 않고
 * 검수 항목으로 되돌린다.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FileStore, StoreLocked } from '../../src/dp/store-fs.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bary-release-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('종료 시 락 반납 (검수 B-16)', () => {
  it('재획득이 옛 락을 밟지 않는다 — 놓아야 다시 열린다', () => {
    const path = join(dir, 'state', 'agent.json');
    const first = FileStore.open(path);

    // 같은 프로세스가 두 번 열 수는 없다. 이게 락의 계약이다.
    expect(() => FileStore.open(path)).toThrow(StoreLocked);

    first.release();
    const second = FileStore.open(path);
    expect(second).toBeInstanceOf(FileStore);
    second.release();
  });

  it('데몬의 종료 경로가 store 를 놓는다', () => {
    // 위 계약이 있어도 **부르지 않으면 소용없다.** SIGTERM 경로는 election 만 놓고
    // store 는 그냥 두고 있었다 — 리눅스의 /proc 폴백에 기대는 상태였다.
    const src = readFileSync(join(ROOT, 'src/bin/barycenterd.ts'), 'utf8');
    const stop = src.slice(src.indexOf('const stop = ()'));
    expect(stop).toContain('.release()');
    // election 과 store 둘 다여야 한다.
    expect(stop.match(/\.release\(\)/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

#!/usr/bin/env node
/**
 * 드라이버 호환성 키트 — DESIGN.md §9.3
 *
 *   node scripts/driver-compat.mjs                       참조 드라이버
 *   node scripts/driver-compat.mjs /path/to/entry.mjs    사내 드라이버
 *
 * 코어를 수정하지 않고, 로더가 그 파일을 집어넣을 수 있는지와
 * capabilities 가 S14 표를 지키는지 잰다. 사내 레포의 CI 가 이걸 돌린다.
 *
 * 구현은 `tests/unit/driver-compat.test.ts` 다. 이 스크립트는 그 테스트를
 * 엔트리만 바꿔 돌리는 입구다 — 키트가 두 벌이면 갈라진다.
 */
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = process.argv[2] === undefined
  ? join(root, 'drivers', 'reference.mjs')
  : resolve(process.argv[2]);

const r = spawnSync(
  'npx',
  ['vitest', 'run', 'tests/unit/driver-compat.test.ts'],
  {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, BARY_DRIVER_ENTRY: entry },
  },
);
process.exit(r.status ?? 1);

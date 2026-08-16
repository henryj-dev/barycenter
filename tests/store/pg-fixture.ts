/**
 * 테스트용 PostgreSQL — **실물이다.**
 *
 * 인메모리 흉내로 대신하지 않는 이유가 있다. §4.0 이 제약을 세 층으로 나눴고 그중 두 층이
 * **DB 안에** 있다 — 단일 행 CHECK 와 복합 FK. 흉내로 검증하면 정작 검증해야 할 것을
 * 검증하지 않는다. 4차 검수의 교훈이 "모의로만 검증한 것은 실물에서 깨진다" 였고,
 * e2e 가 실제 nginx 를 띄우는 것과 같은 이유다.
 */
import { execFileSync } from 'node:child_process';

import { Db } from '../../src/store/pg.js';

const NAME = 'bary-pg-test';
const PORT = 55433;
export const DSN = `postgres://postgres:bary@127.0.0.1:${PORT}/bary`;

const docker = (...args: string[]): string =>
  execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/**
 * 앞선 실패가 남긴 컨테이너를 치운다.
 *
 * e2e 가 정확히 이걸로 두 번 간헐 실패했다 — 남은 컨테이너가 포트를 잡고 있어 다음
 * `docker run` 이 깨졌고, 재실행하면 통과하니 원인을 안 찾게 된다.
 */
export function startPg(): void {
  try {
    docker('rm', '-f', NAME);
  } catch {
    /* 없으면 그만 */
  }
  docker('run', '-d', '--name', NAME,
    '-e', 'POSTGRES_PASSWORD=bary', '-e', 'POSTGRES_DB=bary',
    '-p', `${PORT}:5432`, 'postgres:17-alpine');

  // **고정 sleep 은 거짓 실패를 만든다.** `pg_isready` 는 초기화 중에도 한 번 참을
  // 돌려줄 수 있어서(초기 부팅의 임시 서버), 실제 접속으로 확인한다.
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      docker('exec', NAME, 'psql', '-U', 'postgres', '-d', 'bary', '-c', 'SELECT 1');
      return;
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`PG 기동 실패: ${String(e)}`);
    }
  }
}

export function stopPg(): void {
  try {
    docker('rm', '-f', NAME);
  } catch {
    /* 이미 없으면 그만 */
  }
}

export function dockerAvailable(): boolean {
  try {
    docker('version', '--format', '{{.Server.Version}}');
    return true;
  } catch {
    return false;
  }
}

/**
 * 테스트마다 **깨끗한 상태**로 되돌린다.
 *
 * 시퀀스도 되돌려야 한다. 안 그러면 "리비전이 1 에서 시작한다" 같은 단언이 실행 순서에
 * 따라 달라지고, 그건 테스트가 아니라 소음이다.
 */
export async function reset(db: Db): Promise<void> {
  await db.query(`TRUNCATE audit, operations, plans, changesets, http_routes,
                           passthrough_routes, backends, listeners, pools,
                           config_head, config_revisions RESTART IDENTITY CASCADE`);
  await db.query(`ALTER SEQUENCE config_revision_seq RESTART 1`);
  await db.query(`ALTER SEQUENCE activation_epoch_seq RESTART 1`);
  await db.query(
    `INSERT INTO config_revisions (revision, model, created_by, note)
     VALUES (nextval('config_revision_seq'),
             '{"listeners":[],"httpRoutes":[],"passthroughRoutes":[],"pools":[],"backends":[]}'::jsonb,
             'system', '최초 리비전 — 빈 모델')`);
  await db.query(`INSERT INTO config_head (revision) VALUES (currval('config_revision_seq'))`);
}

export { Db };

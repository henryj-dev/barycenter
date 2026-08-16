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

/**
 * **파일마다 자기 PG 를 쓴다.**
 *
 * 처음엔 이름과 포트를 하나로 고정했는데, vitest 는 파일을 동시에 돌리므로 두 스위트가
 * 같은 컨테이너를 두고 싸웠다 — 하나는 `Conflict. The container name is already in use`,
 * 다른 하나는 앞엣것이 치운 컨테이너를 찾다가 실패. **e2e 포트에서 이미 겪은 모양이고,
 * 단독으로 돌리면 초록이라 "가끔 깨진다" 로 넘어가기 쉬운 종류다.**
 *
 * 컨테이너를 공유하고 테이블만 나누는 방법도 있지만, 그러면 `reset()` 이 남의 스위트
 * 데이터를 지운다. 격리가 싼 쪽을 고른다.
 */
export type PgHandle = { name: string; port: number; dsn: string };

export function pgFor(id: string): PgHandle {
  // 포트는 id 에서 결정적으로 뽑는다. 무작위로 고르면 재현이 안 된다.
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 4000;
  const port = 55400 + h;
  return { name: `bary-pg-${id}`, port, dsn: `postgres://postgres:bary@127.0.0.1:${port}/bary` };
}

const docker = (...args: string[]): string =>
  execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/**
 * 앞선 실패가 남긴 컨테이너를 치운다.
 *
 * e2e 가 정확히 이걸로 두 번 간헐 실패했다 — 남은 컨테이너가 포트를 잡고 있어 다음
 * `docker run` 이 깨졌고, 재실행하면 통과하니 원인을 안 찾게 된다.
 */
export function startPg(pg: PgHandle): void {
  try {
    docker('rm', '-f', pg.name);
  } catch {
    /* 없으면 그만 */
  }
  docker('run', '-d', '--name', pg.name,
    '-e', 'POSTGRES_PASSWORD=bary', '-e', 'POSTGRES_DB=bary',
    '-p', `${pg.port}:5432`, 'postgres:17-alpine');

  // **고정 sleep 은 거짓 실패를 만든다.** `pg_isready` 는 초기화 중에도 한 번 참을
  // 돌려줄 수 있어서(초기 부팅의 임시 서버), 실제 접속으로 확인한다.
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      docker('exec', pg.name, 'psql', '-U', 'postgres', '-d', 'bary', '-c', 'SELECT 1');
      return;
    } catch (e) {
      if (Date.now() > deadline) throw new Error(`PG 기동 실패: ${String(e)}`);
    }
  }
}

export function stopPg(pg: PgHandle): void {
  try {
    docker('rm', '-f', pg.name);
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
  // **표를 안 비우고 시퀀스만 되돌리면 다음 삽입이 PK 로 충돌한다.**
  // 실제로 `leadership` 을 빠뜨려서 리더 선출 테스트 넷이 깨졌다 — 증상은 "리더가 못
  // 됐다"(`tryAcquire` 가 false)였는데 원인은 코드가 아니라 픽스처였다.
  // **되돌리는 것과 비우는 것은 짝이다.** 하나만 하면 상태가 어긋난다.
  await db.query(`TRUNCATE audit, operations, plans, changesets, http_routes,
                           passthrough_routes, backends, listeners, pools,
                           leadership, config_head, config_revisions
                  RESTART IDENTITY CASCADE`);
  await db.query(`ALTER SEQUENCE config_revision_seq RESTART 1`);
  await db.query(`ALTER SEQUENCE activation_epoch_seq RESTART 1`);
  await db.query(`ALTER SEQUENCE leader_token_seq RESTART 1`);
  await db.query(
    `INSERT INTO config_revisions (revision, model, created_by, note)
     VALUES (nextval('config_revision_seq'),
             '{"listeners":[],"httpRoutes":[],"passthroughRoutes":[],"pools":[],"backends":[]}'::jsonb,
             'system', '최초 리비전 — 빈 모델')`);
  await db.query(`INSERT INTO config_head (revision) VALUES (currval('config_revision_seq'))`);
}

export { Db };

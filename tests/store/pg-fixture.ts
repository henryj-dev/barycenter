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
  //
  // **ephemeral 범위를 피한다.** 커널이 아웃바운드 소스 포트로 같은 번호를 먼저 집어가면
  // 컨테이너가 그 포트를 못 묶는다. 증상이 고약하다: `bind: address already in use` 인데
  // `docker ps` 에는 아무것도 없다 — 원인이 이 저장소 안에 안 보이므로 다음 사람은 자기
  // 변경을 의심하며 시간을 버린다.
  //
  // ★두 번 겪었다. 처음엔 55400+ 였고 macOS(49152–65535)에 걸렸다. 그래서 45000+ 로
  //  내렸는데 — **리눅스는 32768–60999 다.** 45000–48999 는 그 한복판이라, macOS 를
  //  피하면서 CI(리눅스) 로 문제를 옮겨 놓기만 했다. 2026-08-26 에 GitHub 러너에서
  //  45396 이 그렇게 깨졌다(`docker ps -a` 는 비어 있었다).
  //
  // 그래서 **둘 다의 아래**로 내린다. 등록된 포트 구간이고 어느 쪽 커널도 임시 포트로
  // 쓰지 않는 20000–23999 다.
  //
  //     리눅스  ip_local_port_range  32768–60999
  //     macOS   임시 포트            49152–65535
  //     여기    20000–23999          둘 다의 아래
  let h = 0;
  for (const ch of id) h = (h * 31 + ch.charCodeAt(0)) % 4000;
  const port = 20000 + h;
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
    '-p', `${pg.port}:5432`, 'docker.io/library/postgres:17-alpine');

  // **고정 sleep 은 거짓 실패를 만든다.** `pg_isready` 는 초기화 중에도 한 번 참을
  // 돌려줄 수 있어서(초기 부팅의 임시 서버), 실제 접속으로 확인한다.
  //
  // ★`-h 127.0.0.1` 이 핵심이다 — 빼면 안 된다(2026-08-26 실사고).
  //
  //  임시 서버는 **유닉스 소켓만** 연다. 그래서 소켓으로 물으면 초기화가 끝나기 전에
  //  "준비됐다" 가 나오고, 그 직후 임시 서버가 내려가면서 바깥에서 붙어 있던 연결이
  //  끊긴다 — `Connection terminated unexpectedly` 로 스위트가 깨진다. 컨테이너 로그가
  //  그 순서를 그대로 보여 준다:
  //
  //      [91] listening on Unix socket ...              ← 임시 서버
  //      [91] database system is ready to accept connections
  //      [92] shutting down
  //           PostgreSQL init process complete
  //      [1]  listening on IPv4 address "0.0.0.0"       ← 진짜 서버
  //
  //  로컬에서 잰 두 시점의 간격은 103ms 였다. 러너가 느린 날에는 그만큼 넓어진다 —
  //  그래서 "가끔 깨진다" 로 보이고 재실행하면 초록이라 원인을 안 찾게 된다.
  //
  //  TCP 로 물으면 임시 서버는 답할 수 없다. **테스트가 붙는 것과 같은 경로로 묻는
  //  것**이 준비 판정의 유일하게 정직한 형태다.
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      docker('exec', pg.name, 'psql', '-h', '127.0.0.1', '-U', 'postgres', '-d', 'bary', '-c', 'SELECT 1');
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
  //
  // **CASCADE 는 *참조하는* 쪽만 데려간다.** `certificates`·`tls_policies` 는 `listeners`
  // 가 참조하는 쪽이라 안 딸려온다 — 이름을 적어야 비워진다. 실제로 v0.6 에서 인증서
  // 행이 테스트 사이에 살아남았고, **읽기 엔드포인트로는 안 보였다**: 그쪽은
  // `config_revisions.model` 스냅샷을 읽는데 그 표는 목록에 있기 때문이다.
  // (`tests/store/api.test.ts` 의 '픽스처' 절이 표에 직접 묻는다.)
  // **`engine_settings` 도 넣는다** (011). 단일 행 표라 CASCADE 가 안 데려간다 —
  // 빠뜨리면 앞 테스트의 엔진 설정이 다음 테스트에 살아남고, 그건 픽스처가 만드는
  // 거짓이다. `certificates`·`tls_policies` 를 이름으로 적어야 했던 것과 같은 이유다.
  await db.query(`TRUNCATE audit, operations, plans, changesets, http_routes,
                           passthrough_routes, backends, listeners, pools,
                           sni_certificate_bindings, certificates, tls_policies,
                           engine_settings,
                           -- 운영 상태도 테스트 사이에 안 넘긴다 (013). 백엔드 삭제
                           -- 트리거가 정상 경로를 덮지만, 픽스처의 TRUNCATE 는 트리거를
                           -- 안 태운다 — 여기 안 적으면 앞 테스트의 판정이 살아남는다.
                           backend_drain, backend_health,
                           -- **시크릿 자료도** (023 · §4.8.1). PgSecretStore 는 내용
                           -- 주소라 같은 자료가 같은 PK 를 내고, 앞 테스트의 행이
                           -- 살아남으면 다음 테스트의 put 이 조용히 그것을 재사용한다.
                           -- (백틱을 쓰면 이 템플릿이 끊긴다 — 바로 위 문단 참조.)
                           secret_materials,
                           -- **헬스 이벤트와 그 커서도** (검수 B-08). 여기 없어서 seq 가
                           -- 테스트 사이에 넘어갔고, health_events 에 직접 쓰는 테스트가
                           -- 앞 테스트의 번호와 PK 로 충돌했다. engine_settings 때와
                           -- 같은 누락이다. (표 이름에 백틱을 쓰면 이 템플릿이 끊긴다.)
                           health_events, health_cursor,
                           leadership, config_head, config_revisions
                  RESTART IDENTITY CASCADE`);
  // 커서는 **단일 행 표**다 — 비웠으면 다시 넣어야 한다. 행이 없으면 `emit()` 의
  // `SELECT ... FOR UPDATE` 가 빈 결과를 받아 seq 를 매번 1 로 발급하고, 두 번째
  // 이벤트에서 PK 가 터진다. `config_head` 와 같은 짝이다.
  await db.query(`INSERT INTO health_cursor DEFAULT VALUES`);
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

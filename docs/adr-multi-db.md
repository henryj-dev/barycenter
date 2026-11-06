# ADR-MULTI-DB — 저장소를 PostgreSQL · MySQL(MariaDB) · SQLite 로 고른다

날짜: 2026-11-05
상태: 채택 — 1단계(공통 기반) · 2단계(SQLite, 아래 「2단계 — SQLite」) 구현. 데몬이 `sqlite:` 를 연다. 3단계(MySQL/MariaDB)는 아직이다
바꾸는 결정: DESIGN.md §11.2 「v0 는 PostgreSQL 하나만」

## 결론

설정 DB 와 계정 DB 는 각각 **DSN 스킴으로 백엔드를 고른다**(`postgres:` · `mysql:` · `mariadb:` · `sqlite:`).
코드와 DB 사이의 경계는 **`Database` 하나**(연결 · 트랜잭션 · 시뮬레이션 롤백 · 마이그레이션 · 닫기)와
**`LeaderLock` 하나**(리더 선출)다. `pg` 패키지는 PG 구현 파일(`src/store/pg*.ts`)에만 있다.

SQL 은 **저장소 함수 단위로 방언마다 나란히 둔다**(아래 「접근」의 (b)). 공통 SQL 생성 도우미(a)는 쓰지 않는다.
**PG 로 나가는 SQL 은 이 단계에서 한 글자도 바뀌지 않는다.**

방언 하나의 완료 조건은 DESIGN.md §11.2 가 적은 그대로다: **같은 불변식 스위트와 저장소 시험 묶음이
그 DB 로 CI 에서 통과한다.** 그 전에는 그 스킴을 받으면 기동을 거부한다.

## 배경

사용자 요구(2026-11-05): 「저장소를 PG / MySQL(MariaDB) / SQLite 모두 지원 — DB 종류를 가리지 않게.
SQLite 는 전역 모드까지.」

지금 코드의 PG 의존(2026-11-05, `origin/main` 571030e 에서 셌다):

| 항목 | 수 | 주된 자리 |
|---|---|---|
| `.query(` 호출 | 약 285 | `config-store.ts` · `control/*` · `accounts/service.ts` |
| 마이그레이션 SQL | 41 (설정 33 · 계정 8) | `src/store/migrations` · `src/store/account-migrations` |
| `FOR UPDATE` | 29 | 단일 행 머리(`config_head` · `health_cursor`) 직렬화 |
| `SKIP LOCKED` | 2 | ACME 주문 집기(`acme-store.ts`) |
| `ON CONFLICT` | 27 | upsert |
| `RETURNING` | 22 | 삽입 · 갱신 뒤 값 |
| `jsonb` | 53 | 모델 스냅샷 · 감사 · 봉투 |
| `::형` 변환 | 44 | `::text` · `::int` · `::jsonb` |
| `now()` · `interval` | 219 · 다수 | 시각과 만료 |
| `= ANY($n)` | 다수 | 배열 인자 |
| `CREATE TYPE`(enum) · `SEQUENCE` · 트리거 | 10 · 3 · 1 | 001 · 002 · 013 |
| advisory lock | 3 키 | 리더 선출 · 마이그레이션 두 계열 |

**변경 알림은 DB 기능을 쓰지 않는다.** 조사 전 가정은 「LISTEN/NOTIFY 로 SSE 를 낸다」 였으나 코드에는
LISTEN/NOTIFY 가 없다. SSE(`src/api/events.ts`)는 **프로세스 안** `EventHub` 다. 인스턴스 사이의 전파는
**주기 읽기**다 — 팔로워는 주기마다 활성 오퍼레이션과 헬스를 읽는다(ADR-CLUSTER). 그래서 `ChangeFeed`
인터페이스는 만들지 않는다. 쓰지 않는 기능의 추상은 시험할 것이 없는 거짓 약속이다. 어느 방언이 알림을
써야 하게 되면 그때 이 ADR 을 고친다.

## 범위

| DB | 최소 버전 | 이유 |
|---|---|---|
| PostgreSQL | 지금 시험하는 17 (하한은 지금과 같다) | 기준 구현 |
| MySQL | 8.0+ | `SKIP LOCKED` · CTE · `JSON` · `CHECK` 강제(8.0.16+) |
| MariaDB | 10.6+ | `SKIP LOCKED`(10.6) · `JSON`(LONGTEXT 별칭 + `JSON_VALID`) |
| SQLite | 3.35+ | `RETURNING`(3.35) · upsert(3.24) · `json_*` 내장 |

## 방언 차이

| 주제 | PostgreSQL | MySQL 8 / MariaDB 10.6 | SQLite 3.35 |
|---|---|---|---|
| 자리 표시 | `$1` | `?` | `?` 또는 `?1` |
| upsert | `ON CONFLICT … DO UPDATE` | `ON DUPLICATE KEY UPDATE` (대상 키를 고를 수 없다 — 유일 키가 둘이면 뜻이 달라진다) | `ON CONFLICT … DO UPDATE` |
| `RETURNING` | 있다 | 없다(MariaDB 는 `INSERT/DELETE … RETURNING` 만 10.5+) → **같은 트랜잭션 안에서 다시 읽는다** | 있다(3.35) |
| JSON | `jsonb` · `->` · `->>` · `@>` | `JSON` · `JSON_EXTRACT` · `->>`(MySQL) | `TEXT` + `json_extract` |
| 시각 | `timestamptz` · `now()` | `DATETIME(6)` UTC 로 저장 · `UTC_TIMESTAMP(6)` | ISO-8601 `TEXT` · `strftime('%Y-%m-%dT%H:%M:%fZ')` |
| 간격 | `now() - interval '1 day'` | `UTC_TIMESTAMP(6) - INTERVAL 1 DAY` | 앱이 경계 시각을 계산해 인자로 준다 |
| 형 변환 | `::text` · `::int` | `CAST(x AS CHAR)` · `SIGNED` | `CAST(x AS TEXT)` |
| `= ANY($n)` 배열 | 있다 | 없다 → `IN (?, ?, …)` 로 펼친다 | 없다 → `IN (…)` 또는 `json_each(?)` |
| enum | `CREATE TYPE … AS ENUM` | `ENUM(…)` 열 | `TEXT` + `CHECK (x IN (…))` |
| 시퀀스 | `SEQUENCE` · `nextval` | 없다 → 단일 행 카운터 표 + `UPDATE … ; SELECT` (같은 트랜잭션) | 없다 → 같은 방식 |
| bigint | 문자열로 받는다(OID 20 파서) | 드라이버 옵션 `supportBigNumbers` · `bigNumberStrings` | `safeIntegers` 또는 `TEXT` |
| 행 잠금 | `FOR UPDATE` · `SKIP LOCKED` | `FOR UPDATE` · `SKIP LOCKED` (InnoDB) | **없다.** 쓰기는 DB 전체가 한 줄 — `BEGIN IMMEDIATE` |
| 기본 격리 | READ COMMITTED | REPEATABLE READ | SERIALIZABLE(쓰기 직렬) |
| DDL 트랜잭션 | 된다 | **안 된다**(DDL 이 암묵 커밋) | 된다 |
| 트리거 · 함수 | PL/pgSQL | 트리거 문법이 다르다 | 트리거만, 문법이 다르다 |
| 세션 잠금(리더) | `pg_try_advisory_lock` | `GET_LOCK(name, 0)` | 없다 → 아래 「리더 선출」 |

## 접근 — (b) 저장소 함수 단위로 방언별 SQL 을 나란히 둔다

두 길을 비교했다.

- **(a) `Dialect` 도우미로 SQL 을 조립한다.** 285 곳의 SQL 을 도우미 호출로 바꿔야 한다. PG 로 나가는 문자열이
  **이 단계에서 바뀐다** — 「PG 동작 불변」을 시험만으로 증명해야 하고, 시험이 덮지 않는 문장(드문 오류 경로 ·
  운영 정리 작업)은 증명되지 않는다. 그리고 도우미가 덮지 못하는 차이가 이미 표에 있다: `RETURNING` 이 없으면
  **쿼리 수가 바뀌고**, upsert 의 대상 키는 MySQL 에서 고를 수 없고, SQLite 에는 행 잠금이 없다. 결국 일부는
  방언 분기를 손으로 쓰게 되고, 그러면 두 방식이 섞인다.
- **(b) 함수 단위로 나란히 둔다.** PG 문장은 그대로 남는다. 2 · 3 단계는 **함수 하나씩** 방언 문장을 더하고,
  같은 저장소 시험이 그 함수를 잰다. 방언마다 쿼리 수와 잠금 방식이 달라도 함수의 계약(입력 · 출력 · 불변식)만
  같으면 된다.

**(b) 를 고른다.** 위험이 작은 쪽이다 — 이 단계에서 PG SQL 이 바뀌지 않고, 차이를 감추는 대신 함수 안에서
드러낸다. 대가는 SQL 이 방언 수만큼 늘어나는 것이다. 그 대가는 시험이 받친다: 방언마다 같은 시험 묶음을 돈다.

경계는 하나다(`src/store/db.ts`).

| 이름 | 하는 일 |
|---|---|
| `Queryable` | `query(text, values)` — 풀 또는 트랜잭션 안의 연결 |
| `Database` | `dialect` · `query` · `tx` · `dryRun`(항상 롤백) · `migrate(set)` · `close` |
| `Dialect` | 방언의 이름과 능력(`$n`/`?` · `RETURNING` · `SKIP LOCKED` · DDL 트랜잭션 · 행 잠금). **SQL 을 만들지 않는다** — 저장소 함수가 이것을 보고 자기 문장을 고른다 |
| `LeaderLock` | 리더 잠금 한 번 시도 → 세션(토큰 · 시각 · 끊김 알림 · 놓기) 또는 사유 |
| `openDb(dsn)` | DSN 스킴으로 구현을 고른다. 구현이 없는 방언은 **기동을 거부**한다 |

방언 분기는 저장소 함수 안의 `switch (db.dialect.name)` 다. 기본 분기를 두지 않는다 — 방언을 더하면
타입 검사가 빠진 함수를 모두 가리킨다(`never` 검사).

## 불변식을 DB 마다 지키는 방법

### 리더 선출 (DESIGN.md §3.5)

계약: 잠금이 정본이다. 잠금을 쥔 뒤에 **엄격 단조** 토큰을 발급한다. 세션이 끊기면 그 순간부터 리더가 아니다.
최종 펜싱은 DP Agent 의 토큰 비교다(여기서 못 닫는 창을 그쪽이 닫는다).

| DB | 잠금 | 토큰 | 끊김 |
|---|---|---|---|
| PG (지금) | 전용 연결의 `pg_try_advisory_lock(0x6261, 0x7279)` | `nextval('leader_token_seq')` | 연결의 `error` · `end` |
| MySQL/MariaDB | 전용 연결의 `GET_LOCK('barycenter.leader', 0)` — 세션 잠금이고 연결이 끊기면 풀린다 | 카운터 표 `UPDATE … SET v = v + 1` 뒤 읽기, 한 트랜잭션 | 연결의 `error` · `end` |
| SQLite (2단계) | 잠금 파일 `<db>-leader.lock` 에 `BEGIN EXCLUSIVE` 를 프로세스 수명 동안 — SQLite 의 `fcntl` 잠금, 프로세스가 죽으면 커널이 푼다 | `bary_sequences` 카운터 + `leadership`, 한 쓰기 트랜잭션 | 잠금 파일의 inode 가 바뀜(1 초마다 본다) · 프로세스 종료 |

SQLite 는 세션 잠금이 없다. 후보는 잠금 파일과 DB 안 임대였고 **잠금 파일을 골랐다** — 근거는 아래 「2단계 — SQLite」.

### 직렬화 · 격리

PG 는 READ COMMITTED 위에서 **단일 행 머리를 `FOR UPDATE` 로 잠가** 쓰기를 줄 세운다(`config_head` ·
`health_cursor`). 격리 수준에 기대지 않고 잠금에 기댄다.

- MySQL/MariaDB: 같은 `FOR UPDATE` 가 InnoDB 행 잠금으로 같은 뜻이다. 다만 기본 격리가 REPEATABLE READ 라
  **잠그지 않은 읽기는 트랜잭션 시작 시점의 스냅샷**이다 — PG 의 READ COMMITTED 와 다르다. 연결마다
  `SET SESSION TRANSACTION ISOLATION LEVEL READ COMMITTED` 로 PG 와 맞춘다. gap lock 으로 교착이 늘 수 있어
  교착(`1213`)은 재시도 대상으로 둔다.
- SQLite: 쓰기 트랜잭션은 **`BEGIN IMMEDIATE`** 로 연다. DB 전체가 한 쓰기 잠금이라 `FOR UPDATE` 가 할 일을
  이미 한다(문장에서는 뺀다). `busy_timeout` 을 둔다. `SKIP LOCKED` 의 뜻(동시에 온 둘이 다른 주문을 집는다)은
  쓰기가 하나뿐이라 저절로 선다.

### 크래시 시맨틱

| DB | 커밋 내구성 | 설정 |
|---|---|---|
| PG | WAL · `fsync` | 지금 그대로 |
| MySQL/MariaDB | InnoDB redo log | `innodb_flush_log_at_trx_commit=1` 를 요구한다(기동 때 확인) |
| SQLite | WAL 모드 | `journal_mode=WAL` · `synchronous=FULL` · `foreign_keys=ON` 을 연결마다 건다 |

### 마이그레이션

계열(설정 · 계정) × 방언이다. PG 파일은 지금 자리(`src/store/migrations` · `src/store/account-migrations`)에
그대로 둔다. 다른 방언은 `src/store/dialects/<방언>/{migrations,account-migrations}/` 에 **같은 이름**의
파일을 둔다 — 이름이 곧 버전이고, 기록 표(`schema_migrations` · `account_schema_migrations`)는 방언과
무관하게 같다.

- 동시 실행 방지: PG 는 지금의 advisory 키(`'ba' 'mg'` · `'ba' 'ac'`). MySQL 은 `GET_LOCK` 대기형. SQLite 는
  `BEGIN EXCLUSIVE`.
- **MySQL 의 DDL 은 트랜잭션이 아니다.** 마이그레이션 하나가 중간에 깨지면 반쯤 적용된다. 그래서 MySQL 파일은
  **문장 하나가 한 단계**이고 다시 돌려도 안전하게(`IF NOT EXISTS` 류) 쓴다. 이 차이는 `Dialect.transactionalDdl`
  로 드러나고 실행기가 그 값을 본다.
- 같은 스키마인지 잰다: `src/store/schema-shape.ts` 의 `SchemaShape`(표 → 열 → 정규화한 형 · NULL 허용)와
  `compareShapes`. PG 는 `information_schema` 로 모양을 읽는다. 2 · 3 단계가 자기 방언의 읽기를 더하고,
  적합성 시험이 「PG 모양 = 그 방언 모양」 을 단언한다.

## SQLite 의 한계

SQLite 는 **파일**이다. 여러 호스트가 한 파일을 함께 쓰면 안 된다(NFS 위의 잠금은 믿을 수 없다).

- 지역 모드: 한 호스트의 한 데몬이면 된다. 클러스터 모드(`BARY_CLUSTER=1`, 여러 호스트가 설정 DB 하나를
  공유)는 **SQLite 를 거부한다.**
- 전역 모드: 전역과 지역이 **계정 DB 를 공유**한다(`BARY_ACCOUNTS_DSN`). 그래서 SQLite 전역 모드는 둘 중 하나다.
  1. 전역과 모든 지역이 **같은 호스트**에 있다.
  2. 설정 DB 만 SQLite 이고, 계정 DB 는 **공유 서버 DB**(PG · MySQL)다.
  이 판정은 2단계가 기동 검사로 넣는다(호스트가 다른 지역이 SQLite 계정 DB 를 가리키는 설정을 못 알아내므로,
  계정 DB 가 SQLite 이면 전역 · 지역 모두 같은 파일 경로이고 그 파일이 로컬인지를 확인한다).

## 설정

| 변수 | 뜻 |
|---|---|
| `BARY_DSN` | 설정 DB. 스킴이 백엔드를 고른다 |
| `BARY_ACCOUNTS_DSN` | 계정 DB. **따로 고른다** — 설정 DB 가 SQLite 여도 계정 DB 는 PG 일 수 있다 |

스킴: `postgres:` · `postgresql:`(PG) · `mysql:` · `mariadb:` · `sqlite:`. **스킴이 그 넷이 아니면 PG 로 본다** —
지금 받는 DSN(키워드 형식 `host=… dbname=…`, `socket:` 등)이 그대로 PG 로 간다. `BARY_DB_KIND` 같은 별도
변수는 두지 않는다. DSN 과 종류 변수가 어긋나는 설정(반만 맞는 설정)을 만들 수 없게 한다.

구현이 아직 없는 방언의 스킴을 받으면 **기동을 거부한다**(「2단계까지 지원하지 않는다」). 조용히 PG 로 시도하지 않는다.

## 단계

1. **공통 기반(이 단계).** ADR · `Database`/`LeaderLock` 경계 · `openDb` · 방언을 아는 마이그레이션 실행기와
   빈 방언 자리 · 스키마 모양 비교 · 방언 적합성 시험 골격(`BARY_TEST_DB=postgres|mysql|sqlite`, 지금은 postgres 만) ·
   CI 매트릭스 자리(postgres 만). PG SQL 과 쿼리 수는 바뀌지 않는다.
2. **SQLite.** 드라이버 의존성 결정(Node 22 의 `node:sqlite` 를 먼저 본다 — 새 의존성이 없다), 마이그레이션 두 계열,
   저장소 함수의 SQLite 분기, 리더 잠금, 전역 모드 기동 검사. CI 매트릭스에 `sqlite` 를 켠다.
3. **MySQL/MariaDB.** `mysql2` 의존성, 마이그레이션(비트랜잭션 DDL), 분기, `GET_LOCK` 리더, 두 서버를 매트릭스에.

## 완료 조건 (방언마다)

- `BARY_TEST_DB=<방언> npm run test:dialect` 가 CI 에서 통과한다(경계 · 마이그레이션 · 리더 · 스키마 모양).
- 같은 **저장소 시험 묶음**(`tests/store`)과 **불변식 스위트**가 그 DB 로 통과한다.
- `openDb` 가 그 스킴의 거부를 푼다. 이 셋이 서기 전에 거부를 풀지 않는다.

## 2 · 3 단계를 위한 주의 (1단계에서 남긴 것)

- **빌드가 방언 파일을 싣지 않는다.** `scripts/build.sh` 는 PG 계열 두 디렉터리만 `dist/` 로 복사한다.
  방언 파일을 채우는 커밋이 `src/store/dialects/**` 의 복사를 함께 더한다.
- **CI 매트릭스의 `db` 축은 잡 이름에 없다.** 값이 하나일 때는 이름이 겹치지 않는다. 둘째 값을 켜는 커밋이
  잡 이름(필수 검사 이름)을 정한다 — 이름을 바꾸면 브랜치 보호의 필수 검사도 같이 바꿔야 한다.
- **`openDb` · `openLeaderLock` 의 거부를 푸는 것이 마지막 커밋이다.** 완료 조건의 세 줄이 선 뒤에 푼다.
- 분기의 모양: 저장소 함수 안의 `switch (db.dialect.name)`. 지금 PG 문장은 그대로 `postgres` 갈래가 된다.
  `Queryable` 만 받는 함수(트랜잭션 안의 연결)는 방언을 모른다 — 방언을 같이 넘기거나 `Database` 를 받는
  쪽에서 고른다. 이 결정은 첫 함수를 옮길 때 한 번 정한다.
- 스키마 모양: PG 의 `uuid` · `cidr` · `interval` · `array` 는 다른 방언에 원형이 없다. 그 방언의 모양 읽기가
  자기 저장 형을 이 논리 형으로 맞춘다(`src/store/schema-shape.ts`).

## 2단계 — SQLite (2026-11-06)

### 드라이버: Node 내장 `node:sqlite`

새 런타임 의존성이 없다. 이 저장소의 Node 는 24(`.nvmrc` · `deploy/Dockerfile`)이고 `node:sqlite` 는 22.13 / 23.4 부터
플래그 없이 열린다. 필요한 것이 다 있다 — 준비 문장의 `columns()`(선언 형), `setReadBigInts`(2^53 위의 정수),
사용자 함수(`function`), SQLite 3.5x 내장. `better-sqlite3` 는 네이티브 빌드(알파인 이미지에 컴파일러)를 들인다.
`node:sqlite` 는 **열 때** `process.getBuiltinModule` 로 가져온다 — PG 만 쓰는 데몬은 이 모듈을 건드리지 않는다.

동기 API 를 비동기 경계로 감싼다(`src/store/sqlite.ts`):

- **쓰기 연결 하나 + 비동기 뮤텍스.** 트랜잭션은 `BEGIN IMMEDIATE`(시작할 때 쓰기 잠금). 같은 프로세스 안에서
  `busy_timeout` 으로 기다리면 동기 호출이 이벤트 루프를 막아 잠금을 쥔 쪽이 영영 못 끝난다 — 그래서 프로세스
  안은 뮤텍스, `busy_timeout`(5 초)은 다른 프로세스의 몫이다.
- **읽기 연결 하나.** 트랜잭션 밖의 `SELECT` 는 이쪽이다. WAL 이라 열린 쓰기 트랜잭션을 기다리지 않고 커밋된
  것만 본다 — PG 에서 풀의 다른 연결이 보는 것과 같다.
- 트랜잭션 안에서 트랜잭션 밖의 쓰기 · 중첩 트랜잭션을 부르면 **던진다**(기다리면 교착이다).

### 드라이버가 맞추는 것과 맞추지 않는 것

**SQL 을 만들지 않는다**는 결정은 그대로다. 드라이버는 문법 대응과 값의 모양만 맞춘다:

| 맞춘다 | 어떻게 |
|---|---|
| 자리 표시 `$n` | `?n` 으로 옮긴다(SQLite 의 `?NNN` — 번호가 곧 인자 자리라 뜻이 같다). 문자열 · 주석 안은 그대로 |
| `now()` · `gen_random_uuid()` | 사용자 함수. `now()` 는 PG 처럼 **트랜잭션 안에서 한 값**, 형식은 `toISOString()` 하나 — 문자열 비교가 시각 비교다 |
| 인자 | boolean → 1/0 · Date → ISO · 배열/객체 → JSON 텍스트 |
| 결과 | 열의 **선언 형**으로 PG 와 같은 JS 값(`int` → number · `bigint`/`INTEGER` 키 → decimal string · `boolean` · `timestamptz` → Date · `json_text` · `text_array` · `blob` → Buffer). 선언 형은 SQLite 계열 `001_init.sql` 머리말 |
| 제약 오류 | PG SQLSTATE 를 단다(`23505` · `23503` · `23514` · `23502`) — 저장소의 409/422 갈래가 방언마다 같다 |

맞추지 않는 것(저장소 함수가 갈래를 둔다): `FOR UPDATE`(뺀다 — 쓰기 트랜잭션 전체가 한 잠금이다) ·
`SKIP LOCKED`(뺀다 — 쓰기가 하나뿐이라 「동시에 온 둘이 다른 행을 집는다」 가 저절로 선다) · `::형` ·
`= ANY($n)`(→ `json_each`) · `jsonb` 연산 · `interval`(→ `strftime(…, now(), '+N seconds')` · `julianday`) · 시퀀스.

### 방언을 넘기는 방법 (1단계가 남긴 결정)

**`Queryable` 이 자기 방언을 든다**(`Queryable.dialect`). `Database` 와 그 `tx` · `dryRun` 이 주는 연결이 채운다.
`Queryable` 만 받는 함수도 받은 연결에서 방언을 안다 — 인자를 늘리지 않는다. 비어 있으면 PG 로 본다(시험의 가짜
연결 `{ query }` 가 그 모양이다. 실제 구현은 반드시 채운다).

갈래는 `byDialect(q, { postgres, sqlite })` 다(`src/store/db.ts`). 형이 **지금 구현이 있는 방언만** 요구한다 —
3단계가 `mysql` 을 더하면 타입 검사가 문장을 빠뜨린 자리를 모두 가리킨다. PG 문장이 SQLite 에서 그대로 같은 뜻인
자리(자리 표시 · `now()` 는 드라이버가 맞춘다)는 갈래 없이 문장 하나다.

### 마이그레이션: SQLite 계열은 최종 모양에서 시작한다

배포된 SQLite DB 가 없던 때에 시작했으므로 SQLite 계열의 `001_init.sql` 이 **PG 33 단계 뒤의 최종 모양**을 한 번에
만들고, `002`–`033` 은 같은 이름의 주석 파일이다(실행기는 이름이 PG 계열과 같아야 받는다). 계정 계열도 같다.
다음 마이그레이션(034~)부터는 PG 와 같이 한 파일이 한 단계다. 같은 모양인지는 `tests/dialect/schema-shape-pg.json`
(PG 의 모양)과 비교한다 — PG 회차가 「PG = 스냅숏」, SQLite 회차가 「SQLite = 스냅숏」 을 잰다.

실행기는 계열 하나를 **한 쓰기 트랜잭션**(`BEGIN IMMEDIATE`)으로, 파일 하나를 SAVEPOINT 하나로 돈다. 다른 프로세스의
동시 마이그레이션은 그 잠금이 막는다(PG 의 advisory 계열 잠금 자리).

옮기지 못한 것은 `001_init.sql` 머리말에 있다: 정규식 CHECK 는 `GLOB` · `length` 로 같은 집합을, `lower()` 는 ASCII 만,
`text[]` 의 원소 형은 검사하지 않는다(CHECK 안에서 `json_each` 를 못 쓴다).

### 리더: 잠금 파일

임대(lease)는 정본이 **시계**가 된다 — 갱신이 늦으면(GC 멈춤 · 디스크 지연) 다른 프로세스가 리더가 된 뒤에도 옛 리더가
다음 갱신까지 자기가 리더라고 믿는다. `O_EXCL` + PID 파일은 낡은 파일을 치우는 경쟁(둘이 같은 낡은 PID 를 보고
둘 다 지운다)과 PID 재사용이 있다. **SQLite 자신의 파일 잠금**은 POSIX `fcntl` 이라 프로세스가 죽으면 커널이 풀고
(advisory lock 이 세션 종료로 풀리는 것과 같다), 같은 프로세스의 두 연결도 SQLite 가 가른다. 남는 구멍은 잠금 파일을
**지우는** 것이다 — 그래서 세션이 1 초마다 inode 를 보고, 바뀌면 그 순간 리더가 아니다. 그 1 초 창은 DP Agent 의 토큰
비교(§3.5)가 무해하게 만든다. 시험: `tests/dialect/sqlite-boundary.test.ts`(다른 프로세스 · SIGKILL · inode · 토큰).

### 배치 검사

`src/store/sqlite-checks.ts` — 클러스터 모드 · 네트워크 파일시스템(리눅스 `statfs` 형 번호) · 전역 화면 + SQLite 계정
DB 에서 지역 API 가 이 호스트가 아님(이름을 풀어 이 호스트의 주소인지 본다)을 기동에서 거부한다. 계정 DB 만 PG 인
갈래(설정 DB 만 SQLite)는 지역이 어디 있어도 된다.

### CI

`verify.yml` 의 `db` 축에 `include: {group: render, db: sqlite}` — DB 를 쓰는 조각(store · dialect)만 SQLite 로 더 돈다.
잡 이름은 postgres 회차가 전과 같고 다른 방언에 ` · sqlite` 가 붙는다. 필수 검사는 `gate` · `codeql` 이라 그대로다
(`gate` 가 `verify` 를 `needs` 로 받는다).

### 완료 조건 — 2단계의 결과

- `BARY_TEST_DB=sqlite`: `tests/dialect`(SQLite 경계 시험 포함) 통과 · `tests/store` 57 파일 통과(473 통과 · 9 건너뜀).
- SQLite 에서 건너뛰는 시험 9 — 모두 PG 의 손발을 직접 재는 것이고, 지키는 불변식은 SQLite 짝이 잰다:
  - `cluster-follow` 「팔로워가 리더의 활성 세대를 따라간다」 7: 여러 호스트가 설정 DB 하나를 보는 클러스터 — SQLite 는
    클러스터 모드를 기동에서 거부한다.
  - `health` 「커서 발급이 직렬화된다」 1: `pg.Client` 둘로 PG 행 잠금을 잰다 — SQLite 짝(엇갈린 `db.tx` 둘 · 다른 연결의
    `BEGIN IMMEDIATE` 가 막힌다)이 같은 파일에 있다.
  - `audit-migrate-lock` 「잠금을 놓는다」 1: PG 의 `pg_locks` 를 본다 — SQLite 짝(마이그레이션 뒤 다른 연결의 쓰기가 끝난다)과
    「다른 프로세스가 쓰기를 쥔 동안 떠도 기다렸다 성공한다」 가 있다.
- **uuid 모양이 아닌 경로 id 는 모든 방언에서 400 이다**(2026-11-06). 처음에는 PG 가 `22P02` 로 400, SQLite 는 uuid 열이
  텍스트라 행이 없어 404 였다. 이제 경로가 DB 에 묻기 전에 모양을 본다(`src/api/server.ts` 의 `UUID_ID_PATH` · `canonicalUuid` —
  changeset · plan · operation · ACME 주문 · 챌린지). 받는 표기는 PG 의 `uuid_in` 그대로(대문자 · `{…}` · 하이픈 없음)이고 정규형으로
  바꿔 넘긴다 — 텍스트 uuid 열도 PG 와 같은 행을 찾는다. 답의 몸은 PG 의 `22P02` 답과 같다(`malformed`). 계정 경로는 서비스가 이미
  모양을 보고 404 를 낸다 — 그대로다.
- 같은 프로세스에서 같은 파일을 여는 `SqliteDb` 들은 쓰기 줄 하나를 함께 쓴다(`sqlite.ts` 의 `Shared`). 따로 두면 둘의 쓰기가
  파일 잠금에서 만나 진 쪽이 `busy_timeout` 동안 이벤트 루프를 막는다.

### 3단계(MySQL)를 위한 주의

- `byDialect` 의 형에 `mysql` 을 더하면 tsc 가 갈래 자리를 가리킨다. **갈래 없이 문장 하나인 자리는 가리키지 않는다**
  — 그 자리들은 「PG 와 SQLite 가 같은 문장」 이다. MySQL 드라이버도 `$n` → `?` 를 맞추면(순서 · 되풀이에 맞춰 인자
  배열을 다시 짠다) 대부분 그대로 돈다. 남는 것은 `RETURNING`(없다) · `ON CONFLICT`(→ `ON DUPLICATE KEY`) · `now()` 다.
  시험 묶음이 그 자리들을 잰다.
- 결과 모양을 PG 와 맞추는 일(선언 형 · `bigNumberStrings` · `DATETIME` → Date · JSON 파싱)은 드라이버에 둔다 —
  SQLite 가 한 방식이다.
- 제약 오류의 SQLSTATE 대응도 드라이버에 둔다(MySQL `1062` → `23505` · `1452` → `23503` · `3819` → `23514`).
- MySQL 의 DDL 은 트랜잭션이 아니다 — 최종 모양 한 파일로 시작하는 방식은 MySQL 에서 더 값지다(반쯤 적용될 단계가 하나다).

## 결과

- 좋다: PG 경로는 이 단계에서 문장도 쿼리 수도 그대로다. 방언 추가는 함수 단위로 리뷰할 수 있다.
- 나쁘다: SQL 이 방언 수만큼 는다. 한 방언만 고치고 다른 방언을 잊을 수 있다 — 같은 시험 묶음을 모든 방언으로
  도는 것이 그 방어다.
- 지금의 `pg.ts` 머리말과 DESIGN.md §11.2 의 「추상화해 두면 갈아 끼울 수 있다는 거짓이다」는 여전히 맞다.
  그래서 SQL 을 추상하지 않는다. 경계는 연결 · 트랜잭션 · 잠금만 감싸고, 방언의 차이는 함수 안에 드러난다.

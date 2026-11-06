# ADR-MULTI-DB — 저장소를 PostgreSQL · MySQL(MariaDB) · SQLite 로 고른다

날짜: 2026-11-05
상태: 채택 — 1단계(공통 기반) 구현. 2단계(SQLite) · 3단계(MySQL/MariaDB)는 아직이다
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
| SQLite | 한 호스트 안의 **잠금 파일**(`<db>.leader`, `O_EXCL` + 보유 PID 확인) 또는 DB 의 단일 행 임대 + 주기 갱신 | 카운터 표, `BEGIN IMMEDIATE` | 프로세스 종료 · 임대 만료 |

SQLite 는 세션 잠금이 없다. 2단계가 둘 중 하나를 고르고, **임대를 고르면 그 만료 시간이 토큰 창의 상한**이다 —
그 창은 DP Agent 의 펜싱이 무해하게 만든다는 §3.5 의 답에 기댄다.

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

## 결과

- 좋다: PG 경로는 이 단계에서 문장도 쿼리 수도 그대로다. 방언 추가는 함수 단위로 리뷰할 수 있다.
- 나쁘다: SQL 이 방언 수만큼 는다. 한 방언만 고치고 다른 방언을 잊을 수 있다 — 같은 시험 묶음을 모든 방언으로
  도는 것이 그 방어다.
- 지금의 `pg.ts` 머리말과 DESIGN.md §11.2 의 「추상화해 두면 갈아 끼울 수 있다는 거짓이다」는 여전히 맞다.
  그래서 SQL 을 추상하지 않는다. 경계는 연결 · 트랜잭션 · 잠금만 감싸고, 방언의 차이는 함수 안에 드러난다.

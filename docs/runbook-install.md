# 첫 설치 런북 — 깔기 전에 정할 것

`deploy/install.sh` 는 **명령 하나로 끝난다.** 그래서 이 문서는 "어떻게 깔까" 가 아니라
**"깔기 전에 무엇을 정해야 하나"** 에 답한다 — 뒤에 정하면 비싼 것들이 몇 개 있다.

두 번째 설치부터는 [`runbook-upgrade.md`](./runbook-upgrade.md) 다(재실행이 곧 업데이트다).
장애 대응은 [`runbook-spof.md`](./runbook-spof.md) 다.

전제는 §11.3 의 v1 권장 배포다 — **전용 VM 한 대**. systemd 에서는 엔진(`barycenter-engine`)과 데몬(`barycenterd`)이 별도 유닛이다 — 데몬을 재시작해도 트래픽이 안 끊긴다(#122).
Debian 11+ · Ubuntu 20.04+ · RHEL 계열 9·10 · Amazon Linux 2023 · Alpine 3.19+.
버전별 지원·거절과 패키지 출처는 `deploy/install.sh` ① 의 `DISTRO_TABLE` 한 곳에 있다.
EL 10 은 openresty.org 가 EL 10 판을 안 내서 **EL 9 의 OpenResty RPM 을 쓴다** (실측으로 선다).
node 는 **22 가 바닥**이고 스크립트가 없으면 깐다.

**사람 계정이 기본으로 켜진다**(공통 회원정책). `--with-postgres` 면 같은 PG 의 `bary_accounts` 에, 외부 PG 면
`--accounts-dsn` 으로 준 공용 계정 PG 에 둔다. 설치가 끝나면 **첫 관리자 링크**가 한 번 나온다 —
[`runbook-accounts.md`](./runbook-accounts.md).

## 1. 깔기 전에 정할 것

| | 고르는 것 | 뒤에 바꾸는 비용 |
|---|---|---|
| PostgreSQL | `--with-postgres` (같은 호스트, 유닉스 소켓 + peer 인증) 또는 `--dsn` | 낮다 — 덤프하고 옮기면 된다 |
| **시크릿 백엔드** | `fs`(기본) 또는 `pg` | **높다 — 아래를 읽는다** |
| KEK | `pg` 를 골랐을 때만 | 회전은 되지만 **분실은 복구 불가** |
| 리스너 주소 | 기본은 `127.0.0.1:8088` | 낮다 — env 한 줄 |
| TLS | 루프백 밖으로 열려면 **필수** | 낮다 |
| ACME | 기본 **켜짐** (`BARY_ACME=0` 으로 끈다) | 낮다 |
| 응답한 노드 이름 (`X-Served-By`) | 기본 **꺼짐** (`BARY_SERVED_BY=<별칭>` 으로 켠다) | 낮다 — 아래 「응답한 노드 이름」 |
| OIDC (GUI 로그인) | 나중에 붙여도 된다 | 낮다 |

### 시크릿 백엔드를 왜 지금 정하나

인증서의 **개인키와 체인이 어디 사는가**를 정하는 값이다.

    fs (기본)   $PREFIX/secrets 에 평문 0400. 디렉터리 권한이 유일한 경계다
    pg          DB 안에 봉투 암호화(AES-256-GCM). KEK 는 DB 밖에 산다 —
                덤프 하나로는 키가 안 나온다

**나중에 바꾸면 자료가 안 따라온다.** 두 저장소는 서로를 모른다 — `fs` 로 깔아 인증서를
올린 뒤 `pg` 로 바꾸면 새 저장소는 비어 있고, 설정의 `material_ref` 는 남아 있는데 자료가
없다. 그 상태는 `nginx -t` 와 API 의 `501` 로 드러나고, 복구는 **인증서를 전부 다시
올리는 것**이다(ACME 것은 새 주문으로). 설정은 안 잃는다 — 정본은 PG 다.

기본이 `fs` 인 이유는 `pg` 가 **KEK 를 어디 둘지**라는 새 문제를 만들기 때문이다.
그 결정을 안 한 배포를 조용히 바꾸지 않는다(§4.8.1).

**고르는 기준 한 줄:** DB 덤프가 인증서 개인키를 들고 다녀도 되는가. 안 된다면 `pg` 다.

### KEK — `pg` 를 골랐다면

32 바이트, base64 또는 hex:

```sh
openssl rand -base64 32
```

⚠️ **잃으면 인증서 자료를 영영 못 연다.** 덤프에 있는 것은 암호문뿐이고 그것이 이
드라이버의 요점이다. 그래서 **설치하는 날이 곧 KEK 백업의 날**이다:

- **덤프와 다른 곳**에 둔다. 같은 금고에 넣으면 봉투 암호화가 하는 일이 없다
- 그 자체의 백업을 따로 가진다 — VM 이 사라지면 `$PREFIX/env` 도 사라진다
- `--env BARY_SECRET_KEK_ID=<이름>` 으로 **이름을 붙여 둔다.** 회전이 그 이름으로
  진행 상황을 센다 — 기본값 `env` 로 두면 첫 회전에서 새 이름을 정해야 한다
  (`scripts/rotate-kek.mjs`, §4.8.3)

### 키를 파일로 안 두려면 — `BARY_SECRET_KEK_CMD`

`BARY_SECRET_KEK` 은 값을 그대로 받으므로 그 키가 `$PREFIX/env`(0640)에 **파일로 남는다.**
그게 싫으면 값 대신 **명령**을 준다 — 기동 때 한 번 돌려 stdout 을 KEK 로 쓰고, 키는
메모리에만 있다:

```sh
sudo deploy/install.sh --with-postgres \
  --env BARY_SECRET_BACKEND=pg \
  --env BARY_SECRET_KEK_CMD='aws kms decrypt --ciphertext-blob fileb:///etc/barycenter/kek.enc --query Plaintext --output text'
```

`vault read`·`gcloud kms decrypt`·`systemd-creds cat`·TPM 을 읽는 스크립트 — stdout 으로
32 바이트를 base64 나 hex 로 내기만 하면 무엇이든 된다. **벤더 SDK 를 안 들이는 것**이
이 모양을 고른 이유다 (§4.8.2).

⚠️ **명령은 키를 stdout 으로만 낸다.** stderr 는 진단 채널이라 **로그로 나간다** —
거기 키를 쓰는 명령은 그것을 로그에 쓰는 것이다. (오류에 명령 문자열이나 stdout 은
안 실린다. 실리는 것은 종료 코드와 stderr 뿐이다.)

⚠️ **둘을 같이 주면 안 뜬다.** 한 비밀에 출처가 둘이면 어느 쪽이 이기는지가 곧 사고다.
그리고 명령이 실패하면 데몬이 **안 뜬다** — 지어내면 *"암호화된 줄 알았다"* 가 그대로
돌아온다. 느린 KMS 를 위해 `BARY_SECRET_KEK_CMD_TIMEOUT_MS` 로 상한을 늘릴 수 있다
(기본 10초).

⚠️ **백업 대상이 바뀐다.** 이제 지켜야 하는 것은 KEK 자체가 아니라 **그 명령이 닿는
것**이다 — KMS 키, 그 키에 대한 권한, 암호문 파일. 그 셋 중 하나라도 잃으면 결과는
KEK 를 잃은 것과 같다.

### 사람 계정의 키와 공유 실패 제한 — 설정 표

사람 계정(`BARY_ACCOUNTS_DSN`)을 켰다면. 자세한 뜻 · 실패 · 옮기는 절차는 `docs/runbook-accounts.md` 「켜기」.

| env | 기본 | 뜻 |
|---|---|---|
| `BARY_ACCOUNTS_KEK` | — | TOTP 비밀을 감싸는 키(32 바이트 base64). 설치 스크립트가 만든다 |
| `BARY_ACCOUNTS_KEK_FILE` | — | 같은 키를 파일에서. 위와 **하나만** |
| `BARY_ACCOUNTS_KEK_CMD` | — | 같은 키를 명령 stdout 으로(`systemd-creds cat …`). 위와 **하나만**. 상한 `…_CMD_TIMEOUT_MS`(10초) |
| `BARY_ACCOUNTS_SEAL_KIND` | `local` | `vault-transit` 이면 `BARY_ACCOUNTS_VAULT_ADDR` · `_KEY` · `_TOKEN_FILE` 이 모두 필요 |
| `BARY_AUTH_LIMIT_STORE` | `memory` | `pg` 면 API 인증 실패를 계정 PG(`auth_throttle`)에서 노드가 함께 센다 |

### 리스너와 TLS

기본 `127.0.0.1:8088` 은 **루프백**이다. 넓은 인터페이스로 옮기려면 TLS 를 같이 준다 —
**스크립트가 그것 없이는 죽는다.** 이 API 로 개인키와 Bearer 토큰이 지나간다.

```sh
--listen 0.0.0.0:8088 --tls-cert /etc/ssl/api.crt --tls-key /etc/ssl/api.key
```

⚠️ **방화벽·보안그룹은 스크립트가 안 건드린다.** 리스너를 열었다는 것과 그 포트에
닿을 수 있다는 것은 다른 사실이다. 반대로 데이터 플레인이 여는 포트(80·443 등)도
따로 열어야 한다.

## 2. 깐다

```sh
git clone <저장소> && cd barycenter

# 같은 호스트에 PG 를 세우고, 시크릿은 DB 에 암호화해서 둔다
sudo deploy/install.sh --with-postgres \
  --env BARY_SECRET_BACKEND=pg \
  --env BARY_SECRET_KEK="$(openssl rand -base64 32)"
```

터미널에서 아무 옵션 없이 돌리면 같은 것들을 **물어본다.** 옵션으로 준 값은 안 묻는다 —
그래서 같은 스크립트가 사람 앞에서도 설정관리 도구 안에서도 같은 뜻이다.

⚠️ **KEK 를 셸 히스토리에 남기지 않는다.** 위 예시는 `$(...)` 라 화면에는 안 남지만
히스토리에는 명령이 남는다. 미리 만들어 파일에 넣고 읽는 편이 낫다.

## 3. 끝나면

스크립트가 **스스로 증명하고 끝낸다** — `/healthz` → `/readyz`(엔진이 붙었다) →
`bary status`(토큰이 맞물렸다). 그러니 사람이 할 일은 셋이다:

1. **토큰을 옮겨 적는다.** 평문은 그 화면에서 한 번만 보인다. 잃으면
   `--rotate-token` 으로 다시 깐다
2. **첫 apply 를 해 본다** — 리스너 하나를 열어 실제로 트래픽이 서는지 본다.
   `bary status` 는 제어 평면이 사는지만 말한다
3. **백업을 건다** (아래)

```sh
export BARY_URL=http://127.0.0.1:8088
export BARY_TOKEN=<설치가 보여 준 것>
node /opt/barycenter/dist/bin/bary.js status
```

### $PREFIX 안에 무엇이 생겼나

    $PREFIX/env           설정. 관리 키 + --env 로 준 것 (0640, KEK 가 여기 산다)
    $PREFIX/tokens.json   토큰 해시 (0640). 평문은 안 들어간다
    $PREFIX/generations   세대 디렉터리 — 활성은 심링크다
    $PREFIX/state         런타임 상태
    $PREFIX/logs          데몬·엔진 로그
    $PREFIX/secrets       fs 백엔드의 자료 (0700). pg 면 안 쓴다
    $PREFIX/run           소켓 (0700)

## 4. 1일차 백업

받아야 할 것이 무엇인지는 **시크릿 백엔드가 정한다**:

| | 받는 것 |
|---|---|
| 공통 | PostgreSQL 덤프 — **정본이다** |
| 공통 | `bary backup` — spec-only 매니페스트 + head 리비전 (시크릿 바이트 없음) |
| `fs` | `$PREFIX/secrets` |
| `pg` | 덤프에 이미 들어 있다 — **대신 KEK 를 다른 곳에** |

절차와 RTO/RPO 는 [`runbook-spof.md`](./runbook-spof.md) 다. **복구 리허설을 미루지
않는다** — 받아 두기만 한 백업은 복구된다는 증거가 아니다.

## 5. 첫 사고 때 볼 곳

```sh
systemctl status barycenterd          # alpine: rc-service barycenterd status
journalctl -u barycenterd -n 100      # alpine: tail -n 100 $PREFIX/logs/daemon.log
curl -fsS http://127.0.0.1:8088/healthz   # 데몬이 사는가
curl -fsS http://127.0.0.1:8088/readyz    # 엔진이 붙었고 드라이버가 답하는가
```

**`/healthz` 와 `/readyz` 는 뜻이 다르다.** 앞은 프로세스가 살아 있다는 것이고, 뒤는
**첫 apply 가 성립한다**는 것이다. 초록/빨강이 갈리면 엔진 쪽을 본다.

    /healthz 초록, /readyz 빨강   엔진이 안 붙었다 → $PREFIX/logs 의 엔진 error log
    둘 다 빨강                    데몬이 안 떴다 → journalctl. DSN·KEK 를 먼저 의심한다
    둘 다 초록인데 트래픽 없음      제어는 살아 있다. 그 다음은 셋으로 갈린다 —
                                  `bary status`(미완 전환이 있으면 `bary recover`) ·
                                  `bary get backends/status`(풀에 살아 있는 백엔드가
                                  있는가) · `bary get rendered`(설정이 정말 그런가)

`pg` 백엔드에서 **KEK 가 틀리면 데몬이 아예 안 뜬다.** 그건 결정이다 — 없는 것을
지어내면 *"암호화된 줄 알았다"* 가 그대로 돌아오고, 아직 아무 자료도 안 들어간 그 시점에
죽는 편이 정직하다.

## 5½. SQLite 로 깔기 (단일 노드)

PG 없이 한 호스트에 띄울 때다. 설계와 한계는 [`adr-multi-db.md`](./adr-multi-db.md) 「SQLite」 다.

> **상태(2단계, 2026-11-06):** 데몬이 `sqlite:` DSN 을 받는다. 같은 저장소 시험 묶음(`tests/store`)과 방언 적합성 묶음이 `BARY_TEST_DB=sqlite` 로 통과한다(CI 의 `verify (render · sqlite)`).

```
BARY_DSN=sqlite:/var/lib/barycenter/bary.db               # 설정 DB. 절대 경로만 받는다
BARY_ACCOUNTS_DSN=sqlite:/var/lib/barycenter/accounts.db  # 계정 DB. 따로 고른다 — PG 여도 된다
```

- **Node 22.13+ (권장 24).** 드라이버는 Node 내장 `node:sqlite` 다 — 따로 깔 것이 없다.
- 파일은 **로컬 디스크**에 둔다. 디렉터리는 데몬 사용자가 쓸 수 있어야 한다 — 옆에 `-wal` · `-shm` ·
  `-leader.lock` 파일이 생긴다. 지우지 않는다(`-leader.lock` 을 지우면 그 순간 리더가 물러난다).
- 연결마다 `journal_mode=WAL` · `synchronous=FULL` · `foreign_keys=ON` · `busy_timeout=5000` 이다.

**기동을 거부하는 조합** — 사유를 말하고 멈춘다:

| 조합 | 왜 |
|---|---|
| `BARY_CLUSTER=1` + SQLite(설정 · 계정 어느 쪽이든) | 클러스터는 여러 호스트가 DB 를 공유한다. 파일은 못 한다 |
| 파일이 NFS · SMB/CIFS · Ceph · AFS · Lustre 위(리눅스) | 네트워크 파일시스템의 파일 잠금을 믿을 수 없다. 다른 OS 는 이 검사를 하지 않는다 — 직접 확인한다 |
| `BARY_GLOBAL_HOST` + SQLite 계정 DB + 다른 호스트의 지역 | 전역과 지역은 계정 DB 를 공유한다. 같은 호스트에 두고 지역 API 를 루프백 주소로 적거나, 계정 DB 를 PG 로 둔다 |

**백업 — 파일을 그대로 복사하지 않는다.** WAL 모드에서는 커밋된 내용 일부가 아직 `-wal` 파일에만 있다.
본 파일만 복사하면 최근 커밋이 빠지거나, 복사 도중의 쓰기로 깨진 사본이 된다. 데몬이 도는 채로 일관된
사본을 만든다:

```sh
sqlite3 /var/lib/barycenter/bary.db "VACUUM INTO '/backup/bary-$(date +%F).db'"
sqlite3 /var/lib/barycenter/accounts.db "VACUUM INTO '/backup/accounts-$(date +%F).db'"
```

(`sqlite3` CLI 의 `.backup` 도 온라인 백업 API 라 같다.) 복구는 데몬을 멈추고 사본을 제자리에 두고
`-wal` · `-shm` 을 지운 뒤 띄운다. 시크릿 백엔드가 `fs` 면 `$PREFIX/secrets` 도 같이 받는다(위 4절).

**한계:** 쓰기는 DB 전체가 한 줄이다 — 한 노드의 제어 평면에는 넉넉하지만 쓰기를 늘려 받을 방법은 없다.
다른 프로세스(운영 도구)가 쓰기 트랜잭션을 쥐고 있으면 데몬의 쓰기가 최대 5 초 기다리고 그 뒤 실패한다.
SQLite 와 PG 사이를 옮기는 행 단위 이주 도구는 없다 — `bary backup` 매니페스트로 설정을 새 DB 에 다시 넣는다(리비전 이력 · 계정 · 감사는 옮겨지지 않는다).

`BARY_SECRET_BACKEND=pg` 는 「설정 DB 에 암호화해 둔다」 는 뜻이다 — 설정 DB 가 SQLite 면 그 파일에 들어간다. 그러면 위 백업 사본에 암호문이 들어 있고, KEK 는 따로 지킨다(4절과 같다).

## 5¾. MySQL · MariaDB 로 깔기

PG 대신 MySQL 8 · MariaDB 를 쓸 때다. 서버 DB 라 **클러스터 모드(`BARY_CLUSTER=1`)도 된다** — 노드들이 같은 서버 하나를
함께 쓴다. 설계와 한계는 [`adr-multi-db.md`](./adr-multi-db.md) 「3단계 — MySQL/MariaDB」 다.

> **상태(3단계, 2026-11-06):** 데몬이 `mysql:` · `mariadb:` DSN 을 받는다. 같은 저장소 시험 묶음과 방언 적합성 묶음이 `BARY_TEST_DB=mysql` · `=mariadb` 로 통과한다(CI 의 `verify (render · mysql)` · `verify (render · mariadb)`). 클러스터 모드를 데몬 둘로 쟀다(리더 승격 · 스탠바이 503).

```
BARY_DSN=mysql://bary:<비밀번호>@db.internal:3306/bary            # 설정 DB. MariaDB 는 mariadb:// (같은 구현이다)
BARY_ACCOUNTS_DSN=mysql://bary:<비밀번호>@db.internal:3306/bary_accounts   # 계정 DB. 따로 고른다 — PG · SQLite 여도 된다
# 인자: ?socket=/run/mysqld/mysqld.sock (유닉스 소켓) · ?ssl=true (시스템 CA 로 검증) · ?sslca=/etc/barycenter/db-ca.pem
```

비밀번호의 특수 문자는 퍼센트 인코딩한다. DSN 을 env 에 두기 싫으면 PG 와 같은 방식(환경 파일의 권한 `0600`)을 따른다.

**서버 버전:** MySQL **8.0.29+**(시험은 8.4 LTS) · MariaDB **10.6+**(시험은 11). 낮으면 첫 연결에서 거부한다.

**DB 와 사용자** — DB 는 `utf8mb4` · `utf8mb4_bin` 으로 만든다(표는 그것을 스스로 적지만 DB 의 기본값도 맞춘다):

```sql
CREATE DATABASE bary CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE DATABASE bary_accounts CHARACTER SET utf8mb4 COLLATE utf8mb4_bin;
CREATE USER 'bary'@'10.0.0.%' IDENTIFIED BY '<비밀번호>';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES, TRIGGER ON bary.*          TO 'bary'@'10.0.0.%';
GRANT SELECT, INSERT, UPDATE, DELETE, CREATE, ALTER, INDEX, DROP, REFERENCES, TRIGGER ON bary_accounts.* TO 'bary'@'10.0.0.%';
```

- `TRIGGER` 는 마이그레이션이 트리거를 만들기 때문이다(백엔드 운영 상태 정리 · 연쇄 삭제 몇 자리 — ADR). **MySQL 에서 바이너리 로그가
  켜져 있으면**(8.x 기본) 트리거를 만드는 데 `SUPER` 가 더 필요하다. 셋 중 하나를 고른다: 첫 기동(마이그레이션)만 관리자 계정의 DSN
  으로 띄운다 · `log_bin_trust_function_creators=1` 을 켠다 · 사용자에게 `SUPER`(8.x 는 `SET_USER_ID` 류)를 준다.
  이것을 안 하면 첫 기동이 `You do not have the SUPER privilege and binary logging is enabled` 로 멈춘다 — 그대로 고치고 다시 띄우면
  된다(아래 「반쯤 적용」).
- 리더 잠금(`GET_LOCK`)은 권한이 필요 없다.

**서버 설정** — 기동이 확인하는 것과 확인하지 않는 것:

| 설정 | 값 | 확인 |
|---|---|---|
| `innodb_flush_log_at_trx_commit` | `1` | 기동(마이그레이션)이 확인하고 아니면 거부한다 — 아니면 커밋한 리비전 · 리더 토큰이 서버 크래시에 사라질 수 있다 |
| `binlog_format` (MySQL) | `ROW`(8.x 기본) | 확인하지 않는다. 연결은 `READ COMMITTED` 라 `STATEMENT` 면 쓰기가 실패한다 |
| 기본 엔진 | InnoDB | 표가 `ENGINE=InnoDB` 를 적는다(`NO_ENGINE_SUBSTITUTION` — 없으면 실패한다) |
| `wait_timeout` | 아무 값 | 리더 연결은 자기 세션의 값을 올리고 2 초마다 잠금을 확인한다 |

연결마다 드라이버가 거는 것: `time_zone='+00:00'` · `READ COMMITTED` · `utf8mb4_bin` · 엄격한 `sql_mode`. 서버의 전역 값을 바꿀 필요는 없다.
**사람이 `mysql` 클라이언트로 시각을 넣으면 세션 시간대를 `+00:00` 으로 둔다** — `DATETIME` 은 시간대가 없어서 다른 시간대로 넣은 시각은
그대로 틀린 시각이 된다.

**클러스터 모드:** 모든 노드가 **같은 기본 서버 하나**에 붙는다. 리더 선출은 서버의 이름 잠금(`GET_LOCK`)이고, 이름 잠금은 노드 사이에
나뉘지 않는다 — **Galera · Group Replication 다중 기본 · 노드마다 다른 복제본**을 가리키면 리더가 둘이 된다. 앞단에 프록시를 둔다면
쓰기를 한 서버로만 보내는 설정이어야 한다. 기본 서버가 바뀌면(장애 조치) 리더 연결이 끊기므로 그 순간 리더가 물러나고, 새 서버에서 다시
뽑는다. 비동기 복제본으로 넘어가면 덜 받은 커밋(리더 토큰 포함)이 사라질 수 있다 — PG 의 비동기 복제와 같은 한계이고, 낡은 리더의 쓰기는
DP Agent 의 토큰 비교가 막는다(DESIGN §3.5).

**반쯤 적용된 마이그레이션.** MySQL 의 DDL 은 트랜잭션이 아니다. 마이그레이션이 중간에 깨지면 기동 로그가
`마이그레이션 <파일> 의 N/M 번째 문장이 실패했다 — 앞 문장들은 이미 적용됐다` 를 말하고 멈춘다. 원인(권한 · 디스크)을 고치고 **그대로 다시
띄운다** — 파일의 모든 문장이 다시 돌아도 안전하게 쓰여 있고(`IF NOT EXISTS` 류), 그 파일은 끝까지 성공해야 기록된다. 손으로 표를 지우지
않는다.

**백업:** `mysqldump --single-transaction --routines --triggers bary > bary-$(date +%F).sql`(계정 DB 도 같이). `--single-transaction` 은
InnoDB 의 일관된 스냅숏이라 데몬이 도는 채로 뜰 수 있다. **`--triggers` 를 빼면 복구한 DB 에 트리거가 없다** — 백엔드를 지워도 운영 상태가
남고, 리스너를 지워도 SNI 바인딩이 남는다. 복구는 빈 DB 에 그 파일을 넣고 데몬을 띄운다(마이그레이션 기록 표도 덤프에 들어 있다).
시크릿 백엔드가 `pg` 면 설정 DB 에 암호문이 들어 있고 KEK 는 따로 지킨다(4절과 같다).

**한계:**

- PG · SQLite 와 사이를 옮기는 행 단위 이주 도구는 없다 — `bary backup` 매니페스트로 설정을 새 DB 에 다시 넣는다(리비전 이력 · 계정 · 감사는 옮겨지지 않는다).
- 키 · 이름 열은 `varchar(255)`(URL 은 768)이다 — PG 의 `text` 와 달리 길이 상한이 있다. 앱의 문법 검사가 그보다 훨씬 좁다.
- 문자열 비교는 바이트(`utf8mb4_bin`)다. MariaDB 의 `utf8mb4_bin` 은 끝 공백을 무시한다(PAD SPACE) — 키 문법이 공백을 받지 않아 키에서는 문제가 없다.
- uuid 는 텍스트다. 경로의 uuid 는 API 가 먼저 정규형으로 맞춘다(대문자 · 중괄호도 PG 처럼 받는다).

## 6. 알아 둘 것

⚠️ 이 배포는 **단일 장애점**이다. 자동 페일오버는 없다 — 콜드 스탠바이이고 트래픽을
옮기는 것은 DNS 나 상위 L4 다([`runbook-spof.md`](./runbook-spof.md)).

⚠️ **업데이트는 이 스크립트를 다시 돌리는 것이다.** 토큰과 env 의 관리 밖 줄은 살아남고,
`restart` 동안 짧은 다운타임이 있다([`runbook-upgrade.md`](./runbook-upgrade.md)).

⚠️ **GUI 를 프록시 뒤로 내면 `BARY_TRUSTED_PROXIES` 를 준다.** barycenter 의 리스너가 GUI 를 8443 으로
넘기면, API 가 보는 접속 주소는 모든 사람이 그 프록시 주소 하나다. 그러면 한 사람이 틀린 토큰을 다섯 번
보낼 때 모든 사람이 429 로 잠긴다. 로그인 시도 제한과 감사 기록의 IP 도 같다.

```
BARY_TRUSTED_PROXIES='10.253.65.250'      # 프록시가 API 에 붙는 주소. IP · CIDR, 쉼표로 여럿
```

접속 주소가 이 목록 안일 때만 `X-Forwarded-For` 를 읽는다. 오른쪽부터 읽고, 목록 밖의 첫 주소를 보낸 사람으로
쓴다. 클라이언트가 직접 붙는 주소는 넣지 않는다 — 넣으면 그 클라이언트가 헤더로 남의 주소를 적을 수 있다.
켜졌는지는 기동 로그 `listening` 줄의 `trustedProxies` 로 본다.

## 무엇이 이것을 지키나

`tests/install/run.sh` 가 **배포판 여섯 판의 실물 컨테이너에서** 이 스크립트를 그대로
돌리고, 서비스 기동·재기동·비-root nginx·특권 포트 apply 까지 본다. `verify.yml` 의
`install` 잡이 **설치의 입력이 바뀐 PR 에서** 그것을 돌린다 — 이 저장소가 선언한 바닥
(node 22)을 실제로 밟아 보는 곳은 거기뿐이다.

**이 문서의 명령은 그 하네스가 안 잰다.** 여기 적힌 것 중 하네스가 도는 것은
`install.sh` 호출뿐이고, 백업·사고 대응 절차는 사람이 읽고 하는 것이다 — 그래서 이 문서는
다른 둘과 달리 **썩을 수 있다.** 고칠 일이 생기면 같은 회차에 고친다.

## 응답한 노드 이름 — `X-Served-By`

기본은 끈다. 켜면 모든 응답에 `X-Served-By: <별칭>` 이 붙고, 엔진 오류 페이지의 요청 id 옆에 같은 이름이 나온다.
어느 노드의 기록을 볼지 응답만 보고 안다.

```
# $PREFIX/env — 노드마다 다른 값
BARY_SERVED_BY=icn-a1        # 짧은 별칭을 권한다. @hostname 이면 호스트 이름
```

- 별칭은 영숫자 · `.` · `-` · `_` 64 자까지. 틀리면 데몬이 기동하지 않는다.
- **호스트 이름보다 짧은 별칭을 권한다.** 응답은 누구나 보므로 내부 이름 규칙 · 영역 · 서버 번호를 드러내지 않는다.
- 데몬을 다시 시작한 뒤 **다음 적용에서** 반영된다. 설정이 그대로면 `POST /api/v1/apply/rerender` 로 다시 적용한다.
- 헤더는 엔진에 headers-more 가 있을 때만 나간다(OpenResty 기본). 없으면 오류 페이지에만 나오고 데몬이
  `served_by.no_header` 경고를 남긴다.

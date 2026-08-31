# 첫 설치 런북 — 깔기 전에 정할 것

`deploy/install.sh` 는 **명령 하나로 끝난다.** 그래서 이 문서는 "어떻게 깔까" 가 아니라
**"깔기 전에 무엇을 정해야 하나"** 에 답한다 — 뒤에 정하면 비싼 것들이 몇 개 있다.

두 번째 설치부터는 [`runbook-upgrade.md`](./runbook-upgrade.md) 다(재실행이 곧 업데이트다).
장애 대응은 [`runbook-spof.md`](./runbook-spof.md) 다.

전제는 §11.3 의 v1 권장 배포다 — **전용 VM 한 대**, 엔진과 데몬이 한 유닛.
Debian 11+ · Ubuntu 20.04+ · RHEL 계열 9 · Amazon Linux 2023 · Alpine 3.19+.
node 는 **22 가 바닥**이고 스크립트가 없으면 깐다.

## 1. 깔기 전에 정할 것

| | 고르는 것 | 뒤에 바꾸는 비용 |
|---|---|---|
| PostgreSQL | `--with-postgres` (같은 호스트, 유닉스 소켓 + peer 인증) 또는 `--dsn` | 낮다 — 덤프하고 옮기면 된다 |
| **시크릿 백엔드** | `fs`(기본) 또는 `pg` | **높다 — 아래를 읽는다** |
| KEK | `pg` 를 골랐을 때만 | 회전은 되지만 **분실은 복구 불가** |
| 리스너 주소 | 기본은 `127.0.0.1:8088` | 낮다 — env 한 줄 |
| TLS | 루프백 밖으로 열려면 **필수** | 낮다 |
| ACME | 기본 **켜짐** (`BARY_ACME=0` 으로 끈다) | 낮다 |
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
- `--env BARY_SECRET_KEK_ID=<이름>` 으로 이름을 붙여 두면 나중에 회전할 때 어느 키로
  감쌌는지 행마다 남는다

KEK 를 운영자가 직접 지는 것이 부담이면, 그것이 KMS/Vault 드라이버가 있어야 할 이유다 —
아직 없다(STATUS §2).

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

## 6. 알아 둘 것

⚠️ 이 배포는 **단일 장애점**이다. 자동 페일오버는 없다 — 콜드 스탠바이이고 트래픽을
옮기는 것은 DNS 나 상위 L4 다([`runbook-spof.md`](./runbook-spof.md)).

⚠️ **업데이트는 이 스크립트를 다시 돌리는 것이다.** 토큰과 env 의 관리 밖 줄은 살아남고,
`restart` 동안 짧은 다운타임이 있다([`runbook-upgrade.md`](./runbook-upgrade.md)).

## 무엇이 이것을 지키나

`tests/install/run.sh` 가 **배포판 다섯 종의 실물 컨테이너에서** 이 스크립트를 그대로
돌리고, 서비스 기동·재기동·비-root nginx·특권 포트 apply 까지 본다. `verify.yml` 의
`install` 잡이 **설치의 입력이 바뀐 PR 에서** 그것을 돌린다 — 이 저장소가 선언한 바닥
(node 22)을 실제로 밟아 보는 곳은 거기뿐이다.

**이 문서의 명령은 그 하네스가 안 잰다.** 여기 적힌 것 중 하네스가 도는 것은
`install.sh` 호출뿐이고, 백업·사고 대응 절차는 사람이 읽고 하는 것이다 — 그래서 이 문서는
다른 둘과 달리 **썩을 수 있다.** 고칠 일이 생기면 같은 회차에 고친다.

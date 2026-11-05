# 런북 — 사람 계정 (A 단계)

> 공통 회원정책 1차(2026-10-18)를 따른다. SSO·메일 재설정은 B 단계라 이 문서에 아직 없다.

## 수치 (회원 공통 수치 1차, 2026-10-18 사용자 결정 — 7개 제품 공통)

| 항목 | 값 |
|---|---|
| 비밀번호 | NFC 정규화 뒤 8자 이상, 영소문자·영대문자·숫자·특수문자(영문자·숫자가 아닌 모든 문자) 중 3종류 이상. 최대 길이 없음, 유출 목록 차단·정기 변경 없음 |
| 요청 본문 | 로그인·가입(초대 수락)·재설정 64 KiB |
| 해시 | scrypt N=2^16·r=8·p=2, salt 16바이트, 출력 64바이트. 옛 해시는 다음 로그인 성공 때 다시 저장 |
| 세션 | 유휴 30분, 절대 12시간 |
| MFA 최근성(step-up) | 10분 — 로그인 때 통과한 MFA 도 10분 인정 |
| TOTP | 6자리·SHA-1·30초, 앞뒤 1창, 같은 창 재사용 거부. 미확인 등록은 24시간 |
| 시도 제한 | 계정·IP 각각, 5번째 실패부터 1초·2초·4초… 최대 15분, 마지막 실패 뒤 15분이면 초기화. 공용 계정 PG 에서 센다 |
| 만료 | 초대 72시간, 재설정 30분 |
| 복구 코드 | 10개, 일회용, 해시 저장, 재발급하면 전부 폐기 |
| 보존 | 감사 1년(데몬이 하루마다 정리), 탈퇴하면 개인정보 즉시 삭제 — username 묘비와 SSO (iss, sub) 는 재사용 방지로 남는다. **백업 30일** — 탈퇴한 사람의 개인정보는 최대 30일 뒤 백업에서도 사라진다 |

기계 토큰(`tokens.json`) · API 인증 실패 제한은 기본으로 인스턴스 메모리에서 센다. 여러 노드가 함께 세게 하려면
`BARY_AUTH_LIMIT_STORE=pg` — 아래 「API 인증 실패 제한을 함께 세기」.

## 켜기

| env | 뜻 |
|---|---|
| `BARY_ACCOUNTS_DSN` | 공용 계정 PG. **모든 지역·전역 인스턴스가 같은 값**을 쓴다. 없으면 계정이 꺼진다(현행 OIDC 메모리 세션만) |
| `BARY_ACCOUNTS_KEK` | TOTP 비밀을 감싸는 키, 32바이트 base64. **계정 PG 에 두지 않는다.** 아래 셋 중 **하나만** 준다. 없으면 기동 거부 |
| `BARY_ACCOUNTS_KEK_FILE` | 같은 키를 **파일**에서 읽는다(한 줄, 64 KiB 상한). env 파일에 키가 안 남는다 |
| `BARY_ACCOUNTS_KEK_CMD` | 같은 키를 **명령**의 stdout 으로 받는다(`systemd-creds cat` · `vault read` · KMS). 기동 때 한 번, 메모리에만. 상한 `BARY_ACCOUNTS_KEK_CMD_TIMEOUT_MS`(기본 10초) |
| `BARY_ACCOUNTS_SEAL_KIND` | 봉인 방식. `local`(기본, 위 키로 AES-256-GCM) · `vault-transit`(아래 「Vault transit 봉인」) |
| `BARY_ACCOUNTS_ISSUER` | 인증 앱에 보이는 이름 (기본 `barycenter`) |
| `BARY_PUBLIC_URL` | CLI 가 링크를 온전한 주소로 적을 때 쓴다 |

키 만들기: `node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'`.
**키를 잃으면 모든 사람의 TOTP 가 못 쓰게 된다** — 복구 링크로 다시 등록해야 한다. 키는 env 파일과 같은
무게로 백업한다.

### KEK 출처 — 값 · 파일 · 명령

계정 KEK 는 인증서 저장소 KEK(`BARY_SECRET_KEK` · `_CMD`, `docs/runbook-install.md`)와 **같은 코드**로 읽는다
(`src/dp/kek-source.ts` 의 `resolveKeyFrom`). 규칙도 같다.

- **셋 중 둘 이상 주면 안 뜬다.** 어느 쪽이 이기는지가 곧 사고다.
- 명령이 실패하면 오류에 **종료 코드와 stderr 만** 실린다. 명령 문자열 · stdout 은 안 실린다. 명령은 키를 stdout 으로만 낸다.
- 값을 읽는 규칙은 **예전 그대로**다(base64 를 풀어 32 바이트). 운영에 적힌 값은 바꾸지 않아도 된다.

실패의 뜻:

| 기동 오류 | 뜻 · 할 일 |
|---|---|
| `… 중 하나가 필요하다` | DSN 은 있는데 키가 없다. 셋 중 하나를 준다 |
| `… 를 둘 다 줬다` | 출처가 둘 이상이다. 하나만 남긴다 |
| `BARY_ACCOUNTS_KEK_FILE (<경로>) 을 읽지 못했다 (ENOENT · EACCES …)` | 파일이 없거나 `bary` 가 못 읽는다. 소유 · 권한(0400 · 0600)을 본다 |
| `BARY_ACCOUNTS_KEK_CMD 가 실패했다 (종료 코드 …)` | 명령이 죽었다. 실린 stderr 를 본다 |
| `BARY_ACCOUNTS_KEK 는 32바이트를 base64 로 적은 값이어야 한다` | 값 · 파일 · 명령이 낸 것이 키가 아니다 |

### env 값에서 파일 · 명령으로 옮기기

운영(web-01)은 지금 `BARY_ACCOUNTS_KEK` env 값이다. 그대로 둬도 된다. 옮길 때(**키 자체는 바꾸지 않는다** — 봉인값이
그 키로 묶여 있다):

1. 같은 값을 파일로 둔다: `install -o bary -g bary -m 0400 /dev/null /etc/barycenter/accounts-kek` 뒤
   그 파일에 env 의 값을 한 줄로 적는다(셸 기록에 남지 않게 편집기로). 또는 `systemd-creds encrypt` 로 자격을 만든다.
2. env 파일에서 `BARY_ACCOUNTS_KEK=` 줄을 지우고 `BARY_ACCOUNTS_KEK_FILE=/etc/barycenter/accounts-kek`
   (또는 `BARY_ACCOUNTS_KEK_CMD='systemd-creds cat accounts-kek'`)를 넣는다. **둘을 같이 두면 안 뜬다.**
3. 데몬을 다시 띄우고 `accounts.sealer` 로그(`kind: local`)를 본다. 인증 앱이 있는 계정으로 한 번 로그인해 본다.
4. 되돌리기: 2 를 거꾸로 한다. 키가 같으므로 봉인값은 그대로 열린다.

모든 지역 · 전역 인스턴스가 **같은 키**를 써야 한다(같은 계정 PG 의 봉인값을 연다). 옮길 때 값이 바뀌지 않았는지
`sha256sum` 으로 대조한다(값을 화면에 내지 않는다).

### Vault transit 봉인 (`BARY_ACCOUNTS_SEAL_KIND=vault-transit`)

키가 barycenter 밖(Vault)에만 있다. barycenter 는 평문을 보내 `vault:v1:…` 을 받고, 그 값이 그대로 봉인값이다.
**열 때는 값의 앞머리로 방식을 고른다** — `v1.` 는 로컬 키, `vault:` 는 Vault. 그래서 바꿔도 옛 값이 열린다.

| env | 뜻 |
|---|---|
| `BARY_ACCOUNTS_VAULT_ADDR` | `https://…` (https 가 아니면 기동 거부) |
| `BARY_ACCOUNTS_VAULT_KEY` | transit 키 이름. **`derived=true` 로 만든다** — 행(사용자)에 묶기를 context 로 한다 |
| `BARY_ACCOUNTS_VAULT_TOKEN_FILE` | 토큰 **파일**. 매 호출 읽는다(Vault Agent 가 갱신해 쓰는 파일). env 값 `BARY_ACCOUNTS_VAULT_TOKEN` 은 거절 |
| `BARY_ACCOUNTS_VAULT_MOUNT` | 기본 `transit` |
| `BARY_ACCOUNTS_VAULT_NAMESPACE` | Enterprise 네임스페이스(선택) |

- Vault 쪽: `vault write -f transit/keys/<이름> derived=true`, 정책은 `transit/encrypt/<이름>` · `transit/decrypt/<이름>` 에 `update`.
- **기동 때 잰다(probe)**: 무작위 값을 context A 로 봉인해 A 로 열리고 B 로 안 열리는지 본다. 키가 파생형이 아니면
  기동 거부(`derived=true 로 만든 키가 필요하다`). 그래서 Vault 가 기동 때 닿아야 한다.
- **반만 주면 기동 거부.** `vault-transit` 인데 `ADDR · KEY · TOKEN_FILE` 중 빠진 것이 있으면 그 이름을 말한다.
- **옛 `v1.` 값을 열려면 계정 KEK 를 남겨 둔다.** KEK 가 없으면 그 값은 `no-sealer` 로 못 연다 — 그 사람은 복구 링크로
  다시 등록해야 한다. 새로 등록 · 재등록하는 TOTP 만 `vault:` 로 봉인된다. 옛 값을 한꺼번에 다시 봉인하는 도구는 아직 없다.
- `local` 로 두고 `BARY_ACCOUNTS_VAULT_*` 를 다 주면 Vault 는 **열기 전용**이다(되돌릴 때 `vault:` 값을 계속 연다).

열기 · 봉인 실패는 로그인에서 **503 `account_store_unavailable`** 이 된다(예전 키 불일치와 같다). 로그의 사유:

| 사유 | 뜻 |
|---|---|
| `integrity` | 다른 키 · 다른 행의 값이다(로컬 KEK 가 바뀌었거나 Vault 키가 다르다). 다시 해도 같다 |
| `denied` | Vault 가 토큰 · 정책을 거절했다(401 · 403), 토큰 파일이 없거나 비었다 |
| `unavailable` | Vault 에 닿지 못했다 · 5xx · 봉인됨(sealed) · 답이 64 KiB 를 넘었다 · 시간 상한 5초 |
| `no-sealer` | 그 앞머리의 방식이 설정에 없다 |
| `malformed` | 봉인값의 모양이 아니다 |

### API 인증 실패 제한을 함께 세기 (`BARY_AUTH_LIMIT_STORE`)

틀린 토큰 · 낡은 세션 쿠키 · 매핑 없는 인증서를 IP 마다 센다(5번째부터 429, 1초에서 두 배씩 60초까지, 마지막 실패 뒤
10분이면 처음부터, 맞는 자격이 오면 지운다). 기본(`memory`)은 인스턴스마다 따로 센다 — 클러스터 · 전역+지역이면
노드 수만큼 더 시도할 수 있다.

`BARY_AUTH_LIMIT_STORE=pg` 면 사람 계정 PG 의 **`auth_throttle`**(마이그레이션 005, 새 표 없음)에서 함께 센다. 키는
`api:<IP>` 다 — 사람 로그인의 `login:` · `reset:` 과 따로 센다. 오래된 행은 계정 정리(`purgeExpired`)가 지운다.
`BARY_ACCOUNTS_DSN` 이 없으면 기동 거부, 모르는 이름도 기동 거부.

**계정 PG 가 죽으면**(메모리로 떨어지지 않는다):

- 실패한 인증은 **503 `auth_limit_unavailable`**(`retry-after: 5`) — 「세지 못했다」를 드러낸다. 지표 `bary_auth_limit_store_errors_total`.
- **맞는 자격(파일 토큰 · mTLS)은 그대로 들어간다.** 성공의 「지우기」는 기다리지 않는다. 계정 PG 장애가 API 토큰까지
  막는 전체 장애가 되지 않게 한 판단이다(「계정 PG 가 죽으면」의 비상 경로를 지킨다). 그 동안 파일 토큰은 맞혀 보기를
  셀 수 없다 — 파일 토큰은 맞혀 볼 수 없을 만큼 긴 무작위 값으로 둔다(사람이 지은 짧은 값을 쓰지 않는다).

## 첫 관리자

**설치 스크립트가 이미 해 준다.** `deploy/install.sh --with-postgres` 는 같은 PG 에 `bary_accounts` 를 만들고
`BARY_ACCOUNTS_DSN`·`BARY_ACCOUNTS_KEK` 을 env 파일에 적고(없을 때만 — 재실행이 KEK 를 바꾸지 않는다),
관리자가 없으면 설치 요약 끝에 **첫 관리자 링크**를 낸다. 외부 PG(`--dsn`)면 `--accounts-dsn` 으로 공용 계정
PG 를 준다. 계정을 안 쓰려면 `--no-accounts`.

손으로 다시 만들 때:

```sh
sudo -u bary env $(cat /etc/barycenter/env | xargs) node /opt/barycenter/dist/bin/barycenterd.js account bootstrap
```

활성 관리자가 하나도 없을 때만 링크가 나온다(24시간, 한 번). 링크를 연 사람이 아이디·비밀번호를 정하고
**인증 앱(TOTP)을 등록해야** 관리자가 된다. 복구 코드 10개는 그때 한 번만 보인다.

## 사람이 잠겼을 때

- 비밀번호·인증 코드를 5번 틀리면 1초부터 두 배씩 잠긴다(최대 15분, 마지막 실패 뒤 15분이면 처음부터). 같은 IP 도 따로 센다. 둘 다 계정 PG 에 살아 인스턴스와 무관하다. 기다리면 풀린다 — 영구 잠금은 없다.
- 비밀번호·인증 앱을 잃었다: 관리자가 `POST /api/v1/users/:id/recovery-link` 로 복구 링크를 만든다.
  **그 사람의 세션은 그 순간 모두 끊긴다.** 링크로 비밀번호와(관리자면) 인증 앱을 다시 정한다.
- **마지막 관리자가 잃었다**: 호스트에서 `barycenterd account recovery-link <아이디>`.

## 끊기

| 하고 싶은 것 | 방법 | 언제 반영 |
|---|---|---|
| 한 사람을 막는다 | `PATCH /api/v1/users/:id {"status":"suspended"}` | 다음 요청 |
| 역할을 내린다 | `PATCH /api/v1/users/:id {"role":"auditor"}` | 다음 요청 |
| 그 사람의 모든 세션 | `POST /api/v1/users/:id/revoke-sessions` | 다음 요청 |
| 내 모든 기기 | `POST /api/v1/session/logout-all` | 다음 요청 |

마지막 활성 관리자는 강등·정지·삭제할 수 없다.

## 계정 PG 가 죽으면

사람 로그인과 사람 세션의 모든 요청이 **503 `account_store_unavailable`** 로 거부된다(확인할 수 없으면
거부 — 공통 정책). API 토큰(`tokens.json`)과 mTLS 는 그대로 된다. 데이터 플레인은 영향이 없다.

**비상 경로**: 그동안 남는 것은 ① 지역 인스턴스에 API 토큰(`tokens.json`)·mTLS 로 들어가는 길, ② 지역 호스트의
`barycenterd account …` CLI 다. 전역 조회는 감사를 남길 수 없으므로 **토큰으로도 503**(`audit_unavailable`)이다 —
`docs/runbook-global.md` 「조회 감사」. 이 길들은 사람 계정과 무관하게 살아 있어야 하므로 토큰 파일을 지우지 않는다.

## 계정 PG 배치와 수동 승격 (2026-10-18·19 사용자 결정, stardust 와 같은 원칙)

- **주는 az01**, **사본은 dev**. 모든 지역·전역의 `BARY_ACCOUNTS_DSN` 은 **주**를 가리킨다. dev 사본은 승격 대비용이다.
- **인스턴스는 stardust R2 계정 PG 와 같이 쓴다**(2026-10-19) — 같은 PG 인스턴스에 **별도 DB `bary_accounts` 와 전용 롤**.
  구성은 stardust 가 맡고, 백업은 stardust R2 제안(하루 1회 안, 보존 30일 — 승인 전)을 따른다.
- **dev 사본은 논리 복제다**(물리 복제가 아니다) — dev PG 는 자기 지역 테이블에 써야 해서 클러스터 전체가 읽기 전용이
  되는 물리 복제를 쓸 수 없다(stardust `docs/design/2026-10-18-region-db-split.md`). `bary_accounts` 는 별도 PUBLICATION·
  SUBSCRIPTION 으로 옮긴다. 승격 정본은 stardust `docs/runbook/2026-10-18-account-pg-promote.md` 이고, 아래는 barycenter 몫이다.
- 인증·권한·철회 판단은 **언제나 주를 동기로 읽는다.** 사본을 읽어 로그인을 받지 않는다. 주가 죽은 동안 사람 요청은
  거부되고(위 절), 이것이 정상 동작이다. **자동 승격은 없다.**
- 운영 적용(D단계 1~8)은 az01 기동(2026-10-29 이후) 뒤 한 번에 한다.

### 논리 복제 — 무엇을 옮기나

| 옮긴다 (PUBLICATION 에 넣는다) | 옮기지 않는다 |
|---|---|
| `users` · `user_identities` · `mfa_totp` · `mfa_recovery_codes` · `invitations` · `password_resets` · `email_changes` · `sso_providers` · `account_audit` | `account_schema_migrations` · `sessions` · `login_flows` · `auth_throttle` |

- **`account_schema_migrations` 는 넣지 않는다.** 넣으면 주의 기록 행이 사본의 같은 행과 PK 로 부딪쳐 복제가 멈춘다.
  사본은 자기 기록을 따로 가진다.
- **세션·로그인 흐름·시도 계수는 옮기지 않는다** — 승격하면 모든 세션이 끝나 **모두 다시 로그인**한다. 의도다: 복제가
  늦어 빠진 로그아웃·「세션 끊기」가 새 주에서 되살아나는 일이 없다. 그 대신 계정 상태(정지·역할)는 `users` 로 옮겨진다.
- 모든 표에 PK 가 있다(REPLICA IDENTITY 기본값으로 충분하다). 큰 객체(large object)는 쓰지 않는다.
- 시퀀스는 `account_audit.id`(bigserial) 하나다 — 승격 때 앞으로 당긴다(아래 절차 3).

### DDL — 마이그레이션 적용 순서

DDL 은 복제되지 않는다. barycenter 를 올릴 때 계정 마이그레이션이 새로 있으면(`src/store/account-migrations/`):

1. **사본(dev) 먼저**: `BARY_ACCOUNTS_DSN=<dev 사본 DSN> barycenterd account migrate` — 마이그레이션만 적용한다(KEK·기동 불필요).
   새 칼럼·표가 사본에 먼저 있어야 주에서 오는 행을 받는다.
2. **새 표가 옮길 대상이면** 주에서 `ALTER PUBLICATION … ADD TABLE …`, 사본에서 `ALTER SUBSCRIPTION … REFRESH PUBLICATION`.
3. **그다음 주**: 새 판의 barycenterd 가 기동하며 주에 적용한다(또는 같은 `account migrate` 를 주 DSN 으로).

누가: barycenter 를 올리는 사람이 1·3, PUBLICATION·SUBSCRIPTION 변경(2)은 stardust 와 함께. 지금까지의 표는 `001`~`005` 다
(`005` 가 `auth_throttle` 을 더했다 — 옮기지 않는 표라 2 는 없다).

### 승격 판단 기준

다음이 **모두** 맞을 때만 승격한다. 하나라도 아니면 주 복구를 기다린다(사람 로그인 503 은 데이터 플레인에 영향이 없다).

1. 주가 **복구 불가**이거나 복구 예상 시간이 사람 로그인 중단을 감수할 수 있는 시간(운영 판단)을 넘는다.
2. 사본의 반영 상태를 확인했다 — 사본에서 `SELECT subname, received_lsn, latest_end_time FROM pg_stat_subscription;`.
   주가 죽기 직전까지의 계정 변경(정지·역할 하향)이 **빠졌을 수 있다**는 것을 받아들인다(승격 뒤 확인 3).
3. **옛 주를 막을 수 있다**(절차 1). 막을 수 없으면 승격하지 않는다 — 주가 둘이 되면 철회가 갈라진다.

### 절차 (stardust 승격 런북과 함께)

1. **옛 주 차단.** 옛 주의 `bary_accounts` 가 쓰기를 받지 못하게 한다 — 옛 주 PG 를 멈추거나(stardust 판단), 닿지 않으면
   망(heliopause)에서 그 호스트의 5432 를 막는다. **이 단계가 끝나기 전에 2단계로 가지 않는다.**
2. **구독 끊기.** 사본에서 `ALTER SUBSCRIPTION <이름> DISABLE;` 뒤 `ALTER SUBSCRIPTION <이름> SET (slot_name = NONE); DROP SUBSCRIPTION <이름>;`
   (옛 주에 닿지 않으므로 슬롯은 사본 쪽에서만 놓는다).
3. **시퀀스 당기기.** 사본에서 `SELECT setval('account_audit_id_seq', (SELECT coalesce(max(id), 0) + 1000 FROM account_audit));`
4. **연결 문자열 전환.** 모든 지역·전역 호스트에서 `/etc/barycenter/env` 의 `BARY_ACCOUNTS_DSN` 을 새 주(dev)로 바꾸고 **재시작**한다
   (`systemctl restart barycenterd`). DSN 은 기동 때만 읽는다 — `reload`(SIGHUP)는 토큰만 다시 읽는다.
   - systemd 지역은 엔진이 별도 유닛이라 재시작해도 트래픽이 안 끊긴다(#122). OpenRC 지역은 몇 초 끊긴다 — 하나씩 돌린다.
   - 전역은 데이터 플레인이 없어 바로 돌려도 된다.
   - `BARY_ACCOUNTS_KEK` 는 그대로다(키는 DB 에 없다). 설치 스크립트를 다시 돌리지 않는다.
5. **세션 표는 비어 있다** — 모두 다시 로그인한다(위 「무엇을 옮기나」). 공지한다.
6. **복제 다시 세우기.** 옛 주가 돌아오면 그 `bary_accounts` 를 비우고(갈라진 쓰기가 있을 수 있다) 새 주를 PUBLICATION 으로,
   옛 주를 SUBSCRIPTION 으로 다시 만든다. 그 전에 옛 주에 `account migrate` 를 먼저 적용한다(DDL 순서와 같다).

### 승격 뒤 확인

1. 각 인스턴스 `/readyz` 200, 로그에 `pg.idle_client_error` 가 이어지지 않는다.
2. 사람 로그인 → MFA → `/me` 가 지역·전역 모두에서 된다. 전역 요약 조회가 200 이고 `account_audit` 에 `global.view` 가 남는다.
3. **빠졌을 수 있는 계정 변경을 다시 한다.** 주가 죽기 직전에 한 정지·역할 하향·탈퇴를 운영 기록에서 찾아 새 주에 다시
   적용한다(세션은 승격으로 이미 모두 끝났다).
4. `account_audit` 의 마지막 행 시각이 승격 직전과 이어지는지 본다(빠진 구간을 기록에 남긴다).

### 되돌리기

승격을 되돌리는 것은 **또 한 번의 승격**이다 — 옛 주로 바로 돌아가지 않는다. 옛 주를 새 주의 사본으로 다시 세운 뒤(절차 6),
같은 판단 기준·절차로 옮긴다. 4단계 전에 멈췄다면(아직 DSN 을 안 바꿨다면) 사본을 그대로 두고 옛 주의 차단을 풀어 원래대로
돌릴 수 있다 — 단, 구독을 지웠다면 다시 만들어야 하고(초기 복사부터), 그 사이 사본이 쓰기를 받지 않았을 때만이다.

## 메일 (B1)

초대 메일·비밀번호 재설정·이메일 변경은 **셋이 모두 있어야** 켜진다(반만 켜지면 조용히 안 가는 메일이 된다 —
기동을 거부한다):

```sh
sudo deploy/install.sh ... \
  --env BARY_SMTP_URL='smtps://user:pass@smtp.example.com:465' \
  --env BARY_MAIL_FROM='barycenter <noreply@example.com>' \
  --env BARY_PUBLIC_URL='https://dev-icn-vtr.barycenter.example.com'
```

### 전송 고르기 — `BARY_MAIL_KIND`

받는 사람 · 제목 · 본문은 그대로이고 **보내는 방법만** 고른다. 없으면 지금처럼 `smtp` 다. 비밀은 파일로만 받는다.
`BARY_MAIL_FROM` · `BARY_PUBLIC_URL` 은 어느 종류든 필요하다.

| 종류 | 변수 | 비고 |
|---|---|---|
| `smtp`(기본) | `BARY_SMTP_URL` 또는 `BARY_SMTP_URL_FILE` | 비밀번호가 URL 에 들면 `_FILE` 을 쓴다. 둘 다 주면 거부 |
| `ses` | `BARY_MAIL_SES_REGION` · `BARY_MAIL_AWS_ACCESS_KEY_ID` · `BARY_MAIL_AWS_SECRET_ACCESS_KEY_FILE` | SES v2, SigV4 를 직접 서명. 보내는 주소가 SES 에서 인증돼 있어야 한다. IAM `ses:SendEmail` |
| `mailgun` | `BARY_MAIL_MAILGUN_DOMAIN` · `BARY_MAIL_MAILGUN_API_KEY_FILE` · `BARY_MAIL_MAILGUN_REGION`(`us`\|`eu`, 기본 us) | 그 도메인의 Sending API 키 |
| `sendgrid` | `BARY_MAIL_SENDGRID_API_KEY_FILE` | 「Mail Send」 권한만 준 키 |
| `log` | (없음) | **개발용.** 보내지 않고 `mail.log.delivered {to(가림), subject, hasLink, bytes}` 만 남긴다 — 링크 · 본문은 남기지 않는다. 링크가 필요하면 `barycenterd account recovery-link` |

**반만 설정하면 기동을 거부한다** — 종류를 안 골랐는데 전송 변수만 있다 · 필요한 값이 없다 · 다른 전송의 변수가 섞였다 ·
키 파일이 없거나 비었다.

보내기가 실패해도 초대 · 재설정 자체는 만들어진다(지금과 같다). 실패하면 로그
`mail.send_failed {transport, to(가림), reason, detail}` 와 계측 `bary_mail_total{transport,outcome}` 이 남는다.
사유: `auth`(키 거절 — 키 · 권한) · `rejected`(보내는 주소 미인증 · 형식) · `rate-limited` · `unavailable`(닿지 못함 · 5xx) ·
`invalid-message`(받는 사람 · 제목에 줄바꿈 — 보내지 않았다). SMTP 실패는 nodemailer 의 오류 그대로다(로그 없음, 지금과 같다).

- 재설정 요청은 **언제나 같은 답**이다(주소에 계정이 있는지 말하지 않는다). 같은 사람에게 5분에 한 번만 보낸다.
- **재설정은 인증 앱을 풀지 않는다.** 메일함을 가진 사람이 곧 관리자가 되지 않게 — 인증 앱을 잃었으면 복구 링크다.
- 이메일은 새 주소에서 확인해야 바뀌고, 옛 주소에는 요청이 왔다는 알림이 간다.

## 민감 작업 (B1)

다음은 **최근 10분 안에 인증 앱 확인**이 필요하다(사람 세션만 — 토큰은 MFA 가 없다): 사람·초대 관리
(역할·정지·삭제·세션 끊기·복구 링크·초대 만들기/취소), `/restore`, 인증서 개인키 올리기. 화면은 코드를 한 번
묻고 이어서 한다(`POST /api/v1/session/step-up`). **인증 앱이 없는 사람은 민감 작업을 못 한다** — 먼저 등록한다
(IdP OTP 를 켰으면 그 IdP 와 이어진 사람은 IdP 의 인증 앱 코드로 확인한다 — 아래 「IdP OTP」).

열린 실시간 스트림(SSE)도 하트비트(15초)마다 세션을 확인해, 로그아웃·정지된 세션의 스트림을 닫는다.
이미 보낸 데이터는 되돌릴 수 없다.

## SSO 연결 (B2 — 로컬 권한 정본)

SSO 공급자는 지금처럼 `BARY_OIDC_*` 로 하나 둔다. 계정이 켜진 배포에서 SSO 는 **「누구인가」(issuer, subject)만**
IdP 에게 묻는다. 역할은 계정이 정하고, IdP 의 역할 클레임·MFA 는 쓰지 않는다(공급자 계약 미해결 — 계획 §9).

- **연결이 없으면 거절**한다(403 `sso_not_linked`). 기존 사람은 로그인한 뒤 「내 계정 → SSO 계정 잇기」
  (비밀번호 재확인)로 잇는다. 이름·이메일이 같다고 저절로 이어지지 않는다.
- **JIT 는 기본 꺼짐.** 관리자가 「사람 → SSO 자동 계정」에서 켜면 연결 없는 SSO 사용자가 처음 올 때
  **auditor** 계정이 새로 생긴다(비밀번호 없음, 이메일 없음). 역할 올리기는 관리자가 한다.
- 관리자·인증 앱 등록자는 SSO 로 와도 **둘째 인증 코드**를 한 번 더 넣는다. 기본은 로컬 인증 앱 코드이고,
  IdP OTP 를 켰으면 그 IdP 와 이어진 사람은 IdP 의 인증 앱 코드다(아래 「IdP OTP」). IdP 토큰의 `amr`·`acr` 는 믿지 않는다.
- 끊기는 비밀번호 재확인 뒤, 다른 로그인 수단(비밀번호)이 남을 때만. 삭제된 계정의 연결은 함께 지운다.

**OIDC 클라이언트 하나를 지역·전역이 함께 쓴다** (2026-10-18 공통 정책 1차). lodestar 에 클라이언트 하나,
redirect URI 둘(정확 일치): `https://dev-icn-vtr.barycenter.tinyuniver.se:8443/login`, `https://barycenter.tinyuniver.se/login`(전역 화면 — 같은 데몬이 호스트만 바꿔 쓴다).
각 인스턴스의 `BARY_OIDC_REDIRECT_URI` 는 자기 주소다. 로그아웃 통지 URI 는 쓰지 않는다(철회는 계정 PG 가 판단).
Role Change URI 는 IdP 권한 정본을 쓸 때만 등록한다(아래 「IdP 권한 정본」).
⚠️ **클라이언트 비밀이 하나다.** 한 호스트에서 새면 지역·전역 모두 영향을 받는다 — 새어 나간 의심이 들면 lodestar 에서
비밀을 바꾸고 **모든** 지역·전역의 `/etc/barycenter/env`(0640) `BARY_OIDC_CLIENT_SECRET` 을 같은 값으로 바꾼 뒤 재시작한다
(지역은 재시작 동안 데이터 플레인이 몇 초 끊기므로 하나씩). 비밀은 그 파일에만 두고 메시지·로그·티켓에 적지 않는다.

**기존 OIDC 사용자 이전**: 계정을 켜면 역할 클레임으로 들어오던 옛 경로는 닫힌다. 관리자가 초대하고, 초대받은
사람이 계정을 만든 뒤 SSO 를 잇는다(또는 JIT 를 켜서 auditor 로 들인 뒤 역할을 올린다).

## IdP 권한 정본 (B3 · A안 권한 위임, 2026-11-05)

IdP 정본인 사람은 **IdP 가 권한을 정한다** — 역할 하나와, 범위 하나씩의 더하기(grant) · 빼기(deny). 반영은 SSO 로그인 때마다,
그리고 IdP 가 Role Change(서명된 SET)를 push 하면 **그때 바로**(열린 세션도 다음 요청부터)다.

**실효 범위 = 역할 범위 ∪ grant − deny. deny 가 이긴다.** 역할 범위는 auditor `read` · operator `read write` · admin
`read write apply admin`. 개인 API 토큰은 min(토큰 역할, 주인 역할) 범위와 주인의 실효 범위의 교집합이다(deny 는 토큰에도
걸리고, grant 는 토큰으로 옮겨 가지 않는다). 「사람」 표의 「실효 범위」 열과 「내 계정 → 권한」 이 그 값을 보인다(「운영자 · 적용 더함」).

**누가 IdP 정본인가**: 「사람」 표에서 그 사람의 정본을 「IdP」 로 돌렸거나(SSO 연결 필요), 「사람 → SSO 공급자」 에서
**「이 공급자의 SSO 사용자는 모두 IdP 가 권한을 정해요」** 를 켠 공급자와 이어진 사람(공급자 기본 정본). 공급자 기본 정본을 켜면
JIT 로 처음 오는 사람도 auditor 가 아니라 **매핑 결과 역할**로 만든다(매핑이 거절하면 계정을 만들지 않는다). 매핑을 먼저 저장해야
켜진다(409 `roles_not_configured`). 끄거나 정본을 로컬로 돌리면 IdP 가 준 grant/deny 는 지워지고 역할만 남는다.

**lodestar 의 클레임** (lodestar 안내: groups 는 조직 소속 — **인가 금지**. 인가는 entitlements. roles 는 「이 사람은 무엇인가」):

| 칸 | lodestar 값 | 뜻 |
|---|---|---|
| 역할 클레임 | `roles` | 문자열 배열. 매핑에 있는 값만 고르고, 둘 이상이면 **가장 높은 역할**. 하나도 없으면 로그인 거부. `roles_label` 은 표시명 — 쓰지 않는다 |
| entitlement 클레임 | `entitlements` | 문자열 배열. 접두가 붙은 것만 본다. 없으면 빈 목록(IdP 는 빈 entitlements 를 빼고 보낸다) |
| 접두 | `barycenter.` | 이 앱의 entitlement 표식. entitlement 를 읽으면 비울 수 없다(다른 앱의 것까지 권한이 되지 않게) |

「프로필로 채우기」 의 lodestar 가 위 셋과 기본 표 · 권하는 역할 매핑을 채운다(저장해야 바뀐다). 다른 IdP 는 클레임 자리만 다르다 —
Keycloak `realm_access.roles`(점 경로), Entra ID `roles`, Okta `groups`(그 IdP 에서는 그룹이 인가 수단이다).

**lodestar 에 등록할 이름** — 역할 (클라이언트 역할, 사람에게 하나):

| lodestar role | barycenter 역할 |
|---|---|
| `barycenter-admins` | admin (둘째 인증 필수) |
| `barycenter-operators` | operator |
| `barycenter-auditors` | auditor |

entitlement (기본 표 — 「접두 뒤 이름 = 효과」, 표는 「SSO 공급자」 에서 고칠 수 있다):

| lodestar entitlement | 효과 | 쓰임 |
|---|---|---|
| `barycenter.apply` | grant apply | 운영자에게 적용(트래픽에 걸기)까지 |
| `barycenter.write` | grant write | 감사자에게 설정 고치기 |
| `barycenter.admin` | grant admin | 관리 범위(둘째 인증 · 마지막 관리자 규칙을 그대로 지난다) |
| `barycenter.no_apply` | deny apply | 관리자라도 적용 없음 |
| `barycenter.no_write` | deny write | 읽기만 |
| `barycenter.no_admin` | deny admin | 관리 범위 빼기 |

**접두가 붙었는데 표에 없는 entitlement 는 로그인 거부**다(`unknown-entitlement`) — 모르는 deny 를 조용히 버리면 막으려던 권한이
열린다. lodestar 에 새 `barycenter.*` 를 만들기 **전에** 표에 먼저 넣는다.

**Role Change (즉시 반영)** — lodestar 클라이언트 등록의 「Role Change URI」:

- `https://util-icn-vtr.barycenter.tinyuniver.se/api/v1/oidc/role-change`
- `https://barycenter.tinyuniver.se/api/v1/oidc/role-change` (전역 화면 — 같은 데몬)

계정 PG 가 하나라 **한 곳에 닿으면 모든 지역 · 전역에 반영**된다. 둘 다 받게 하면 두 번째는 409(같은 jti)로 버려진다 — 해롭지 않다.
켜기(`/etc/barycenter/env`): `BARY_OIDC_ROLE_CHANGE_EVENT=<lodestar 가 정한 events 키 URI>` — 기본값은 없다(틀린 기본값은 서명은 맞는데
이벤트가 없다며 모든 변경을 조용히 버린다). heliopause 의 `HELIOPAUSE_OIDC_ROLE_CHANGE_EVENT` 와 같은 값이다. 서명은 **IdP 공개키로만**
본다 — `BARY_OIDC_JWKS_URL`(또는 discovery) 또는 PEM 공개키가 있어야 한다. OIDC 로그인 · 사람 계정 · 비대칭 키 중 하나라도 없이 켜면
기동 거부. 켜지면 기동 로그에 `oidc.role_change.enabled`.

받는 규칙(heliopause `src/set.ts` 와 같다): 본문 `role_change_token=<SET>`(form). 서명 · `typ: secevent+jwt` · nonce 없음(ID Token 거절) ·
iss · aud(우리 client_id) · iat(미래 60초까지) · exp · 수명 1시간 이하 · jti(한 번만, 계정 PG) · sub · **txn**(그 사람에게 마지막으로
적용한 것보다 새로워야 — 늦게 온 옛 스냅숏이 철회를 되돌리지 않게) · `events[키] = { roles: [], entitlements: [] }`.

| 답 | 뜻 · 할 일 |
|---|---|
| 204 | 반영했다 — 또는 이 사람에게는 반영하지 않는다(IdP 정본 아님 · 연결 없는 sub · 로컬 정지 — 감사 `account.idp_role_change_ignored`) |
| 400 | 모양(본문 · events 키 · 배열). events 키가 다르면 `BARY_OIDC_ROLE_CHANGE_EVENT` 를 lodestar 의 값과 맞춘다 |
| 401 | 서명 · iss · aud · 시각 · jti/txn 없음. 위조이거나 키 회전 직후(JWKS 갱신 주기만큼). 같은 IP 의 401 이 쌓이면 429 |
| 409 `role_change_replayed` | 같은 SET 을 이미 받았다(두 주소로 보낸 두 번째 등) |
| 409 `role_change_stale` | 그 사람에게 더 새로운 변경을 이미 적용했다 |
| 409 `role_change_guarded` | 마지막 관리자의 관리 범위를 빼려 했거나, 둘째 인증 없는 사람에게 관리 범위를 주려 했다 — 바꾸지 않았다 |
| 503 | 계정 PG 를 못 물었다. IdP 는 다시 보내지 않는다 — 그 사람의 다음 SSO 로그인이 맞추거나, 급하면 barycenter 에서 정지한다 |

거부는 데몬 로그 `oidc.role_change.refused`(사유 · IP — 토큰은 없다)에 남는다. **거절된 역할 변경은 권한 축소가 반영되지 않았다는
뜻일 수 있다** — 보이면 그 사람의 실효 범위를 「사람」 표에서 확인한다.

**IdP 가 이 앱의 역할을 거두면**(Role Change 의 roles 에 매핑된 값이 없음): 로컬 역할로 떨어지지 않는다 — **모든 범위를 deny** 하고
그 사람의 세션을 끊는다(개인 토큰도 범위 0). IdP 가 다시 주면 돌아온다. 마지막 관리자라면 409 로 그대로 둔다.

거부되는 로그인(로컬 역할로 떨어지지 않는다, 계정 감사 `account.idp_role_refused` — detail 에 사유):
클레임 없음 · 문자열 배열이 아님 · 매핑에 있는 값 없음 · 표에 없는 접두 entitlement · 공급자 설정 없음 · 둘째 인증 없는 사람에게 관리 범위 ·
**마지막 활성 관리자의 관리 범위를 빼려 함**(역할 강등이든 `no_admin` 이든 — 빼지 않고 거부). 「둘째 인증」 은 로컬 인증 앱 또는 IdP OTP 연결이다.
마지막 관리자 판정은 「실효 관리자」(admin 역할 또는 admin grant, admin deny 없음)로 센다. 로컬 정지 · 삭제는 언제나 우선이다.

**매핑 구현 고르기**: `BARY_IDP_ROLES_KIND`(기본 `claims` — 지금은 이것 하나). 모르는 이름이면 기동 거부.

## OIDC discovery (2026-11-05)

`BARY_OIDC_DISCOVERY=1` 이면 `BARY_OIDC_ISSUER` 의 `/.well-known/openid-configuration` 을, `BARY_OIDC_DISCOVERY_URL=<주소>` 면 그 주소를
기동 때 한 번 읽어 `BARY_OIDC_AUTHORIZATION` · `BARY_OIDC_TOKEN` · `BARY_OIDC_JWKS_URL` 의 **빈칸만** 채운다 — **손으로 준 값이 이긴다**.
둘 다 없으면 읽지 않는다(지금처럼 손으로 준다). lodestar: `BARY_OIDC_ISSUER=https://idp.tinyuniver.se` + `BARY_OIDC_DISCOVERY=1`.

- **issuer 불일치는 기동 거부**(문서의 `issuer` 가 `BARY_OIDC_ISSUER` 와 문자 그대로 달라야 — 끝의 `/` 도 다르다). 문서가 JSON 이 아님 ·
  주소 없음 · https 아님도 거부(설정 문제).
- **닿지 못하면 기동을 거부하지 않는다** — 크게 경고(`oidc.discovery.unavailable`)하고 뜬다. 그때 손으로 주지 않은 주소는 비어 SSO
  로그인 · JWKS 검증이 꺼진 채다. IdP 가 돌아오면 재시작한다. 이 창을 없애려면 세 주소를 손으로도 줘 둔다(discovery 는 빈칸만 채운다).
  ⚠️ IdP OTP(`BARY_MFA_IDP_*`) · Role Change 는 OIDC 로그인이 켜져 있어야 하므로, discovery 로만 주소를 받는 배포에서 기동 때 IdP 가
  죽어 있으면 **기동이 거부된다** — 그런 배포는 주소를 손으로도 준다.
- https 만 · 리다이렉트 안 따라감 · 8초 · 256KiB 상한. 읽으면 기동 로그 `oidc.discovery.loaded`(세 주소).

## IdP OTP (둘째 인증 어댑터, 2026-11-05 사용자 요구)

lodestar 에 OTP 를 이미 등록한 사람이 barycenter 에 인증 앱을 또 등록하지 않게 한다. barycenter 는 **비밀을 갖지 않는다** —
사람이 넣은 6자리를 `POST {IdP}/api/totp/verify` 로 보내 판정만 받는다(heliopause 와 같은 계약). 재사용 방지 · 시도 제한은 IdP 가 한다.

**누가 대상인가**: IdP OTP 를 켠 배포에서, `BARY_OIDC_ISSUER` 와 **같은 issuer** 로 SSO 가 이어진 사람(「내 계정 → SSO 계정 잇기」 또는 JIT).
그 사람의 로그인 MFA 단계와 민감 작업 확인(step-up)은 **IdP 의 인증 앱 코드**를 받는다 — 로컬 인증 앱이 있어도 그 코드는 받지 않는다.
연결이 없는 사람은 지금처럼 로컬 인증 앱이다. **복구 코드는 언제나 로컬**이다(IdP 에 보내지 않는다 — IdP 가 죽어도 쓴다).

- IdP OTP 연결은 「MFA 가 있다」로 센다: 관리자 로그인 · 관리자 승격(손 · IdP 역할) · 민감 작업이 받아들인다. 그래서 로컬 인증 앱 없는
  관리자도 있을 수 있다. 그런 관리자는 그 SSO 연결을 끊을 수 없다(409 `admin_needs_mfa` — 먼저 인증 앱을 등록한다).
- **관리자 초대 · 첫 관리자 · 복구 링크 수락은 그대로 로컬 인증 앱을 맞춘다** — 수락 때는 아직 SSO 가 이어지지 않았다.
- **연결이 있는 operator·auditor 도 MFA 단계가 생긴다** (켜기 전에는 인증 앱이 없으면 비밀번호 · SSO 만으로 들어왔다). 그 사람이 lodestar 에
  OTP 를 등록하지 않았으면 404 「IdP 에 OTP 가 없어요」로 막힌다 — 켜기 전에 연결된 사람들의 lodestar OTP 등록을 확인한다.
- 감사(`account_audit`)의 `session.login` · `session.step_up` 에 통과한 수단이 남는다: `totp` · `idp_otp` · `recovery`.

**켜기** (`/etc/barycenter/env`):

```
BARY_MFA_IDP_KIND=lodestar
BARY_MFA_IDP_TOKEN_FILE=/etc/barycenter/mfa-idp-token     # 0640 root:barycenter, 토큰 한 줄
# BARY_MFA_IDP_URL=https://idp.tinyuniver.se              # 없으면 BARY_OIDC_ISSUER
```

- OIDC 로그인(`BARY_OIDC_*` — 인가 · 토큰 주소 · 클라이언트 · redirect 까지)과 사람 계정(`BARY_ACCOUNTS_DSN`)이 켜져 있어야 한다.
- **반만 있으면 기동을 거부한다** (KIND 나 TOKEN_FILE 만 있음 · 모르는 KIND · https 가 아닌 주소 · 빈 토큰 파일 · OIDC 꺼짐).
  조용히 로컬 인증 앱으로 남지 않는다. 서비스 토큰을 env 값(`BARY_MFA_IDP_TOKEN`)으로 주면 그것도 기동 거부다 — **파일로만** 준다.
- 켜지면 기동 로그에 `accounts.mfa_idp.enabled`(kind · url · issuer — 토큰은 없다)가 찍힌다.

**서비스 토큰 발급 (lodestar 쪽)**: lodestar 관리자가 barycenter 용 서비스 토큰을 **따로** 하나 발급한다(heliopause 와 같은 토큰을
나눠 쓰지 않는다 — 한쪽이 새면 다른 쪽도 바꿔야 한다). 권한은 `/api/totp/verify` 한 호출만. 값은 각 호스트의 토큰 파일에만 두고
메시지 · 로그 · 티켓에 적지 않는다. 바꿀 때는 lodestar 에서 새 토큰을 발급 → **모든** 지역 · 전역의 토큰 파일을 바꾸고 재시작 →
옛 토큰을 폐기한다(지역은 재시작 동안 데이터 플레인이 몇 초 끊기므로 하나씩).

**실패의 뜻** (모두 닫힌다 — 로컬 인증 앱으로 넘어가지 않는다):

| IdP 의 답 | 화면 | 뜻 · 할 일 |
|---|---|---|
| 401 `{"ok":false}` | 401(로그인) · 403 `step_up_failed` | 코드가 틀렸거나 이미 썼다. 계정 잠금에 센다 |
| 429 | 429 `mfa_idp_rate_limited` | IdP 가 그 사람의 시도를 막았다. 잠시 뒤 |
| 403 | 403 `mfa_idp_inactive` | IdP 에서 그 계정이 비활성 · 잠김이다. lodestar 에서 확인 |
| 404 | 404 `mfa_idp_not_enrolled` | IdP 에 OTP 가 없다. 그 사람이 lodestar 에서 OTP 를 등록한다 |
| 401(본문 없음) | 503 `mfa_idp_unavailable` | **서비스 토큰 거절** — 배포 문제. 토큰 파일 · lodestar 의 토큰 상태를 본다 |
| 닿지 못함 · 타임아웃(8초) · 그 밖 · 200 인데 `ok:true` 아님 · 64KiB 넘는 답 | 503 `mfa_idp_unavailable` | IdP 장애 또는 중간 프록시 |

503 일 때 데몬 로그의 `accounts.mfa_idp_failed`(reason · detail · user id — 코드 · 토큰은 없다)가 `service-token` 인지 `unavailable` 인지 가른다.
IdP 가 오래 죽어 관리자가 들어와야 하면: 복구 코드로 들어오거나, 데몬의 `BARY_MFA_IDP_*` 를 지우고 재시작한다(그러면 로컬 인증 앱이 있는
사람만 MFA 단계를 지난다 — 로컬 인증 앱이 없는 관리자는 복구 링크다).

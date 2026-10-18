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

기계 토큰(`tokens.json`)의 인증 실패 제한은 사람 계정이 아니라서 지금처럼 인스턴스 메모리에서 센다.

## 켜기

| env | 뜻 |
|---|---|
| `BARY_ACCOUNTS_DSN` | 공용 계정 PG. **모든 지역·전역 인스턴스가 같은 값**을 쓴다. 없으면 계정이 꺼진다(현행 OIDC 메모리 세션만) |
| `BARY_ACCOUNTS_KEK` | TOTP 비밀을 감싸는 키, 32바이트 base64. **계정 PG 에 두지 않는다.** 없으면 기동 거부 |
| `BARY_ACCOUNTS_ISSUER` | 인증 앱에 보이는 이름 (기본 `barycenter`) |
| `BARY_PUBLIC_URL` | CLI 가 링크를 온전한 주소로 적을 때 쓴다 |

키 만들기: `node -e 'console.log(require("crypto").randomBytes(32).toString("base64"))'`.
**키를 잃으면 모든 사람의 TOTP 가 못 쓰게 된다** — 복구 링크로 다시 등록해야 한다. 키는 env 파일과 같은
무게로 백업한다.

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
   - 지역은 데몬과 엔진이 한 유닛이라 **재시작 동안 데이터 플레인이 몇 초 끊긴다.** 지역을 하나씩 돌린다.
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

- 재설정 요청은 **언제나 같은 답**이다(주소에 계정이 있는지 말하지 않는다). 같은 사람에게 5분에 한 번만 보낸다.
- **재설정은 인증 앱을 풀지 않는다.** 메일함을 가진 사람이 곧 관리자가 되지 않게 — 인증 앱을 잃었으면 복구 링크다.
- 이메일은 새 주소에서 확인해야 바뀌고, 옛 주소에는 요청이 왔다는 알림이 간다.

## 민감 작업 (B1)

다음은 **최근 10분 안에 인증 앱 확인**이 필요하다(사람 세션만 — 토큰은 MFA 가 없다): 사람·초대 관리
(역할·정지·삭제·세션 끊기·복구 링크·초대 만들기/취소), `/restore`, 인증서 개인키 올리기. 화면은 코드를 한 번
묻고 이어서 한다(`POST /api/v1/session/step-up`). **인증 앱이 없는 사람은 민감 작업을 못 한다** — 먼저 등록한다.

열린 실시간 스트림(SSE)도 하트비트(15초)마다 세션을 확인해, 로그아웃·정지된 세션의 스트림을 닫는다.
이미 보낸 데이터는 되돌릴 수 없다.

## SSO 연결 (B2 — 로컬 권한 정본)

SSO 공급자는 지금처럼 `BARY_OIDC_*` 로 하나 둔다. 계정이 켜진 배포에서 SSO 는 **「누구인가」(issuer, subject)만**
IdP 에게 묻는다. 역할은 계정이 정하고, IdP 의 역할 클레임·MFA 는 쓰지 않는다(공급자 계약 미해결 — 계획 §9).

- **연결이 없으면 거절**한다(403 `sso_not_linked`). 기존 사람은 로그인한 뒤 「내 계정 → SSO 계정 잇기」
  (비밀번호 재확인)로 잇는다. 이름·이메일이 같다고 저절로 이어지지 않는다.
- **JIT 는 기본 꺼짐.** 관리자가 「사람 → SSO 자동 계정」에서 켜면 연결 없는 SSO 사용자가 처음 올 때
  **auditor** 계정이 새로 생긴다(비밀번호 없음, 이메일 없음). 역할 올리기는 관리자가 한다.
- 관리자·인증 앱 등록자는 SSO 로 와도 **로컬 인증 앱 코드**를 한 번 더 넣는다.
- 끊기는 비밀번호 재확인 뒤, 다른 로그인 수단(비밀번호)이 남을 때만. 삭제된 계정의 연결은 함께 지운다.

**OIDC 클라이언트 하나를 지역·전역이 함께 쓴다** (2026-10-18 공통 정책 1차). lodestar 에 클라이언트 하나,
redirect URI 둘(정확 일치): `https://dev-icn-vtr.barycenter.tinyuniver.se/login`, `https://barycenter.tinyuniver.se/login`.
각 인스턴스의 `BARY_OIDC_REDIRECT_URI` 는 자기 주소다. 로그아웃·role-change 통지 URI 는 쓰지 않는다(철회는 계정 PG 가 판단).
⚠️ **클라이언트 비밀이 하나다.** 한 호스트에서 새면 지역·전역 모두 영향을 받는다 — 새어 나간 의심이 들면 lodestar 에서
비밀을 바꾸고 **모든** 지역·전역의 `/etc/barycenter/env`(0640) `BARY_OIDC_CLIENT_SECRET` 을 같은 값으로 바꾼 뒤 재시작한다
(지역은 재시작 동안 데이터 플레인이 몇 초 끊기므로 하나씩). 비밀은 그 파일에만 두고 메시지·로그·티켓에 적지 않는다.

**기존 OIDC 사용자 이전**: 계정을 켜면 역할 클레임으로 들어오던 옛 경로는 닫힌다. 관리자가 초대하고, 초대받은
사람이 계정을 만든 뒤 SSO 를 잇는다(또는 JIT 를 켜서 auditor 로 들인 뒤 역할을 올린다).

## IdP 권한 정본 (B3 — 지연을 감수하고 지원, 2026-10-18 사용자 결정)

계정마다 관리자가 권한 정본을 고른다(「사람」 표의 「로컬 → IdP」). IdP 정본 계정은 **SSO 로그인 때마다** 공급자의
역할 클레임을 매핑으로 바꿔 역할을 맞춘다.

1. 「사람 → SSO 공급자」에서 역할 클레임 이름(lodestar 는 `roles`)과 매핑(`viewer = auditor` …)을 저장한다.
   lodestar 의 `roles` 는 원소 하나짜리 배열이고, 표시명 `roles_label` 은 권한에 쓰지 않는다.
2. 그 사람에게 SSO 가 이어져 있어야 IdP 정본으로 돌릴 수 있다.

**받아들인 한계**: IdP 쪽에서 역할을 내리거나 사용자를 끄면 **그 사람의 다음 SSO 로그인 때** 반영된다 — 그 사이는
열린 세션의 수명(최대 12시간, 30분 쉬면 끝)만큼 늦다. 급하면 barycenter 에서 **정지**한다(다음 요청부터 막힌다 — 로컬 정지가 언제나 우선).

거부되는 로그인(로컬 역할로 떨어지지 않는다, 계정 감사에 `account.idp_role_refused`):
클레임 없음 · 값이 둘 이상 · 매핑에 없는 값 · 인증 앱 없는 사람을 관리자로 올리려 함 · **마지막 활성 관리자를 내리려 함**
(관리자가 0 이 되지 않게 내리지 않고 거부한다). IdP 의 MFA 는 여전히 인정하지 않는다 — 관리자는 로컬 인증 앱 코드다.

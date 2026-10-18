# 런북 — 사람 계정 (A 단계)

> 공통 회원정책 1차(2026-10-18)를 따른다. SSO·메일 재설정은 B 단계라 이 문서에 아직 없다.

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

- 비밀번호 5번 틀리면 1분부터 잠긴다(최대 1시간, 인스턴스와 무관하게 계정 PG 에 산다). 기다리면 풀린다.
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

다음은 **최근 15분 안에 인증 앱 확인**이 필요하다(사람 세션만 — 토큰은 MFA 가 없다): 사람·초대 관리
(역할·정지·삭제·세션 끊기·복구 링크·초대 만들기/취소), `/restore`, 인증서 개인키 올리기. 화면은 코드를 한 번
묻고 이어서 한다(`POST /api/v1/session/step-up`). **인증 앱이 없는 사람은 민감 작업을 못 한다** — 먼저 등록한다.

열린 실시간 스트림(SSE)도 하트비트(15초)마다 세션을 확인해, 로그아웃·정지된 세션의 스트림을 닫는다.
이미 보낸 데이터는 되돌릴 수 없다.

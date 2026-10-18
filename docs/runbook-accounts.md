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

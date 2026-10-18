# 런북 — 전역 모드

> 설계: `docs/design-global-mode.md`(#74). 전역은 지역들을 **읽기 전용**으로 모아 보이는 `barycenterd` 다 —
> 설정 PG·데이터 플레인·리더가 없고, 사람 계정은 지역과 같은 공용 계정 PG 를 쓴다.

## 지역 쪽 준비 (지역마다)

1. 전역 인스턴스용 auditor 토큰을 만든다 — **전역 인스턴스마다 따로**(`global-az01` …):
   `node -e 'const c=require("crypto");const t=c.randomBytes(24).toString("base64url");console.log(t);console.error("sha256:"+c.createHash("sha256").update(t).digest("hex"))'`
2. 그 지역 `tokens.json` 에 `{"name":"global-az01","role":"auditor","hash":"sha256:…"}` 를 더하고
   **`systemctl reload barycenterd`** — 재시작이 아니다(데이터 플레인을 끊지 않는다).
3. 지역 관리 API 가 전역에서 닿게 한다(메시 주소, TLS). 호스트 방화벽에 「전역 → 지역 관리 포트」 허용.

끊을 때: 그 줄을 지우고 `systemctl reload barycenterd`.

## 전역 쪽

지역 목록 파일(`BARY_GLOBAL_REGIONS`):

```json
[{ "name": "dev-icn-vtr", "api": "https://10.17.47.52:8443", "gui": "https://dev-icn-vtr.barycenter.example",
   "ca": "/etc/barycenter/global/dev-icn-vtr-ca.pem", "token": "/etc/barycenter/global/dev-icn-vtr.token" }]
```

토큰 파일은 0600. 모르는 키·겹치는 이름·https 아닌 주소는 **기동 거부**다.

env:

| | |
|---|---|
| `BARY_MODE=global` | 전역으로 뜬다 |
| `BARY_GLOBAL_REGIONS` | 위 파일 |
| `BARY_ACCOUNTS_DSN`·`BARY_ACCOUNTS_KEK` | 지역과 **같은** 공용 계정 PG·키 |
| `BARY_LISTEN`·`BARY_TLS_*` | 메시 주소, TLS |
| `BARY_OIDC_*` | 전역용 OIDC 클라이언트(호스트 이름 하나에 redirect URI 하나) |

`BARY_DSN`·`BARY_DP_REMOTE_URL`·`BARY_SECRET_BACKEND`·`BARY_DRIVER` 가 있으면 **기동 거부**(전역은 안 쓴다).

설치:

```sh
sudo deploy/install.sh --mode global --regions /etc/barycenter-global/regions.json \
  --accounts-dsn 'postgres://…/bary_accounts' --env BARY_ACCOUNTS_KEK='<지역과 같은 값>' \
  --listen <메시 주소>:8443 --tls-cert … --tls-key …
```

엔진·설정 DB 를 깔지 않고, 유닛은 엔진을 띄우지 않는다. 계정을 켜면 KEK 는 **지역과 같은 값을 직접** 줘야 한다
(새로 만들면 지역에서 등록한 인증 앱을 못 연다 — 설치가 거부한다). 지역 목록·토큰 파일은 서비스 유저(`bary`)가
읽을 수 있어야 한다(`root:bary 0640`). 설치 하네스의 `global` 판이 이 길을 실물로 잰다.

## 여러 전역 + DNS

- 클러스터마다 전역 하나, **데이터 플레인 호스트에는 두지 않는다.** 메시 내부 DNS 에 A 레코드 여러 개.
- `/readyz` 는 지역 상태와 무관하게 200 이다 — 지역 하나가 죽었다고 전역이 빠지지 않는다.
- 세션은 공용 계정 PG 의 서버 세션이라 어느 전역으로 가도 같다. 계정 PG 가 죽으면 사람 로그인은 503.

## 화면

첫 화면은 「지역」이다. 닿지 않는 지역은 **모른다**로, 판이 다르면 「판 다름」으로 보인다. 지역을 고르면 그 지역의
읽기 화면을 본다. 설정 쓰기 버튼은 없고 그 자리에 「<지역> 에서 편집」 링크가 있다. SSE 는 지역마다 상류 연결
하나를 나눠 쓰고, 보는 사람의 세션은 15초마다 다시 확인한다.

## 조회 감사

지역·전역 대시보드 공통 정책 1차(2026-10-18 사용자 결정 4번)에 따라, 전역에서 **누가 어느 지역의 어느 화면을
언제 봤는지** 공용 계정 PG 의 `account_audit` 에 남긴다.

- `action` 은 `global.view`(요약·읽기 화면 한 번)나 `global.events_open`(SSE 접속 한 번)이다. `detail` 에는
  `{region, path}` 만 적는다 — 응답 본문·쿼리·비밀값은 싣지 않는다. `actor` 는 사람이면 `user:<이름>`,
  토큰이면 토큰 이름이다.
- **기록을 남기지 못하면 그 조회를 거부한다**(503 `audit_unavailable`). 계정 PG 가 죽으면 토큰으로도 전역
  조회는 안 된다. 그때의 비상 경로는 지역 인스턴스(토큰)와 호스트 CLI 다.
- 전역에 계정 PG(`BARY_ACCOUNTS_DSN`)가 없으면 공용 저장소가 없으므로 프로세스 로그(`global.view`)로만 남는다.
- 조회: 관리자 화면 「사람 → 감사」나 `GET /api/v1/account-audit`.

## 인증서 갱신

관리 포트(8443)의 인증서(`BARY_TLS_CERT_FILE`·`BARY_TLS_KEY_FILE`)가 갱신돼 파일이 바뀌면 **`systemctl reload barycenterd`**
(OpenRC 는 `rc-service barycenterd reload`) — SIGHUP 으로 인증서와 토큰을 다시 읽는다. 재시작이 아니라 지역의 데이터
플레인이 끊기지 않는다. 새 연결부터 새 인증서이고, 로그에 `tls.reloaded`(새 만료 시각 `validTo`)가 남는다.
파일이 깨졌거나 키와 짝이 안 맞으면 `tls.reload_failed` 를 남기고 **옛 인증서를 계속 쓴다** — 갱신 경로(cert-manager·반출)는
파일을 바꾼 뒤 reload 까지 해야 끝난다. 컨테이너(파드)로 돌릴 때는 Secret 갱신 뒤 롤링 재시작이 단순하다.

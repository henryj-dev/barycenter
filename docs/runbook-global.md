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

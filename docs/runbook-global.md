# 런북 — 전역 모드

> 설계: `docs/design-global-mode.md`(#74). 전역은 지역들을 **읽기 전용**으로 모아 보이는 `barycenterd` 다 —
> 설정 PG·데이터 플레인·리더가 없고, 사람 계정은 지역과 같은 공용 계정 PG 를 쓴다.

> **전역은 별도 서비스가 아니다** (2026-11-01, `docs/adr-host-dispatch.md`). 지역 `barycenterd` 가 들어온 Host 로
> 고른다 — `BARY_GLOBAL_HOST` 로 오면 전역, 나머지(지역 이름 · IP)는 지역이다. 옛 `--mode global` · `barycenter-global` ·
> 9443 은 걷었다. 옛 env 에 `BARY_MODE=global` 이 남아 있으면 기동을 거부한다.

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
[{ "name": "dev-icn-vtr", "api": "https://dev-icn-vtr.barycenter.tinyuniver.se:8443",
   "gui": "https://dev-icn-vtr.barycenter.tinyuniver.se:8443",
   "ca": "/etc/barycenter/global/dev-icn-vtr-ca.pem", "token": "/etc/barycenter/global/dev-icn-vtr.token" }]
```

토큰 파일은 0600. 모르는 키·겹치는 이름·https 아닌 주소는 **기동 거부**다.

- **`api` 는 IP 가 아니라 이름으로 적는다.** 전역은 그 지역의 `ca` 파일**만** 믿고(시스템 신뢰 저장소를 쓰지 않는다),
  인증서 이름을 `api` 의 호스트로 검사한다. 공개 CA(Let's Encrypt) 인증서에는 IP 가 없으므로 IP 로 적으면 실패한다.
  공개 CA 면 `ca` 에는 루트(ISRG Root X1, 필요하면 X2)를 넣는다 — 중간 인증서가 바뀌어도 그대로 된다.
  전역 노드는 그 이름을 메시 내부 DNS 로 풀 수 있어야 한다.
- **`gui` 에는 `:8443` 을 붙인다.** 포트가 없으면 브라우저가 443 으로 가는데, 지역 호스트의 443 은 대시보드가 아니라
  데이터 플레인(공개 사이트)이다. Cloudflare 앞단을 쓰는 데이터 플레인은 Origin Pull 클라이언트 인증서를 요구하므로
  브라우저에서는 `ERR_BAD_SSL_CLIENT_AUTH_CERT` 로 거절된다 — 고장이 아니라 다른 문으로 간 것이다.

env (지역 `/etc/barycenter/env` 에 더한다):

| | |
|---|---|
| `BARY_REGION` | 이 지역의 이름(`util-icn-vtr`). 전역이 목록의 이름과 맞춰 본다 |
| `BARY_GLOBAL_HOST` | 전역 화면의 호스트 이름(`barycenter.tinyuniver.se`, 포트 없이) |
| `BARY_GLOBAL_REGIONS` | 위 파일. 자기 지역도 넣고 HTTPS 로 읽는다(auditor 토큰) |
| `BARY_OIDC_*` | 그대로. 전역 화면은 redirect URI 의 호스트만 `BARY_GLOBAL_HOST` 로 바꾼다 — IdP 에 두 주소를 다 등록한다 |
| `BARY_SESSION_DOMAIN` | 로그인 세션을 함께 쓸 도메인(`barycenter.tinyuniver.se`). 아래 「로그인 세션 공유」 |

`BARY_GLOBAL_HOST` 와 `BARY_GLOBAL_REGIONS` 는 짝이다. 하나만 있으면 기동을 거부한다. 새로 깔 때는
`deploy/install.sh … --env BARY_GLOBAL_HOST=… --env BARY_GLOBAL_REGIONS=…` 로 준다. 이미 깔렸으면 env 에 줄을 더하고
`systemctl restart barycenterd` — 설치를 다시 돌려도 그 줄은 남는다. 지역 목록·토큰 파일은 서비스 유저(`bary`)가
읽을 수 있어야 한다(`root:bary 0640`). 설치 하네스의 `global` 판이 이 길을 실물로 잰다.

## 전역에서 고치기

전역 화면에서 지역을 고르면 그 지역을 고칠 수 있다(docs/design-global-mode.md §1.1). 고친 것은 보는 사람의 세션 그대로
그 지역으로 간다. 그러려면:

- 전역과 그 지역이 **같은 계정 PG**(`BARY_ACCOUNTS_DSN`)를 본다. 다르면 지역이 그 세션을 모르므로 401 이다.
- 지역의 `BARY_TRUSTED_PROXIES` 에 전역의 주소를 넣는다. 그래야 지역의 시도 제한 · 감사가 사람의 주소를 쓴다.
  (같은 프로세스면 이미 들어 있다.)
- 지역 auditor 토큰은 그대로 둔다. 지역 목록 요약과 공유 실시간 스트림이 쓴다.

## 로그인 세션 공유

전역과 지역은 **같은 계정 PG**(`BARY_ACCOUNTS_DSN`)를 본다. 그리고 `BARY_SESSION_DOMAIN=barycenter.tinyuniver.se` 를 주면
그 도메인 아래로 들어온 로그인이 `__Secure-bary_sid; Domain=barycenter.tinyuniver.se` 쿠키를 받는다. 전역에서 지역 화면으로,
지역에서 전역으로 옮겨도 다시 로그인하지 않는다. 어느 쪽에서 로그아웃해도 그 세션은 모든 화면에서 끝난다.

- 도메인 밖(IP · `:8443` 직접)으로 들어오면 지금처럼 그 호스트만 쓰는 `__Host-bary_sid` 다. 브라우저는 IP 에 Domain 쿠키를
  받지 않는다.
- 켜기 전의 `__Host-` 쿠키도 계속 읽는다. 켜는 순간 로그인이 끊기지 않는다. 다음 로그인부터 도메인 쿠키로 바뀐다.
- API TLS 를 켠 서버에서만 쓴다(`__Secure-`). TLS 가 없으면 기동을 거부한다. 점이 하나뿐인 도메인(`tinyuniver.se`)도 거부한다.
- **그 도메인 아래에는 barycenter 화면만 둔다.** 그 아래 호스트는 모두 이 쿠키를 받고, 같은 이름의 쿠키를 심을 수도 있다.
  다른 서비스(데이터 플레인의 공개 사이트 등)를 `*.barycenter.tinyuniver.se` 에 열지 않는다. 와일드카드 DNS 도 두지 않는다.
- 쓰기의 CSRF 검사(`Origin` 이 그 요청의 `Host` 와 같아야 한다)는 그대로다. 화면마다 자기 호스트로 쓴다.

## 주소 · 인증서 · DNS

- **전역 주소는 데이터 플레인 443 으로 들어온다.** 지역 주소(`util-icn-vtr.barycenter.tinyuniver.se`)와 같은 길이다.
  barycenter 설정에 `barycenter.tinyuniver.se` 의 인증서와 HTTPS 라우트를 더하고, 그 라우트를 관리 API(8443)
  풀로 보낸다. nginx 가 SNI 로 이름마다 인증서를 고르고, `Host` 를 그대로 넘긴다 — 데몬은 그 Host 로 전역을 고른다.
  `*.barycenter.tinyuniver.se` 는 `barycenter.tinyuniver.se` 를 덮지 않으므로 인증서가 따로 필요하다.
- 앞단 nginx 의 주소는 `BARY_TRUSTED_PROXIES` 에 있어야 한다. 그래야 시도 제한 · 감사가 사람의 주소를 쓴다.
- **엔진이 고장 나면 443 의 두 이름이 함께 안 열린다.** 그때는 관리 포트로 바로 간다:
  `https://<지역>.barycenter.tinyuniver.se:8443` (그 인증서는 와일드카드다). 엔진을 거치지 않는 문이 남는다.
- DNS: `barycenter.tinyuniver.se` 에 지역 서버마다 A 레코드를 하나씩 둔다(라운드로빈). 헬스체크는 없다 — 죽은 서버로
  가면 브라우저가 다시 시도해야 한다. 세션은 공용 계정 PG 의 서버 세션이라 어느 서버로 가도 같다. 계정 PG 가 죽으면
  사람 로그인은 503.
- `/readyz` 는 지역 상태와 무관하게 200 이다 — 지역 하나가 죽었다고 전역이 빠지지 않는다.
- ⚠️ **같은 프로세스다.** 지역 `barycenterd` 가 재시작하면 그 서버의 전역 화면도 함께 내려간다. 다른 서버의 전역이
  받친다. 지역이 하나인 동안(web-01)은 그 서버가 죽으면 전역도 죽는다.
- 노출: 지역 서버에는 이미 계정 DSN·KEK 가 있으므로, 전역을 켜서 새로 늘어나는 것은 **다른 지역의 읽기 전용 auditor
  토큰**뿐이다.

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

# ADR — 한 프로세스가 Host 로 전역과 지역을 고른다

- 상태: 채택 (2026-11-01, 사용자 결정). `docs/runbook-global.md` 의 「지역 호스트에 함께 깐다 — 다른 서비스 · 포트」
  (2026-10-19)를 대신한다.
- 범위: `barycenterd` 의 제어 API · GUI. 데이터 플레인은 그대로다.

## 맥락

전역은 따로 도는 프로세스였다(`barycenter-global`, 9443, `/etc/barycenter-global`). 서버마다 두 서비스와 두 설정 ·
두 인증서 · 두 포트를 관리해야 했다. 운영자가 원하는 모양은 다음과 같다.

- 서버 하나에 `barycenterd` 하나.
- `barycenter.tinyuniver.se` 로 오면 전역 화면, `util-icn-vtr.barycenter.tinyuniver.se` 로 오면 지역 화면.
- `barycenter.tinyuniver.se` 에는 모든 서버의 A 레코드를 넣는다(DNS 라운드로빈).

## 결정

1. **지역 `barycenterd` 가 전역 화면도 낸다.** 요청의 Host 가 `BARY_GLOBAL_HOST` 이면 전역으로, 나머지 Host(지역 이름 ·
   IP · 없음)는 지역으로 답한다. 모르는 Host 를 거절하지 않는다 — CLI · 설치 검증 · 헬스 체크가 IP 로 온다.
2. **인증 · 사람 계정 · 세션 · GUI 파일 · 실패 제한은 두 화면이 함께 쓴다.** 세션 쿠키는 `__Host-` 라 호스트마다 따로
   붙는다. 실패 제한은 한 벌이라, 화면을 바꿔 가며 두 배로 시도하지 못한다.
3. **Host 는 클라이언트가 정한다.** 그래도 두 화면은 각자 인증한다. Host 를 바꿔서 얻는 권한은 없다. 전역 화면은 지금처럼
   읽기만 한다.
4. **지역은 자기 이름을 안다** (`BARY_REGION`). `/status` · `/readyz` 의 `region` 으로 말하고, GUI 상단이 보인다. 전역은
   지역 목록의 `name` 과 지역이 말한 이름이 다르면 그 지역을 「오류」로 싣는다 — 목록 오타로 다른 지역을 그 이름으로
   보이지 않는다.
5. **env** (서버마다):

   | | 예 | 뜻 |
   |---|---|---|
   | `BARY_REGION` | `util-icn-vtr` | 이 지역의 이름 |
   | `BARY_GLOBAL_HOST` | `barycenter.tinyuniver.se` | 전역 화면의 호스트 이름(포트 없이) |
   | `BARY_GLOBAL_REGIONS` | `/etc/barycenter/regions.json` | 전역이 보는 지역 목록(`runbook-global.md` 의 모양) |
   | `BARY_NODE_NAME` | `web-01` | 서버 이름(지금 그대로) |

   `BARY_GLOBAL_HOST` 와 `BARY_GLOBAL_REGIONS` 는 짝이다. 하나만 있으면 기동을 거부한다.

## 단계

1. (이 ADR) Host 로 고르기 · `BARY_REGION` · 이름 맞춰 보기. 자기 지역도 목록에 넣고 HTTPS 로 읽는다(auditor 토큰).
2. (끝, 2026-11-01) SSO(`BARY_OIDC_*`).
   - 로그인 중 상태: 계정(`BARY_ACCOUNTS_DSN`)이 켜져 있으면 이미 계정 PG(`login_flows`)에 있다. 시작과 콜백이 다른 서버로
     가도 된다. 계정이 꺼져 있으면 서버 메모리에 있다. 그 상태로 전역 호스트와 SSO 를 함께 켜면 기동 때
     `oidc.login_state_in_memory` 경고를 낸다. 노드가 여럿이면 계정을 켠다.
   - redirect URI: 전역 화면은 `BARY_OIDC_REDIRECT_URI` 의 호스트만 `BARY_GLOBAL_HOST` 로 바꾸고 포트를 뗀다. 경로는 같다.
     예: `https://util-icn-vtr.barycenter.tinyuniver.se:8443/login` → `https://barycenter.tinyuniver.se/login`.
     IdP 에는 두 주소를 모두 등록한다.
3. 설치 스크립트와 문서에서 별도 전역 서비스(`--mode global`, 9443)를 걷는다. 8443 직결로 두 이름을 쓰려면 인증서 하나가
   두 이름을 모두 덮어야 한다(`*.barycenter.tinyuniver.se` 는 `barycenter.tinyuniver.se` 를 덮지 않는다). 데이터 플레인 443 을
   거치면 nginx 가 이름마다 인증서를 고른다.

## 대가

- **프로세스 격리가 없다.** 지역 `barycenterd` 가 재시작하거나 죽으면 그 서버의 전역 화면도 함께 내려간다. 다른 서버의
  전역이 받친다(DNS 라운드로빈). 지역이 하나인 동안은 서버 장애에 어차피 함께 갔다.
- **DNS 라운드로빈은 헬스 체크가 없다.** 죽은 서버의 레코드는 손으로 빼야 하고 TTL 동안 남는다.

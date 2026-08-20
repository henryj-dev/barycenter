# 현재 상태 (2026-08-20)

무엇이 있고, 무엇이 열려 있고, 무엇을 안 하는가. 설계는 `DESIGN.md`, 테스트는
`TESTS.md`, 실행은 `scripts/verify.sh` 다.

회차 일기(검수·스파이크·화면을 연 날)는
[`docs/archive/STATUS-log.md`](./docs/archive/STATUS-log.md) 로 옮겼다.
그 파일은 정본이 아니다.

마지막 GUI 쓰기는 source_ip_hash 풀 put 이다. hashKey 를 안 붙인다.
산출물 화면은 head 렌더다. 기록 화면은 로그다. nginx.conf 는 정본이 아니다.
CLI 는 listener·풀·HTTP/패스스루 라우트·백엔드·TLS 정책·인증서·SNI create 가 있다.
listener·라우트·백엔드·SNI·풀·인증서·TLS 정책은 뺀다. get 은 인증서·정책·SNI·헬스·오퍼레이션·plan·
metrics 와 풀/백엔드 한 줄 읽기를 연다. 모르는 이름은 안 부른다. recover 는 미완
전환을 이어받는다. changeset 은 discard·reopen 이 있다. apply 는 아니다.
websocket 은 HTTP proxy 에서만 켠다. 인증서 패치에 개인키가 없다.

CI Linux 는 OpenSSL 3 출력 · 바인드 마운트 uid 0 · Lua 밸런서의 호스트 이름 거절에서
깨졌다. 멤버십 슬롯은 넣기 전에 IP 로 푼다. 그 다음 남은 둘은 호스트가 uid 0
error.log 에 쓰려 한 자리와, source_ip_hash 잔여 상태에서 B12 만 기대한 재시작
테스트다. 씨앗은 컨테이너 안에서 깔고, 재시작은 멤버십만 :12 로 옮긴 뒤 잰다.

---

## 1. 지금 있는 것

엔진은 HTTP · HTTPS · TCP · UDP · TLS 패스스루를 렌더한다. 적용은 changeset →
plan → commit → apply 다. 게시는 세대이고 활성화는 증거로 판정한다.

| 층 | 있는 것 | 없는 것 |
|---|---|---|
| 모델 | 리스너·풀·백엔드·HTTP/패스스루 라우트·인증서·TLS 정책·SNI 바인딩. 판별 유니온 | h3, `least_conn`, WAF, `on_nxdomain`/`on_timeout` |
| 적용 | 봉인된 changeset, 시맨틱 plan, 크래시 저널, 펜싱, 롤백 | — |
| 동결 | 구현된 OpenAPI (`SURFACE-API.json`) · DDL (`SURFACE-DDL.sql`) | 미구현 계약 |
| 멤버십 | 이중 zone 슬롯, Lua 밸런서, HTTP 본문 프로브(HTTP 풀) · TCP connect(L4), SSE `health`, 드레인 제외, peer inflight 관측 | — |
| TLS | 업로드 자료, https 렌더, SNI 선택, 세대 결박 롤백, GUI SNI 바인딩 · 인증서·정책 삭제 | — |
| ACME | http-01 러너, dns-01 파일 프로바이더, 주문·챌린지 GET, EAB, Retry-After 백오프, 만료 30일 전 갱신 틱 | — |
| CLI | `changeset` 단계(discard·reopen 포함), `commit --plan`, `apply --plan`, export/import, backup/restore, status/rollback/recover, listener·풀·라우트·백엔드·TLS 정책·인증서·SNI create, listener·라우트·백엔드·SNI·풀·인증서·정책 delete, get(인증서·정책·SNI·헬스·오퍼레이션·plan·metrics·주문), backend drain/drain-status | — |
| GUI | 여덟 Kit 경로. 폴링하지 않는다 | 아래 §2 |

### GUI

화면: 영향 · 리스너 · 풀 · 라우트 · 인증서 · 상태 · 산출물 · 기록. Kit 여덟
경로다. SSE 는 fetch 스트림 + `pullSse` 다.
산출물은 `GET /api/v1/config/rendered` 다. 기록은 `GET /api/v1/audit` 다.
폴링하지 않는다.

쓰기는 changeset 을 지나 **commit 까지** 한다. apply 는 영향 화면만 한다.

| 쓰기 | 계약 |
|---|---|
| 풀 | 첫 백엔드와 같이. `round_robin` · `hash`+hashKey · `source_ip_hash`. 빈 풀은 plan 이 막는다. delete 한 줄 |
| 백엔드 | put · delete |
| HTTP 리스너 | bind · port · `http.defaultAction.pool` |
| TCP 리스너 | bind · port · `defaultPool` (http 프로필을 안 붙인다) |
| UDP 리스너 | bind · port · `defaultPool` · named preset. PROXY 필드 없음 |
| TLS 정책 | `minVersion` 만. HSTS 안 켬 |
| HTTPS 리스너 | bind · port · pool · `tls.policy` · `tls.defaultCertificate`. 자료 없는 인증서는 안 고른다 |
| HTTP 라우트 | 호스트 → 풀 proxy. websocket 은 기본 끔. 켜려면 명시 |
| HTTP redirect | 호스트 → `to`. status 301·302·307·308. 기본 302. pool 없음 |
| HTTP reject | 호스트 → 403·404·444. 기본 403. to·pool 없음. 444 는 응답 없이 끊는다 |
| 패스스루 리스너 | bind · port. tls 없음. unmatched SNI 풀은 선택 |
| 패스스루 라우트 | SNI → TCP 풀 proxy. reject 는 SNI 만 끊는다. HTTP status 없음 |
| 인증서 | 자료는 `POST /certificates/material`. 설정 put 은 `materialRef`·digest 만 |
| SNI 바인딩 | listener · hosts · certificate. override 없음. 라우트에 안 붙인다 |

만료는 자료에서 읽고, 자료가 없으면 빼지 않는다. 개인키는 패치에 없다.

### 스위트

수치는 2026-08-20 `verify:quick` 과 직전 전체 게이트의 실측이다.

| 스위트 | 명령 | 통과 |
|---|---|---|
| typecheck | `npm run typecheck` | — |
| 표면 | `node scripts/surface.mjs --check` | — |
| 모델 | `npm run test:model` | 13 |
| 단위 | `npm test` | **510** |
| conformance | `npm run test:conformance` | **392** |
| 골든 | `npm run test:golden` | 44 |
| 엔진 사실 | `npm run test:engine` | 73 (SKIP 2) |
| e2e | `npm run test:e2e` | 57 |
| 스파이크 | `spike/*/run.sh` | 91 |
| 저장소 | `npm run test:store` | 107 |

스위트 통과와 동결 가능은 다르다. `--freeze-gate` 는 미해소 항목이 있으면
non-zero 다. API·DB 스키마는 아직 동결하지 않는다 (§9.1.1).

---

## 2. 열린 것

가까운 GUI 구멍 — 모델에 있는 쓰기 알고리즘은 폼이 있다. 풀은 뺀다. 미완 전환은
상태 화면에서 recover 한다. `least_conn` 은 모델에 없다.

주문 GET · dns-01 place/cleanup · 드레인 시작은 있다. 드레인 숫자는 엔진
admin `/membership/inflight` 가 주면 싣고, 없으면 안 싣는다 (`no_new_traffic`).
HTTP 풀은 GET 본문으로 판정한다. 인증서·TLS 정책은 뺀다. BackendDiscovery 는
멤버십이 발견한 엔드포인트를 받는다. 역할은 auditor · operator · admin 이다.
백업은 `GET /backup`, 복구는 `POST /restore` (`admin`). SPOF 런북은
`docs/runbook-spof.md` 다. 숫자는 목표 후보다.

로드맵 잔여.

- A 표면 안정 회차 (동결 카운터 1)
- OIDC Authorization Code UI (ID Token 검증은 있다)

스파이크 — 기능 축소 등급. 게이트에 넣지 않는 것은 넣지 않는다.

| | 상태 |
|---|---|
| S2 드레인 관측 | 밸런서 inflight 관측. 없으면 숫자를 안 싣는다 |
| S3 재시작 부트스트랩 | eligible ∩ durable 헬스. 빈 슬롯은 의도적 zero-peer 로 민다 |
| S4 CP 단절 | 멤버십 슬롯에 TTL 없음. 갱신 실패는 마지막 셋 유지 |
| S5 부분 전환 | 평면별 슬롯. 한 평면이 비어도 다른 평면을 안 지운다 |
| S6 `least_conn` | v0 알고리즘에서 제외 |
| S9 SNI 3분기 | 현행 유지 (부재·파싱실패는 reject) |
| S10 `strict_priority` | 안 연다 |
| S14 native DNS | 7/8. 게이트에 안 넣는다 |
| S15 밸런서 품질 | Lua 가 round_robin/hash/source_ip_hash. 수치 게이트는 스파이크 |
| S20 HTTP/3 | 모델에서 뺀다. 게이트에 안 넣는다 |

block 등급 S8 · S11 · S12 는 열려 지나갔다. S13 은 원장을 안 짓기로 닫았다 —
마커로는 옛 워커를 못 센다. `worker_shutdown_timeout` 이 상한이다.

---

## 3. 안 하는 것

- WAF · 메서드×경로 ALLOW/DENY
- 모델에 h3 / `transportOf()`
- `on_nxdomain` · `on_timeout` 모델 필드
- OCSP stapling
- 멀티 노드 HA · 기존 세션 강제 종료
- raw nginx 편집 UI
- GUI 폴링

---

## 4. 모듈

| | 무엇 |
|---|---|
| `model/decode.ts` | 경계 해독기. `unknown` → `Model` |
| `model/provisional.ts` | `RawModel` / 판별 유니온 `Model` |
| `validate/` | 참조 · 소켓 · 프로토콜 · 엔진 제약 |
| `conf/` | AST → `nginx.conf` |
| `route/compile.ts` | 호스트 라우트 최종 순서 |
| `control/health.ts` | HTTP 본문 프로브 · TCP 프로브. 드레인 숫자를 안 만든다 |
| `control/discovery.ts` | 발견한 엔드포인트 → 멤버십 슬롯. 표면 아님 |
| `control/acme-*.ts` | 주문 원장 · 틱 러너 · 게시 |
| `engine/probe.ts` | `nginx -V` 를 실제로 묻는다 |
| `web/edit.ts` | GUI 가 얹는 patch. apply 가 아니다 |
| `dp/` | 적용 상태기계 · 세대 · 시크릿 |
| `index.ts` | 동결 대상 표면 |

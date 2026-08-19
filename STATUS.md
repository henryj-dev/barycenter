# 현재 상태 (2026-08-19)

무엇이 있고, 무엇이 열려 있고, 무엇을 안 하는가. 설계는 `DESIGN.md`, 테스트는
`TESTS.md`, 실행은 `scripts/verify.sh` 다.

회차 일기(검수·스파이크·화면을 연 날)는
[`docs/archive/STATUS-log.md`](./docs/archive/STATUS-log.md) 로 옮겼다.
그 파일은 정본이 아니다.

마지막 GUI 쓰기는 인증서 자료 업로드다. 개인키는 패치에 안 실린다.

---

## 1. 지금 있는 것

엔진은 HTTP · HTTPS · TCP · UDP · TLS 패스스루를 렌더한다. 적용은 changeset →
plan → commit → apply 다. 게시는 세대이고 활성화는 증거로 판정한다.

| 층 | 있는 것 | 없는 것 |
|---|---|---|
| 모델 | 리스너·풀·백엔드·HTTP/패스스루 라우트·인증서·TLS 정책·SNI 바인딩. 판별 유니온 | h3, `least_conn`, WAF, `on_nxdomain`/`on_timeout` |
| 적용 | 봉인된 changeset, 시맨틱 plan, 크래시 저널, 펜싱, 롤백 | OpenAPI · DDL 동결 |
| 멤버십 | 이중 zone 슬롯, Lua 밸런서, TCP connect 프로브, SSE `health` | 드레인 관측(S2), HTTP 본문 프로브 |
| TLS | 업로드 자료(`POST /certificates/material`), https 렌더, SNI 선택, 세대 결박 롤백 | GUI SNI 바인딩 폼 |
| ACME | http-01 러너, shared dict 챌린지, 만료 30일 전 갱신 틱 | 주문 GET, dns-01 프로바이더 |
| CLI | `changeset` 단계, `commit --plan`, `apply --plan`, export/import, status/rollback | 리소스 하위 명령 |
| GUI | 여섯 화면. 폴링하지 않는다. Kit 이 아니다 | 아래 §2 |

### GUI

화면: 영향 · 리스너 · 풀 · 라우트 · 인증서 · 상태. 같은 `index.html`, `pageOf` 가
가른다. SSE 는 fetch 스트림 + `pullSse` 다.

쓰기는 changeset 을 지나 **commit 까지** 한다. apply 는 영향 화면만 한다.

| 쓰기 | 계약 |
|---|---|
| 풀 | 첫 백엔드와 같이. `round_robin` 만. 빈 풀은 plan 이 막는다 |
| 백엔드 | put · delete |
| HTTP 리스너 | bind · port · `http.defaultAction.pool` |
| TCP 리스너 | bind · port · `defaultPool` (http 프로필을 안 붙인다) |
| UDP 리스너 | bind · port · `defaultPool` · named preset. PROXY 필드 없음 |
| TLS 정책 | `minVersion` 만. HSTS 안 켬 |
| HTTPS 리스너 | bind · port · pool · `tls.policy` · `tls.defaultCertificate`. 자료 없는 인증서는 안 고른다 |
| HTTP 라우트 | 호스트 → 풀 proxy. websocket 끔 |
| 인증서 | 자료는 `POST /certificates/material`. 설정 put 은 `materialRef`·digest 만 |

만료는 자료에서 읽고, 자료가 없으면 빼지 않는다. 개인키는 패치에 없다.

### 스위트

수치는 2026-08-19 `verify:quick` 과 직전 전체 게이트의 실측이다.

| 스위트 | 명령 | 통과 |
|---|---|---|
| typecheck | `npm run typecheck` | — |
| 표면 | `node scripts/surface.mjs --check` | — |
| 모델 | `npm run test:model` | 13 |
| 단위 | `npm test` | **388** |
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

가까운 GUI 구멍 — API 는 있고 폼이 없다.

- SNI 바인딩 put
- 패스스루 리스너 · 패스스루 라우트
- HTTP 라우트 redirect · reject · websocket
- 풀 알고리즘 `hash` (`hashKey` 필요)

API 가 없어서 못 그리는 것.

- ACME 주문·챌린지 GET
- dns-01 프로바이더
- 드레인 inflight/sessions (S2)

로드맵 잔여.

- CLI 리소스 하위 명령
- SvelteKit (여섯 경로인데도 한 `index.html`)
- 렌더된 conf / audit 화면 (API 는 있다)
- v1.0 RBAC · 백업/복구 리허설 · SPOF 런북

스파이크 — 기능 축소 등급. 게이트에 넣지 않는 것은 넣지 않는다.

| | 상태 |
|---|---|
| S2 드레인 관측 | 열림 |
| S3 재시작 부트스트랩 | 열림 |
| S4 CP 단절 | 열림 |
| S5 부분 전환 | 부분 |
| S6 `least_conn` | v0 알고리즘에서 제외 |
| S9 SNI 3분기 | 현행 유지 (부재·파싱실패는 reject) |
| S10 `strict_priority` | 안 연다 |
| S14 native DNS | 7/8. 게이트에 안 넣는다 |
| S15 밸런서 품질 | 열림 |
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
| `control/health.ts` | TCP 프로브. 드레인 숫자를 안 만든다 |
| `control/acme-*.ts` | 주문 원장 · 틱 러너 · 게시 |
| `engine/probe.ts` | `nginx -V` 를 실제로 묻는다 |
| `web/edit.ts` | GUI 가 얹는 patch. apply 가 아니다 |
| `dp/` | 적용 상태기계 · 세대 · 시크릿 |
| `index.ts` | 동결 대상 표면 |

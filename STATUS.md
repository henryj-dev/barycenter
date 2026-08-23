# 현재 상태 (2026-08-23)

무엇이 있고, 무엇이 열려 있고, 무엇을 안 하는가. 설계는 `DESIGN.md`, 테스트는
`TESTS.md`, 실행은 `scripts/verify.sh` 다.

회차 일기(검수·스파이크·화면을 연 날)는
[`docs/archive/STATUS-log.md`](./docs/archive/STATUS-log.md) 로 옮겼다.
그 파일은 정본이 아니다.

화면 산출물(`gui/build`)은 `scripts/build.sh` 가 만들고 이미지가 싣는다 — 전에는
게이트에도 이미지에도 없었고, 브라우저 번들이 안 서는 상태였다.
마지막 GUI 쓰기는 source_ip_hash 풀 put 이다. hashKey 를 안 붙인다.
산출물 화면은 head 렌더다. 기록 화면은 로그다. nginx.conf 는 정본이 아니다.
CLI 는 listener·풀·HTTP/패스스루 라우트·백엔드·TLS 정책·인증서·SNI create 가 있다.
listener·라우트·백엔드·SNI·풀·인증서·TLS 정책은 뺀다. get 은 인증서·정책·SNI·헬스·오퍼레이션·plan·
metrics 와 풀/백엔드 한 줄 읽기를 연다. 모르는 이름은 안 부른다. recover 는 미완
전환을 이어받는다. changeset 은 discard·reopen 이 있다. apply 는 아니다.
websocket 은 HTTP proxy 에서만 켠다. 인증서 패치에 개인키가 없다.

CI 는 `.github/workflows/verify.yml` 이고 **`scripts/verify.sh` 를 그대로 돌린다** — 자기
단계 목록을 따로 들지 않는다. 갈라지면 어느 쪽이 계약인지 아무도 모른다.

`spike/s12` 의 간헐 빨강은 **성격이 특정됐고 원인이 닫혔다.** 고정된 로직 결함이 아니라
러너가 *"활성화를 관측 못 함"* 과 *"활성화가 안 일어남"* 을 똑같이 `failed` 로 접던 것이다
(▲ 잔여물). 이제 갈라진다 — 못 읽었으면 세계에 대해 아무 주장도 하지 않고, HUP 을 다시
보내지도 않는다.

---

## 1. 지금 있는 것

엔진은 HTTP · HTTPS · TCP · UDP · TLS 패스스루를 렌더한다. 적용은 changeset →
plan → commit → apply 다. 게시는 세대이고 활성화는 증거로 판정한다.

| 층 | 있는 것 | 없는 것 |
|---|---|---|
| 모델 | 리스너(프록시 한계값·헤더 규칙·레이트리밋·`on_no_sni`·`strictPriority` 포함)·풀(헬스체크 정의·`least_conn`)·백엔드·HTTP/패스스루 라우트·인증서·TLS 정책·SNI 바인딩·엔진 dict 크기. 판별 유니온 | h3, WAF, `on_nxdomain`/`on_timeout`, **그리고 §4.3·§4.3.1·§4.4 의 아래 필드들** |
| 적용 | 봉인된 changeset, 시맨틱 plan, 크래시 저널, 펜싱, 롤백. 관측 실패와 부정 관측을 가른다 | — |
| 동결 | B(구현된 OpenAPI · DDL). **A 는 이 회차에 풀렸다** — W3 설정 셋을 들이려고. 근거가 `SURFACE.txt` 머리에 남는다 | 미구현 계약 |
| 멤버십 | 이중 zone 슬롯, Lua 밸런서, HTTP 상태코드 프로브(풀별 정의) · TCP connect(L4), SSE `health`, 드레인 제외, **두 평면의 peer inflight 관측** | — |
| TLS | 업로드 자료, https 렌더, SNI 선택, 세대 결박 롤백, GUI SNI 바인딩 · 인증서·정책 삭제 | — |
| ACME | http-01 러너, dns-01 파일 프로바이더, 주문·챌린지 GET, EAB, Retry-After 백오프, 만료 30일 전 갱신 틱 | — |
| CLI | `changeset` 단계(discard·reopen 포함), `commit --plan`, `apply --plan`, export/import, backup/restore, status/rollback/recover, listener·풀·라우트·백엔드·TLS 정책·인증서·SNI create, listener·라우트·백엔드·SNI·풀·인증서·정책 delete, get(인증서·정책·SNI·헬스·오퍼레이션·plan·metrics·주문·`backends/status`), backend drain/drain-status. **리스너 옵션 플래그**(`--rate`·`--header`·`--max-body`·타임아웃) | — |
| GUI | Kit 경로(로그인 포함). 폴링하지 않는다. **리스너 옵션 폼**·**왜 트래픽을 안 받나**·패스스루 두 폴백(`on_no_sni` 포함) | 아래 §2 |

### GUI

화면: 영향 · 리스너 · 풀 · 라우트 · 인증서 · 상태 · 산출물 · 기록 · 로그인. Kit
경로다. SSE 는 fetch 스트림 + `pullSse` 다.
영향 화면은 §5.4 **아홉 항목**을 읽는다 — reload · 좌표 이동 · 영향받는 리스너 ·
기존 세션 · 소켓 · 인증서 교체와 만료 · 라우트 순서 경고 · 엔진 경고. 끊기는 것을
먼저 말하고 영향 없는 프로토콜은 안 싣는다. CLI 도 커밋 앞에서 같은 요약을 낸다.
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

수치는 2026-08-23 전체 게이트의 실측이다. **문서에 옮겨 적은 값은 늘 낡는다** —
직전 표는 단위를 510 이라고 적어 뒀는데 실측은 595 였다.

| 스위트 | 명령 | 통과 |
|---|---|---|
| typecheck | `npm run typecheck` | — |
| 표면 | `node scripts/surface.mjs --check` | — |
| 모델 | `npm run test:model` | 13 |
| 단위 | `npm test` | **743** |
| conformance | `npm run test:conformance` | **424** |
| 골든 | `npm run test:golden` | 62 |
| 엔진 사실 | `npm run test:engine` | 76 (SKIP 1) |
| e2e | `npm run test:e2e` | 60 |
| 스파이크 | `spike/*/run.sh` | 100 |
| 저장소 | `npm run test:store` | 189 |

스위트 통과와 동결 가능은 다르다. `--freeze-gate` 는 A(타입·DP ABI) 표면과
B(구현된 API·DDL) 드리프트를 둘 다 막는다.

**A 동결은 이 회차에 풀렸다.** 먼저 W3 의 설정 셋(`Pool.healthCheck` · dict 크기 ·
`GenerationError('path_escape')`)이, 이어서 제안 6·7·8 의 넷(`ProxyLimits` ·
`HeaderRule` · `HeaderRules` · `RateLimit`)이 `Model` 을 넓혔다. **116 심볼 · 카운터 0 ·
미선언**이고, **재동결까지 3 회차를 다시 쌓아야 한다.** 푸는 길은
`surface.mjs --unfreeze "<근거>"` 하나뿐이고 근거를 요구한다 — 그 근거는 `SURFACE.txt`
머리에 남고 `--write` 를 지나서도 안 지워진다.

⚠️ 그래서 **`./scripts/verify.sh --freeze-gate` 는 지금 빨갛다. 회귀가 아니다** —
A 가 미선언이라는 사실을 그대로 말하는 것이다. 기본 게이트(`verify.sh`)는 `--check` 만
쓰므로 초록이다. 3 회차를 쌓고 `--freeze` 를 선언하면 다시 초록이 된다.

---

## 2. 열린 것

가까운 GUI 구멍 — 모델에 있는 쓰기 알고리즘은 폼이 있다. 풀은 뺀다. 미완 전환은
상태 화면에서 recover 한다. `least_conn` 은 모델에 없다.

주문 GET · dns-01 place/cleanup · 드레인 시작은 있다. 드레인 숫자는 엔진 admin 이
주면 싣고, 없으면 안 싣는다 (`no_new_traffic`). **두 평면 다 창구가 있다** — http 는
`/membership/inflight`, stream 은 admin 의 `inflight` 동사다. 아직 inflight 와 세션이
한 카운터라 둘로 안 갈린다. HTTP 풀은 상태 코드로 판정하고 풀별로 좁힐 수 있다. 인증서·TLS 정책은 뺀다. BackendDiscovery 는
멤버십이 발견한 엔드포인트를 받는다. 역할은 auditor · operator · admin 이다.
백업은 `GET /backup`, 복구는 `POST /restore` (`admin`). SPOF 런북은
`docs/runbook-spof.md` 다. RTO/RPO 는 ADR-SPOF 가 v1 운영 정책으로 확정한다
(랩 SLA 아님). OIDC 는 ID Token Bearer 와 Authorization Code 로그인이다.

로드맵 v0.1~v1.0 은 전부 코드에 있다. 검수의 제안 6·7·8·9·10 이 닫혔고 **저작 표면
(CLI 플래그·GUI 폼)까지 갔다.** S6 `least_conn` 과 mTLS 신원 매핑도 이 회차다.

남은 것과 **왜 안 하는지**:

| | 판정 |
|---|---|
| ~~S2 세션 수~~ | **닫혔다.** 가를 것이 없다 — stream 은 연결당 한 번이라 정의상 같고, http 는 upstream `keepalive` 를 안 내므로 요청 하나가 연결 하나다. 그 **전제**를 계약 테스트로 지킨다 |
| S15 밸런서 품질 | **넷 중 셋을 쟀다.** RR 편차 ~0% · hash 분포 최대 10.1% · **재매핑률 75~94%**(consistent 이상값 5.9~25%) · 고르는 비용 23ns. 넷째는 `passive` 가 모델에 없어 잴 대상이 없다 |
| ~~S3 재시작 부트스트랩~~ | **통과.** head ∩ 지금 헬스로 다시 적재한다 — 죽은·드레인된 백엔드가 재시작으로 안 되살아난다. `unknown` 은 안 뺀다 |
| ~~S4 CP 단절~~ | **통과.** 의도적 zero-peer 와 갱신 실패를 가른다 (§6.7) |
| ~~S9 SNI 3분기~~ | **열렸다.** 셋이 갈린다 — no-SNI 는 `$ssl_preread_protocol` 이 차고, malformed 는 비-TLS 와 한 통이고, timeout 은 연결이 끊긴다. `on_no_sni` 가 설정 가능해졌다 |
| S10 `strict_priority` | **모드는 냈고 기준은 못 넘었다.** 충돌 그래프의 연결 요소를 앵커 정규식으로 내린다. 실측 강등 50개 +3.4% · 250개 +9.8% 라 500 라우트 5% 기준을 두 배로 넘는다 — 그래서 검증기가 **강등 128개 상한**을 건다 (§7.5-4). 스파이크는 게이트에 안 넣는다 |
| S14 native DNS | **8/8 이 나오는 회차가 있다** — SRV 포함. 다만 6/8~8/8 사이로 흔들린다. 흔들리는 것은 엔진이 아니라 **스파이크의 결합**이다: 한 resolver 와 한 존을 여덟 측정이 나눠 쓰고 앞 측정의 캐시가 뒤에 남는다. 게이트에 안 넣는다 |
| S20 HTTP/3 | §4.5 검증기가 다중 전송을 표현해야 한다 — 그것이 선결 조건이고 §12.0 이 h3 를 모델에서 뺀 이유다 |
| ▲ 잔여물 넷 | **셋의 답이 이 회차에 측정이 됐다** — 창을 못 막는 것은 그대로지만(결함이 아니라 결정이다) 그 문장의 두 절을 따로 잰다: 창이 열리는가 · 수렴이 덮는가. 남은 하나(예산 초과)는 여전히 재현물을 못 쓴다. §12 의 재투영 창 ▲ 도 닫혔다 |
| 원격 드라이버 전송 | v0.1 이 실측했다 — 에이전트와 nginx 는 **같은 파일시스템**을 봐야 한다. 지금 배포에서 둘은 같은 프로세스라 그 사이에 전송이 없다 |
| §11.3 동적 포트 | k8s 네이티브 배포가 별도 과제다. v1 권장은 전용 VM + hostNetwork |

**§4.3·§4.3.1·§4.4 에 적혀 있는데 코드에 없는 것** (2026-08-23 실사). 이건 축소 결정이
아니라 **아직 안 한 것**이다 — 결정이었다면 §12.0 이나 §15 에 근거가 있어야 한다:

| 자리 | 없는 필드 |
|---|---|
| `Pool` (§4.3) | `upstream_tls` · `dns` · `sticky`. **`passive` 는 안 넣기로 했다** — 이 평면의 upstream 은 `server` 가 자리표시 하나뿐이라 peer 별로 셀 대상이 없고, Lua 로 다시 만들면 멤버십의 주인이 둘이 된다 |
| 헬스 프로브 (§4.3.1) | `probe.mode`·`protocol`·`port`·`host_override`·`udp`. `interval`·`timeout`·`rise`·`fall` 은 **데몬 전체에 하나씩** 이지 풀별이 아니다 |
| `Backend` (§4.4) | `max_conns` · `admin_state` · `drain.deadline_s` · `is_backup` |

드레인은 **스펙 필드가 아니라 멤버십 평면의 동작**으로 산다 — `bary backend drain` 이
슬롯에서 빼고 `in:` 으로 관측한다. 그래서 드레인은 되지만 기한과 `deadline_exceeded` 는
표현할 자리가 없다.

⚠️ 레이트리밋은 **`return` 으로 끝나는 라우트(redirect·reject)에 안 걸린다.** nginx 의
단계 순서다 — `return` 은 rewrite, `limit_req` 는 preaccess 인데 rewrite 가 앞이다.
`tests/golden/rate-limit.test.ts` 가 그 거동을 못 박는다.

스파이크 — 기능 축소 등급. 게이트에 넣지 않는 것은 넣지 않는다.

| | 상태 |
|---|---|
| S2 드레인 관측 | **두 평면 다** 창구가 있다 — http 는 `/membership/inflight`, stream 은 `inflight` 동사. 남은 것: inflight 와 세션이 한 카운터라 둘로 안 갈린다 |
| S3 재시작 부트스트랩 | eligible ∩ durable 헬스. 빈 슬롯은 의도적 zero-peer 로 민다 |
| S4 CP 단절 | 멤버십 슬롯에 TTL 없음. 갱신 실패는 마지막 셋 유지 |
| S5 부분 전환 | 평면별 슬롯. 한 평면이 비어도 다른 평면을 안 지운다 |
| S9 SNI 3분기 | **열렸다.** `spike/s9` — engine_facts 의 E26.2 스킵이 남긴 자리다. 백엔드를 stream-lua 로 두어 클라이언트가 TLS 를 말할 필요를 없앴다. `on_no_sni` 승격 |
| S6 `least_conn` | **열렸다.** 배제 근거("워커별 근사")가 사실이 아니게 됐다 — `in:` 이 dict 에 살아 워커 간 공유다. 골든이 편차 <10% 를 실측 |
| S9 SNI 3분기 | 현행 유지 (부재·파싱실패는 reject) |
| S10 `strict_priority` | 안 연다 |
| S14 native DNS | 6/8~8/8 로 흔들린다. 흔들리는 원인은 스파이크의 측정 결합이다. 게이트에 안 넣는다 |
| S15 밸런서 품질 | Lua 가 round_robin/hash/source_ip_hash. 수치 게이트는 스파이크 |
| S20 HTTP/3 | 모델에서 뺀다. 게이트에 안 넣는다 |

block 등급 S8 · S11 · S12 는 열려 지나갔다. S13 은 원장을 안 짓기로 닫았다 —
마커로는 옛 워커를 못 센다. `worker_shutdown_timeout` 이 상한이다.

▲ 잔여물 넷은 여전히 "수렴이 덮는다" 하나에 매달려 있다. 그중 **살아 있던 물음** —
종단 기록이 세계에 대해 거짓을 말하던 것 — 은 앞 회차에 닫혔다.

**§12 의 ▲ 는 다른 목록이고, 그중 하나가 이 회차에 닫혔다** — staging 과 활성화 사이의
헬스 창이다. 근거가 *"밖에서 결정적으로 만들 방법이 없다"* 였는데, 헬스가 `backend_health`
표에 사니 **안에서는** 결정적이다. `tests/store/reproject-window.test.ts` 다섯이 재투영을
빼는 변이에 전부 죽는다 — 그 전에는 *"아무 테스트도 안 깨뜨린다"* 가 같은 자리의 다른
반쪽이었다.

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
| `control/health.ts` | HTTP 상태코드 프로브(풀별 `healthCheck` 로 좁힌다) · TCP 프로브 |
| `control/drain.ts` | 드레인 수명과 관측. 엔진이 안 주면 **숫자를 안 만든다** |
| `control/admin-client.ts` | admin 소켓 — http 는 `fetch`, stream 은 `adminTalk` |
| `control/discovery.ts` | 발견한 엔드포인트 → 멤버십 슬롯. 표면 아님 |
| `control/acme-*.ts` | 주문 원장 · 틱 러너 · 게시 |
| `engine/probe.ts` | `nginx -V` 를 실제로 묻는다 |
| `control/backend-status.ts` | 왜 이 백엔드가 트래픽을 안 받나 — 이유를 전부 낸다 |
| `web/edit.ts` | GUI 가 얹는 patch. apply 가 아니다 |
| `dp/` | 적용 상태기계 · 세대 · 시크릿 |
| `index.ts` | 동결 대상 표면 |

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
| 모델 | 리스너(프록시 한계값·헤더 규칙·레이트리밋·`on_no_sni`·`strictPriority` 포함)·풀(헬스체크 정의·`least_conn`·`upstreamTls`)·백엔드·HTTP/패스스루 라우트·인증서·TLS 정책·SNI 바인딩·엔진 dict 크기. 판별 유니온 | h3, WAF, `on_nxdomain`/`on_timeout`, **그리고 §4.3·§4.3.1·§4.4 의 아래 필드들** |
| 적용 | 봉인된 changeset, 시맨틱 plan, 크래시 저널, 펜싱, 롤백. 관측 실패와 부정 관측을 가른다 | — |
| 동결 | B(구현된 OpenAPI · DDL). **A 는 이 회차에 풀렸다** — W3 설정 셋을 들이려고. 근거가 `SURFACE.txt` 머리에 남는다 | 미구현 계약 |
| 멤버십 | 이중 zone 슬롯, Lua 밸런서, HTTP 상태코드 프로브(풀별 정의) · TCP connect(L4), SSE `health`, 드레인 제외, **두 평면의 peer inflight 관측** | — |
| TLS | 업로드 자료, https 렌더, SNI 선택, 세대 결박 롤백, GUI SNI 바인딩 · 인증서·정책 삭제 | — |
| 시크릿 | 드라이버 **둘**. `fs`(기본, 평문 0400)와 `pg`(봉투 암호화 AES-256-GCM · KEK 는 DB 밖). 참조·digest·재업로드 수리 계약을 두 드라이버가 **같이** 낸다 (검수 2026-08-29). GC 정책은 한 자리(`partitionForSweep`) | KMS·Vault 드라이버 · KEK 회전 절차 |
| ACME | http-01 러너, dns-01 파일 프로바이더, 주문·챌린지 GET, EAB, Retry-After 백오프, 만료 30일 전 갱신 틱 | — |
| CLI | `bary-dp-agent`(원격 DP 창구). `changeset` 단계(discard·reopen 포함), `commit --plan`, `apply --plan`, export/import, backup/restore, status/rollback/recover, listener·풀·라우트·백엔드·TLS 정책·인증서·SNI create, listener·라우트·백엔드·SNI·풀·인증서·정책 delete, get(인증서·정책·SNI·헬스·오퍼레이션·plan·metrics·주문·`backends/status`), backend drain/drain-status. **리스너 옵션 플래그**(`--rate`·`--header`·`--max-body`·타임아웃) | — |
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

인증은 정적 SPA와 같은 출처의 데몬 세션을 사용한다. OIDC 교환 전의 state·PKCE
verifier·nonce는 데몬 메모리의 짧은 수명 로그인 세션에 있고 브라우저에는 opaque
`bary_login` 쿠키만 간다. 교환 뒤 ID Token은 응답 본문에 내보내지 않고
`bary_session` HttpOnly·SameSite=Lax 쿠키로 바꾼다(HTTPS에서는 Secure). 세션은 인스턴스
메모리라 재시작·다중 인스턴스 사이에 공유되지 않는다.

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

수치는 **2026-08-24** 전체 게이트의 실측이다. **문서에 옮겨 적은 값은 늘 낡는다** —
직전 표는 단위를 510 이라고 적어 뒀는데 실측은 595 였고, 그 다음 표는 816 이라고 적어
뒀는데 이번 실측은 948 이다. 이 표는 **그날의 사진**이지 정본이 아니다.

| 스위트 | 명령 | 통과 |
|---|---|---|
| typecheck | `npm run typecheck` | — |
| 표면 | `node scripts/surface.mjs --check` | — (숫자는 그 도구가 답한다) |
| 모델 | `npm run test:model` | 13 |
| 단위 | `npm test` | **948** |
| conformance | `npm run test:conformance` | **479** |
| 골든 | `npm run test:golden` | **71** (14 파일 · **직렬**) |
| 엔진 사실 | `npm run test:engine` | 76 (SKIP 1) |
| e2e | `npm run test:e2e` | **70** (9 파일) |
| 스파이크 | `spike/*/run.sh` | **100** (12 개 · SKIP 2) |
| 저장소 | `npm run test:store` | **234** |

> **골든이 직렬이 됐다** (검수 2026-08-24). `--no-file-parallelism` 이다 —
> `test:e2e`·`test:store` 가 이미 그랬고 골든만 빠져 있었는데, 파일이 늘자 부하가
> 다른 테스트의 타이밍을 흔들었다. 게이트 시간이 늘었고 그 대가는 결정성이다.

**검수 목록(①②③)이 코드에 닿아 있는지는 이제 게이트가 답한다** —
`tests/conformance/goal-coverage.test.ts` 가 한 줄에 한 검사다. 사람이 커밋 로그로 세는
대신 도는 것이 답한다. 커밋 로그는 *"그래서 지금 되는가"* 에 답하지 못한다.

스위트 통과와 동결 가능은 다르다. `--freeze-gate` 는 A(타입·DP ABI) 표면과
B(구현된 API·DDL) 드리프트를 둘 다 막는다.

**A 동결은 이 회차에 풀렸다.** 먼저 W3 의 설정 셋(`Pool.healthCheck` · dict 크기 ·
`GenerationError('path_escape')`)이, 이어서 제안 6·7·8 의 넷(`ProxyLimits` ·
`HeaderRule` · `HeaderRules` · `RateLimit`)이 `Model` 을 넓혔다.

**여기 숫자를 안 적는다** (2026-08-24). 전에 「116 심볼」이라고 적어 뒀는데 그 사이
두 번 움직여 **117** 이 됐고, 그 표는 그동안 거짓을 말했다 — `verify.sh` 가 자기
안에서 같은 실수를 하고 고치며 적어 둔 그대로다: *"도구가 답하는 것을 사람이 베껴
적으면 그 사본은 반드시 낡는다."* **정본은 `node scripts/surface.mjs --check` 의
출력이다.**

**재동결까지 3 회차를 다시 쌓아야 한다.** 푸는 길은
`surface.mjs --unfreeze "<근거>"` 하나뿐이고 근거를 요구한다 — 그 근거는 `SURFACE.txt`
머리에 남고 `--write` 를 지나서도 안 지워진다.

**쌓는 것은 저절로 안 된다** (2026-08-29). `--round` 는 **사람이 부르는 모드**이고,
세는 단위는 「검수 회차」다 — 기능 PR 이 표면을 안 건드렸다고 세지 않는다. 13차 검수가
준 기준이 *"여러 **적대적** 회차 동안 이 파일이 변하지 않을 것"* 이기 때문이다.

**그리고 이제 근거를 요구한다** (셋째 회차 B). `--round "<근거>"` 가 필수고 그 줄이
`# 회차 N:` 으로 파일에 쌓인다 — 전에는 아무것도 안 요구해서 카운터가 세는 것이 사실상
**`--round` 를 부른 횟수**였다. `--unfreeze` 가 이미 반대쪽에서 같은 규칙을 갖고 있었다.
1·2 회차에는 그 줄이 없다(요구가 생기기 전에 올랐다) — 그 둘이 무엇이었는지는
`docs/audit-2026-08-29.md` 와 `-install.md` 가 든다.
2026-08-29 의 `PgSecretStore` 검수(`docs/audit-2026-08-29.md`)가 **1 회차**,
같은 날의 `deploy/install.sh` 검수(`docs/audit-2026-08-29-install.md`)가 **2 회차**,
게이트 자신에 대한 검수(`docs/audit-2026-08-29-gate.md`)가 **3 회차**다.

**셋을 쌓았으므로 `--freeze` 가 열린다. 그런데 선언하지 않기로 했다** (2026-08-29).

근거는 §4.3.1 의 프로브 필드(`probe.mode`·`protocol`·`port`·`host_override`·`udp`)와
§4.4 의 백엔드 필드(`max_conns`·`admin_state`·`drain.deadline_s`·`is_backup`)다. 아래
§2 가 그것들을 *"축소 결정이 아니라 아직 안 한 것"* 으로 든다 — **들이면 `Model` 표면이
움직이고 카운터는 0 으로 간다.** 지금 선언하면 그 필드들이 동결 뒤에 갇히고, 꺼내려면
`--unfreeze` 를 지나야 한다.

**그 상태를 이미 한 번 겪었다.** 파일에 남아 있는 해제 근거가 그것이다 —
*"동결 뒤에 갇혀 있던 설정 셋을 들이기로 사람이 결정했다 (2026-08-23)."* 같은 값을 두 번
치르지 않는다. **필드를 먼저 들이고, 그 뒤에 다시 쌓는다.**

**`--freeze-gate` 의 자리는 정해졌다** (셋째 회차 C). 기본 게이트에 `--freeze-status` 로
들어간다 — 미선언 상태에서도 **카운터와 회차 근거가 맞물리는지**를 재고, 선언되면 거기에
회차 수와 표면 일치가 더해진다. 그래서 선언하는 날 이 자리를 다시 정할 일이 없다.

**설치 하네스의 자리도 정해졌다** (둘째 회차 D · 2026-08-29). `verify.yml` 의 `install`
잡이 **설치의 입력이 바뀐 PR 에서만** 돈다. 모든 PR 에 안 거는 이유는 다섯 배포판
컨테이너가 임계 경로를 크게 늘리기 때문이고(#15 가 873초→254초로 줄인 직후다),
nightly 로 안 보내는 이유는 그러면 *"머지 뒤에 안다"* 가 되기 때문이다.
**바뀐 것이 그것일 때 머지 앞에서 잰다.**

**그 「입력」이 너무 좁았다** (2026-08-31). 처음 목록은 `deploy/`·`tests/install/`·그
워크플로 셋이었는데, #28 이 `gui/package.json` 한 줄(typescript 7)을 바꿔 그 구멍으로
지나갔고 **머지된 main 이 새 호스트에 설치가 안 되는 상태**가 됐다.

다른 잡이 못 잡은 이유가 핵심이다. **CI 는 전부 핀(`.nvmrc` = 24)에서 돈다.** 그런데
선언한 **바닥은 22** 다(`engines.node` · `install.sh` 의 `node_version_ok`) — 그리고 그
바닥을 실제로 밟아 보는 곳은 **이 하네스뿐이다.** #28 은 그 틈으로 갔다: `build
(dist·gui)` 는 24 의 npm 11 로 통과했고 설치 컨테이너의 22 는 npm 10.9 라 같은 트리에서
ERESOLVE 로 죽었다. npm 버전은 바닥이 데리고 오는 것 중 하나일 뿐이라 다음엔 다른 것이
걸린다.

목록에 `scripts/build.sh`·`.nvmrc`·루트와 `gui/` 의 `package(-lock).json` 을 더했다.
정본은 워크플로의 `TARGETS` 이고, `tests/unit/install-filter.test.ts` 가 **그 값을 읽어
`grep -E` 를 그대로 돌린다** — 여기 목록을 베껴 적은 것은 사람용이라 낡을 수 있다.
`tsconfig*.json` 은 안 넣었다: npm 버전과 무관해서 `build (dist·gui)` 가 같은 답을 낸다.

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

**시크릿 저장소는 이제 둘이다** (2026-08-28 · §4.8.1). `BARY_SECRET_BACKEND=fs|pg` 이고
기본은 `fs` 다 — 전용 VM 한 대 배포에서는 KEK 를 어디 둘지가 새 문제라, 그 결정을 안 한
배포를 조용히 바꾸지 않는다. `pg` 는 **KEK 없이 안 뜬다**(`BARY_SECRET_KEK`, 32 바이트
base64/hex). 자료마다 DEK 를 뽑아 AES-256-GCM 으로 감싸고 그것을 KEK 로 다시 감싸므로
**DB 덤프 하나로는 키가 안 나온다.** AAD 가 참조라 행을 옮기면 안 열린다.

⚠️ 그 대가는 백업 절차에 있다 — `pg` 에서 **KEK 를 잃으면 자료를 영영 못 연다.**
KEK 는 덤프와 다른 곳에 둔다(`docs/runbook-spof.md`). 설정은 안 잃는다.

`facts()` 만 동기로 남았다. 그것을 읽는 자리 둘(커밋 앞 SAN 커버 검증기 · plan 의
임팩트 계산)이 동기라서다. `pg` 드라이버는 그 값을 캐시로 들고 기동과 틱에서 다시 읽는다 —
**자료를 복호화하지 않는다**(`facts` 는 평문 열이다). miss 는 「사실을 모른다」다.

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
| S20 HTTP/3 | 7/8. **선결 조건은 풀렸다** — §4.5 의 예약이 전송을 집합으로 낸다(`transportsOf`). h3 를 여는 날 `transportsOf('https')` 에 `udp` 를 더하는 것 하나로 UDP 겹침이 잡힌다. 스파이크가 여전히 빨간 것은 **엔진이 조용히 한쪽을 버린다**는 사실 자체이고 그건 우리가 못 고친다 |
| ▲ 잔여물 넷 | **셋의 답이 이 회차에 측정이 됐다** — 창을 못 막는 것은 그대로지만(결함이 아니라 결정이다) 그 문장의 두 절을 따로 잰다: 창이 열리는가 · 수렴이 덮는가. 남은 하나(예산 초과)는 여전히 재현물을 못 쓴다. §12 의 재투영 창 ▲ 도 닫혔다 |
| ~~원격 드라이버 전송~~ | **생겼다.** mTLS HTTP/JSON — `RemoteDataplaneDriver` ↔ `bary-dp-agent`. 실측 제약(*"에이전트와 nginx 는 같은 파일시스템"*)은 **에이전트↔nginx** 의 것이라 안 걸린다. 거절(409)과 불통(그 외)을 절대 안 섞는다 |
| §11.3 동적 포트 | k8s 네이티브 배포는 여전히 별도 과제다 — 설계의 결정이고 안 뒤집는다. 다만 어느 배포를 고르든 필요한 **소켓 집합**을 낸다: `GET /api/v1/sockets` · `bary get sockets` **그리고 v1 권장 배포(전용 VM 한 대)는 이제 스크립트가 세운다** — `deploy/install.sh` 가 패키지·서비스 유저·`setcap`·빌드·유닛과 (선택) 로컬 PG 를 세우고 `/readyz` 와 `bary status` 까지 확인하고 끝낸다. Debian·Ubuntu·RHEL9 계열·Amazon Linux 2023·Alpine 을 `tests/install/run.sh` 가 **실물 컨테이너에서** 판정한다 — 서비스 기동·재기동·비-root nginx·특권 포트 apply 까지 본다. **업데이트 경로도 이 스크립트다** (2026-08-31) — 다시 돌리는 것이 업데이트이고, 그래서 재실행이 토큰(`tokens.json`)과 env 의 관리 밖 줄(`BARY_SECRET_KEK` 을 포함)을 **안 부순다.** 뒤집는 문은 `--rotate-token`·`--reset-env` 다. 절차는 [`docs/runbook-upgrade.md`](docs/runbook-upgrade.md) 이고, **첫 설치에서 정할 것**(시크릿 백엔드·KEK·리스너·1일차 백업)은 [`docs/runbook-install.md`](docs/runbook-install.md) 다. debian 판이 실제로 두 번 깔아 토큰·KEK 생존과 env 키 중복 없음을 판정한다 — 나머지 네 판의 재설치는 여전히 안 잰다 |

**§4.3·§4.3.1·§4.4 에 적혀 있는데 코드에 없는 것** (2026-08-23 실사). 이건 축소 결정이
아니라 **아직 안 한 것**이었다 — 결정이었다면 §12.0 이나 §15 에 근거가 있어야 한다.

✅ **2026-08-31 에 이 표가 닫혔다.** 남은 것은 전부 「안 하기로 한 것」이고 근거가
`docs/adr-membership-attrs.md` 에 있다. 세 줄 다 그 뒤에 적었다:

| 자리 | 없는 필드 |
|---|---|
| `Pool` (§4.3) | ~~비었다~~ — `upstream_tls` 는 **구현됐다**(2026-08-24). **`passive`·`sticky` 는 안 넣기로 했다** — `sticky` 가 말하는 둘(L4 소스IP·HTTP 쿠키)은 `algorithm`·`hashKey` 로 이미 표현되고, 쿠키 **발급**은 상용 모듈이다. `passive` 는 — 이 평면의 upstream 은 `server` 가 자리표시 하나뿐이라 peer 별로 셀 대상이 없고, Lua 로 다시 만들면 멤버십의 주인이 둘이 된다. **`dns` 도 결정된 것이다** — 엔진이 선택지를 안 줘서 해독기가 `unknown_field` 로 거절한다 (§7.3) |
| 헬스 프로브 (§4.3.1) | ~~비었다~~ — **들어왔다 (2026-08-30).** `mode`·`protocol`·`port`·`hostOverride`·`hostHeader` 와 풀별 `intervalS`/`timeoutS`/`rise`/`fall`. 프로브가 데이터 경로와 갈린다 — tcp 풀이 http 헬스 포트를 가질 수 있다. **`udp` 는 결정이다** (§13-6 드라이버 위임) · **`passive` 도** (이 평면에 `server` 줄이 없다). ⚠️ 풀별 주기는 **전역 틱이 바닥**이다 — 그보다 짧게는 못 만든다 |
| `Backend` (§4.4) | ~~비었다~~ — **전부 닫혔다 (2026-08-31).** `soft_max_conns`·`is_backup` 은 Lua 밸런서가 진다 — peer 별 속성이 `attr:` 키로 슬롯과 나란히 가고, 밸런서는 **읽기만** 한다(쓰면 멤버십 주인이 둘이 된다). `admin_state` 는 **안 넣기로 했고**(드레인이 이미 운영 동작이다), `drain.deadline_s` 는 **드레인 동작에 붙었다** — 기한은 관측이라 지나도 안 풀리고 `deadline_exceeded` 로 드러난다 |

드레인은 **스펙 필드가 아니라 멤버십 평면의 동작**으로 산다 — `bary backend drain` 이
슬롯에서 빼고 `in:` 으로 관측한다. 그래서 드레인은 되지만 기한과 `deadline_exceeded` 는
표현할 자리가 없다.

⚠️ 레이트리밋은 **`return` 으로 끝나는 라우트(redirect·reject)에 안 걸린다.** nginx 의
단계 순서다 — `return` 은 rewrite, `limit_req` 는 preaccess 인데 rewrite 가 앞이다.
`tests/golden/rate-limit.test.ts` 가 그 거동을 못 박는다.

✅ **S12 의 게이트 흔들림을 고쳤다** (2026-08-24). 원인은 계측기였다 — 후속 봉투가
`expectedCurrent` 를 못 박아, 복구가 증거 예산 안에 못 끝난 회차에서 좌표만 뒤에 남고
`coordinate_mismatch` 로 영영 막혔다. 프로덕션은 다음 오퍼레이션의 좌표를 **살아 있는
상태에서** 만든다 — 그렇게 바꿨다.

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

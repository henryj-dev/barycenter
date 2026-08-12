# barycenter — 테스트 케이스

> [`DESIGN.md`](./DESIGN.md) v2 와 3라운드 외부 검수에서 나온 주장·불변식을 **검증 가능한
> 형태로 옮긴 것**이다. 설계 문서가 "이렇게 동작한다"고 말한 모든 것에 대응하는 케이스가
> 있어야 하고, 대응이 없는 주장은 근거 없는 주장이다.

## 상태 범례

| 상태 | 뜻 |
|---|---|
| **RUNNABLE** | 지금 실행된다 |
| **SPIKE** | v0.0 아키텍처 스파이크(§12.0)에서 실행. 버릴 코드로 검증 |
| **v0.1+** | 미확정 계약에 의존한다. 지금은 명세이고 스텁을 만들지 않는다 |

> **스텁을 만들지 않는 이유.** 구현이 없는 상태에서 `skip` 처리된 테스트 파일은 통과 신호를
> 위조한다. 실행 가능한 것만 실행 가능한 형태로 두고, 나머지는 명세로 둔다.

> **왜 일부만 RUNNABLE 인가.** DESIGN.md §12.0 이 "v0.1 타입·API·DB 스키마 freeze 는 No-Go"
> 라고 못박았다. 그래서 지금 TDD 로 짤 수 있는 것은 **엔진이 계약을 정해 준 영역**뿐이다 —
> 렌더러 · 문자열 문법 계약 · 소켓 겹침 · 라우트 컴파일러. 이들은 `topology_epoch` ·
> changeset · ApplyOperation 에 전혀 의존하지 않는 순수 함수라서 스파이크 결과가 뒤집혀도
> 살아남는다. M · C · A · P · G 는 아직 확정되지 않은 계약을 대상으로 하므로 명세로 둔다.

## 실행

```bash
./scripts/verify.sh           # 전부. 지금 어디까지 확인됐는지 한 번에 본다
./scripts/verify.sh --quick   # 도커 없이 (단위 + 타입)
```

개별로:

```bash
npm test                # 단위 — 렌더러 · 문자열 · 소켓 · 라우트 컴파일러 · capability
npm run test:golden     # 렌더 산출물을 실제 엔진 nginx -t 로 검증
npm run test:e2e        # 저널이 실제 nginx 를 수렴시키는지 (도커)
npm run test:engine     # 엔진 사실 검증
./spike/s1-s5/run.sh    # S1 멤버십 평면 · S5 이중 zone
./spike/s7/run.sh       # S7 활성화 판정
./spike/s8/run.sh       # S8 인증서 세대 롤백
./spike/s11/run.sh      # S11 activation_epoch 경합

BARY_ENGINE_IMAGE=my/custom-openresty npm run test:engine   # pin 후보 검증
```

> 도커가 필요한 묶음은 도커가 없으면 **건너뛰지 않고 실패한다.** 조용히 건너뛰면 통과 신호를
> 위조하게 된다. 굳이 빼려면 `--quick` 을 명시한다.

### 현재 상태 — 스위트 413개 통과, 게이트는 별개

| 묶음 | 명령 | 결과 |
|---|---|---|
| 단위 | `npm test` | **216 PASS** |
| conformance | `npm run test:conformance` | **78 PASS** — 5차 검수 반례 (§9.1.1 blocker 1~5 + 크래시 지점 매핑) |
| 골든 (`nginx -t` + 런타임 프로브) | `npm run test:golden` | **10 PASS** |
| **e2e (실제 nginx)** | `npm run test:e2e` | **6 PASS** — 저널이 실제 nginx 를 수렴시킨다 |

> e2e 는 고정 `sleep` 을 쓰지 않는다. **조건이 참이 될 때까지 폴링한다.**
> 처음엔 고정 대기를 썼다가 간헐적으로 깨졌다 — 간헐적으로 깨지는 테스트는 없느니만
> 못하다. green 이 될 때까지 다시 돌리는 습관을 들이기 때문이다.
| 엔진 사실 (E) | `npm run test:engine` | **61 PASS / 1 SKIP** |
| 스파이크 S1·S5 | `./spike/s1-s5/run.sh` | **8 PASS** |
| 스파이크 S7 | `./spike/s7/run.sh` | **9 PASS** |
| 스파이크 S8 | `./spike/s8/run.sh` | **11 PASS** |
| 스파이크 S11 | `./spike/s11/run.sh` | **14 PASS** |

### 착수 게이트 현황 (§2)

| | 항목 | 상태 |
|---|---|---|
| ~ | **S11 operation tuple 과 경합** | DP Agent 상태기계(`src/dp`)로 재구현. **P18~P21 통과**하고 (P22 는 리듀서 이후 — 미구현) 직렬화를 제거하면 실패하는 것을 뮤테이션으로 확인. 남은 것: 실제 nginx 와 물린 end-to-end, P3·P5·P6 |
| ~ | S1 | reload 없는 peer 선택 **primitive** 만. 가중치·재시도·drain·DNS 없음 |
| ~ | S5 | 이중 zone 확정 / stream 평면 미측정, 부분 전환 미검증 |
| ~ | S7 | 로그 행 수를 정본 신호로 씀 → 진단용으로 강등하고 판정 계약 재작성 필요 |
| ~ | S8 | CN 만 비교 / key·SPKI·chain·SNI 별 자료 미검증 |
| ~ | **S12 크래시 저널** | `ApplyRunner` 로 구현. 저장·부작용의 **모든 직전/직후**를 훑고 관측 우선을 확인. 뮤테이션으로 변별력 검증. **실제 nginx 와 물렸다**(`tests/e2e`). 남은 것: 시크릿 materialize, 평면별 전이, 세대 디렉토리 원자 게시 |
| ❌ | S13 GC ledger | 미착수 |
| ❌ | S2 S3 S4 S6 S9 S10 S14 S15 S16 S17 S18 | 미착수 |

> **"S12 만 남았다"는 판정은 철회됐다.** 스위트가 green 인 것과 게이트가 열리는 것은
> 다르다. `./scripts/verify.sh` 가 이제 둘을 나눠서 출력한다.

---

## 1. E — 엔진 사실 검증 (RUNNABLE)

**목적**: DESIGN.md 가 사실로 전제한 nginx/OpenResty 동작을 *우리가 pin 할 실제 이미지에서*
확인한다. 검수 3라운드 동안 "맞다/틀리다"로 뒤집힌 항목이 전부 여기 있다.

### 최근 실행 결과 — `openresty/openresty:alpine` (openresty/1.31.1.1)

```
PASS=43  FAIL=0  SKIP=1
```

### 케이스 목록

| ID | 검증 대상 | 기대 | 근거 |
|---|---|---|---|
| E0.* | 빌드 capability — **필수**(`stream`, `stream_ssl_preread`, `stream_ssl`, `http_v2`, `http_realip`, `http_ssl`, `ngx_stream_lua`)와 **선택**(`stream_realip`)을 나눠 보고 | 필수는 전부 존재, 선택은 결과를 기록 | §7.6 |
| E1 | stream 에 `ip_hash` | **거부** — stream 엔 없는 디렉티브 | §4.3 · 1차 |
| E2 | stream 에 `least_conn` | 수용 — OSS 네이티브 | §7.3 · 2차 |
| E3 | stream `hash $remote_addr consistent` | 수용 — `source_ip_hash` 의 실제 렌더 | §7.1 |
| E4 | http location 에 `proxy_protocol on` | **거부** — HTTP 업스트림엔 송신 디렉티브가 없다 | §4.7 · 3차 |
| E5 | stream `proxy_protocol on` | 수용 (v1 송신) | §4.7 |
| E6 | UDP 리스너 + `proxy_protocol on` | **수용된다** → 엔진이 안 막으므로 **모델이 막아야 한다** | §4.7 · 1차 |
| E7 | map 없이 `$connection_upgrade` | **거부** — 내장 변수 아님 | §7.1 · 1차 |
| E8 | map 을 함께 렌더 | 수용 | §7.1 |
| E9 | `http2 on;` | 수용 (core 1.25.1+) | §7.6 |
| E10 | `server ... resolve` (zone 없음) | **거부** | §7.3 대안 B |
| E11 | `zone` + `resolver` + `resolve` | 수용 — 1.27.3+ OSS | §7.3 · 2차 |
| E12 | 같은 포트에 TCP + UDP | 수용 — 공존 가능 | §4.5 |
| E13 | `ssl_preread on` + `preread_timeout` | 수용 | §7.1 |
| E14 | http/stream 에 동명 `lua_shared_dict` | **거부** — `already declared for a different use` | §3.4 · 3차 |
| E20.1 | map: exact vs wildcard | **exact 가 항상 우선** (등장 순서 무관) | §7.5 |
| E20.2 | map: wildcard 매칭 | 매칭 | §7.5 |
| E20.3 | map: 정규식 2개 중 앞의 것 | **등장 순서대로 평가** | §7.5 `strict_priority` 의 전제 |
| E20.4 | map: 뒤 정규식 폴백 | 매칭 | §7.5 |
| E20.5 | map: `default` | 폴백 | §7.5 |
| E21.1 | `~^UP\.example\.org$` 에 소문자 요청 | **미매칭** — `~` 는 대소문자 구분 | §7.1 · 3차 |
| E21.2 | `~*` 동일 조건 | 매칭 | §7.1 |
| E22.1 | `server_name *.example.org` ← `www.example.org` | 매칭 | §4.6 |
| E22.2 | 동일 ← `www.sub.example.org` | **매칭된다** — nginx 와일드카드는 다중 라벨. **X.509 와일드카드(1라벨)와 불일치** | §4.6 · 3차 |
| E22.3 | 미매칭 호스트 | `default_server` 로 — `server_name` 으로는 지정 불가 | §4.6 · 3차 |
| E23.1 | 포트 점유 상태에서 `nginx -t` | **통과한다** | §6.3 |
| E23.2 | 그 상태로 HUP | **마스터 생존 + 옛 세대로 계속 서비스** | §6.3 · 1차 |
| E23.3 | HUP 후 error log | `bind()` 실패 기록 → 판정 신호로 사용 가능 | §6.3 |
| E24.1 | shared dict, HUP 후 | **유지** | §6.5 |
| E24.2 | shared dict, 인스턴스 종료 후 재시작 | **소실** → 부트스트랩 필수 | §6.5 · 3차 |
| E25.1 | http Lua ↔ stream Lua zone 상호 참조 | **양방향 불가시** → §3.4 이중 평면 확정 | §3.4 · 3차 |
| E26.1 | 비-TLS 트래픽에서 `$ssl_preread_protocol` | **빈 문자열** → 비-TLS 를 구분할 수 있다 | §4.1 |
| E26.2 | TLS-no-SNI | *SKIP* — TLS 백엔드 필요. **S9 로 이관** | §4.1 |
| E27 | 동일 `listen` 의 server 별 `ssl_protocols` 설정 | 문법 수용 (실제 적용 여부는 **S16**) | §4.6 · 3차 |
| E30.1 | `[::]:p` 와 `0.0.0.0:p` 동시 기동 | **공존한다** — `ipv6only` 기본값은 `on` | §4.5 · 4차 |
| E30.2 | IPv4 접속 | v4 소켓이 받는다 | §4.5 |
| E31.1 | `location /` 뒤에 `location /api`, `GET /api/x` | **`/api` 가 이긴다** — 선언 순서도 priority 도 아닌 longest-prefix | §7.5 · 4차 |
| E31.2 | 매칭 없는 경로 | `/` 로 폴백 | §7.5 |
| E32.1 | `default_server` 없이 모르는 Host | **첫 번째 server 로 조용히 들어간다** — 테넌트 간 누수 | §4.6 · 4차 |
| E33.quoted | map 키를 `"default"` 로 인용 | **거부** — 인용해도 default 절이다 | §7.5 · 4차 |
| E33.regex | `~^default$` 를 키로 | 리터럴 호스트 `default` 를 매칭한다 | §7.5 |
| E34.bare | IPv6 백엔드 bracket 없이 | **거부** — `invalid port in upstream` | §7.1 · 4차 |
| E34.bracket | `[2001:db8::1]:443` | 수용 | §7.1 |
| E35.1–4 | `server_name ~^[^.]+\.example\.com$` | **한 라벨만** 매치. 다중 라벨·apex 는 안 됨. 대소문자 무관 | §4.6 · 4차 |
| E36.1 | 겹치는 `server_name` 을 가진 두 server | **경고뿐이고 첫 블록이 이긴다** — `nginx -t` 는 통과 | §7.5 · 4차 |
| E36.2 | 그 경고의 위치 | error.log 가 아니라 **`nginx -t` stderr** | §7.5 |
| E37 | 인용 없는 정규식의 후행 백슬래시 | **거부** — 뒤의 세미콜론을 삼킨다 | §4.9 · 4차 |
| E28.1 | `stream_realip` 없이 `$proxy_protocol_addr` | **실 클라이언트 IP 를 준다** → 소스IP 해시 대체 경로 | §7.6 |
| E28.2 | 같은 조건의 `$remote_addr` | 앞단 프록시 주소로 남는다 | §7.6 |
| E29.1 | PROXY 수신 + 송신 체인 | **실 클라이언트 IP 를 잃는다** → 모델이 조합을 막는 근거 | §7.6 |

### E 가 확정한 설계 결론

1. **§7.6 필수 모듈 목록은 기본 이미지로 충족되지 않는다** (E0) — 커스텀 이미지 or 요구 축소.
2. **`on_no_sni` 분기는 구현 가능하다** (E26.1). `$ssl_preread_protocol` 이 비-TLS 를 가른다.
   → S9 의 남은 질문은 "TLS-no-SNI 와 malformed TLS 의 구분"으로 좁혀졌다.
3. **§3.4 이중 평면은 가설이 아니라 사실이다** (E14, E25.1). 단순화 여지가 없다.
4. **§6.3 은 실제 위험이다** (E23.1–3). `-t` 통과 + 마스터 생존 상태로 옛 설정이 서비스된다.
5. **§4.6 와일드카드는 실제 인증서 오선택 경로다** (E22.2).
6. **§7.5 축소 계약이 옳다** (E20.1) — 클래스 우선순위가 등장 순서를 이긴다.
7. **필수 모듈 목록은 성립할 수 없다** (E0) — `stream_realip` 과 `ngx_stream_lua` 가 서로 다른
   이미지 계열에 있다. capability 로 다루고, 잃는 것은 **PROXY 체인 하나뿐**임이 실측됐다
   (E28·E29). → §7.6 개정, `src/validate/engine-constraints.ts` 가 강제.

---

## 2. S — 스파이크 게이트 (SPIKE, v0.0)

각 항목은 **수치 합격 기준**과 **실패 시 결정**을 함께 갖는다. 결정이 없는 실험은 게이트가
아니다. `block` 은 설계를 다시 해야 한다는 뜻이다.

| ID | 검증 | 합격 기준 | 실패 시 |
|---|---|---|---|
| **S1** ✅ | `balancer_by_lua` 동적 peer 변경 | HTTP·TCP·**UDP** 세 서브시스템 전부 reload 없이 전환. 전환 후 첫 요청부터 반영 | → 대안 B |
| **S2** | 드레인 관측 | HTTP/1·HTTP/2·TCP·UDP 각각에서 **peer 별** upstream inflight·세션 수를 오차 0 으로 관측 | 기능 축소: `no_new_traffic` 만 |
| **S3** | 인스턴스 재시작 부트스트랩 | 재시딩까지 공백 < 1s. **이 구간에 disabled/unhealthy 백엔드로 나가는 요청 0** | 기능 축소: 부팅 시 전 백엔드 `unknown` |
| **S4** | CP 단절 | `expires_at` 경과 후 fail-open 이 마지막 값을 유지. eviction 으로 zero-peer 되는 일 0 | `fail_closed` 기본화 |
| **S5** ~ | **http/stream 이중 zone + 워커 수렴** | 양쪽 ACK 후 **전 워커** 수렴 < 500ms. 한쪽 실패·ACK 유실·늦은 RPC·리더 교체·옛 HTTP/2 워커 잔존 시나리오 포함 | → 대안 B |
| **S6** | `least_conn` 근사 오차 | native(zone 유·무) 대비 편차 < 10%. **워크로드·하드웨어·베이스라인을 먼저 정의** | v0 알고리즘에서 제외 |
| **S7** ✅ | reload 실패 판정 | 오탐/미탐 0, 판정 시간 < 3s. E23 을 자동화 | ApplyOperation 스키마 freeze **block** |
| **S8** ✅ | 인증서 세대 롤백 | 갱신 후 롤백 시 옛 key/chain 정확 복원 | **block** |
| **S9** | SNI 결과 분기 관측성 | TLS-no-SNI / malformed / preread timeout 구분 (**비-TLS 는 E26.1 로 확인 완료**) | 현행 유지 — 부재·파싱실패는 계속 `reject` 고정 |
| **S10** | 라우트 컴파일러 | exact/wildcard/path 우선순위 정확 + 라우트 500개에서 p99 영향 < 5% | `strict_priority` 미제공 |
| **S11** | **epoch 경합** | 아래 P1~P8 시나리오 전부에서 잘못된 peer 선택 **0회** | **block** |
| **S12** | 크래시 저널 | A5 의 **11개 지점** 전부에서 복구 정확 + HUP 재전송이 워커 세대를 늘리지 않음 | **block** |
| **S13** | 마커·워커 레지스트리·GC | 옛 워커 잔존 중 세대/시크릿 오삭제 0회. GC 각 단계 크래시 포함 | GC 보수화 |
| **S14** | **대안 B 실증** | HTTP/TCP/UDP × A/AAAA/SRV × TTL 만료/NXDOMAIN/timeout/SERVFAIL. 각 경우의 **허용 동작·수렴 시간·기존 세션 보존**을 수치로 | 폴백 없음 → 요구 재조정 |
| **S15** | 밸런서 품질 | RR 공정성 편차 < 5%, hash 재매핑률, 재시도·failure penalty 동작, CPU/p99 오버헤드 < 10% | 알고리즘 축소 |
| **S16** | **SNI 별 TLS policy 렌더** | 동일 `listen` 의 비-default server 별 `ssl_protocols` 가 **실제 handshake 에 적용**되는가 (E27 은 문법만 확인) | `override` 제거, TlsPolicy 는 리스너 단위 |
| **S17** | **TLS 인증서 선택 렌더** | exact / 1-라벨 와일드카드 / `default_server` 조합에서 **SAN 이 커버하지 않는 인증서가 제시되는 일 0** (E22.2 위험) | v0 은 exact host 만 허용 |
| **S18** | **ACME 상태기계** | 오더·챌린지·재시도·고아 TXT 정리. v0.6 전 실행 | ACME 범위 축소 |
| **S19** | **롤백 경로 합성** | 옛 topology·TLS 자료를 새 세대로 clone 하고 새 epoch 를 구워 활성화. S8 과 S11 이 함께 성립하는가 | 설계 재작업 (block) |

### S1 / S5 실행 결과 — `./spike/s1-s5/run.sh`

```
PASS=8  FAIL=0     openresty/1.31.1.1, worker_processes 4
```

| ID | 결과 |
|---|---|
| S1.http | HTTP — 전환 후 **첫 요청**부터 새 peer (A→B) |
| S1.tcp | TCP — 전환 후 **첫 연결**부터 (A→B) |
| S1.udp | UDP — 전환 후 **첫 세션**부터 (A→B) |
| S1.noreload | 전 과정에서 reload 0회 (error.log 기준) |
| S1.samemaster | 마스터 PID 불변 |
| S5.zones | http Lua 에서 stream zone 이 보이지 않는다 — 이중 평면 확정 |
| S5.converge | 워커 4개 전부 새 리비전 채택, 가장 늦은 워커 **15–23ms** (동기화 주기 20ms) |
| S5.perworker | 전환 직후 30요청 전부 새 peer — 스테일 창 없음 |

**S1 은 통과. OpenResty 멤버십 평면 경로가 성립한다.** 따라서 §7.3 대안 B 는 폴백으로
남고, 3차 검수의 멤버십 관련 blocking 항목(2·3·4)은 **버릴 수 없다. 설계해야 한다.**

**측정에서 배운 것 — 3차 검수 "워커 수렴" 지적에 대한 답.**
`balancer_by_lua` 는 **연결마다** shared dict 를 읽으므로, 리비전 검사를 곁들이면
워커 로컬 캐시가 스테일 창을 만들지 않는다(S5.perworker 30/30). 즉 워커 수렴은
*트래픽*의 문제가 아니라 *관측*의 문제다. 위험은 리비전 검사 없이 캐시할 때만 생긴다.

> 측정 함정 둘을 겪었다. ① 요청을 때려서 워커를 세면 커널 accept 분배 운에 좌우된다
> (4개 중 3개만 관측돼 거짓 실패). ② busybox `date` 는 `%N` 을 지원하지 않아 `0ms` 라는
> 가짜 숫자가 나왔다. 둘 다 워커 자가보고 + `ngx.now()` 로 고쳤다. **S5 는 아직 부분
> 통과다** — 한쪽 평면 실패·ACK 유실·늦은 RPC·리더 교체·옛 HTTP/2 워커 잔존은 미검증.

### S11 실행 결과 — `./spike/s11/run.sh`

```
PASS=14  FAIL=0     openresty/1.31.1.1, worker_processes 2
```

| ID | 결과 |
|---|---|
| P1.rollback | 롤백이 옛 topology 를 **새 epoch(E7)** 로 활성화 |
| P1.stale_stage | 지연된 `(E1)` 델타 거부 (409) |
| P1.not_monotonic | `activate E1` 거부 — 엄격 단조 (409) |
| P1.traffic | 지연 RPC 이후에도 트래픽 오염 없음 |
| P7.admin | 미staging epoch 활성화 거부 |
| P7.dataplane | 슬롯 없는 세대로 HUP → **503**. 옛 peer 로 조용히 흘러가지 않음 |
| P8.control | HUP 없으면 keepalive 응답 2개 (대조군) |
| P8.keepalive_closed | **HUP 이 유휴 keepalive 연결을 닫는다** |
| P8.inflight | HUP 을 가로지른 in-flight 요청이 옛 세대에서 완료 |
| P8.new | 새 연결은 새 epoch 로 |
| P15.lower / higher / demoted / traffic | 리더 토큰 펜싱 |

**P1 이 핵심이다.** v3 §3.3 이 `activation_epoch` 를 엄격 단조로 만들고 롤백도 새 값을 쓰게
바꾼 것이 실제로 ABA 를 막는다. **v2 설계였다면 롤백이 E1 을 재활성화하므로 지연 델타가 먹었다.**

**P8 은 3차 검수의 전제를 교정했다.** "옛 HTTP 워커가 keepalive 연결에서 새 요청을 계속
처리한다"는 사실이 아니다 — HUP 이 그 연결을 닫는다. E-old 가 필요한 진짜 이유는
**HUP 을 가로지르는 in-flight 요청과 그 재시도**다. 창이 좁아졌지 사라진 건 아니다.

**엔진 스파이크로 덮이지 않는 것**: 평면 부분 전환(P5·P6), 스냅샷 cut→replay(P3),
버퍼링/abort(P2·P4)는 컨트롤 플레인 프로토콜 로직이다. 프로토콜 구현 단계에서 검증한다.

### S8 실행 결과 — `./spike/s8/run.sh`

```
PASS=11  FAIL=0
```

두 배치를 나란히 돌린다.

| ID | 결과 |
|---|---|
| S8.prevalidate | **게시 전에** 새 세대를 그 자리에서 `nginx -t` 할 수 있다 — §6.2 prepare 성립 |
| S8.initial / renew / swap | 세대 전환이 conf 와 인증서를 함께 바꾼다 |
| **S8.rollback** | 배치 A(세대 결박) — **롤백이 그 시점의 key/chain 을 정확히 복원** |
| **S8.mutable_broken** | 배치 B(세대 밖 mutable) — **롤백해도 갱신된 인증서가 그대로 나온다** |
| S8.mismatch | cert/key 불일치는 `nginx -t` 가 거부 |
| S8.gc_traffic | 인증서를 지워도 **열린 fd 로 트래픽은 계속 흐른다** |
| S8.gc_root | 그런데 **다음 reload 는 실패한다** — 트래픽만 보면 알 수 없다 |

**배치 B 가 1차 검수 Critical #4 의 실물이다.** "롤백은 symlink 되돌리기 + reload 로 끝난다"가
왜 거짓이었는지를 재현한다. conf 는 되돌아가는데 인증서 파일은 이미 덮여 있다.

**S8.gc_traffic + S8.gc_root 이 §8.4 GC root 의 근거다.** 활성 세대의 파일을 지워도 트래픽은
멀쩡하다. 다음 reload 에서야 터진다. 그래서 "지금 잘 돌아간다"는 GC 안전의 근거가 못 된다.

**부수 발견 — `ssl_certificate` 는 conf_prefix 기준으로 풀린다.** prefix 가 아니다. 세대 conf
안에 `certs/...` 라고 쓰면 `-c current/nginx.conf` 로는 symlink 를 따라가고,
`-t -c generations/N/nginx.conf` 로는 그 세대 자신을 가리킨다. 이 성질이 게시 전 검증을
가능하게 한다. 경로에 세대 번호를 넣으면(`generations/N/certs/...`) `current` 를 거칠 때
`current/generations/N/...` 로 풀려 깨진다 — 실제로 처음에 이렇게 짜서 기동에 실패했다.

### S7 실행 결과 — `./spike/s7/run.sh`

```
PASS=9  FAIL=0     openresty/1.31.1.1, worker_processes 3
```

| ID | 결과 |
|---|---|
| S7.baseline | 기동 직후 전 워커가 gen1 보고 |
| A4.3 | in-flight 요청을 **gen1 워커**가 처리하는데 shared 마커는 `2` — 마커는 세대별 렌더 리터럴이어야 한다 |
| S7.success | 정상 HUP → **74ms** 에 활성화 판정 (미탐 0) |
| S7.test_passes | 포트 점유 중에도 `nginx -t` 통과 (E23 자동화) |
| S7.fail_detect | 실패한 HUP → **71ms** 에 실패 판정 (오탐 0) |
| S7.stays_old | `accepting` 이 옛 세대로 유지 |
| S7.traffic | 실패한 HUP 뒤에도 옛 설정으로 트래픽 유지 |
| S7.errlog | 워터마크 이후 bind 실패 기록 |
| S7.recover | 점유 해제 후 **8ms** 에 활성화 |

**판정에는 음성 신호가 반드시 필요하다.** 워커 레지스트리만으로는 실패 판정이 타임아웃
전체를 소모한다 — "새 워커가 안 보인다"는 아무리 기다려도 계속 참이기 때문이다. 처음 돌렸을
때 **4,027ms** 가 걸렸다. error log 워터마크를 함께 보면 **71ms**. §6.3 이 이미 워터마크를
판정 3단계로 적어 뒀는데, 그게 왜 필요한지는 이 실측 전까지 근거가 없었다.

→ **ApplyOperation 스키마를 고정할 수 있다.**

---

## 3. M — 모델 불변식: 저장이 거부되어야 하는 것 (v0.1+)

**계약**: 아래는 전부 `plan` 이전, **저장 시점에** 거부된다. 코드 `422`(의미적 불가) 또는
`409`(현재 상태와 충돌)로 갈린다 (§5.1).

### M1 리스너

| ID | 입력 | 기대 |
|---|---|---|
| M1.1 | `protocol=udp` + `inbound_proxy_protocol` | 422 — 타입 수준에서 `never` |
| M1.2 | `protocol=http` + `http2=true` | 422 — `http2` 는 `HttpsProfile` 에만 |
| M1.3 | `protocol=tcp`, `default_pool_id` 누락 | 422 |
| M1.4 | `protocol=tls_passthrough` + `tls_policy_id` | 422 — 패스스루는 인증서를 제시하지 않는다 |
| M1.9 | 잘못된 `bind`(`127.0.0.1x`) | **저장 거부.** 렌더가 와일드카드로 바꾸지 않는다 — **RUNNABLE** |
| M1.10 | 없는 풀/리스너 참조, 백엔드 없는 풀 | **저장 거부.** 렌더에서 조용히 사라지게 두지 않는다 — **RUNNABLE** |
| M1.11 | `protocol=https` | **표현 불가** — 렌더러가 TLS 종단을 못 내는 동안 타입에서 제거 |
| M1.8 | `tls_passthrough` + `on_no_sni` 설정 시도 | **표현 불가** — 부재·파싱실패는 `reject` 고정. `on_unmatched_sni` 만 설정 가능 (§4.1) |
| M1.5 | `inbound_proxy_protocol.enabled=true`, `trusted_proxy_cidrs=[]` | 422 — **비어 있으면 source IP 스푸핑** |
| M1.6 | `udp.expected_responses` 를 `tcp` 리스너에 | 422 |
| M1.7 | `bind_address` 비정규 표기(`::ffff:0.0.0.0`, 대문자 hex) | 정규화 후 저장, 이후 겹침 판정에 사용 |

### M2 라우트

| ID | 입력 | 기대 |
|---|---|---|
| M2.1 | `HttpRoute.listener_id` → `tls_passthrough` 리스너 | 422 — 복합 FK 위반 |
| M2.2 | `TlsPassthroughRoute` 에 `redirect` 액션 | 422 — 타입에 없음 |
| M2.3 | `TlsPassthroughRoute.action.reject` 에 HTTP status | 422 |
| M2.4 | `HttpRoute` 에 `sni` 매치 | 422 |
| M2.5 | `proxy` 액션 + `redirect_http_to_https` | **표현 불가** — 필드를 제거했다. `redirect` 액션만 존재 |
| M2.6 | `host` 에 `*.a.*.b.com` (다중 와일드카드) | 422 |
| M2.7 | `host` 대문자·trailing dot·유니코드 | IDNA 정규화 후 저장, 중복이면 409 |
| M2.8 | 같은 리스너·같은 매치·같은 priority 2개 | 409 — tie-break 가 결정적이어야 하므로 |

### M3 풀

| ID | 입력 | 기대 |
|---|---|---|
| M3.1 | `protocol_class=http` + `send_proxy_protocol=v1` | 422 — **E4 로 확정된 엔진 제약** |
| M3.2 | `protocol_class=udp` + `send_proxy_protocol=v1` | 422 |
| M3.3 | `protocol_class=tcp` + `send_proxy_protocol=v2` | 422 (driver capability 보고 시에만 허용) |
| M3.4 | `protocol_class=udp` + `upstream_tls.enabled` | 422 |
| M3.5 | `tls_passthrough` 라우트가 참조하는 풀에 `upstream_tls.enabled` | 422 — **TLS-over-TLS. 3차 지적** |
| M3.6 | stream 풀에 `hash_key=request_uri` | 422 — 클래스별 화이트리스트 |
| M3.7 | `algorithm=hash`, `hash_key` 누락 | 422 |
| M3.8 | `algorithm=source_ip_hash` + `is_backup=true` 백엔드 | 422 — 해시 링과 backup 충돌 |
| M3.9 | `protocol_class≠http` + `sticky.kind=cookie` | 422 |
| M3.10 | `protocol_class=udp` + `probe.protocol=http` | **허용** — 별도 헬스 포트는 정당 (§4.3.1) |
| M3.11 | `probe.mode=active`, `probe.protocol` 누락 | 422 |
| M3.12 | `least_conn` 지정 | **표현 불가** — `Algorithm` enum 에 없다. S6 이후 되살릴지 결정 |
| M3.13 | `http` 리스너가 `protocol_class=tcp` 풀 참조 | 422 — 복합 FK |

### M4 백엔드

| ID | 입력 | 기대 |
|---|---|---|
| M4.1 | `admin_state=draining` + `drain.deadline_s` 누락 | 허용 (기한 없는 관측 드레인) |
| M4.2 | `health_state` 를 PATCH 로 변경 시도 | 422 — Status 는 읽기 전용 |
| M4.3 | BackendStatus 갱신이 BackendSpec `version` 을 올림 | **금지** — 별도 리비전 |
| M4.4 | 삭제된 백엔드 UUID 재사용 | 422 — **영구 재사용 금지 (3차 지적)** |
| M4.5 | `host` 가 링크로컬/메타데이터 주소(`169.254.169.254`) | 422 — §14-6 |

### M5 TLS

| ID | 입력 | 기대 |
|---|---|---|
| M5.1 | `SniCertificateBinding.hosts` 에 다중 라벨 와일드카드 | 422 — **E22.2 위험. v0 은 exact + 1라벨만** |
| M5.2 | binding host 가 인증서 SAN 에 없음 | 422 |
| M5.3 | 같은 TlsPolicy 에 동일 host binding 2개 | 409 |
| M5.4 | cipher 정책 | 자유 문자열 불가. 버전된 `CipherPolicyRef` 만. TLS1.2 이하와 1.3 산출물 분리 |
| M5.5 | `override.min_version` 을 S16 미통과 엔진에서 | 422 `capability` |
| M5.6 | 와일드카드 도메인 + `acme.challenge=http-01` | 422 — dns-01 만 가능 |
| M5.7 | `material_ref` 에 `@latest` | 422 — 버전 고정 참조만 |

### M6 소켓 겹침 (§4.5) — **RUNNABLE** `tests/unit/sockets.test.ts`

| ID | 입력 | 기대 |
|---|---|---|
| M6.1 | `https :443` + `tls_passthrough :443` | 409 — **둘 다 transport=tcp** |
| M6.2 | `tcp :9999` + `udp :9999` | **허용** — E12 로 확정 |
| M6.3 | `0.0.0.0:8080` + `10.0.0.5:8080` | 409 — 동등이 아니라 겹침 |
| M6.4 | `[::]:8080` + `0.0.0.0:8080` (ipv6only=off) | 409 |
| M6.5 | 두 changeset 이 동시에 같은 소켓 커밋 | 하나만 성공, 나머지 409 — advisory lock |

### M7 문자열 문법 계약 (§4.9) — **RUNNABLE** `tests/unit/strings.test.ts` (M7.6 퍼즈 제외)

| ID | 입력 | 기대 |
|---|---|---|
| M7.1 | 헤더 값에 `\r\n` | 422 |
| M7.2 | 헤더 값에 `$` 로 시작하는 비화이트리스트 변수 | 422 |
| M7.3 | `hash_key` 에 임의 문자열 | 422 |
| M7.4 | host 에 `"; } server { listen 80; #` | 422 — 인젝션 |
| M7.5 | 리다이렉트 대상에 `javascript:` | 422 |
| M7.6 | 위 전부에 대한 **퍼즈** (10만 케이스) | 렌더 산출물이 항상 `nginx -t` 통과 or 저장 거부. **중간 상태 없음** — *미구현* |
| M7.7 | 짝 없는 `$` (`$`, `$-x`, `${host`) | 422 — 검증기가 문법을 끝까지 소비한다 — **RUNNABLE** |
| M7.8 | 비정규 IPv4 표기 (`127.1`, `0x7f.1`) | 422 — WHATWG URL 이 조용히 정규화하는 것을 막는다 — **RUNNABLE** |
| M7.9 | `cookie(sid-token)`, `header(X.Foo)` | 422 — nginx 변수명이 될 수 없다 — **RUNNABLE** |

---

## 4. R — 렌더러 골든 테스트 — **RUNNABLE**

`tests/unit/render.test.ts` (문자열) · `tests/golden/nginx-t.test.ts` (실제 엔진)

**계약**: 모델 → conf 는 결정적이다. 같은 모델은 항상 같은 바이트를 만든다.
모든 골든 산출물은 **E 와 같은 방식으로 실제 엔진 `nginx -t` 를 통과**해야 한다.

| ID | 모델 | 기대 산출물 |
|---|---|---|
| R1 | TCP 리스너 999 → 풀 A(백엔드 :11) | `stream{ upstream ... server{ listen 999; proxy_pass ...} }`, `nginx -t` 통과 |
| R2 | 같은 모델 재렌더 | **바이트 동일** (다이제스트 동일) |
| R3 | 백엔드 순서만 다른 동일 집합 | **바이트 동일** — 정렬 정규화 |
| R4 | websocket 라우트 1개 이상 | `$connection_upgrade` map 이 http 컨텍스트에 **정확히 1회** |
| R5 | websocket 라우트 0개 | map 미생성 |
| R6 | `source_ip_hash`, `protocol_class=http` | `ip_hash;` |
| R7 | `source_ip_hash`, `protocol_class=tcp` | `hash $remote_addr consistent;` |
| R8 | SNI 라우트 + `on_unmatched_sni=pool` | map 에 `~*` 정규식(대소문자 무시) + `[^.]+`(1라벨) + `default` |
| R21 | HTTP 와일드카드 | `~^[^.]+\.example\.com$` 앵커 정규식 — X.509 1라벨 계약과 맞춘다 (E22.2 vs E35) |
| R21 | 호스트 부분 겹침(`[a,b]`+`[b,c]`) | **저장 거부** — 엔진은 경고만 내고 첫 블록에 준다 (E36) |
| R21 | 호스트 여러 개인 라우트 | 호스트마다 server 블록 — `hosts[0]` 만 보고 순서를 정하지 않는다 |
| R22 | PROXY 수신·일반 리스너가 해시 풀 공유 | **저장 거부** — 일반 쪽에서 `$proxy_protocol_addr` 가 비어 한 peer 로 몰린다 |
| R20 | IPv6 백엔드 | `[2001:db8::1]:443` — bracket 없으면 엔진이 거부 (E34) |
| R20 | 풀 키 `a-b` 와 `a_b` | **서로 다른** upstream 이름 — 치환이 비단사면 중복 선언이 된다 |
| R20 | SNI 가 `default` | `~^default$` 앵커 정규식 — 인용은 소용없다 (E33) |
| R19 | http 리스너 | 리스너마다 명시적 `default_server` 하나. 기본 `444`. **실제 요청으로 확인** (E32) |
| R9 | SNI 라우트, 부재 SNI | map 에 `"" "";` 가 렌더되어 폴백 풀이 아니라 reject 로 간다. **v0 은 `$ssl_preread_protocol` 분기를 만들지 않는다** (두 경우 동작이 같다) |
| R10 | 겹치는 exact/wildcard host, priority 역전 | 컴파일 결과가 §7.5 클래스 순서를 따르고 **plan 이 경고** |
| R11 | UDP 리스너 + `preset=dns` | `proxy_responses 1; proxy_timeout 5s; listen ... udp reuseport;` |
| R12 | `send_proxy_protocol=v1`, tcp | `proxy_protocol on;` |
| R13 | `send_proxy_protocol` 이 http 풀 | 렌더 자체가 불가 — M3.1 에서 이미 차단 |
| R14 | 인증서 3개 + default | server 블록 3개 + `listen ... default_server` 1개 |
| R15 | `enabled=false` 리스너 | 산출물에서 제외되되 소켓 예약은 해제 |
| R16 | 전 리소스 삭제 | 유효한 최소 conf (nginx 가 기동 가능) |
| R17 | 골든 전량 | 실제 pin 이미지에서 `nginx -t` 통과 |

---

## 5. A — Apply 상태기계와 크래시 주입 (SPIKE + v0.1+)

### A1 정상 경로

| ID | 시나리오 | 기대 |
|---|---|---|
| A1.1 | 유효 plan → apply | `rendered→validated→published→reload_signaled→activated→verified` |
| A1.2 | 각 전이 | 저널에 fsync 후 진행 |
| A1.3 | `verified` 후 status | `published_revision == accepting_generation` |

### A2 실패와 롤백

| ID | 시나리오 | 기대 |
|---|---|---|
| A2.1 | 렌더 산출물이 `nginx -t` 실패 | `failed`. **게시 안 함.** 트래픽 무영향 |
| A2.2 | 새 리스너 포트를 외부가 점유 → HUP | **E23 재현.** `activated` 판정 실패 → 롤백 |
| A2.3 | 롤백 후 | 옛 세대가 `accepting_generation` 으로 복귀, 합성 프로브 통과 |
| A2.4 | 롤백 자체가 실패 | `rollback_failed` — **자동 복구 금지, 즉시 알림** |
| A2.5 | 연속 롤백 N회 | 서킷 브레이커 작동, 자동 apply 중단 |
| A2.6 | `nginx -t` 후 HUP 전에 인증서 파일 삭제 | 감지 후 롤백 |

### A3 동시성

| ID | 시나리오 | 기대 |
|---|---|---|
| A3.1 | 동시 apply 2건 | 하나만 진행, 나머지 409 — advisory lock |
| A3.2 | 리더가 apply 중 죽음 | 새 리더가 저널로 재개 또는 봉인 |
| A3.3 | **옛 리더의 지연 RPC 가 새 리더 apply 후 도착** | **DP Agent 가 leader fencing token 으로 거부** (3차 Critical) |
| A3.4 | 같은 `operation_id` 재전송 | 멱등 — 같은 결과 반환, 부작용 1회 |

### A4 활성화 판정 (§6.3)

| ID | 시나리오 | 기대 |
|---|---|---|
| A4.1 | 워커 1개만 새 세대 등록 | **아직 `activated` 아님** — 기대 워커 수 대조 |
| A4.2 | 옛 워커가 기존 연결 처리 중 | `serving_generations` 에 두 세대가 함께 노출 |
| A4.3 | 마커를 shared dict 로 구현 | **실패해야 정상** — 옛 워커도 새 값을 읽는다. 세대별 렌더 리터럴이어야 함 |
| A4.4 | HUP 후 error log 에 `emerg` | 워터마크 이후만 수집. 이전 것은 무시 |
| A4.5 | 합성 프로브: TCP connect / TLS handshake(SNI) / UDP | 리스너별 전부 통과해야 `verified` |

> **저널과 멤버십은 한 오퍼레이션이다.** `DpAgent` 가 durable 상태를 소유하고
> operation tuple 이 저널을 타고 흐른다. 둘이 같은 store 를 각자 쓰던 시절에는 서로를
> 덮어썼다(5차 반례 ③④). 멤버십 staging 은 **HUP 앞에**(§6.5-1), 좌표 이동은
> **활성화 확인 뒤에**(§6.5-4) 일어나며 둘 다 뮤테이션으로 변별력을 확인했다.

### A5 크래시 주입 매트릭스 (S12) — **부분 RUNNABLE** `tests/unit/apply-journal.test.ts`

> 지점을 손으로 고르지 않는다. 저장과 부작용을 **같은 시계로 세고 전 지점을 훑는다** —
> §6.2 표가 7행에서 11행으로 늘어난 이유가 "고르면 빠뜨린다" 였다.
>
> 합격 기준은 v4 에서 바뀌었다: HUP 은 exactly-once 로 만들 수 없으므로
> **최종 세대가 정확하고 중복 reload 가 상한 이내**인지를 본다.


**모든 durable write 와 외부 side-effect 의 직전/직후**에 프로세스를 죽인다. 3차 검수가
"7행으로는 부족하다"고 지적한 부분이다.

| ID | 주입 지점 | 기대 복구 |
|---|---|---|
| A5.1 | `publish_intent` 기록 **전** | 오퍼레이션 폐기, 디스크 무변화 |
| A5.2 | `publish_intent` 기록 **후**, symlink 교체 전 | symlink 상태를 읽어 재개 (멱등) |
| A5.3 | symlink 교체 **후**, `published` 기록 전 | symlink 가 정본. `published` 로 보정 |
| A5.4 | `reload_intent` 기록 후, HUP 전 | HUP 재전송 — 단 **재전송이 워커 cycle 을 추가로 만들지 않는지 확인** |
| A5.5 | HUP 후, `reload_observed` 기록 전 | 워커 레지스트리로 판정 |
| A5.6 | `activated` 후 epoch 스냅샷 전송 전 | 멤버십 풀 스냅샷 재전송 |
| A5.7 | http 평면 ACK 후 stream 평면 전송 전 | `partial_transition` 상태로 진입, 재시도 |
| A5.8 | 롤백 중 | 이전 세대 재게시 후 동일 판정 절차 |
| A5.9 | 시크릿 materialize 후 검증 전 | 재검증, 불일치면 `failed` |
| A5.10 | GC 디스크 삭제 후 refcount 감소 전 | **누수 없이 복구** (§8.4 release ledger) |
| A5.11 | `reload_intent` 후 HUP 전 / HUP 후 `reload_observed` 전 | **마스터 cycle 관측으로 갈라야 한다.** HUP 재전송은 워커 세대를 늘리므로 멱등이 아니다 |

### A6 취소

| ID | 시나리오 | 기대 |
|---|---|---|
| A6.1 | `rendered`/`validated` 에서 `/cancel` | `cancelled` — 부작용 없음 |
| A6.2 | `published` 이후 `/cancel` | **거부** 또는 롤백으로 전환. 조용한 중단 금지 |

---

## 6. P — epoch / 멤버십 펜싱 (SPIKE S11 + v0.1+)

**여기가 가장 위험하다.** 틀리면 죽은 백엔드로 트래픽이 간다. 3차 검수가 구성한 시나리오를
그대로 케이스화한다.

| ID | 시나리오 | 기대 |
|---|---|---|
| **P1** | `E10 → E11 → 롤백` 후, E10 시절의 지연 델타 `(E10, m91)` 도착 | **거부.** 롤백은 옛 topology 를 **새 `E12`** 로 활성화하므로 `E10` 은 다시 유효해지지 않는다 (§3.3-2). *v2 설계는 이걸 통과시켰다 — ABA* |
| **P2** | apply `prepare` 중 헬스 델타 유입 | 버퍼링 후 유실 없이 반영 |
| **P3** | 스냅샷이 `healthy` 를 읽은 뒤 `activated` 전에 `unhealthy` 델타 도착 | **죽은 백엔드가 되살아나지 않는다.** high-water mark 이후 이벤트를 순서대로 **replay** 한다 (§6.5-4) |
| **P4** | `prepare` 실패로 abort | E-new 슬롯 폐기, 버퍼는 기존 epoch 로 복귀. abort 동안에도 활성 epoch 는 헬스를 계속 받는다 |
| **P5** | http 는 E21 활성화·ACK, stream 은 timeout | 전역 커밋 금지. `partial_transition` 노출 + `max_convergence_ms` 초과 시 경보 |
| **P6** | P5 상태에서 http 롤백, 이후 늦은 stream E21 RPC 완료 | **거부** — 평면별 fencing + 새 epoch |
| **P7** | 새 워커가 accept 시작했는데 E-new 슬롯 미준비 | **일어나지 않아야 한다.** 슬롯이 준비되지 않은 워커는 ready 가 되지 않는다 (§6.5-3) |
| **P8** | 옛 HTTP 워커가 keepalive/HTTP2 연결에서 새 요청 처리 중 | **E-old 슬롯이 살아 있다.** 서빙 워커가 전부 사라질 때까지 유지 (§6.5-5) |
| **P15** | 옛 리더가 보낸 rollback RPC 가 새 리더 apply 뒤에 도착 | **DP Agent 가 거부** — 더 높은 `leader_token` 을 본 뒤에는 낮은 토큰의 요청을 전부 거부 (§3.5) |
| **P18** | 낮은 토큰 요청이 검사 후 yield 하는 사이 높은 토큰이 완주 | **거부.** 검사와 적용이 하나의 임계구역이어야 한다 (§3.6-4). *4차 검수가 재현한 실패 지점* |
| **P19** | 취소된 미래 epoch `E13` 의 지연 RPC 가 활성 `E12` 뒤 도착 | **거부** — "더 높으니까"가 아니라 `expected_current` CAS 로 판정 (§3.6-2) |
| **P20** | 같은 좌표에 다른 `payload_digest` 로 재요청 | **거부.** digest 가 같을 때만 cached ACK (§3.6-3) |
| **P21** | DP Agent 재시작 후 낮은 토큰 RPC | 거부 — 토큰은 side effect **전에** fsync 됐다 (§3.5) |
| **P23** | 같은 `(operation, transition)` 을 두 평면이 쓴다 | 평면마다 독립 판정 — 한쪽 ACK 를 다른 쪽이 훔치면 안 된다 (5차) |
| **P24** | abort 한 전환에 지연 stage/commit 도착 | **`aborted` 로 거부.** 캐시로 성공을 돌려주거나 슬롯을 되살리면 안 된다 (5차) |
| **P25** | 같은 store 를 보는 두 Agent 인스턴스 | 자기 기억으로 덮어쓰지 않는다 — 토큰 되감기 금지 (5차) |
| **P26** | Agent 가 다른 컴포넌트의 durable 상태와 같은 store 를 쓴다 | 남의 필드를 날리지 않는다 (5차) |
| **P22** | 먼저 시작한 프로브가 나중 것보다 늦게 완료 | 낡은 결과를 버린다 — `probe_start_seq` CAS (§6.6) |

**P18~P21 은 `tests/unit/dp-agent.test.ts` 에서 실행된다** (P22 는 리듀서 구현 후).
동시성 테스트는 **뮤테이션으로 변별력을 확인**했다 — `serial()` 의 직렬화를 제거하면
두 테스트가 실패한다. 변별하지 못하는 동시성 테스트는 거짓 확신만 준다는 것이
S11 하네스의 교훈이다.
| **P16** | DP Agent 재시작 후 옛 토큰 RPC 도착 | 거부 — 최대 토큰은 durable |
| **P17** | 같은 `topology_version` 인데 `activation_epoch` 만 다름 | 헬스 **재투영 가능** — 멤버십 식별 공간이 같다 (§3.3-4) |
| P9 | 백엔드 host/port 변경 후 옛 endpoint 의 지연 프로브 결과 도착 | 거부 — `{backend_id, endpoint_fingerprint, probe_spec_digest}` 전부 일치할 때만 투영 (§3.3-5) |
| P10 | `admin_state=disabled` 와 늦은 `healthy` 델타 경합 | **admin_state 가 항상 우선.** 단일 리듀서가 합성하고 헬스 프로듀서는 헬스 필드만 쓴다 (§6.6) |
| P11 | 모든 백엔드를 의도적으로 disabled | **실제로 빈 멤버십.** 요청이 실패해야 한다. 갱신 실패의 fail-open 과 **구분**된다 (§6.7) |
| P12 | shared dict OOM / 부분 쓰기 | 이전 완전 스냅샷 유지 (이건 fail-open) |
| P13 | 리비전 갭 감지 | 풀 스냅샷 재요청 |
| P14 | epoch 불일치 델타 | `EpochMismatch` 로 거부, 카운터 증가 |

---

## 7. C — API 계약 (v0.1+)

### C1 상태 코드 (§5.1)

| ID | 상황 | 기대 |
|---|---|---|
| C1.1 | `If-Match` 불일치 | **412** |
| C1.2 | `If-Match` 누락 | **428** |
| C1.3 | 소켓 이미 점유 | **409** |
| C1.4 | UDP + upstream_tls | **422** |
| C1.5 | 타입 오류 | **400** |
| C1.6 | 412 와 409 가 동시 성립 | **412 우선** |

### C2 changeset / plan 수명주기 (§5.3)

| ID | 시나리오 | 기대 |
|---|---|---|
| C2.1 | `plan` 후 `PATCH` | **409** — sealed |
| C2.2 | `reopen` 후 `PATCH` | 허용, 기존 plan 무효 |
| C2.3 | 같은 `plan_id` 로 commit 2회 | 두 번째는 409 — 단회 소비 |
| C2.4 | base_revision ≠ head 인 상태로 commit | 409 `PLAN_STALE(head_moved)` |
| C2.5 | 의존 리소스가 바뀐 뒤 commit | 409 `PLAN_STALE(dependency_changed)` |
| C2.6 | 렌더러 버전 변경 후 apply | 409 `PLAN_STALE(renderer_version_changed)` |
| C2.7 | 엔진 capability digest 변경 후 apply | 409 `PLAN_STALE(engine_capability_changed)` |
| C2.8 | plan TTL 경과 | 409 `PLAN_STALE(expired)` + **재-plan 경로 제공** |
| C2.9 | R1 커밋 → R2 커밋 → R1 plan 으로 apply | **거부.** 과거 리비전 적용은 명시적 rollback 으로만 (3차 지적) |
| C2.10 | commit 은 됐는데 apply 안 함 | `status.pending_apply` 로 노출 |
| C2.11 | 같은 `plan_id` 로 apply 2회 | 같은 `operation_id` 반환 (멱등) |
| C2.12 | commit 중 일부 리소스 실패 | **전부 롤백.** 부분 적용 없음 |
| C2.13 | 직접 CRUD 엔드포인트 호출 | 존재하지 않음 — 모든 쓰기는 changeset 경유 |

### C3 impact (§5.4)

| ID | 시나리오 | 기대 |
|---|---|---|
| C3.1 | 헬스만 변화 | `requires_reload=false` |
| C3.2 | 백엔드 추가 | `topology_epoch_change=true` |
| C3.3 | 새 포트 리스너 추가 | `socket_changes` 에 새 bind 표시 (**A2.2 위험 예고**) |
| C3.4 | 라우트 우선순위 변경 | `route_order_changes` 에 컴파일된 순서 + 그림자 경고 |
| C3.5 | 엔진 미지원 조합 | `capability_warnings` |

### C4 export / import (§5.5)

| ID | 시나리오 | 기대 |
|---|---|---|
| C4.1 | export → import (동일 인스턴스) | 리소스 수·내용 불변 |
| C4.2 | 같은 매니페스트 2회 import | **결과 동일** (멱등) |
| C4.3 | export 산출물에 `id`/`version`/status | **없어야 함** |
| C4.4 | export 산출물에 개인키·시크릿 값 | **없어야 함.** 별칭만 |
| C4.5 | 대상에 없는 `materialAlias` | **plan 단계에서 실패** |
| C4.6 | 중간이 깨진 매니페스트 | 전체 거부. 부분 적용 없음 |
| C4.7 | `--mode replace --prune` | 명시된 것만 삭제 |

---

## 8. G — GC / 보존 (SPIKE S13 + v0.1+)

| ID | 시나리오 | 기대 |
|---|---|---|
| G1 | 세대가 `serving_generations` 에 남아 있음 | **GC 금지** |
| G2 | 옛 워커 종료 + 보존 개수 초과 + 롤백 보존 경과 | tombstone → 삭제 → refcount 감소 |
| G3 | 디스크 삭제 후 refcount 감소 전 크래시 | **영구 누수 없음** — release ledger 로 복구 (3차 지적) |
| G4 | refcount 감소 후 완료 표시 전 크래시 → 재시도 | **이중 감소 없음** — `(generation, secret_version)` unique |
| G5 | SecretStore 삭제 실패 | 재시도 + 누수 경보. **세대 GC 는 진행** |
| G6 | 시크릿 삭제 직전 새 세대가 같은 버전 참조 | 삭제 취소 — 직전 zero-ref 재확인 |
| G7 | GC root 누락 검사 | `current`, `published`, 진행 중 오퍼레이션의 target·rollback, **committed-but-unapplied artifact** 가 전부 pin |
| G8 | plan artifact TTL 경과했으나 그 세대가 활성 | **삭제 금지** |

---

## 9. X — 보안 (v0.1+)

| ID | 시나리오 | 기대 |
|---|---|---|
| X1 | M7 전 항목 | 저장 거부. 렌더까지 도달 금지 |
| X2 | 백엔드 host = 클라우드 메타데이터 엔드포인트 | 목적지 정책 위반으로 거부 |
| X3 | 백엔드 DNS 가 프로브 시점에 내부 IP 로 재해석 | **재검증 후 차단** (DNS rebinding) |
| X4 | 액티브 프로브를 임의 내부 포트로 유도 | egress 정책으로 차단 |
| X5 | allowlist 에 없는 드라이버 패키지명 | 로드 거부 |
| X6 | integrity(sha512) 불일치 드라이버 | 로드 거부 |
| X7 | `apiVersion` 불일치 드라이버 | **기동 실패** (조용한 degrade 금지) |
| X8 | 개인키 조회 API | 존재하지 않음. 쓰기 전용 |
| X9 | materialize 된 키 파일 권한 | `0400`, DP uid 소유 |
| X10 | 감사 로그 | 모든 변경에 who/what/before/after/revision |
| X11 | 스코프 없는 토큰으로 apply | 403 |

---

## 10. 추적 매트릭스 — 검수 지적 → 케이스

| 검수 | 지적 | 케이스 |
|---|---|---|
| 1차 C1 | OpenResty 시점 | S1, S5, S6, S15 |
| 1차 C2 | apply 상태기계 부재 | A1–A6, S12 |
| 1차 C3 | changeset 부재 | C2 |
| 1차 C4 | 인증서 세대 롤백 불가 | S8, G1–G8 |
| 1차 H1 | PROXY v2 | E4, E5, E6, M3.1–M3.3 |
| 1차 H2 | `nginx -t` 는 증거가 아님 | **E23**, A2.2, A4 |
| 1차 H5 | SNI 폴백·우선순위 | E20, E26, S9, S10, R8–R10, M2 |
| 1차 H8 | 렌더 예시 오류 | E7, E8, E1, E3, R4–R7 |
| 1차 H11 | 로드맵 의존성 | (문서) |
| 2차 C1 | epoch fencing | **P1–P14**, S11 |
| 2차 C2 | 인증서 handshake 분리 | E22, M5, R14, S16, S17 |
| 2차 H | http/stream 이중 평면 | **E14, E25**, S5, P5, P6 |
| 2차 H | 워커 레지스트리 | A4.1–A4.3, S7 |
| 2차 H | GC 순환 | G3–G7 |
| 2차 H | 드레인 계층 오류 | S2, M4 |
| 3차 C | epoch ABA | **P1** — v3 §3.3 에서 해소 |
| 3차 C | 스냅샷 전환 순서 | **P7, P8** |
| 3차 C | 스냅샷 cut 델타 유실 | **P3** |
| 3차 C | 평면 부분 전환 | **P5, P6** |
| 3차 C | 리더 fencing | **A3.3, P15, P16** |
| 3차 H | plan 단회성 | C2.3, C2.9, C2.11 |
| 3차 H | 크래시 표 부족 | **A5.1–A5.10** |
| 3차 H | 와일드카드 인증서 | **E22.2**, M5.1, M5.2, S17 |
| 3차 H | SNI 별 ssl_protocols | E27, M5.5, **S16** |
| 3차 H | zero-peer fail-open | **P11** |
| 3차 M | redirect 중복 | M2.5 |
| 3차 M | cipher preset | M5.4 |

---

## 11. 열린 결정

### 닫힌 것

| # | 사안 | 어떻게 닫았나 |
|---|---|---|
| 1 | `stream_realip` 이 기본 이미지에 없다 | **capability 로 전환.** 필수/선택을 나누고(§7.6), 잃는 기능을 실측으로 특정한 뒤(E28·E29) PROXY 체인만 저장 단계에서 막고 소스IP 해시는 `$proxy_protocol_addr` 로 자동 대체한다. 커스텀 이미지를 빌드하든 대안 B 로 가든 **코드는 그대로**다. |

근거가 되는 실행 테스트: `E0`, `E28.1/.2`, `E29.1`,
`tests/unit/capabilities.test.ts`, `tests/unit/engine-constraints.test.ts`,
`tests/unit/render.test.ts` R18, `tests/golden` R18.

### 남은 것 — 스파이크에 종속

| # | 사안 | 언제 결정되나 |
|---|---|---|
| 2 | 커스텀 OpenResty 이미지(`--with-stream_realip_module`)를 빌드할 것인가 | **S1/S5 이후.** 대안 B 로 가면 공식 nginx 이미지가 `stream_realip` 을 갖고 `stream_lua` 는 불필요해져 질문 자체가 사라진다 |
| 3 | S9 — TLS-no-SNI 와 malformed TLS 의 구분 | 비-TLS 구분은 **이미 확인됨**(E26.1). 남은 건 이 둘 |
| 4 | S16 — SNI 별 `ssl_protocols` 가 handshake 에 실제 적용되는가 | E27 은 문법만 확인했다 |

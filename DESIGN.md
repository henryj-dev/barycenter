# barycenter — 설계 문서 (v2 초안)

> nginx 를 실행 엔진으로 쓰는 **HTTP / TCP / UDP 리버스프록시·로드밸런서 컨트롤 플레인**.
> GUI · API · CLI 어디서든 같은 일을 할 수 있고, 설정은 파일이 아니라 **모델**이다.
>
> 작명 — 무게중심(barycenter): 두 천체가 서로를 도는 **공통 질량중심**. 다체 시스템이 실제로 공전하는 균형점이 로드밸런싱의 은유. CLI 는 `bary`.

> **개정 이력.** v0 초안 → 검수 1차(C4/H15/M6/L3) → v1 → 검수 2차(반박 재판정 + C2/H9/M5/L2)
> → v2 → 검수 3차(blocking 9건 + High/Medium) 반영 → **현재 v3**. 근거와 철회한 반박은 **§15**.
>
> **현재 판정**
> - **S1 통과 (2026-08-11).** `balancer_by_lua` 로 HTTP·TCP·UDP 전부 reload 없이 백엔드가
>   바뀐다 (`./spike/s1-s5/run.sh`). **OpenResty 멤버십 평면 경로가 확정됐고, §7.3 대안 B 는
>   폴백으로만 남는다.**
> - **S11 · S7 통과 (2026-08-11).** ABA 가 실제로 막히고(`./spike/s11/run.sh`), 활성화
>   판정이 오탐/미탐 0 으로 성립한다(`./spike/s7/run.sh`).
> - **v0.1 타입·API·DB 스키마 freeze: 여전히 No-Go.** 남은 block 은 **S8**(인증서 세대 롤백) ·
>   **S12**(크래시 저널) 이고, S5·S11 의 프로토콜 잔여분(평면 부분 전환 · cut→replay)과
>   S13(GC) 이 남아 있다.
> - v3 의 편집 방향: **v2 에서 문구로만 축소했던 것을 스키마와 코드에서 실제로 뺐다** (§15.5).

---

## 1. 목적과 비(非)목적

### 목적
- 도메인 기반 HTTP(S) 라우팅과 TLS 수명주기를 GUI 에서 관리한다.
- **TCP / UDP 를 단순 포워딩이 아니라 업스트림 풀 기반 로드밸런싱으로** 관리한다.
- 인바운드 포트와 백엔드 포트를 자유롭게 분리한다 (`:999 → A:11`, `:888 → B:11`).
- GUI · API · CLI 가 **동일한 능력**을 갖는다 (**v1.0 기준**. 단계별로는 GUI 가 뒤따른다 — §10).
- OSS 코어 + 비공개 드라이버로 사내 사정을 코어 밖에서 흡수한다.

### 비목적 (v1 범위 밖 — 명시적으로 안 한다)
- API 게이트웨이 기능 (플러그인 체인, 컨슈머, 레이트리밋 정책 엔진) — APISIX/Kong 영역.
- WAF, 봇 관리, 캐시 정책 세밀 제어.
- **멀티 노드 클러스터 관리** — v1 은 *단일 데이터플레인 인스턴스*만 관리한다 (§ 11).
- **고가용성(HA)** — v1 의 데이터플레인은 **SPOF 다.** 이건 "아직 안 만든 기능"이 아니라
  **명시된 운영 제약**이다. §11.4 에 RTO/RPO·콜드 스탠바이·페일오버 런북을 정의한다.
- **기존 세션의 강제 종료** — 드레인은 v0 에서 *새 트래픽 차단 + 관측*까지만 보증한다.
  강제 종료는 별도 capability 로 분리한다 (§ 4.4).
- 서비스 메시, mTLS 자동 발급 (백엔드 방향).
- nginx 설정 파일 직접 편집 UI. **어떤 경로로도 사용자 문자열이 raw nginx 디렉티브가 되지
  않는다** (§ 4.9, §14-5).

### 설계 원칙
1. **모델이 정본, nginx.conf 는 산출물.** 사람이 conf 를 손대는 순간 모델이 거짓이 된다.
2. **API 가 유일한 진입점.** GUI 도 CLI 도 API 클라이언트다. 내부 지름길을 만들지 않는다.
3. **원자적인 것은 게시(publish)뿐.** reload · 워커 기동 · 트래픽 전환 · 롤백은 원자적이지
   않다. 이 사실을 전제로 상태기계를 설계한다 (§ 6).
4. **데이터플레인 에이전트가 유일한 writer.** 컨트롤 플레인은 conf 파일도 nginx 프로세스도
   직접 소유하지 않는다 (§ 3.2).
5. **상태는 하나가 아니다.** desired / published / runtime / membership 을 분리하고,
   **설정 세대와 멤버십을 `topology_epoch` 로 결박한다** (§ 3.3). 이게 없으면 apply·롤백과
   헬스 변화가 경합해 죽은 백엔드로 트래픽이 간다.
6. **엔진이 관측 못 하는 상태는 API 로 약속하지 않는다.** 관측 가능성이 스키마의 상한이다.
7. **사내 사정은 드라이버로.** 코어에 특정 조직 가정을 넣지 않는다.
8. **불가능한 조합은 저장 자체를 막는다.** 타입 → DB 제약/트리거 → 트랜잭션 검증기 3중으로.

---

## 2. 왜 만드는가 — 갭 요약

### 2.1 갭 명제 (좁힌 버전)

느슨하게 "쓰기 GUI 가 있으면 L4 가 약하다"고 말하면 **거짓이다.** 반례가 실재한다.

- **Roxy-WI** (Apache-2.0) — HAProxy frontend/backend 를 쓰기 UI 에서 CRUD 하고 설정을
  push·검증·복원한다. HAProxy 자체가 TCP 풀 LB 를 한다.
- **HAProxy OpenManager** (AGPL) — 시각적 frontend/backend/server CRUD, TCP 모드,
  apply/version/rollback.
- **Zoraxy** (AGPL) — 쓰기 UI + TCP/UDP stream 프록시. (stream 이 다중 백엔드 풀 LB 까지
  하는지는 미확인 — *추정 아님, 미조사*.)

따라서 명제를 정확히 좁힌다.

> **쓰기 GUI + 타입화된 TCP·UDP 풀 + SNI 패스스루 + 액티브 헬스 + 시맨틱 plan 을
> 한 제품에서 제공하는 OSS 가 없다.**

| | 쓰기 GUI | API | CLI | TCP 풀 | UDP 풀 | SNI 패스스루 | 액티브 헬스 | 시맨틱 plan |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **Nginx Proxy Manager** | ✅ | 내부 REST | ❌ | ❌ | ❌ | ❌ | ❌ | ❌ |
| **Traefik** | ❌ 읽기전용 | ✅ | ~ | ✅ | ✅ | ✅ HostSNI | ✅ TCP | ❌ |
| **HAProxy + DPA** | ❌ (OSS) | ✅ 트랜잭션 | ✅ | ✅ | Enterprise | ✅ | ✅ | ~ |
| **Roxy-WI / OpenManager** | ✅ | ~ | ~ | ✅ | ❌ | ~ | ✅ | ❌ |
| **Caddy** | ❌ | ✅ ETag | ✅ | 커뮤니티 L4 | 커뮤니티 L4 | 커뮤니티 L4 | ~ | ❌ |
| **APISIX** | ~ 내장 대시보드 | ✅ | ~ | ✅ | ✅ | ✅ | ✅ | ❌ |
| **Nginx UI** | ✅ | ~ | ~ | 수동 conf | 수동 conf | 수동 conf | ❌ | ❌ |
| **Zoraxy** | ✅ | ~ | ❌ | ~ | ~ | ~ | ~ | ❌ |
| **NGINX One / NIM** | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ~ (상용) |

**barycenter 의 좌표**: *단일 VM 규모에서, NPM 보다 모델화·안전하고 APISIX/NGINX One 보다
작은 **쓰기 가능한 L4 컨트롤 플레인**.*

### 2.2 해자에 대한 정직한 평가

"API/CLI 대칭 + 검증·롤백"은 **해자가 아니다.** HAProxy DPA 는 이미 트랜잭션과 버전을,
Caddy Admin API 는 이미 ETag/If-Match 와 실패 시 기존 설정 유지를 제공한다. 기능 목록으로
복제 가능한 것은 전부 해자가 아니다. 실행 품질이 필요한 쪽으로 옮긴다.

1. **시맨틱 영향 분석** — "이 저장이 어떤 리스너의 어떤 세션에 무슨 영향을 주는가"를
   diff 가 아니라 *영향*으로 보여주는 것 (§ 5.4).
2. **프로토콜별 드레인 관측** — HTTP 업스트림 inflight / TCP 연결 / UDP 유사 세션의 잔존을
   peer 단위로 보여주는 것. (강제 종료가 아니라 **관측**이 해자다 — §4.4.)
3. **UDP 프리셋** — DNS / WireGuard / 게임 서버별 `proxy_requests`·`proxy_responses`·
   `proxy_timeout` 조합은 틀리면 조용히 깨진다. 검증된 프리셋 자체가 가치다.
4. **안정 ID GitOps** — UUID 가 아니라 스코프 내 안정 키로 export/import (§ 5.5).
5. **NPM 마이그레이션 경로** — NPM 사용자를 그대로 흡수하는 임포터.

### 2.3 리스크 — 갭이 닫힐 가능성

NPM 이 stream 을 제대로 만들면 표의 첫 줄이 바뀐다. [issue #4119](https://github.com/NginxProxyManager/nginx-proxy-manager/issues/4119)
가 오래 열려 있는 건 유리하지만 영구 보장이 아니다. → §2.2 의 1·2·3 이 실제 방어선이다.

---

## 3. 아키텍처

```
   ┌── Web GUI (SvelteKit)
   ├── CLI (bary)                    모두 같은 REST API 만 호출
   └── IaC / 스크립트
             │
             ▼
   ╔═══════════════════ 컨트롤 플레인 (Node) ═══════════════════╗
   ║  ┌─────────────────┐                                       ║
   ║  │   API 서버      │ 인증·인가 · 검증 · 감사 · changeset   ║
   ║  └────────┬────────┘                                       ║
   ║           ▼                                                ║
   ║  ┌─────────────────┐  Listener/Route/Pool/Backend/Cert     ║
   ║  │  선언 모델 (PG) │  + ConfigRevision · topology_epoch     ║
   ║  └────────┬────────┘                                       ║
   ║           ▼                                                ║
   ║  ┌─────────────────┐        ┌──────────────────┐           ║
   ║  │   Reconciler    │◄───────┤  Health Prober   │           ║
   ║  │ (단일 리더)     │        └──────────────────┘           ║
   ║  └───┬─────────┬───┘                                       ║
   ╚══════│═════════│═══════════════════════════════════════════╝
     설정 │ 경로    │ 멤버십 경로 — (topology_epoch, revision) 동반
          │ prepare/commit/abort  │
          ▼                       ▼
   ╔═══════════════ 데이터 플레인 (OpenResty) ═══════════════════╗
   ║  ┌──────────────────────────────────────────────────┐      ║
   ║  │  DP Agent  — /etc/barycenter 의 유일한 writer     │      ║
   ║  │  · materialize · nginx -t · 게시 · SIGHUP         │      ║
   ║  │  · epoch 전환 시 delta 버퍼링 → 스냅샷 원자 전환  │      ║
   ║  │  · 워커 레지스트리 대조 · 합성 프로브 · ACK       │      ║
   ║  └───────────┬──────────────────────┬───────────────┘      ║
   ║              ▼ http admin sock      ▼ stream admin sock    ║
   ║  ┌────────────────────────┐ ┌────────────────────────┐     ║
   ║  │ nginx http 서브시스템   │ │ nginx stream 서브시스템 │     ║
   ║  │ lua_shared_dict (http) │ │ lua_shared_dict(stream)│     ║
   ║  │ balancer_by_lua        │ │ balancer_by_lua        │     ║
   ║  └────────────────────────┘ └────────────────────────┘     ║
   ║   ※ 두 zone 은 별개다. 하나로 갱신할 수 없다 (§3.4)         ║
   ╚════════════════════════════════════════════════════════════╝
```

### 3.1 프로세스 분리는 타협 불가

컨트롤 플레인이 죽어도 트래픽은 계속 흘러야 한다. **단, 이 분리가 막는 것은 "CP 장애 → 트래픽
장애"뿐이다.** nginx 호스트·컨테이너·커널·볼륨 장애는 그대로 전체 LB 장애다 (§ 1, §11.4).

### 3.2 DP Agent — 유일한 writer

CP 컨테이너의 `nginx -t` 는 DP 컨테이너의 nginx 가 아니다 — 바이너리 버전, 컴파일된 모듈,
UID, 마운트 네임스페이스, 파일 권한이 전부 다를 수 있다.

| 책임 | 주체 |
|---|---|
| 모델 → 렌더 아티팩트 생성, 다이제스트 계산 | 컨트롤 플레인 |
| `/etc/barycenter` 쓰기, 시크릿 materialize | **DP Agent 전용** |
| `nginx -t -p <prefix> -c nginx.conf` | **DP Agent** (실제 DP 바이너리로) |
| symlink 게시 · SIGHUP · 결과 판정 · ACK | **DP Agent** |
| 워커 레지스트리 수집, 리스너 합성 프로브 | **DP Agent** |
| 멤버십 스냅샷/델타 주입 (http·stream 각각) | **DP Agent** |
| 백엔드 헬스 프로브 | 컨트롤 플레인 (프로버) |

### 3.3 상태 좌표 — `topology_version` 과 `activation_epoch` 를 분리한다

v2 는 `topology_epoch` 하나로 "무엇이 활성인가"와 "어떤 식별 공간인가"를 동시에 표현했다.
**그게 ABA 구멍이었다.** v2 의 규칙 5 는 "롤백은 이전 epoch 로 되돌린다"였는데:

```
E10 → E11 → rollback to E10
              ↑ 이 순간, E10 시절에 떠난 지연 델타 (E10, m91) 가 다시 "유효한 epoch" 가 된다
```

`membership_revision` 을 계속 올려도 소용없다 — **직전 E10 활성화의 늦은 RPC 와 현재 E10 을
구분할 방법이 없기 때문**이다. epoch 를 재사용하는 순간 그건 fencing token 이 아니라 라벨이다.

그래서 좌표를 나눈다.

| 좌표 | 저장 위치 | 성질 | 의미 |
|---|---|---|---|
| `desired_revision` | PG | 단조 | 사용자가 커밋한 모델 |
| `published_revision` | PG + DP 디스크 | 단조 | 게시되고 `nginx -t` 를 통과 |
| `accepting_generation` | nginx 런타임 | — | **새 연결을 받는** 세대 |
| `serving_generations[]` | nginx 런타임 | — | `{generation, pids, connections}` — 옛 워커 포함 |
| `topology_version` + `topology_digest` | PG | **내용 식별** | 풀·백엔드 식별 공간. 같은 내용이면 같은 값 |
| **`activation_epoch`** | PG + DP + shared dict | **엄격 단조. 재사용 없음** | 이 활성화 사건의 고유 번호 |
| `membership_revision[plane]` | shared dict (http·stream 각각) | 단조 | 해당 epoch 안의 멤버십·헬스 리비전 |
| `leader_token` | PG advisory lock + DP | 엄격 단조 | § 3.5 |

**핵심 규칙 — 롤백도 새 값을 쓴다.**

1. 모든 스냅샷·델타·ACK·DP RPC 는 `(activation_epoch, membership_revision, payload_digest)` 를 갖는다.
2. **`activation_epoch` 는 절대 재사용하지 않는다.** 롤백은 "E10 으로 되돌아가는" 것이 아니라
   **옛 topology 를 새 `E12` 로 활성화하는 것**이다. `topology_version` 은 E10 시절 값으로
   돌아가지만 epoch 는 앞으로만 간다. 지연된 `(E10, …)` RPC 는 자동으로 무효가 된다.
3. `activation_epoch` 보다 낮은 값을 실은 요청은 **거부한다** (`EpochMismatch`). 카운터를 남긴다.
4. `topology_version` 이 같으면 멤버십 식별 공간이 같다는 뜻이므로, **헬스를 재투영할 수 있다.**
   epoch 가 달라도 상관없다. 이게 "롤백 후 최신 헬스 유지"를 안전하게 만드는 근거다.
5. 백엔드 UUID 는 **영구 재사용 금지.** 헬스 재투영은
   `{backend_id, endpoint_fingerprint(host:port), probe_spec_digest}` 가 **전부** 일치할 때만 한다.
   host/port 나 프로브 설정이 바뀌면 옛 엔드포인트의 지연 프로브 결과가 새 엔드포인트에
   투영될 수 있다.

`GET /api/v1/status` 는 위 전부를 노출한다.

### 3.4 http 와 stream 은 별개 상태 평면이다

**OpenResty 의 `lua_shared_dict` 는 http 블록과 stream 블록에 각각 선언되고 서로의 zone 을
참조할 수 없다.** 실측으로 확정됐다 — 같은 이름은 `already declared for a different use` 로
거부되고(E14), 이름이 달라도 양방향으로 보이지 않는다(E25, S5.zones).

#### 평면별 리비전 벡터

"양쪽 ACK 후 전역 커밋"은 **원자 전환이 아니다.** http 가 E21 을 활성화하고 ACK 한 뒤 stream 이
timeout 나면 전역 revision 만 E20 인데 런타임은 이미 갈라져 있다. http 를 되돌린 뒤 늦은
stream E21 RPC 가 완료되면 이번엔 stream 만 E21 이 된다.

교차 평면 동시 전환은 **보장할 수 없다.** 그러니 보장하는 척하지 않는다.

| 필드 | 의미 |
|---|---|
| `plane_state[http]` / `plane_state[stream]` | `{activation_epoch, membership_revision, digest, prepared_workers, active_workers}` |
| `affected_planes` | 이 전환이 건드리는 평면 (한쪽만일 수 있다) |
| `transition_id` | 이 전환의 고유 ID. 모든 평면 RPC 가 실어 나른다 |
| `partial_transition` | 평면 간 좌표가 갈린 상태. **status 에 노출한다** |
| `max_convergence_ms` | 이 상태를 허용하는 상한. 초과하면 경보 |

프로토콜은 `stage → 전 워커 prepared ACK → fenced commit pointer` 다. commit 포인터를 옮기기
전까지 새 스냅샷은 **비활성 상태로 적재만** 되어 있다.

#### 워커 수렴 — 실측이 좁혀 준 것

S5 에서 확인했다: `balancer_by_lua` 는 **연결마다** shared dict 를 읽으므로, 리비전 검사를
곁들이면 워커 로컬 캐시가 스테일 창을 만들지 않는다 (전환 직후 30/30 정확). 워커 4개 채택
지연은 15–23ms(동기화 주기 20ms)였다.

→ **워커 수렴은 *트래픽*의 문제가 아니라 *관측*의 문제다.** 다만 리비전 검사 없이 캐시하면
그때 위험이 생기므로, 밸런서는 `(epoch, revision)` 을 확인하고 다르면 로컬 뷰를 **통째로
교체**한다(더블버퍼). 부분 갱신을 금지한다.

### 3.5 리더 펜싱 — DP Agent 가 최종 심판이다

PG advisory lock 은 리더 세션이 죽으면 풀린다. 그런데 **옛 리더가 이미 보낸 rollback/abort
RPC 는 네트워크나 DP 큐에 남아 있을 수 있다.** 새 리더가 apply 를 시작한 뒤 그 RPC 가 도착하면
`previous_revision` CAS 와 `abort(opId)` 만으로는 막지 못한다.

- 리더는 선출될 때 **엄격 단조 증가하는 `leader_token`** 을 받는다 (PG 시퀀스).
- 모든 DP RPC 는 `leader_token` 을 싣는다.
- **DP Agent 는 지금까지 본 최대 토큰을 durable 하게 보관한다.** 더 높은 토큰을 본 뒤에는
  더 낮은 토큰의 `prepare`/`commit`/`abort`/`rollback` 을 **전부 거부**한다.
- DP Agent 는 진행 중 오퍼레이션도 durable 하게 들고 있어, 재시작 후에도 이 판정을 유지한다.

컨트롤 플레인은 자기가 리더라고 *믿을* 수 있을 뿐이다. 실제 심판은 DP Agent 다.

---

## 4. 데이터 모델

프록시 중립 스키마다. `nginx` 라는 단어가 스키마에 등장하지 않는 것이 목표.

### 4.0 공통 메타데이터와 제약 강제 지점

모든 리소스는 `ResourceMeta` 를 갖는다.

| 필드 | 타입 | 비고 |
|---|---|---|
| `id` | uuid | 내부 PK |
| `key` | string | **스코프 내 안정 키.** export/import 의 정본 식별자 (§ 5.5) |
| `name` | string | 표시용 |
| `version` | int | 낙관적 동시성. strong ETag 로 노출 |
| `created_at`/`updated_at` | timestamptz | |
| `created_by`/`updated_by` | principal | 감사 |
| `revision` | int | 이 리소스를 마지막으로 바꾼 전역 `ConfigRevision` |

**제약을 어디서 강제하는가** — PostgreSQL 의 일반 `CHECK` 는 **다른 행·테이블을 참조할 수
없다.** 그래서 층을 나눈다.

| 제약 종류 | 강제 지점 |
|---|---|
| 단일 행 내 필드 조합 (예: `algorithm=hash → hash_key` 필수) | DB `CHECK` |
| 리스너 protocol ↔ 풀 `protocol_class` 일치 | **복합 FK** (`(pool_id, protocol_class)` 참조) |
| 소켓 겹침, 라우트 그림자, 참조 무결성 그래프 | **트랜잭션 검증기** (커밋 트랜잭션 안, advisory lock) |
| 지연 검사가 필요한 다중 행 불변식 | `DEFERRABLE` 제약 트리거 |
| 타입 수준 판별 유니온 | TypeScript + Zod, API 경계 |

**삭제·유일성 정책:**

| 관계 | 정책 |
|---|---|
| Listener → Route | `RESTRICT` |
| Pool → Backend | `CASCADE` |
| Pool ← Listener/Route 참조 | `RESTRICT` |
| Certificate ← SniCertificateBinding 참조 | `RESTRICT` |
| `key` 유일성 | 타입별 전역 유일 |
| 소프트 삭제 | **없음.** `enabled=false` 로 비활성화, 삭제는 진짜 삭제 |
| 시크릿 정리 | §8.4 (비차단 GC) |

### 4.1 Listener — 무엇을 듣는가

**프로토콜별 판별 유니온.** 공통 필드는 base 에 둔다.

```ts
type ListenerBase = ResourceMeta & {
  bind_address: string;                    // 정규화 저장. "0.0.0.0" / "::" / 특정 NIC
  port: number;
  enabled: boolean;
  inbound_proxy_protocol?: InboundProxyProtocol;   // §4.7. udp variant 에서는 금지
};

type Listener =
  | ListenerBase & { protocol: 'http';  http:  HttpProfile }
  | ListenerBase & { protocol: 'https'; https: HttpsProfile }        // http2 는 여기만
  | ListenerBase & { protocol: 'tls_passthrough'; passthrough: PassthroughProfile }
  | ListenerBase & { protocol: 'tcp'; tcp: TcpStreamProfile; default_pool_id: uuid }
  | ListenerBase & { protocol: 'udp'; udp: UdpStreamProfile; default_pool_id: uuid;
                     inbound_proxy_protocol?: never };
```

**포트 리매핑은 여기서 자연히 풀린다.** `Listener(port=999, tcp) → Pool A(backend a:11)`,
`Listener(port=888, tcp) → Pool B(backend b:11)`.

#### HttpProfile / HttpsProfile

| 필드 | 프로파일 | 비고 |
|---|---|---|
| `client_max_body_size` | 둘 다 | |
| `client_header_timeout` / `client_body_timeout` | 둘 다 | |
| `default_action` | 둘 다 | `reject_444` \| `route_to_pool(pool_id)` |
| `http2` | **https 만** | 타입상 http 에서 표현 불가 |
| `tls_policy_id` | **https 만** | §4.6 |

#### PassthroughProfile — SNI 패스스루

| 필드 | 비고 |
|---|---|
| `on_unmatched_sni` | `reject` \| `pool(pool_id)` — **유효한 SNI 인데 매칭이 없다.** 설정 가능 |
| `preread_timeout` | ClientHello 대기 |

**SNI 가 없거나 파싱할 수 없으면 v0 은 무조건 `reject` 다. 설정할 수 없다.**

v2 는 `on_no_sni` 를 설정 가능하게 두고 "합치면 보안 결함"이라고 주장했는데, 정확히는
**합치는 것 자체가 문제가 아니라 SNI 부재·파싱 실패를 설정 가능한 폴백 풀로 보내는 것**이
문제다. 그리고 v2 의 렌더 예시는 자기가 주장한 정책을 구현하지도 못했다 — map 에 빈 문자열
분기가 없어 no-SNI 와 unmatched 가 같은 `default` 로 갔다.

세 경우를 이렇게 가른다.

| 상황 | v0 동작 | 근거 |
|---|---|---|
| 유효한 SNI, 매칭 있음 | 해당 풀 | |
| 유효한 SNI, 매칭 없음 | `on_unmatched_sni` (설정 가능) | 우리가 모르는 도메인 — 폴백 풀이 합리적일 수 있다 |
| **SNI 없음 (TLS 이지만)** | **reject 고정** | S9 통과 시 설정 가능으로 승격 검토 |
| **비-TLS / 파싱 실패** | **reject 고정** | TLS 패스스루 포트에 온 비-TLS 바이트를 어디로도 보내지 않는다 |

> `$ssl_preread_protocol` 로 비-TLS 를 구분할 수 있음은 실측으로 확인했다(E26.1). 그래서
> 나중에 분기를 되살릴 수 있다. **다만 v0 은 두 경우의 동작이 같으므로 map 도 하나만 렌더한다** —
> 쓰지 않는 분기를 미리 만들지 않는다.

#### TcpStreamProfile / UdpStreamProfile

L4 세션 파라미터는 **리스너에 산다** (라우트가 없는 L4 리스너에 `Route.timeouts` 는 적용 불가).

| 필드 | 프로토콜 | 비고 |
|---|---|---|
| `connect_timeout` | tcp/udp | 업스트림 연결 |
| `session_timeout` | tcp/udp | 무활동 타임아웃. **엔진 기본 10분 — 장수 세션은 반드시 조정** |
| `udp.expected_responses` | udp | 클라이언트 데이터그램당 **예상 업스트림 응답 수**. `unlimited` 지원 |
| `udp.max_requests` | udp | 세션당 허용 클라이언트 데이터그램 수. `0`=무제한 |
| `udp.reuseport` | udp | 워커별 소켓 |
| `preset` | udp | `dns` \| `wireguard` \| `game_generic` \| `custom` (§2.2-3) |

> `expected_responses` 는 **응답을 자르는 값이 아니라 세션 종료 힌트**다. 너무 크게 잡으면
> 세션이 `session_timeout` 까지 남아 매핑 테이블을 점유한다.

### 4.2 Route — 프로토콜별로 분리한다

v1 은 `Route` 하나에 `HttpMatch|SniMatch` 와 액션 유니온을 얹었는데, listener protocol 과
독립이라 **HTTP 리스너에 SNI 매치**, **패스스루 리스너에 redirect** 를 저장할 수 있었다.
타입을 완전히 가른다.

```ts
type HttpRoute = ResourceMeta & {
  listener_id: uuid;                 // protocol ∈ {http, https} 인 리스너만 (복합 FK)
  priority: number;                  // §7.5 — 같은 매치 클래스 안에서만 유효
  match: { host: string[]; path_prefix?: string };
  action:
    | { kind: 'proxy'; upstream_pool_id: uuid; proxy: HttpProxyOptions }
    | { kind: 'redirect'; to: string; status: 301|302|307|308 }
    | { kind: 'reject'; status: 403|404|444 };
};

type TlsPassthroughRoute = ResourceMeta & {
  listener_id: uuid;                 // protocol = tls_passthrough 인 리스너만 (복합 FK)
  priority: number;
  match: { sni: string[] };
  action:
    | { kind: 'proxy'; upstream_pool_id: uuid }
    | { kind: 'reject' };            // TLS 를 종단하지 않으므로 HTTP status 가 없다
};
```

`HttpProxyOptions`: `request_headers`(§4.9 문법 계약), `timeouts`(connect/read/send), `websocket`.

> `redirect_http_to_https` 는 뺐다. `redirect` 액션이 이미 있는데 proxy 옵션에도 두면
> "프록시하면서 리다이렉트한다"는 모순 조합이 다시 표현 가능해진다.

**인증서는 여기 없다.** → §4.6.

### 4.3 UpstreamPool — 어디로 보내는가

| 필드 | 타입 | 비고 |
|---|---|---|
| `protocol_class` | enum | **`http` \| `tcp` \| `udp` — 불변.** 복합 FK 의 일부 |
| `algorithm` | enum | `round_robin` \| `source_ip_hash` \| `hash` — **`least_conn` 없음** |
| `hash_key` | enum+params? | **자유 문자열 금지** (§ 4.9). 클래스별 화이트리스트 |
| `health` | object | §4.3.1 — **프로브 대상과 데이터 경로를 분리한다** |
| `passive` | object? | `max_fails`, `fail_timeout_s` |
| `send_proxy_protocol` | enum | §4.7. **http 는 `none` 고정** |
| `upstream_tls` | object? | `http`/`tcp` 만. `enabled`, `sni`, `ca_bundle_ref`, `client_cert_ref`, `verify` |
| `dns` | object? | `resolver_ref`, `valid_s`, `on_nxdomain`, `on_timeout`, `resolve_mode` |
| `sticky` | object? | HTTP: 쿠키 / L4: `source_ip_hash` |

**`least_conn` 은 v0 enum 에 아예 넣지 않는다.** stream/http OSS 에 네이티브로 있지만, S1 이
통과해 Lua 밸런서 경로가 확정된 이상 그 경로에서는 **워커별 근사**가 된다. 정확한 것처럼
보이는 이름으로 근사를 파는 것이 가장 나쁘다. S6 이 오차를 재고 나서 되살릴지 정한다.
v2 는 이걸 "축소했다"고 써놓고 enum 에는 남겨 뒀다 — 문구만의 축소는 축소가 아니다.

#### 4.3.1 헬스 프로브 — 데이터 경로와 분리

v1 은 `health.type` 을 `protocol_class` 에 묶었는데, **TCP/UDP 서비스가 별도 HTTP 헬스 포트나
사이드카 프로브를 갖는 정당한 구성을 막았다.**

| 필드 | 비고 |
|---|---|
| `probe.mode` | `none` \| `passive` \| `active` |
| `probe.protocol` | `tcp_connect` \| `http` \| `udp_payload` — **데이터 프로토콜과 무관** |
| `probe.port` | 미지정 시 백엔드 포트, 지정 시 별도 헬스 포트 |
| `probe.host_override` | 사이드카 프로브용 |
| `probe.http` | `path`, `expect_status`, `host_header`, `tls` |
| `probe.udp` | `payload_ref`, `expect_pattern` — 드라이버 위임 (§13-6) |
| `interval_s` / `timeout_s` / `rise` / `fall` | |

**남는 제약** (복합 FK · 트리거 · 검증기로 강제):

| 제약 | 이유 |
|---|---|
| `protocol_class=http` → `send_proxy_protocol=none` | **HTTP 업스트림에 PROXY 송신 디렉티브가 없다** |
| `protocol_class=udp` → `send_proxy_protocol=none` | 엔진 미지원 |
| `protocol_class=tcp` → `send_proxy_protocol ∈ {none, v1}` | 버전 선택 디렉티브 없음 |
| `protocol_class=udp` → `upstream_tls` 금지 | |
| `tls_passthrough` 라우트가 참조하는 풀 → `upstream_tls` 금지 | 클라이언트 TLS 바이트를 다시 TLS 로 감싸면 TLS-over-TLS 가 된다 |
| `hash_key` 화이트리스트 | http: `remote_addr`/`request_uri`/`header(n)`/`cookie(n)` · stream: `remote_addr` 만 |
| `algorithm ∈ {hash, source_ip_hash}` → `is_backup` 백엔드 금지 | 해시 링과 backup 의미가 충돌 |
| `sticky.kind=cookie` → `protocol_class=http` | |
| 리스너 protocol ↔ 풀 `protocol_class` | 복합 FK. `http/https`→`http`, `tcp/tls_passthrough`→`tcp`, `udp`→`udp` |

> `source_ip_hash` 라는 중립 이름을 쓰는 이유: stream 서브시스템에는 `ip_hash` 디렉티브가
> 없고 `hash $remote_addr consistent` 로 렌더해야 한다. **http `ip_hash` 와 동일한 분배·재매핑을
> 보장하지 않으며**, 이는 제품 의미상 "출발지 IP 고정"일 뿐임을 문서에 명시한다.

### 4.4 Backend — Spec / Status 분리

**BackendSpec** (사용자 소유, 버전 관리됨)

| 필드 | 비고 |
|---|---|
| `pool_id` / `host` / `port` / `weight` / `max_conns` | `host` 는 §14-6 목적지 정책 검사 대상 |
| `admin_state` | `enabled` \| `draining` \| `disabled` |
| `drain.deadline_s` | 관측 목적의 기한. **강제 종료는 별도 capability** |
| `is_backup` | 전부 죽었을 때만 |

**BackendStatus** (관측값, 별도 테이블·별도 리비전, `If-Match` 대상 아님)

| 필드 | 비고 |
|---|---|
| `health_state` | `healthy` \| `unhealthy` \| `unknown` |
| `last_probe_at` / `consecutive_ok` / `consecutive_fail` | |
| `drain_started_at` | |
| `upstream_inflight` | **peer 별 업스트림 인플라이트** (HTTP/TCP 공통) |
| `active_sessions` | TCP 연결 / UDP 유사 세션 |
| `drain_condition` | `pending` \| `no_new_traffic` \| `quiesced` \| `deadline_exceeded` |
| `(topology_epoch, membership_revision)` | 이 상태가 반영된 좌표 |

**드레인 계약 — v0 에서 무엇을 보증하는가**

| 보증 | v0 |
|---|---|
| 새 연결/세션이 이 백엔드로 가지 않음 | ✅ (멤버십 제외) |
| peer 별 업스트림 inflight 관측 | ✅ |
| `quiesced` = inflight 0 && active_sessions 0 | ✅ (관측 기반) |
| 기존 TCP 연결·UDP 세션 강제 종료 | ❌ **별도 capability.** 워커별 세션 핸들과 제어 경로 필요 |
| 클라이언트 HTTP/2 GOAWAY | ❌ **약속하지 않는다** |

> v1 초안은 "HTTP/2 는 GOAWAY 후 활성 스트림 0" 이라고 썼는데 **계층이 틀렸다.** 백엔드 하나를
> 풀에서 빼는 것과 client↔nginx 의 HTTP/2 커넥션에 GOAWAY 를 보내는 것은 무관하다. 필요한 건
> peer 별 업스트림 inflight 다. 다운스트림 keepalive 만료도 드레인 완료의 필요조건이 아니다.

### 4.5 소켓 예약 — 리스너 충돌 검증

`(transport, address_family, bind_address, port)` **단순 유일 제약으로는 부족하다.**

- `http`/`https`/`tls_passthrough` → `transport=tcp`. **http 컨텍스트 443 과 stream 컨텍스트
  443 이 충돌한다.**
- `tcp` 와 `udp` 는 같은 포트 번호를 공존시킬 수 있다.
- `0.0.0.0` 대 특정 주소는 **동등이 아니라 겹침**이다. `::` 는 `ipv6only` 설정에 따라 v4 를 덮는다.

→ **겹침 검증기**로 구현한다. inet 범위 기반 판정을 커밋 트랜잭션 안에서 수행하고,
동시 changeset 커밋 경합을 막기 위해 **advisory lock(또는 serializable isolation)** 을 건다.
유일 인덱스는 정확일치 중복만 잡는 보조 수단이다.

### 4.6 TLS 바인딩 — handshake 시점과 라우팅 시점을 분리

**v1 의 설계 오류 수정.** `proxy.tls.certificate_id` 를 라우트에 뒀는데, **인증서와 TLS 버전은
HTTP Host/path 를 보기 전에 SNI 로 선택된다.** 라우트에 두면 같은 host 의 path 별 라우트가
서로 다른 인증서를 갖는 표현이 허용되고, redirect/reject 라우트에도 인증서가 붙는다.

```ts
type TlsPolicy = ResourceMeta & {
  default_certificate_id: uuid;      // SNI 미매칭 시 제시
  min_version: '1.2' | '1.3';
  max_version?: '1.2' | '1.3';
  /** 버전된 정책 참조. 자유 문자열이 아니다. TLS1.2 이하와 TLS1.3 산출물을 분리한다. */
  cipher_policy: CipherPolicyRef;
  hsts?: { max_age: number; include_subdomains: boolean; preload: boolean };
  ocsp_stapling: boolean;
};

type SniCertificateBinding = ResourceMeta & {
  tls_policy_id: uuid;
  hosts: string[];                   // handshake 단계 선택 키
  certificate_id: uuid;
  override?: { min_version?: '1.2' | '1.3'; cipher_policy?: CipherPolicyRef };
};
```

- `HttpsProfile.tls_policy_id` → `TlsPolicy` → `SniCertificateBinding[]`.
- **SNI 와 HTTP Host 불일치 정책**을 명시한다: `allow`(기본, 로그만) \| `reject_421`.
  둘이 다를 수 있다는 사실 자체를 모델이 인정해야 한다.
- `tls_passthrough` 리스너에는 `TlsPolicy` 가 붙지 않는다 (인증서를 제시하지 않으므로).

### 4.7 PROXY protocol — 방향·전송·버전 3축

| 방향 | 전송 | 엔진 지원 | 모델 |
|---|---|---|---|
| 인바운드 수신 | TCP (http/https/tcp/passthrough) | v1·v2 수신 | `ListenerBase.inbound_proxy_protocol` |
| 인바운드 수신 | UDP | 불가 | 타입에서 `never` |
| 업스트림 송신 | **HTTP** | **디렉티브 자체가 없음** | `send_proxy_protocol = none` 고정 |
| 업스트림 송신 | TCP (stream) | **v1 만** | `none \| v1` |
| 업스트림 송신 | UDP | 불가 ([nginx#1061](https://github.com/nginx/nginx/issues/1061)) | `none` 고정 |

`InboundProxyProtocol`:

| 필드 | 비고 |
|---|---|
| `enabled` | 헤더 수신 활성화 |
| `trusted_proxy_cidrs[]` | **필수, 비어 있을 수 없다.** 없으면 source IP 스푸핑 |
| `real_ip_from_header` | 파생 소스 |
| `forwarded_header_policy` | `overwrite` \| `append` \| `drop` |

> 수신 활성화와 실 클라이언트 IP 적용은 엔진에서 별개 설정이고 realip 모듈이 필요하다 (§7.6).
> "UDP 는 실 클라이언트 IP 를 못 얻는다"는 **PROXY 헤더 경로에 한정해서** 참이다.

### 4.8 Certificate & Secret

| 필드 | 비고 |
|---|---|
| `name` / `domains[]` | SAN 전체 |
| `source` | `acme` \| `uploaded` |
| `acme_order_id` | §8.2 |
| `not_before` / `not_after` | 만료 모니터링 근거 |
| `material_ref` | **`store://<name>@<version>`** + `sha256` |
| `chain_digest` / `key_digest` | 세대 결박용 |

**개인키는 메인 DB 에 평문으로 두지 않는다.** SecretStore 드라이버 경유, **불변 버전 참조**.
버전 없는 참조는 롤백을 거짓말로 만든다 (§ 8.3).

### 4.9 사용자 문자열 문법 계약

**어떤 사용자 문자열도 raw nginx 디렉티브로 흘러들지 않는다.**

| 입력 | 계약 |
|---|---|
| `hash_key` | 자유 문자열 금지. 클래스별 화이트리스트 (§4.3.1) |
| 헤더 이름 | RFC 9110 token |
| 헤더 값 | 가변 참조는 화이트리스트 변수만. CR/LF 금지 |
| `host` / `sni` | IDNA 정규화, 소문자화, trailing dot 제거 후 LDH 라벨 검증 |
| 리다이렉트 대상 | 스킴·호스트 화이트리스트 |

렌더러는 **문자열 템플릿이 아니라 타입 있는 conf AST** 를 만들고 직렬화 단계에서만
이스케이프한다. AST 노드 종류 자체가 화이트리스트다. 퍼즈 테스트는 v0.1 완료 조건이다.

---

## 5. API

### 5.1 규약과 상태 코드

- `/api/v1/...`, JSON, REST.
- 인증: API 토큰(스코프) + OIDC(사람). RBAC. **v0.1 부터 최소 형태로 존재**한다.
- 모든 변경은 감사 로그(who/what/before/after/revision).

**상태 코드 4분할** (v1 의 "도메인 제약 위반=409" 는 부정확했다):

| 상황 | 코드 |
|---|---|
| `If-Match` 가 대상 리소스 표현과 불일치 | **412** (다른 충돌이 같이 있어도 412 우선) |
| 조건부 헤더를 요구하는데 누락 | **428** |
| 현재 상태와 충돌하지만 사용자가 해소 가능 (예: 소켓 이미 점유) | **409** |
| 상태와 무관하게 의미적으로 불가능한 입력 (예: UDP + upstream_tls) | **422** |
| 타입/구문 오류 | **400** |

**changeset 커밋의 전제조건**은 `If-Match` 로 표현하지 않는다. `If-Match` 는 요청 대상
표현의 precondition 이고, 우리가 걸고 싶은 건 **전역 config head** 다.
→ `/api/v1/config/head` 를 실제 리소스로 모델링하고, 커밋은 그 ETag 를
`If-Config-Head-Match` 확장 헤더 대신 **본문의 `base_revision`** 으로 받는다. 불일치는 409.

### 5.2 엔드포인트

```
# 리소스 읽기 — 쓰기는 전부 changeset 경유
GET    /api/v1/listeners  /routes  /pools  /pools/{id}/backends
GET    /api/v1/tls-policies  /sni-bindings  /certificates
GET    /api/v1/backends/{id}/status
GET    /api/v1/config/head              # 전역 revision + ETag

# changeset — 유일한 쓰기 경로
POST   /api/v1/changesets               # {base_revision} → changeset(state=open)
PATCH  /api/v1/changesets/{id}          # 변경 누적. state=open 일 때만 (아니면 409)
POST   /api/v1/changesets/{id}/plan     # state → sealed. plan_id 발급
POST   /api/v1/changesets/{id}/reopen   # sealed → open (plan 무효화)
POST   /api/v1/changesets/{id}/commit   # {plan_id} 단회 소비 → committed_revision
DELETE /api/v1/changesets/{id}
GET    /api/v1/plans/{plan_id}          # impact · render_digest · TTL · 상태

# 적용·관찰
POST   /api/v1/apply                    # {plan_id} 필수 → operation_id
GET    /api/v1/operations/{id}          # ApplyOperation 상태기계 (§6.2)
POST   /api/v1/operations/{id}/cancel
GET    /api/v1/status                   # 4-way + topology_epoch + membership + 드리프트
GET    /api/v1/config/rendered?revision=
GET    /api/v1/health/backends
GET    /api/v1/events                   # SSE
GET    /api/v1/audit
```

### 5.3 plan → commit → apply — 단회 lifecycle

v2 는 plan 을 봉인했지만 세 구멍이 남았다. plan 시점에는 `target_revision`/`activation_epoch`
할당 규칙이 없는데 세대 manifest 에는 둘이 들어간다. `plan_id` 가 commit 에서 소비된 뒤
apply 에서 또 쓰인다. 보존된 옛 plan 을 일반 `/apply` 로 재생할 수 있다.

**plan 은 상태를 갖는다.**

```
planned ──commit──→ committed ──apply──→ operation_bound ──→ applied
   │                    │                      │
   └── expired          └── superseded         └── failed / rolled_back
```

| 전이 | 규칙 |
|---|---|
| `planned` | changeset 을 seal 한다. 이후 PATCH 는 409 |
| → `committed` | `base_revision == head` 여야 한다. **이 순간 `target_revision` 과 `activation_epoch` 를 예약**하고 artifact 에 결박한다. `plan_id` 는 여기서 단회 소비된다 |
| → `operation_bound` | `(plan_id → operation_id)` 가 **unique**. 같은 `plan_id` 로 다시 apply 하면 새 오퍼레이션이 아니라 **같은 operation 을 반환**한다 (멱등) |
| → `applied` | 이 artifact 가 실제로 활성화됐다 |
| `superseded` | 더 최근 리비전이 적용됐다. **이 plan 은 일반 apply 로 재생할 수 없다** |

- **과거 리비전 적용은 명시적 rollback 으로만.** `R1` 커밋 → `R2` 적용 뒤에 `R1` plan 을
  `/apply` 로 되돌리는 경로는 없다. `POST /operations/{id}/rollback` 또는
  `POST /apply {rollback_to: revision}` 이 별도 의도로 존재하고, 감사에도 그렇게 남는다.
- **committed artifact 는 pin 된다.** TTL 은 `planned` 상태에만 적용된다. 커밋된 artifact 는
  적용·롤백 보존 기간이 끝날 때까지 지우지 않는다 — 24시간 뒤 만료돼 되돌릴 수단이
  사라지는 상황을 만들지 않는다 (§ 8.4 GC root).
- **모든 쓰기는 changeset 경유.** 직접 CRUD 는 없다. 단일 리소스 편집도 서버가 암묵
  changeset 을 만들어 처리하고 감사에 남긴다.
- **`PLAN_STALE(reason)`**: `head_moved` \| `dependency_changed` \| `renderer_version_changed`
  \| `engine_capability_changed` \| `expired` \| `superseded`.
  GUI 는 **rebase → replan** 을 한 동작으로 제공한다. 커밋 후 capability 가 바뀐 경우도
  같은 경로로 빠져나온다 — 막다른 골목을 만들지 않는다.
- **커밋됐지만 미적용**은 `status.pending_apply` 로 노출한다. 숨기지 않는다.
- **부분 적용은 없다.**

### 5.4 impact — plan 이 보여주는 것

| 항목 | 내용 |
|---|---|
| `requires_reload` | 멤버십만 바뀌면 아니오 |
| `topology_epoch_change` | epoch 가 바뀌는가 (§3.3 — 멤버십 전면 재전송 유발) |
| `affected_listeners` | 영향받는 리스너와 프로토콜 |
| `session_impact` | 프로토콜별 기존 세션 영향 (`none`/`new_only`/`may_reset`) |
| `socket_changes` | 새로 bind / 해제되는 소켓 — **HUP 실패 위험이 여기서 드러난다** |
| `certificate_changes` | 교체되는 인증서와 만료일 |
| `route_order_changes` | 컴파일된 매칭 순서 변화, 그림자 라우트 (§7.5) |
| `capability_warnings` | 대상 엔진 빌드가 지원하지 않는 조합 |
| `conf_diff` | 참고용 |

### 5.5 export / import

```yaml
schemaVersion: "1"
resources:
  - kind: UpstreamPool
    key: pool-a
    spec: { protocolClass: tcp, algorithm: round_robin }
  - kind: Backend
    key: pool-a/10.0.0.11-11
    spec: { poolKey: pool-a, host: 10.0.0.11, port: 11, weight: 2 }
  - kind: Certificate
    key: api-example-com
    spec: { source: uploaded, materialAlias: prod/api-cert }   # 값이 아니라 별칭
```

- **spec-only.** `id`/`version`/`revision`/status 는 export 되지 않는다.
- **`key` 가 정본 식별자.** import 시 `key → uuid` remap 테이블 유지.
- **시크릿은 별칭만.** 대상 SecretStore 에 없으면 **plan 단계에서 실패**한다.
- **전체 매니페스트 검증 후 단일 changeset 으로 커밋.** 순차 CRUD 금지.
- 머지 정책: `--mode merge|replace`, `--prune` (replace 에서만).

### 5.6 CLI (`bary`)

```bash
bary listener create --name game --protocol tcp --port 999 --pool pool-a
bary pool create --name pool-a --protocol-class tcp --algorithm round_robin
bary backend add --pool pool-a --host 10.0.0.11 --port 11 --weight 2
bary backend drain <id> --deadline 300s
bary backend drain-status <id>          # inflight / active_sessions / drain_condition
bary route create --listener web --host api.example.com --pool api-pool

bary changeset new                       # 모든 편집은 changeset 안에서
bary plan                                # impact + diff, plan_id 발급
bary commit --plan <plan_id>
bary apply  --plan <plan_id>
bary status                              # 4-way + epoch + pending_apply
bary get config --rendered
bary export > barycenter.yaml
bary import barycenter.yaml --mode merge
```

---

## 6. Reconciler & Apply

### 6.1 두 개의 경로 — 그리고 그 경계

```
설정 경로 (reload 유발, epoch 증가 가능)     멤버십 경로 (reload 없음, epoch 고정)
모델 변경 (리스너/라우트/풀/백엔드 CRUD)      헬스 판정 변화
weight·admin_state 변경                       (그 외 없음)
  → 디바운스 (2s, 최대 10s)                    → 레이트 리밋만
  → 렌더 → 아티팩트 다이제스트                 → (epoch, revision) 델타
  → prepare → nginx -t → 게시 → HUP            → http/stream 양쪽 push
  → 워커 대조 → 프로브 → 활성화                → 둘 다 ACK 후 revision 커밋
  → 새 epoch 스냅샷 원자 전환
```

**경계를 v1 보다 좁혔다.** v1 은 드레인과 DNS 변화를 멤버십 경로로 분류했는데, `admin_state`
와 weight 는 **모델 변경이라 ConfigRevision 을 올린다.** 같은 값을 두 경로가 각각 바꾸면
경합한다. 따라서:

- `admin_state`/weight 변경 → 설정 경로. 단 **렌더 결과가 동일하면 reload 를 생략**하고
  epoch 를 유지한 채 멤버십만 push 한다 (`requires_reload=false` 최적화).
- **헬스 판정만이 순수 멤버십 경로다.** 헬스는 사용자 소유 필드가 아니므로 경합하지 않는다.
- DNS 변화는 대안 B 에서 엔진이 처리하고, 멤버십 평면 경로에서는 CP 가 재해석해
  설정 경로로 반영한다.

### 6.2 ApplyOperation 상태기계 (durable)

```
 rendered → validated → publish_intent → published → reload_intent
                                                          │
                                          reload_observed → activated → verified
     │          │            │              │                 │
     └──────────┴────────────┴──────────────┴─────────────────┴──→ failed
                                                                     │
     cancelled ←── (rendered/validated 단계에서만)          rolling_back → rolled_back
                                                                       └→ rollback_failed ⚠
```

**`*_intent` 와 결과 상태를 나눈 이유**: v2 의 7행 표는 "단계 진입 전 fsync" 라고 해놓고
`published` 를 이미 symlink 가 바뀐 상태로 가정했다. 저널을 side-effect **전**에 쓰면
"기록했지만 안 했을" 수 있고, **후**에 쓰면 "했지만 기록 못 했을" 수 있다. 둘 다 덮으려면
의도와 관측을 별도 상태로 둬야 한다.

| 필드 | 비고 |
|---|---|
| `operation_id` | 멱등 재시도 키. `(plan_id → operation_id)` unique (§ 5.3) |
| `plan_id` / `target_revision` / `previous_revision` | |
| `activation_epoch` | commit 시점에 예약된 값 (§ 3.3) |
| `leader_token` | § 3.5 — DP Agent 가 이걸로 옛 리더를 걸러낸다 |
| `render_digest` | plan artifact 와 대조 |
| `plane_progress` | 평면별 `{epoch, revision, prepared, active}` (§ 3.4) |
| `state` / `attempts` / `last_error{kind, detail}` | |

**크래시 결정표 — side-effect 직전/직후 전부**

| # | 크래시 지점 | 관측으로 판정 | 복구 |
|---|---|---|---|
| 1 | `rendered` 기록 전 | — | 폐기 |
| 2 | 렌더 후, `validated` 기록 전 | 임시 세대 존재 | 삭제 후 재시도 |
| 3 | `publish_intent` 기록 후, symlink 교체 전 | symlink = 옛 세대 | 교체부터 재개 (멱등) |
| 4 | symlink 교체 후, `published` 기록 전 | **symlink 가 정본** | `published` 로 보정 |
| 5 | `reload_intent` 기록 후, HUP 전 | 마스터 cycle 불변 | HUP 전송 |
| 6 | HUP 후, `reload_observed` 기록 전 | 마스터 cycle 증가 | 워커 레지스트리로 판정 |
| 7 | `activated` 후, 평면 스냅샷 전송 전 | `plane_progress` 비어 있음 | 풀 스냅샷 재전송 |
| 8 | http 평면 ACK 후, stream 전송 전 | 평면 좌표 불일치 | `partial_transition` → 재시도 |
| 9 | 시크릿 materialize 후, 검증 전 | 다이제스트 대조 | 재검증, 불일치면 `failed` |
| 10 | GC 디스크 삭제 후, refcount 감소 전 | release ledger | § 8.4 |
| 11 | 롤백 중 | 혼재 | 이전 세대를 **새 epoch 로** 재게시 후 동일 절차 |

> **HUP 재전송은 운영적으로 멱등이 아니다.** 신호를 두 번 보내면 워커 cycle 이 하나 더 생겨
> 옛 워커 세대가 쌓인다. 그래서 #5·#6 은 재전송이 아니라 **마스터 cycle 관측**으로 먼저
> 갈라야 한다.

- **단일 리더** — PG advisory lock + `leader_token`. 최종 판정은 DP Agent (§ 3.5).
- **CAS** — DP Agent 는 `previous_revision` 이 자신의 `published_revision` 과 일치할 때만 진행.
- **취소** — `rendered`/`validated` 에서만 `cancelled` 로 갈 수 있다. `publish_intent` 이후의
  `/cancel` 은 거부하거나 롤백으로 전환한다. 조용한 중단은 없다.
- 연속 롤백 N 회 → 서킷 브레이커 + 알림.

### 6.3 활성화를 어떻게 증명하는가

**`nginx -t` 성공 + 마스터 생존 + 소켓 존재는 증거가 아니다.** HUP 시 새 리스너 bind 나 파일
open 에 실패하면 nginx 는 이전 설정으로 계속 서비스한다.

그리고 **유닉스 소켓 마커를 한 번 조회하는 것으로도 부족하다** — HUP 후에는 새 워커 여럿과
기존 연결을 처리하는 옛 워커가 공존하므로, 커넥션 하나가 새 세대를 반환해도 **워커 하나만**
증명한다.

판정 절차:
1. **프리플라이트** — DP Agent 가 실제 DP 환경에서 `nginx -t -p <generation_prefix> -c nginx.conf`.
2. **새 소켓 사전 bind 확인** — `socket_changes` 에 새 bind 가 있으면 별도 프로세스로 확인.
3. **HUP 후 error log 워터마크 대조** — HUP 시점 이후의 `emerg`/`alert` 수집.
4. **워커 레지스트리 대조** — 각 워커가 기동 시 `{pid, generation}` 을 등록하고 주기적으로
   하트비트를 갱신한다(끊긴 항목은 죽은 워커다). 마커는 **shared dict 가 아니라 세대별 렌더
   리터럴**이어야 한다. S7 에서 실증했다 — HUP 을 가로지르는 in-flight 요청을 **gen1 워커**가
   처리하는 동안 shared 마커는 이미 `2` 라고 답했다. 공유 상태는 "누가 응답했는가"를
   말해주지 못한다.
   `accepting_generation` 과 `serving_generations[{generation, pids, connections}]` 를 산출한다.
5. **기대 워커 수 대조** — `worker_processes` 와 마스터 cycle 을 기준으로 수렴을 판정.
6. **리스너별 합성 프로브** — TCP connect / TLS handshake(SNI 포함) / UDP 프로브.
7. 하나라도 실패 → 롤백. 롤백도 같은 절차로 검증하며 **롤백 실패는 별도 상태**로 즉시 알린다.

**양성 신호와 음성 신호를 함께 봐야 한다 — S7 이 알려준 것.**

워커 레지스트리(4~5)는 **성공을 빠르게** 판정한다. 그런데 그것만으로는 **실패 판정이 타임아웃
전체를 소모한다** — "새 워커가 안 보인다"는 아무리 기다려도 계속 참이기 때문이다. 실측에서
레지스트리만 쓰면 4,027ms 가 걸렸다.

3(error log 워터마크)이 **음성 신호**다. nginx 는 bind 실패를 HUP 직후 `emerg` 로 남기므로,
워터마크 이후의 `emerg` 를 보면 즉시 실패로 확정할 수 있다. 같은 시나리오가 **71ms** 로 떨어졌다.

| 신호 | 판정 | 실측 |
|---|---|---|
| 워커 레지스트리에 목표 세대가 `expected` 만큼 | **성공** | 74ms |
| 워터마크 이후 `emerg` | **실패** | 71ms |
| 둘 다 없음 | 계속 대기 → 예산 초과 시 `TIMEOUT` (실패로 처리) | — |

> 오탐/미탐 0 을 확인했다: 정상 HUP 을 실패로 보지 않고, 실패한 HUP 을 성공으로 보지 않는다.
> 점유가 풀린 뒤 같은 세대를 재시도하면 8ms 만에 활성화로 판정한다.

### 6.4 반드시 지킬 것

- **디바운스는 옵션이 아니다.** nginx reload 는 새 워커를 띄우고 옛 워커는 기존 연결이 끝날
  때까지 살아 있다. 장수 TCP 세션 + 잦은 reload = 워커/메모리 누적.
- **`worker_shutdown_timeout` 은 양날.** 안 걸면 *장수 연결이 있을 때* 옛 워커가 오래 남고,
  걸면 만료 시 열린 연결을 끊는다. 기본값을 정하고 트레이드오프를 문서화한다.
- **reload admission control** — `serving_generations` 수 상한을 두고, 초과하면 설정 경로
  apply 를 큐에 세운다. FD/메모리/UDP 세션 수에 알람.
- **드리프트 — 대상을 분리한다.**
  - `config_artifact_digest`: 렌더 conf + 인증서 자료. 불일치 → **`alert + block`**.
  - `membership_epoch/revision/digest`: 런타임 멤버십. 헬스 변화로 항상 움직이므로
    **드리프트 판정 대상이 아니다.**
  - 부트스트랩 멤버십은 아티팩트에 포함하되, **DP Agent 가 마지막 호환 멤버십 스냅샷을
    별도로 durable 저장**한다. 재시작 시 옛 부트스트랩만 쓰면 이미 disabled/unhealthy 인
    백엔드가 잠시 되살아난다.
  - 블록 해제는 명시적 `force-reconcile`(브레이크글라스, 감사 기록)만.

### 6.5 멤버십 전환 — staging · cut · replay

v2 는 "`activated` 직후 새 epoch 의 풀 스냅샷을 원자 전환한다 (델타 재생 아님)" 이라고 썼다.
두 군데가 틀렸다.

**틀린 것 1 — 순서.** 새 워커가 accept 를 시작한 *뒤에* 스냅샷을 전환하면, 그 사이 새 워커는
옛 공유 상태나 부트스트랩으로 peer 를 고른다. 그리고 옛 세대는 HUP 후에도 계속 서빙하므로
E-old 슬롯이 살아 있어야 한다. 단일 활성 epoch 로는 두 세대를 동시에 못 버틴다.

> **E-old 가 필요한 진짜 이유 — S11 이 좁혀 줬다.** 3차 검수는 "옛 HTTP 워커가 기존
> keepalive 연결에서 새 요청을 계속 처리하므로" 라고 했는데, **그건 사실이 아니다.**
> 실측 결과 **HUP 은 옛 워커의 유휴 keepalive 연결을 닫는다** (P8.keepalive_closed —
> HUP 없는 대조군은 응답 2개, HUP 를 끼우면 1개). 옛 워커는 그 연결에서 새 요청을 받지
> 않는다.
>
> 그래도 E-old 는 필요하다. 이유가 다를 뿐이다 — **HUP 을 가로지르는 in-flight 요청이
> 옛 세대에서 완료되고**(P8.inflight 로 확인), 그 요청이 재시도하면 밸런서가 다시 돈다.
> stream 의 장수 세션도 마찬가지다. 즉 창은 3차 검수가 생각한 것보다 **좁지만 0 은 아니다.**

**틀린 것 2 — 델타 유실.** 스냅샷이 `healthy` 를 읽은 뒤 `activated` 전에 `unhealthy` 델타가
버퍼에 들어오면, "재생 안 함" 규칙 때문에 **죽은 백엔드가 다음 프로브까지 되살아난다.**

수정한 절차:

```
1. stage    HUP **전에** E-new 스냅샷을 비활성 슬롯에 적재한다.
            세대별 렌더 리터럴이 자기 epoch 의 슬롯만 보게 한다.
2. cut      스냅샷을 뜬 시점의 헬스 이벤트 시퀀스 번호를 high-water mark 로 기록한다.
3. HUP      새 워커는 자기 epoch 슬롯이 준비되지 않았으면 **ready 가 되지 않는다.**
4. replay   활성화 직후, high-water mark **이후**의 헬스 이벤트를 순서대로 적용한다.
            (버리지 않는다. 합쳐서 적용한다.)
5. retain   E-old 슬롯은 그 세대를 서빙하는 워커가 **전부 사라질 때까지** 유지한다.
6. abort    prepare 가 실패하면 E-new 슬롯을 버리고, 버퍼는 **기존 epoch 로 되돌린다.**
            prepare 동안에도 활성 epoch 는 헬스 갱신을 계속 받는다.
```

헬스 이벤트에는 **durable sequence** 를 붙인다. 그래야 high-water mark 가 의미를 갖는다.

### 6.6 멤버십 리듀서 — 소유자가 달라도 경합은 남는다

v2 는 "`admin_state`/weight 는 사용자 소유, 헬스는 프로버 소유라 경합하지 않는다"고 했다.
**소유가 다른 것과 경합이 없는 것은 다르다.** 둘 다 최종적으로 같은 peer eligibility 를
갱신하므로, 늦게 도착한 whole-peer 헬스 델타가 방금 내린 `disabled` 를 되돌릴 수 있다.

- **단일 리듀서**가 `{spec revision, raw health}` 를 합성해 eligibility 를 만들고 시퀀스를 발급한다.
- 헬스 프로듀서는 **헬스 필드만** 쓴다. peer 전체를 덮어쓰지 않는다.
- **`admin_state` 가 항상 우선한다.** `disabled`/`draining` 은 어떤 헬스 값으로도 뒤집히지 않는다.

### 6.7 멤버십 경로의 실패 모드

| 상황 | 정책 |
|---|---|
| nginx 인스턴스 전체 재시작 | shared dict 소멸 → Agent 가 durable 스냅샷으로 **재시딩**. 시딩 전에는 렌더된 부트스트랩 사용 |
| HUP | shared dict 유지. epoch 전환은 § 6.5 절차 |
| CP ↔ DP 단절 | **값 자체에 TTL 을 걸지 않는다.** 만료된 키는 `get` 에서 사라지고 메모리 압박 시 LRU eviction 도 된다. `observed_at`/`expires_at` 만 저장하고 stale 판정은 읽는 쪽에서 한다 |
| stale 판정 후 | fail-open(기본)은 **기존 값 유지**, `fail_closed` 만 명시적으로 비운다 |
| shared dict OOM / 부분 쓰기 | `safe_set` 사용. **이전 완전 스냅샷을 유지한다.** eviction/OOM 은 경보 |
| **의도적 zero-peer** | 모든 백엔드를 `disabled` 로 만든 상태는 **실제로 빈 멤버십**이다. 요청을 실패시킨다. 갱신 실패의 fail-open 과 **구분해야 한다** — 안 그러면 전부 내렸는데 옛 peer 가 계속 트래픽을 받는다 |
| 프로버 장애 | 헬스 판정 동결, `unknown` 표시, 멤버십 유지 |
| 델타 유실 / epoch 갭 | 갭 또는 `EpochMismatch` 감지 시 풀 스냅샷 재요청 |
| 한 평면만 ACK | 전역 커밋 안 함. `partial_transition` 노출 + `max_convergence_ms` 초과 시 경보 (§ 3.4) |

> **shared dict 수명.** HUP reload 에는 유지되고, **nginx 인스턴스 전체가 종료된 뒤 재시작**하면
> 사라진다 (E24 로 실측). 마스터만 비정상 종료하고 워커가 남은 순간과 동일시하면 안 된다.

**DP Agent 의 durable 스냅샷**은 `last-known.json` 하나가 아니다. 어느 평면·어느 epoch·어느
topology digest 에 호환되는 스냅샷인지 표현할 수 없기 때문이다.
→ `membership/{plane}/{topology_digest}.json` 으로 콘텐츠 주소 지정하고 atomic fsync+rename.

---

## 7. nginx 렌더링

### 7.1 요구사항 예시

**`:999 → A:11`, `:888 → B:11`** (TCP):

```nginx
stream {
    upstream pool_a { server 10.0.0.11:11 weight=2 max_fails=3 fail_timeout=10s; }
    upstream pool_b { server 10.0.0.21:11; }

    server { listen 999; proxy_pass pool_a; proxy_timeout 10m; proxy_protocol on; }  # v1 송신
    server { listen 888; proxy_pass pool_b; }
}
```

**UDP**:

```nginx
stream {
    upstream dns_pool { server 10.0.1.5:53; server 10.0.1.6:53; }
    server {
        listen 8853 udp reuseport;
        proxy_pass dns_pool;
        proxy_responses 1;      # 클라이언트 데이터그램당 예상 응답 수 (세션 종료 힌트)
        proxy_timeout 5s;
    }
}
```

**443 SNI 패스스루** — 대소문자 무시 정규식과 폴백:

```nginx
stream {
    map $ssl_preread_server_name $tls_backend {
        hostnames;
        mail.example.com     pool_mail;        # 정확일치 (해시)
        ~*^.+\.example\.com$ pool_wild;        # ~* — SNI/DNS 는 대소문자 무시 (§7.5)
        default              pool_fallback;    # on_no_match (파싱 실패·비-TLS 포함)
    }
    server {
        listen 443;
        ssl_preread on;
        preread_timeout 5s;
        proxy_pass $tls_backend;
    }
}
```

> `on_no_sni` 를 `on_no_match` 와 다르게 처리하려면 `$ssl_preread_server_name` 이 빈 문자열인
> 경우를 별도 분기해야 한다. **stock nginx 에서 빈 SNI · malformed TLS · preread timeout 이
> 안정적으로 구분되는지는 S9 검증 대상**이며, 구분 불가면 `on_no_sni` 를 `reject` 고정으로
> 축소한다.

**HTTP 도메인 라우팅 + TLS 종단**:

```nginx
http {
    # WebSocket 라우트가 하나라도 있으면 http 컨텍스트에 정확히 한 번 렌더한다.
    # $connection_upgrade 는 내장 변수가 아니다. 없으면 nginx -t 가 실패한다.
    map $http_upgrade $connection_upgrade { default upgrade; '' close; }

    upstream api_pool { server 10.0.2.10:8080; server 10.0.2.11:8080; }
    server {
        listen 443 ssl;
        http2 on;                        # nginx 1.25.1+ 문법. §7.6 에서 버전 pin
        server_name api.example.com;     # ← handshake 단계 인증서 선택 (SniCertificateBinding)
        ssl_certificate     /etc/barycenter/current/certs/api.example.com/fullchain.pem;
        ssl_certificate_key /etc/barycenter/current/certs/api.example.com/privkey.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        location / {
            proxy_pass http://api_pool;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;      # websocket=true 인 라우트만
            proxy_set_header Connection $connection_upgrade;
        }
    }
}
```

> `source_ip_hash` 렌더: http 는 `ip_hash;`, **stream 은 `hash $remote_addr consistent;`**
> (stream 에 `ip_hash` 디렉티브는 없다). 두 경로는 동일 분배를 보장하지 않는다.

### 7.2 파일 레이아웃 — 인증서를 세대에 결박한다

```
/etc/barycenter/
├── current -> generations/000123/
├── generations/000123/
│   ├── manifest.json     # revision · topology_epoch · 아티팩트 다이제스트 · 시크릿 버전
│   ├── nginx.conf
│   ├── http/{listener-*.conf, upstream-*.conf, map-*.conf, admin.conf}
│   ├── stream/{listener-*.conf, upstream-*.conf, map-*.conf, admin.conf}
│   ├── lua/{bootstrap-membership.json, balancer.lua, marker.lua}
│   └── certs/<domain>/{fullchain.pem, privkey.pem}   # ← 세대 안에 있다
├── membership/last-known.json                        # DP Agent durable 스냅샷 (§6.4)
└── secrets-cache/<name>@<version>/                   # 콘텐츠 주소, tombstone 기반 GC
```

- `manifest.json` 이 `material_ref`(`store://name@version`)와 `sha256` 을 세대에 결박한다.
- DP Agent 가 세대 디렉토리 안에 인증서를 **원자적으로 materialize** (temp → fsync → rename).
- 직후 **인증서-키 일치·SAN·not_after·권한(0400, DP uid)** 검증.
- 세대 보존: 최근 N 개 + `serving_generations` 에 남아 있는 모든 세대.

### 7.3 OpenResty 와 멤버십 평면

| | 순수 nginx (대안 B) | OpenResty (`balancer_by_lua`) |
|---|---|---|
| 정적 백엔드 CRUD | reload | reload 불필요 |
| DNS/SRV 변화 | **1.27.3+ `resolve`** 로 reload 불필요 (`zone`+`resolver` 필요) | 동일 |
| 임의 IP 백엔드 즉시 추가/제거 | reload | **reload 불필요** |
| 액티브 헬스 결과 반영 | reload | **reload 불필요** |
| `least_conn` | **OSS 네이티브 (정확)** | 워커별 근사 (직접 구현) |
| 복잡도 | 낮음 | 높음 |

**`balancer_by_lua` 는 stream 서브시스템과 UDP 세션에도 적용된다.** 다만 이건 native upstream
멤버 목록을 바꾸는 게 아니라, 매 연결·요청·세션마다 Lua 가 `set_current_peer()` 로 peer 를
고르는 **커스텀 밸런서**다. 채택 비용:

- 가중 RR·일관 해시는 `lua-resty-balancer` 가 제공한다. **다만 이 패키지는 "선택 알고리즘
  라이브러리"일 뿐이고 experimental 로 표시돼 있다.** 멤버십 저장, 워커 수렴, DNS,
  failure penalty, 드레인, least-conn 은 전부 우리 책임이다.
- **`least_conn` 은 퇴보다.** stream/http OSS 에 네이티브로 존재하는데, Lua 로 가면 워커별
  근사가 된다. → v0 기본 알고리즘에서 뺀다 (§4.3, §15.3).
- shared dict 는 http/stream 이 **별개 zone** 이고 밸런서 객체는 worker-local 이다 (§ 3.4).
- 액티브 프로브는 `balancer_by_lua` 안에서 돌지 않는다. **컨트롤 플레인 프로버**를 쓴다.

**결정: §12.0 게이트를 통과할 때만 채택한다.** 그리고 멤버십 평면은 렌더러 교체가 아니라
데이터플레인 상태 모델의 일부이므로, **계약(§9.2 `pushMembership`)은 v0.1 에 고정**하되
epoch·ACK·수렴까지 포함한 형태여야 한다 (§15.1-R4).

**대안 B 의 정확한 범위** — 이건 "일반 멤버십 평면의 대체재가 아니다":

| 대안 B 로 되는 것 | 안 되는 것 |
|---|---|
| DNS 가 표현하는 endpoint 집합 변화 (A/AAAA/SRV) | GUI 로 등록한 임의 IP 백엔드 즉시 변경 |
| SRV weight (DNS 를 멤버십 정본으로 삼을 때) | A/AAAA 백엔드의 수동 weight 변경 |
| TTL/`valid=` 이후 반영 | push 식 즉시 반영 |
| — | 액티브 헬스 결과를 reload 없이 peer 제외에 반영 |
| — | `quiesced`·deadline·강제 종료 |

NXDOMAIN 과 timeout/SERVFAIL 의 네이티브 동작이 다르며 우리 모델의 `on_nxdomain`/`on_timeout`
선택형과 1:1 대응하지 않는다. **대안 B 자체도 S14 에서 별도 검증한다.**

### 7.4 nginx 의 한계 — 문서에 명시할 것

- **UDP 업스트림 PROXY protocol 미지원** ([nginx#1061](https://github.com/nginx/nginx/issues/1061)).
- **HTTP 업스트림에는 PROXY protocol 송신 디렉티브 자체가 없다.**
- **TCP 업스트림은 v1 만.** 버전 선택 디렉티브 없음.
- UDP "세션" 은 client IP:port 기반 유사 세션. `proxy_responses`/`proxy_requests` 를 틀리면
  세션이 안 닫히거나 조기에 닫힌다.
- OSS 액티브 헬스체크 부재.
- `proxy_timeout` 기본 10분.
- stream 에 `ip_hash` 없음. http 와 디렉티브 집합이 다름.
- **ECH**: inner-origin 별 라우팅 불가, outer `public_name` 단위로 축소.
- 정규식 매칭은 순차 평가다. nginx 자신도 regex server name 을 확장성 낮은 경로로 설명한다.

### 7.5 라우트 컴파일러 — 계약을 정직하게 축소한다

v1 은 "숫자 priority 를 와일드카드 정규식화로 완전 구현"한다고 했다. **불충분했다.**

- `map` 은 정확일치(해시) → 최장 prefix mask → 최장 suffix mask → 정규식(등장 순서) → default.
  정규식끼리는 등장 순서를 따르지만 **클래스 우선순위가 등장 순서보다 앞선다.**
  exact(priority 10) vs wildcard(priority 20) 에서 wildcard 가 이겨야 하는데 exact 를 해시에
  남기면 exact 가 무조건 먼저다.
- `path_prefix` 는 다룬 적조차 없다. 같은 host 의 `/api`(p10) vs `/`(p20) 은 native
  longest-prefix location 이면 `/api` 가 이긴다.
- HTTPS 는 **인증서가 handshake 단계에서 SNI 로 선택**되므로 단일 server + map 으로 못 덮는다.

**v0 계약 (축소):**

1. **우선순위는 매치 클래스 안에서만 의미가 있다.** API 는 `(match_class, priority, specificity)`
   3튜플로 실제 순서를 **그대로 노출**한다. 숨기지 않는다.
   매치 클래스 = `exact_host` > `wildcard_host` > `regex_host`, 그 안에서 `path_prefix` 길이.
2. **겹침·그림자·도달 불가 라우트는 plan 이 경고**하고, GUI 는 컴파일된 최종 순서를 보여준다
   (§5.4 `route_order_changes`).
3. 클래스를 가로지르는 우선순위 역전은 **저장은 허용하되 plan 에서 경고**한다. 조용히
   거부하지도, 조용히 다르게 동작하지도 않는다.
4. **`strict_priority` 모드는 옵트인**이고 S10 통과가 전제다. 이 모드는 충돌 그래프의
   연결 요소 전체(정확일치 포함)를 anchored 정규식으로 내려 등장 순서로 정렬한다.
   비용: 순차 평가로 인한 CPU/p99 증가. 라우트 수 상한과 벤치 기준을 함께 정의한다.

### 7.6 엔진 계약 (capability)

- **이미지 계약으로 버전 pin.** OpenResty 버전 → 내장 nginx core 버전 명시.
  `http2 on;` 은 core 1.25.1+ 이고 `ngx_http_v2_module` 빌드가 별도로 필요하다.
  `resolve` 는 1.27.3+ 여야 OSS 에서 동작한다.
- **컴파일 모듈은 "필수 목록"이 아니라 capability 다.** 실측(tests/engine E0)으로 확인한 것:
  우리가 필요한 두 모듈이 **서로 다른 이미지 계열에 나뉘어 있고, 어느 공개 이미지도 둘 다
  갖고 있지 않다.**

  | | `stream_realip` | `ngx_stream_lua` |
  |---|:---:|:---:|
  | 공식 `nginx:alpine` | ✅ | ❌ |
  | `openresty/openresty:*` (alpine·alpine-fat·bookworm) | ❌ | ✅ |

  따라서 목록을 하드코딩하면 어떤 이미지를 골라도 "설계 위반"이 된다. 필수와 선택을 나눈다.

  - **필수**: `stream`, `stream_ssl`, `stream_ssl_preread`, `http_v2`, `http_ssl`, `http_realip`
  - **선택(기능을 좁힘)**: `stream_realip`, `http_lua`, `stream_lua`

  `stream_realip` 이 없을 때 실측된 결과 (E28·E29):

  | | 없을 때 |
  |---|---|
  | 실 클라이언트 IP 읽기 | ✅ `$proxy_protocol_addr` 로 가능 |
  | 소스IP 해시 | ✅ 렌더러가 `$proxy_protocol_addr` 로 자동 대체 |
  | `$remote_addr` | ❌ 앞단 프록시 주소로 남는다 (로그·변수 영향) |
  | PROXY 체인(수신+송신) | ❌ **백엔드가 실 클라이언트 대신 프록시 주소를 받는다** |

  → 마지막 항목만 **저장 단계에서 막는다**(`proxy_protocol_chain_requires_stream_realip`).
  조용히 틀린 주소가 가는 것이 가장 나쁘다. 나머지는 대체 경로로 흡수하고 경고만 남긴다.

  > **이미지 결정은 스파이크의 하위 문제다.** S1/S5 가 실패해 대안 B(순수 nginx)로 가면
  > 공식 이미지가 `stream_realip` 을 갖고 `stream_lua` 는 필요 없어져 이 제약 자체가 사라진다.
  > OpenResty 경로가 확정되면 그때 `--with-stream_realip_module` 을 넣은 커스텀 이미지를
  > 빌드할지 결정한다. 어느 쪽이든 코드는 바뀌지 않는다.
- **기동 시 capability check**: `nginx -V` 파싱 + 최소 conf 스모크 테스트.
  결과를 `GET /status.engine_capabilities` 와 `plan.engine_capability_digest` 로 노출한다.
  digest 가 바뀌면 기존 plan 은 `PLAN_STALE(engine_capability_changed)`.
- 렌더러는 `HttpRenderer` / `StreamRenderer` 로 분리한다.

---

## 8. TLS / 인증서

### 8.1 기본

- **ACME**: `http-01`(80 포트 도달) + `dns-01`(프로바이더 드라이버).
- 갱신은 만료 30일 전 자동, 실패 시 알림. `not_after` 를 상태 API 에 노출.
- **인증서 교체는 reload 를 유발한다** → 갱신도 디바운스 큐에 태운다.
- 업로드 인증서도 1급 시민. **GUI 는 개인키를 절대 되돌려주지 않는다**(쓰기 전용).

### 8.2 ACME 수명주기

| 엔티티 | 필드 |
|---|---|
| `AcmeAccount` | `directory_url`, `contact[]`, `account_key_ref`, `tos_agreed_at`, `eab` |
| `CertificateOrder` | `certificate_id`, `status`(pending/ready/processing/valid/invalid), `expires_at`, `retry_policy`, `attempts`, `last_error` |
| `Challenge` | `order_id`, `type`, `domain`, `status`, `propagation_deadline`, `cleanup_state` |

- **와일드카드는 dns-01 만** — 모델에서 강제.
- **http-01 임시 라우트 소유권**: 시스템 소유 예약 라우트로 렌더되고 사용자가 만들거나 지울
  수 없다. 80 포트 리스너가 없으면 plan 이 막는다.
- CA 레이트 리밋 인지 + 지수 백오프. 실패 누적 시 중단 + 알림.
- dns-01 TXT 는 성공/실패와 무관하게 cleanup 보장 + 주기적 고아 스캔.

> **위 §8.2 는 규범이 아니라 후보다.** v2 는 "스파이크 후 ADR 로 미룬다"고 써놓고 상태기계를
> 규범적으로 남겨 뒀다 — 그건 미룬 게 아니다. v3 에서 명시한다: **§8.2 의 엔티티·상태·정책은
> ADR-ACME 가 확정하기 전까지 구속력이 없고, v0.1 타입 freeze 범위에 들어가지 않는다.**
> 대응 게이트는 S18(ACME 상태기계 실증)이며 v0.6 전에 실행한다.

### 8.3 시크릿 버저닝

```
material_ref = "store://prod/api-cert@7"  +  sha256:abc...
```

- `SecretStore.get(ref)` 는 **버전이 박힌 참조**만 받는다. `@latest` 금지.
- 갱신은 새 버전을 만들 뿐 기존 버전을 덮지 않는다.
- 세대 manifest 가 버전+다이제스트를 결박한다 → 롤백이 정확히 그 시점 자료를 복원한다.

### 8.4 세대·시크릿 GC — root 와 release ledger

v1 의 "refcount 0 이면 삭제, refcount 는 보존 세대 수" 는 **순환**이었다 (세대 GC 가 카운트 0 을
기다리면 마지막 참조 세대를 영원히 못 지운다). v2 는 순서를 뒤집어 순환은 없앴지만
**crash-safe 하지 않았다**:

- 디스크 삭제 후 refcount 감소 전에 죽으면 → **영구 누수**
- refcount 감소 후 완료 표시 전에 죽고 재시도하면 → **이중 감소 → 조기 삭제**

#### GC root — 지워지면 안 되는 것

| root | 이유 |
|---|---|
| `current` symlink 가 가리키는 세대 | 지금 서비스 중 |
| `published_revision` 의 세대 | 게시된 정본 |
| `serving_generations[]` 에 있는 모든 세대 | 옛 워커가 아직 쓴다 |
| 진행 중 오퍼레이션의 `target` 과 `rollback` 세대 | 아직 결과가 안 났다 |
| **committed-but-unapplied artifact** | § 5.3 — 적용 전에 사라지면 되돌릴 수단이 없다 |
| 롤백 보존 기간 안의 세대 | 되돌릴 대상 |

#### release ledger — 이중 감소를 구조로 막는다

```
1. GC 후보 = 위 root 어디에도 없음 AND 보존 개수 초과 AND 롤백 보존 경과
2. tombstone 을 **먼저 durable 하게** 쓴다.
   tombstone = { generation, secret_refs[], phase: 'pending' }
3. 디스크 삭제 → tombstone.phase = 'disk_released'
4. secret_refs 각각에 대해 release ledger 에 삽입한다.
     UNIQUE (generation, secret_version)
   → 재시도해도 두 번 감소하지 않는다. 삽입 성공한 것만 refcount 를 줄인다.
5. tombstone.phase = 'released'
6. refcount 0 + 유예(기본 7일) 경과 → 시크릿 삭제를 비동기 큐에 넣는다.
   **삭제 직전에 zero-ref 를 다시 확인한다** (그 사이 새 세대가 같은 버전을 참조했을 수 있다)
7. 시크릿 삭제 실패 → 재시도 + "시크릿 누수" 경보. **세대 GC 는 절대 막지 않는다**
```

각 단계의 크래시는 phase 를 읽어 그 지점부터 재개한다 (§ 6.2 표 #10).

---

## 9. 드라이버 인터페이스

**포크하지 않는다.** OSS 코어에 인터페이스를 두고 조직별 구현을 별도 레포로 주입한다.
라이선스: **Apache-2.0**.

### 9.1 확정 시점

각 인터페이스는 **최초 소비 버전 직전에 고정한다.**

| 인터페이스 | 확정 시점 |
|---|---|
| `DataplaneDriver` (멤버십 포함) | v0.1 이전 |
| `AuditSink` / `Notifier` / `AuthProvider` | v0.1 이전 |
| `SecretStore` / `DNSProvider` | v0.6 이전 |
| `BackendDiscovery` | v0.7 |

v0.7 은 **참조 구현 + 로딩 하드닝 + 호환성 테스트 키트**다.

### 9.2 계약

```ts
export interface ConfigSnapshot {
  revision: number;
  topology_epoch: number;
  digest: string;
  listeners: readonly Listener[];
  httpRoutes: readonly HttpRoute[];
  passthroughRoutes: readonly TlsPassthroughRoute[];
  pools: readonly UpstreamPool[];
  backends: readonly BackendSpec[];
  tlsPolicies: readonly TlsPolicy[];
  sniBindings: readonly SniCertificateBinding[];
  secrets: readonly SecretBinding[];      // store://name@version + sha256
}

export interface DataplaneCapabilities {
  engine: { name: string; version: string; modules: readonly string[]; digest: string };
  supports: {
    udp: boolean;
    sniPassthrough: boolean;
    sniOutcomeSplit: boolean;             // no_sni 와 no_match 를 구분할 수 있는가 (S9)
    upstreamProxyProtocol: { http: []; tcp: readonly ('v1')[]; udp: [] };
    runtimeMembership: { http: boolean; stream: boolean };   // §3.4 — 별개다
    nativeLeastConn: boolean;
    dnsResolve: boolean;                  // 1.27.3+ resolve (대안 B)
    forceCloseSessions: boolean;          // 드레인 강제 종료 capability
  };
}

export interface DataplaneDriver {
  capabilities(): Promise<DataplaneCapabilities>;
  render(s: ConfigSnapshot): Promise<RenderedArtifact>;
  prepare(a: RenderedArtifact, opId: string, signal: AbortSignal): Promise<PrepareResult>;
  commit(opId: string, signal: AbortSignal): Promise<CommitResult>;   // → activated 증빙 포함
  abort(opId: string): Promise<void>;
  status(opId?: string): Promise<DataplaneStatus>;   // 4-way + serving_generations[]

  // 멤버십 평면 — epoch 결박 · 서브시스템별 ACK
  pushMembershipSnapshot(
    epoch: number, rev: number, s: MembershipSnapshot
  ): Promise<MembershipAck>;             // { http: rev, stream: rev, convergedWorkers }
  pushMembershipDelta(
    epoch: number, rev: number, d: MembershipDelta
  ): Promise<MembershipAck>;             // epoch 불일치는 EpochMismatch 로 reject
}
```

**오류 분류** (`DriverError.kind`): `validation` | `capability` | `epoch_mismatch` |
`transient` | `conflict` | `permission` | `fatal`.

### 9.3 로딩 — 하드닝

- 동적 `import()` 는 **코어 재컴파일**을 없애지, **패키지 프로비저닝**을 없애지 않는다.
  컨테이너 배포에서는 여전히 이미지에 넣거나 볼륨으로 주입해야 한다. 실질 이득은
  "코어를 포크·재빌드하지 않아도 된다"까지다.
- 설정의 임의 패키지명을 로드하지 않는다. **이미지에 pin 된 allowlist** 만.
- `name + version + integrity(sha512)` 검증. `apiVersion` 불일치는 기동 실패.

---

## 10. Web GUI

- 스택: **SvelteKit** (Svelte 5 runes). 코어와 같은 TypeScript 타입 공유.
- **v0.5 는 얇은 vertical slice 로 시작한다** — Listeners / Pools & Backends(드레인) /
  Plan·Impact 3화면으로 제품 가설을 검증하고, 나머지는 뒤로 뺀다.

| 화면 | 단계 |
|---|---|
| Listeners — 포트별 목록, 소켓 충돌 경고 | v0.5 |
| Pools & Backends — 헬스 실시간(SSE), 드레인 진행률(inflight/sessions) | v0.5 |
| Plan/Impact 모달 — diff 가 아니라 **영향** | v0.5 |
| Routes — 컴파일된 매칭 순서와 그림자 경고 | v0.6 |
| Certificates — 만료 정렬, ACME 오더/챌린지 상태 | v0.6 |
| Status — 4-way + epoch + pending_apply + capability | v0.6 |
| Rendered Config (읽기 전용) / Audit | v1.0 |

- 실시간: SSE (스냅샷 + 델타, 하트비트). GUI 는 폴링하지 않는다.
- **GUI 는 changeset 위에서 편집한다.** "저장"=commit, "적용"=apply 를 시각적으로 분리한다.

---

## 11. 배포 형태

### 11.1 구성

- 컨트롤 플레인 + 데이터 플레인 **별도 컨테이너**.
- **배포 1급 경로는 컨테이너 이미지**다. `docker compose` 한 장으로 CP+DP 가 뜨는 것이 기본
  설치 경험. 바이너리 배포는 Node SEA 로 v1.0 이후 검토.
- **DP Agent 는 별도 마운트 네임스페이스의 사이드카**로 둔다. 같은 컨테이너 안에서 "Agent 만
  RW, nginx 만 RO" 는 **literal 하게 불가능하다** — 마운트의 read-only 속성은 프로세스가
  아니라 네임스페이스 단위다. 사이드카가 불가능한 배포에서는 **UID·디렉토리 소유권·ACL**
  로 경계를 세우고, 그 차이를 문서에 명시한다.
- CP ↔ DP Agent 는 **mTLS gRPC**. 멤버십 admin 소켓은 DP 네임스페이스 내부 전용.

### 11.2 상태 저장소

**v0 는 PostgreSQL 하나만.** 격리 수준, advisory lock, 제약 표현, 마이그레이션, JSON 처리,
크래시 시맨틱이 달라 리더 선출과 그래프 스냅샷 구현이 갈린다. SQLite 는 **동일한 불변식
테스트 스위트 통과**를 완료 조건으로 하는 별도 과제.

### 11.3 동적 포트 노출

`:999`, `:888` 같은 임의 포트를 Kubernetes 에서 노출하려면 hostNetwork / hostPort /
LoadBalancer 중 하나를 골라야 하고 셋 다 제약이 있다(예: Cilium 의 `nodeport-addresses` 가
HostPort 바인딩까지 함께 제한하는 사례). → **v1 권장 배포는 전용 VM + hostNetwork**.
k8s 네이티브 배포는 별도 과제.

### 11.4 SPOF 운영 계약

| 항목 | v1 목표 (ADR 로 확정) |
|---|---|
| RTO (DP 호스트 손실 → 서비스 복구) | **≤ 15분** (수동 페일오버 기준) |
| RPO (설정 손실) | **0** — 설정 정본은 PG, 아티팩트는 재생성 가능 |
| PG 손실 시 RPO | **≤ 5분** (PITR/스트리밍 복제 기준) |
| 콜드 스탠바이 | 두 번째 DP 호스트에 동일 세대 아티팩트 사전 배치 |
| 페일오버 | DNS 또는 상위 L4(외부 VIP/keepalived) 전환. **자동 아님** |
| 포트 탈취 방지 | 스탠바이 동시 bind 금지 fencing 절차 |
| 백업/복구 | `bary export` + PG 덤프 + SecretStore 백업 3종 + **분기별 복구 리허설** |
| 리소스 알람 | `serving_generations` 수, FD, 메모리, UDP 세션, conntrack |

> **위 표는 규범이 아니라 목표 후보다.** ADR-SPOF 가 확정하기 전까지 구속력이 없다.
> 근거 없는 숫자를 계약처럼 적어 두면 검증되지 않은 채 굳는다. 페일오버·복구 리허설의
> 합격 조건과 함께 v1.0 전에 확정한다.

---

## 12. 로드맵

### 12.0 v0.0 — 아키텍처 스파이크 (착수 게이트)

**전부 버릴 코드다.** 각 항목에 **결과별 결정**이 붙어 있어야 게이트다. 수치 기준 없는 실험은
게이트가 아니다.

| # | 검증 | 합격 기준 (초기값, 스파이크에서 확정) | 실패 시 |
|---|---|---|---|
| S1 ✅ | Lua 동적 peer 변경 (HTTP·TCP·**UDP**) | 세 서브시스템 전부 reload 없이 전환 | → **대안 B** |
| S2 | 드레인 관측 | HTTP/1·HTTP/2·TCP·UDP 각각에서 peer 별 inflight·세션 관측 가능 | 기능 축소: `no_new_traffic` 만 |
| S3 | 인스턴스 재시작 부트스트랩 | 재시딩까지 공백 < 1s, 오래된 헬스 되살아남 없음 | 기능 축소: 부팅 시 전 백엔드 `unknown` |
| S4 | CP 단절 | fail-open 유지, eviction 시 zero-peer 없음 | fail_closed 기본화 |
| S5 ~ | **이중 zone + 워커 수렴 + 평면 부분 전환** | 양쪽 ACK 후 전 워커 수렴 < 500ms **AND** 한쪽 평면 실패·ACK 유실·늦은 RPC·리더 교체·옛 HTTP/2 워커 잔존에서 잘못된 peer 선택 0회 | → 대안 B (구조 불성립) |
| S6 | `least_conn` 근사 오차 | 균등 부하에서 편차 < 10% | v0 알고리즘에서 제외 |
| S7 ✅ | reload 실패 판정 | 포트 점유 상태 HUP 재현 + 오탐/미탐 0, 판정 시간 < 3s | 판정 절차 재설계 (ApplyOperation freeze 에는 block) |
| S8 | 인증서 세대 롤백 | 갱신 후 롤백 시 옛 key/chain 정확 복원 | 설계 재작업 (block) |
| S9 | SNI 결과 3분기 관측성 | TLS-no-SNI / malformed / preread timeout 구분 가능 여부 (**비-TLS 는 E26.1 로 이미 확인**) | 현행 유지 — 부재·파싱실패는 계속 `reject` 고정 |
| S10 | 라우트 컴파일러 | exact/wildcard/path 우선순위 + 라우트 500개 p99 영향 < 5% | `strict_priority` 모드 미제공 |
| S11 | **activation_epoch 경합** | ① 롤백 후 옛 epoch RPC 거부 ② 스냅샷 cut 이후 델타 미유실 ③ staging 전 accept 시작 없음 ④ 다중 serving epoch 공존 ⑤ 옛 리더 토큰 거부 — 전부 잘못된 peer 선택 0회 | 설계 재작업 (block) |
| S12 | 크래시 저널 | §6.2 표의 **11개 지점** 전부(모든 durable write·외부 side-effect 직전/직후)에서 복구 정확. HUP 재전송이 워커 세대를 늘리지 않는지 포함 | 설계 재작업 (block) |
| S13 | 마커·워커 레지스트리·GC | 옛 워커 잔존 중 오삭제 0회 + §8.4 GC 각 단계 크래시에서 **누수·이중감소 0회** + GC root 누락 0회 | GC 보수화 |
| S14 | **대안 B 실증** | HTTP/TCP/UDP × A/AAAA/SRV × TTL/NXDOMAIN/timeout, 기존 세션 거동 | 폴백 자체가 없음 → 요구 재조정 |
| S15 | 밸런서 품질 | RR 공정성 편차 < 5%, hash 재매핑률, 재시도·failure penalty 동작, CPU/p99 오버헤드 < 10% | 알고리즘 축소 |
| S16 | SNI 별 TLS policy 렌더 | 비-default server 별 `ssl_protocols` 가 **실제 handshake 에 적용**되는가 | `override` 제거 |
| S17 | TLS 인증서 선택 렌더 | exact / 1라벨 와일드카드 / `default_server` 조합에서 SAN 미커버 인증서 제시 0회 | v0 은 exact host 만 |
| S18 | ACME 상태기계 | 오더·챌린지·재시도·고아 TXT 정리 (v0.6 전) | ACME 범위 축소 |

**S8·S11·S12 실패는 프로젝트 block 이다** (설계를 다시 해야 한다). 나머지는 기능 축소 또는
대안 B 로 흡수된다. **S7 은 프로젝트 block 은 아니지만 ApplyOperation 스키마 freeze 에는
block 이다** — 활성화를 판정하지 못하면 상태기계를 고정할 수 없다.

**실행 결과 (2026-08-11).** `./spike/s1-s5/run.sh` → 8 PASS / 0 FAIL.

- **S1 통과.** HTTP·TCP·UDP 세 서브시스템 전부에서 reload 없이 백엔드가 바뀌고, 전환 후
  첫 요청·첫 연결·첫 세션부터 반영된다. reload 0회, 마스터 PID 불변.
  → **OpenResty 멤버십 평면 경로가 성립한다.** 대안 B 는 폴백으로만 남는다.
- **S5 부분 통과.** 이중 zone 확정(§3.4 재확인), 워커 4개 수렴 15–23ms.
  아직 검증 안 된 것: 한쪽 평면 실패, ACK 유실, 늦은 RPC, 리더 교체, 옛 HTTP/2 워커 잔존.
- **부수 발견.** `balancer_by_lua` 는 연결마다 dict 를 읽으므로, 리비전 검사를 곁들이면
  워커 로컬 캐시가 스테일 창을 만들지 않는다(전환 직후 30/30 정확). 3차 검수의 "워커
  수렴" 우려는 *트래픽*이 아니라 *관측*의 문제로 좁혀진다. 캐시에 리비전 검사를 빼면
  그때 위험이 생긴다.

**S11 실행 결과 (2026-08-11).** `./spike/s11/run.sh` → 14 PASS / 0 FAIL.

- **P1 통과 — ABA 가 실제로 막힌다.** 롤백을 새 `activation_epoch` 로 활성화한 뒤 지연된
  옛 epoch 의 `stage`/`activate` 를 던졌더니 둘 다 409 로 거부됐고 트래픽은 오염되지 않았다.
  *v2 설계였다면 롤백이 E1 을 재활성화하므로 그 델타가 먹었다.*
- **P7 통과.** 미staging epoch 은 활성화할 수 없고(admin), 슬롯 없는 세대로 HUP 하면
  **503 으로 실패**한다 — 조용히 옛 peer 로 흘러가지 않는다(dataplane).
- **P15 통과.** 더 낮은 `leader_token` 은 거부되고, 한 번 높은 토큰을 본 뒤에는 옛 리더의
  요청이 전부 막힌다. 그 와중에도 활성 세대의 트래픽은 흔들리지 않았다.
- **P8 — 3차 검수의 전제를 교정했다.** 위 §6.5 주석 참조.

**남은 S11 범위**: 평면 부분 전환(P5·P6)과 스냅샷 cut→replay(P3)는 컨트롤 플레인 프로토콜
로직이라 엔진 스파이크로 덮이지 않는다. S5 잔여 항목과 함께 프로토콜 구현 단계에서 검증한다.

**S7 실행 결과 (2026-08-11).** `./spike/s7/run.sh` → 9 PASS / 0 FAIL.

- **오탐/미탐 0.** 정상 HUP 은 74ms 에 성공, 포트 점유 HUP 은 71ms 에 실패로 판정한다.
  점유를 풀고 재시도하면 8ms 에 활성화된다.
- **판정에는 음성 신호가 필요하다.** 워커 레지스트리만 쓰면 실패 판정이 타임아웃을 다 써
  4,027ms 가 걸렸다. error log 워터마크를 함께 보면 71ms 다 (§6.3).
- **A4.3 확인.** shared dict 마커는 "누가 응답했는가"를 말해주지 못한다 — in-flight 요청을
  gen1 워커가 처리하는 동안 마커는 이미 `2` 였다. 세대별 렌더 리터럴이어야 한다.
- → **ApplyOperation 스키마를 고정할 수 있다.** S7 은 더 이상 freeze block 이 아니다.

### 12.1 이후 단계

| 단계 | 내용 | 완료 판정 |
|---|---|---|
| **v0.1** 골격 | 타입 모델(판별 유니온) + PG + `ConfigRevision`/`topology_epoch`/changeset sealing + ApplyOperation + DP Agent + conf AST 렌더러 + 최소 auth/audit + `DataplaneDriver` 계약 확정 | `curl` 로 `:999→A:11` 이 뜨고, 모순 조합은 저장이 거부되며, AST 퍼즈 테스트와 §6.2 크래시 표가 통과한다 |
| **v0.2** L4 | 풀/백엔드, LB 알고리즘, UDP 프로파일, SNI 패스스루 + 폴백, 소켓 겹침 검증기, 라우트 컴파일러(축소 계약) | SNI 로 두 백엔드가 갈리고, http 443 ↔ stream 443 중복이 저장 단계에서 막힌다 |
| **v0.3** 멤버십 | 이중 zone 멤버십 평면 + epoch 결박 + 헬스 프로버 + 드레인 관측 | 백엔드 down 시 reload 없이 격리되고, apply 중 헬스 변화가 경합하지 않는다 (S11 시나리오 회귀 테스트) |
| **v0.4** CLI | `bary` 전 리소스 + changeset/plan/commit/apply + 트랜잭셔널 export/import | GUI 없이 전부 가능. 같은 매니페스트를 두 번 import 해도 결과가 같다 |
| **v0.5** GUI slice | Listeners / Pools·Backends / Plan·Impact 3화면 + SSE | 클릭만으로 v0.3 시나리오 재현 |
| **v0.6** TLS | `SecretStore`/`DNSProvider` 확정 → ACME 상태기계, 업로드, 자동 갱신, 세대 결박 롤백 + GUI 잔여 화면 | 무중단 갱신 관측 + 갱신 후 롤백 시 옛 인증서 복원 |
| **v0.7** 드라이버 | 참조 구현 + 로딩 하드닝 + 호환성 테스트 키트 + `BackendDiscovery` | 사내 레포가 코어 수정 없이 빌드·로드 |
| **v1.0** | 전체 RBAC, 백업/복구 리허설, SPOF 런북, 문서 | RTO/RPO 리허설 합격 |

**순서 근거**: v0.1 완료 판정이 `:999→A:11` 이므로 풀/백엔드가 v0.1 에 있어야 한다.
CLI/GUI 가 드레인을 노출하려면 멤버십이 먼저(v0.3)여야 한다. ACME 가 `SecretStore`/
`DNSProvider` 를 소비하므로 계약이 먼저다. API 가 인증/감사를 요구하므로 v0.1 부터 최소
형태로 존재해야 한다. **GUI 는 맨 뒤로 미루지 않는다** — 제품 명제가 GUI 이므로 얇은
slice 로 v0.5 에서 검증한다.

---

## 13. 미결정 사항

1. **구현 언어** — ✅ **Node.js + TypeScript** (2026-08-11). 런타임은 Node. GUI 는 SvelteKit.
   ⚠️ Go 대비 단일 바이너리 배포를 잃는다 → §11.1 컨테이너로 보완. 얻는 것은 §9.3 범위까지.
2. **OpenResty 도입 시점** — ✅ 스파이크(S1·S5) 통과 시 **v0.3**, 계약은 **v0.1** 고정.
3. **프로젝트명** — ✅ `barycenter`.
4. **레포 위치** — ✅ 공개 정본 `mack-erel/barycenter` (Apache-2.0), 사내 드라이버는 별도
   비공개 레포에서 npm 의존. 포크하지 않는다.
5. **v1 에서 멀티 인스턴스 제외** — 유지. SPOF 는 §1·§11.4 에 명시.
6. **UDP 헬스체크 정의** — `probe.protocol=udp_payload` 를 프로토콜별 드라이버로 뺀다
   (DNS 는 질의/응답, WireGuard 는 핸드셰이크 개시). 정의 불가면 `probe.mode=none` 강제.
7. **`least_conn` 을 v1 계약에 넣을 것인가** — S6 결과에 따름. 현재 기본 알고리즘에서 제외.
8. **SNI 결과 분기 수** — S9 결과에 따름. 현재 2분할.
9. **`strict_priority` 제공 여부** — S10 결과에 따름. 현재 옵트인 예정.
10. **ECH 대응** — outer public_name 라우팅으로 축소됨을 문서화. 별도 대응 없음.

---

## 14. 리스크

1. **스파이크 실패** — 최대 기술 리스크. S8/S11/S12 는 프로젝트 block, S1/S5 는 대안 B 강등.
2. **epoch 경합 버그** — 설계상 가장 미묘한 부분이고, 틀리면 **죽은 백엔드로 트래픽이 간다.**
   → §3.3 규칙 + S11 회귀 테스트.
3. **reload 폭풍** — §6.1 경로 분리 + §6.4 admission control.
4. **L4 LB 는 L7 보다 운영 난이도가 높다** — GUI 로 감싸면 실수 표면이 넓어진다.
   → `plan` 의 impact + 불가능 조합 사전 차단.
5. **설정 인젝션** — §4.9 타입 AST + 화이트리스트 + 퍼즈 테스트.
6. **SSRF / 내부 스캔** — 백엔드 `host` 와 액티브 프로브는 임의 내부 목적지 연결 통로다.
   → 목적지 CIDR/DNS 정책, egress 제한, DNS rebinding 재검증, 프로브 전용 네트워크 정책.
7. **공급망** — §9.3 allowlist + integrity + `apiVersion`. 시크릿 볼륨 권한 경계는 §11.1.
8. **SPOF 와 자원 고갈** — §11.4 + §6.4.
9. **경쟁 갭이 닫힐 수 있다** — §2.3.
10. **스코프 크리프** — §1 비목적.
11. **복잡도** — epoch·changeset sealing·이중 zone·크래시 표는 전부 정당하지만, v0.1 을 못
    내면 무의미하다. → §12.1 v0.1 완료 판정을 좁게 유지하고, §15.3 축소 목록을 되돌리지 않는다.

---

## 15. 검수 대응

### 15.1 1차 반박(R1~R7)의 2차 재판정

| | 1차 지적 | v1 의 반박 | **2차 재판정 → v2 처리** |
|---|---|---|---|
| R1 | 해자 주장 성립 안 함 | "명제는 갭이지 기능 목록이 아니다" | **반박 철회.** 1차는 실제로 "작은 write-GUI L4 CP" 포지셔닝을 제안했고, 느슨한 명제에는 Roxy-WI·OpenManager·Zoraxy 반례가 있다 → §2.1 을 좁힌 명제로 교체 |
| R2 | 숫자 priority 구현 불가 | "정규식 등장 순서로 가능" | **양쪽 부분.** 사실은 맞으나 v1 의 §7.5 도 exact-low·path·HTTPS cert 를 못 다뤘다 → §7.5 를 **축소 계약**으로 교체 |
| R3 | OpenResty 필수 | "1.27.3 `resolve` 대안 있음" | **양쪽 부분.** 대안 B 로는 성립하나 일반 멤버십의 대체재가 아니다 → §7.3 에 범위표 추가, S14 신설 |
| R4 | 멤버십 구조를 먼저 | "계약 v0.1 / 구현 v0.3" | **양쪽 부분.** 일정 분리는 타당하나 v1 의 `pushMembership` 계약이 너무 얇았다 → §9.2 에 epoch·서브시스템별 ACK·수렴 추가 |
| R5 | GUI 를 뒤로 | "제품 명제가 GUI 다" | **반박 타당.** 1차가 순서 제안 철회. 단 v0.5 는 8화면이 아니라 **3화면 slice** → §10 |
| R6 | 409 → 412 | "412/428/409 3분할" | **양쪽 부분.** 의미 불가능 입력은 422 여야 하고, changeset 커밋 전제조건은 `If-Match` 로 표현할 수 없다 → §5.1 4분할 + `config/head` |
| R7 | 총평 No-Go | "범주 오류" | **반박 철회.** 1차 결론은 이미 "구현 No-Go / 스파이크 Go"였다. 내가 없는 오류를 만들어 반박했다 |

### 15.2 사실관계 교정 누적

| 위치 | 이전 서술 | 교정 | 출처 |
|---|---|---|---|
| §4.3 | HTTP 풀에 `send_proxy_protocol=v1` 허용 | **HTTP 업스트림에는 PROXY 송신 디렉티브 자체가 없다** | `ngx_http_proxy_module` 확인 |
| §4.1 | "ECH 와 SNI 패스스루는 원리적으로 공존 불가" | ClientHelloOuter 의 `public_name` 은 남는다. **inner-origin 라우팅만 불가** | RFC 9849 |
| §6.5 | "shared dict 는 master 종료 시 소멸" | HUP 엔 유지, **nginx 인스턴스 전체 종료 후 재시작 시** 소멸 | lua-nginx-module |
| §4.0 | 조합 제약을 "DB CHECK 로 강제" | PostgreSQL `CHECK` 는 **다른 행/테이블 참조 불가** → 복합 FK·트리거·검증기 | PostgreSQL 문서 |
| §3.2 | 단일 admin 소켓 + 단일 shared dict | **http/stream 은 별개 zone**, 밸런서는 worker-local → 이중 구조 (S5) | §3.4 |
| §7.5 | 와일드카드 정규식화로 전역 priority 구현 | 클래스 우선순위가 등장 순서보다 앞선다. path·HTTPS cert 미해결 | ngx map / server_names |
| §6.3 | 마커 1회 조회로 활성화 판정 | 다중 워커 공존. `accepting`/`serving_generations` 분리 | — |
| §8.4 | refcount 0 후 세대 GC | **순환.** tombstone 먼저, 시크릿 GC 는 비차단 | — |
| §4.4 | 드레인에 HTTP/2 GOAWAY | 계층 오류. peer 별 업스트림 inflight 가 맞다 | — |
| §7.1 | SNI map 에 `~` (대소문자 구분) | DNS/SNI 는 대소문자 무시 → `~*` | — |
| §6.2 | `reload_accepted` | 관측 불가능한 상태명 → `reload_signaled` + `activated` | — |
| §11.1 | 같은 컨테이너에서 nginx 만 RO 마운트 | 마운트 RO 는 네임스페이스 단위 → 사이드카 또는 UID/ACL | — |
| §4.3 | `source_ip_hash` 가 http/stream 동일 | 동일 분배·재매핑을 보장하지 않는다 | — |
| (1차분) | `$connection_upgrade`, stream `ip_hash`, `proxy_responses` 의미, `worker_shutdown_timeout`, APISIX/Nginx UI, `resolve` 1.27.3+ | 전부 §7·§2 에 반영 완료 | — |

### 15.3 v2 에서 **축소한** 것 (과설계 지적 수용)

문서를 키우는 방향의 반영만 하면 v0.1 을 못 낸다. 다음은 의도적으로 뺐다.

| 항목 | v1 | v2 |
|---|---|---|
| 전역 숫자 priority | nginx 우선순위 위에 완전 재현 | **매치 클래스 안에서만.** `strict_priority` 는 S10 통과 시 옵트인 |
| `least_conn` | 기본 알고리즘 + "근사 명시" | **v0 기본에서 제외.** S6 결과에 따름 |
| 드레인 | GOAWAY + `force_close` 약속 | **관측 + 새 트래픽 차단까지.** 강제 종료는 capability |
| SNI 결과 분기 | 3분할 확정 | **2분할.** 3분할은 S9 통과 시 |
| ACME / 콜드 스탠바이 | v1 문서에서 계약 확정 | **스파이크 후 ADR** 로 미룸 |
| GUI | v0.5 에 8화면 | **3화면 slice**, 나머지 v0.6/v1.0 |

**반대로 축소하지 않은 것** (2차 검수도 "안전성의 최소 구조"로 인정): immutable generation,
DP 단일 writer, graph changeset, config↔membership epoch fencing.

### 15.4 3차 검수 blocking 9건 — v3 처리

S1 이 통과해 OpenResty 멤버십 평면이 확정됐으므로, "대안 B 로 가면 사라질 항목"은 없다.
전부 설계 대상이다.

| # | 지적 | v3 처리 |
|---|---|---|
| 1 | 롤백에도 새 값을 쓰는 monotonic fencing + DP leader token | **§3.3** `topology_version`(내용) 과 `activation_epoch`(활성화 사건, 엄격 단조) 분리. 롤백은 옛 topology 를 **새 epoch 로** 활성화한다 → ABA 소멸. **§3.5** DP Agent 가 leader token 을 durable 보관하고 낮은 토큰을 전부 거부 |
| 2 | desired/published/accepting/serving 좌표 분리, 다중 serving epoch | **§3.3** 좌표표 · **§3.4** 평면별 리비전 벡터 · **§6.5-5** E-old 슬롯을 서빙 워커가 사라질 때까지 유지 |
| 3 | E-new 스냅샷 staging / cut / abort·replay | **§6.5** HUP **전** staging, high-water mark 로 cut, 활성화 직후 그 이후 이벤트 **replay**(버리지 않는다), abort 시 기존 epoch 복귀 |
| 4 | http/stream partial-transition + stale RPC 차단 | **§3.4** `plane_state` · `transition_id` · `partial_transition` · `max_convergence_ms`. 교차 평면 동시 전환을 **보장하지 않는다고 명시** |
| 5 | plan→commit→apply 단회 lifecycle, revision/epoch 예약, artifact pinning | **§5.3** plan 상태기계. commit 에서 revision·epoch 예약, `(plan_id → operation_id)` unique, committed artifact 는 TTL 면제, `superseded` 도입 |
| 6 | 모든 side-effect 직전/직후 크래시 저널 + cancel | **§6.2** `*_intent`/결과 분리, 11행 표, HUP 재전송이 멱등이 아님을 명시, `cancelled` 상태 |
| 7 | crash-safe GC root / release ledger | **§8.4** GC root 표(committed-but-unapplied 포함) + `UNIQUE(generation, secret_version)` release ledger + 삭제 직전 zero-ref 재확인 |
| 8 | TLS 렌더 스파이크 | **S16 · S17** 신설. `CipherPolicyRef` 도입, `cipher_preset: custom` 제거 |
| 9 | S1/S5 실패 시 제품 결정 | **S1 통과로 해소.** 대안 B 는 폴백. §7.3 범위표 유지 |

**함께 반영한 3차 High/Medium**: 멤버십 리듀서 단일화(§6.6) · 의도적 zero-peer 와 갱신 실패
구분(§6.7) · 평면·epoch 별 durable 스냅샷(§6.7) · `tls_passthrough` 풀의 `upstream_tls` 금지 ·
`redirect_http_to_https` 제거 · `sniOutcomeModel` enum · GUI 동등성을 v1.0 한정.

### 15.5 v3 에서 **문구가 아니라 코드까지** 축소한 것

v2 의 §15.3 은 축소를 선언했지만 스키마와 본문에는 그대로 남아 있었다. 3차 검수가 "축소가
문구에만 머물렀다"고 지적한 부분이다. v3 은 실제로 뺐다.

| 항목 | v2 (선언) | v3 (실제) |
|---|---|---|
| `least_conn` | "v0 기본에서 제외" 라고 쓰고 enum 에 남김 | **enum 에서 제거.** `src/model/provisional.ts` 의 `Algorithm` 에 없다 |
| ACME 상태기계 | "ADR 로 미룸" 이라 쓰고 §8.2 를 규범으로 남김 | **구속력 없음을 명시**, v0.1 freeze 범위에서 제외, S18 신설 |
| RTO/RPO | "ADR 에서 확정" 이라 쓰고 수치를 표로 남김 | **목표 후보임을 명시.** ADR-SPOF 전까지 구속력 없음 |
| SNI 분기 | 2분할이되 `on_no_sni` 를 설정 가능하게 둠 | **`on_unmatched_sni` 하나만 설정 가능.** 부재·파싱실패는 `reject` 고정. 렌더도 map 하나 |

### 15.6 3차 검수가 옳았던 것 — R8 재판정 수용

v2 의 §15.4 는 "`on_no_sni` 를 합치면 보안 결함" 이라고 주장했다. 3차 재판정이 정확히 갈랐다:
**합치는 것 자체가 문제가 아니라, SNI 부재·파싱 실패를 설정 가능한 폴백 풀로 보내는 것이
문제다.** 합친 동작이 `reject` 고정이면 결함이 아니다.

더 아픈 지적은 이것이다 — **v2 의 렌더 예시는 자기가 주장한 정책을 구현하지도 못했다.**
map 에 빈 문자열 분기가 없어 no-SNI 와 unmatched 가 같은 `default` 로 갔다. 주장과 산출물이
반대였다.

v3 은 계약을 `on_unmatched_sni` 하나로 좁히고, **렌더와 테스트로 강제**한다
(`tests/unit/render.test.ts` R8/R9, 골든 R17).

---

## 참고

- [NGINX TCP/UDP Load Balancing](https://docs.nginx.com/nginx/admin-guide/load-balancer/tcp-udp-load-balancer/)
- [ngx_stream_proxy_module](https://nginx.org/en/docs/stream/ngx_stream_proxy_module.html) ·
  [ngx_stream_ssl_preread_module](https://nginx.org/en/docs/stream/ngx_stream_ssl_preread_module.html) ·
  [ngx_stream_upstream_module](https://nginx.org/en/docs/stream/ngx_stream_upstream_module.html) ·
  [ngx_stream_realip_module](https://nginx.org/en/docs/stream/ngx_stream_realip_module.html)
- [ngx_http_proxy_module](https://nginx.org/en/docs/http/ngx_http_proxy_module.html) (업스트림 PROXY 디렉티브 부재) ·
  [ngx_http_upstream_module](https://nginx.org/en/docs/http/ngx_http_upstream_module.html)
- [ngx_stream_map_module](https://nginx.org/en/docs/stream/ngx_stream_map_module.html) ·
  [ngx_http_map_module](https://nginx.org/en/docs/http/ngx_http_map_module.html) (매칭 순서) ·
  [server_names 최적화](https://nginx.org/en/docs/http/server_names.html#optimization) ·
  [request processing](https://nginx.org/en/docs/http/request_processing.html)
- [WebSocket proxying](https://nginx.org/en/docs/http/websocket.html) ·
  [`http2` 디렉티브](https://nginx.org/en/docs/http/ngx_http_v2_module.html#http2)
- [nginx 제어 신호](https://nginx.org/en/docs/control.html) · [명령행 스위치](https://nginx.org/en/docs/switches.html) ·
  [`worker_shutdown_timeout`](https://nginx.org/en/docs/ngx_core_module.html#worker_shutdown_timeout)
- [OpenResty stream-lua](https://github.com/openresty/stream-lua-nginx-module) ·
  [`ngx.balancer`](https://github.com/openresty/lua-resty-core/blob/master/lib/ngx/balancer.md) ·
  [lua-resty-balancer](https://github.com/openresty/lua-resty-balancer) ·
  [`lua_shared_dict` 수명](https://github.com/openresty/lua-nginx-module#lua_shared_dict)
- [nginx#1061 — UDP PROXY protocol 미지원](https://github.com/nginx/nginx/issues/1061) ·
  [PR #992 — 업스트림 PROXY v2 (미병합)](https://github.com/nginx/nginx/pull/992)
- [NPM issue #4119](https://github.com/NginxProxyManager/nginx-proxy-manager/issues/4119) ·
  [NPM stream 템플릿](https://github.com/NginxProxyManager/nginx-proxy-manager/blob/develop/backend/templates/stream.conf)
- [Traefik TCP 서비스](https://doc.traefik.io/traefik/reference/routing-configuration/tcp/service/) ·
  [Traefik TLS 패스스루](https://doc.traefik.io/traefik/reference/routing-configuration/tcp/tls/)
- [Caddy Admin API](https://caddyserver.com/docs/api) · [Caddy L4](https://caddyserver.com/docs/modules/layer4)
- [HAProxy Data Plane API](https://www.haproxy.com/documentation/haproxy-data-plane-api/) ·
  [HAProxy Enterprise UDP](https://www.haproxy.com/documentation/haproxy-enterprise/enterprise-modules/udp-load-balancing/overview/) ·
  [Roxy-WI](https://roxy-wi.org/) · [HAProxy OpenManager](https://github.com/taylanbakircioglu/haproxy-openmanager)
- [APISIX 배포 모드](https://apisix.apache.org/docs/apisix/deployment-modes/) ·
  [APISIX Dashboard](https://apisix.apache.org/docs/apisix/dashboard/) ·
  [Nginx UI](https://github.com/0xJacky/nginx-ui) · [Zoraxy](https://github.com/tobychui/zoraxy)
- [PostgreSQL CHECK 제약의 한계](https://www.postgresql.org/docs/current/ddl-constraints.html#DDL-CONSTRAINTS-CHECK-CONSTRAINTS)
- [RFC 9110 §13 조건부 요청 · 409 · 422](https://www.rfc-editor.org/rfc/rfc9110) ·
  [RFC 6585 §3 (428)](https://www.rfc-editor.org/rfc/rfc6585#section-3)
- [RFC 9849 — Encrypted Client Hello](https://datatracker.ietf.org/doc/rfc9849/)

# barycenter — 설계 문서 (v5)

> nginx 를 실행 엔진으로 쓰는 **HTTP / TCP / UDP 리버스프록시·로드밸런서 컨트롤 플레인**.
> GUI · API · CLI 어디서든 같은 일을 할 수 있고, 설정은 파일이 아니라 **모델**이다.
>
> 작명 — 무게중심(barycenter): 두 천체가 서로를 도는 **공통 질량중심**. 다체 시스템이 실제로 공전하는 균형점이 로드밸런싱의 은유. CLI 는 `bary`.

> **개정 이력.** v0 초안 → 검수 1차(C4/H15/M6/L3) → v1 → 검수 2차(반박 재판정 + C2/H9/M5/L2)
> → v2 → 검수 3차(blocking 9건 + High/Medium) → v3 → 검수 4차(거짓 신호 제거 + 좌표 분리)
> → v4 → **검수 5차(반례 7건 재현 → v0.1 surface 축소, §9.1.1)** → **현재 v5**. 근거와 철회한 반박은 **§15**.
>
> **v4 (2026-08-12) — 4차 검수의 설계 Critical 4건을 확정했다.**
> ① **§3.6 operation tuple** — epoch 하나로는 "허가된 operation" 을 증명하지 못한다.
> 취소된 미래 epoch, 같은 epoch payload 교체, 리더 교체가 전부 통과했다. 튜플 전체를 싣고
> **검사와 적용을 하나의 임계구역**으로 묶는다. ② **§6.5 커밋 순서 커서** — PG `nextval` 은
> 커밋 순서와 달라서 cut 이 이벤트를 영구 누락시킨다. 잠금 행으로 연속 커서를 발급하고
> 스냅샷과 HWM 을 같은 스냅샷에서 읽는다. abort 는 버퍼를 옮기지 않는다. ③ **§6.6 헬스 관측
> ABA** — 먼저 시작한 프로브가 늦게 끝나면 낡은 결과가 최신을 덮는다. `probe_incarnation` ·
> `probe_start_seq` · `resolved_endpoint_digest` 로 CAS 한다. ④ **§8.4 참조 테이블** —
> refcount 를 파생값으로 두면 crash 에서 이중 감소·누락이 생긴다. 불변
> `generation_secret_ref` 를 정본으로 하고 시크릿에 `live→delete_pending→deleted` 를 둔다.
>
> 함께: 롤백은 head 를 뒤로 옮기지 않고 `rollback_of` 를 붙인 **새 리비전**을 만든다 ·
> **HUP exactly-once 를 포기**하고 bounded duplicate 를 허용한다 · 무엇이 새 epoch 를 쓰는지
> 분류기로 고정한다 · 세대는 디렉토리 rename 으로 **통째로** 게시한다 · 드라이버 계약에
> 좌표를 전파하고 큰 수는 decimal string 으로 다룬다 · **S19**(롤백 경로 합성) 신설.
>
> **⚠️ 4차 검수 (2026-08-12) — 스파이크 결론을 되돌린다.**
> 외부 검수가 **S11 하네스에서 동시성 결함을 재현했다.** `/stage` 가 토큰을 검사한 뒤
> `read_body()` 에서 yield 하고, 재개 후 재검사 없이 슬롯을 쓴다. 그 사이 더 높은 토큰이
> 완주하면 낮은 토큰의 쓰기가 살아남아 **트래픽이 오염된다.** 직접 재현했다 —
> `rejected_token=0`, 트래픽 `EVIL_PEER`.
> **S11 은 게이트 FAIL 이고 "리더 펜싱이 성립한다"는 결론을 철회한다.** 순차 하네스로
> 동시성 안전을 주장한 것이 오류였다.
>
> **함께 고친 구현 Critical 3건** (4차 C 절):
> ① 잘못된 `bind` 가 와일드카드로 확대되던 것 → `validateModel` 을 통과한 모델만 렌더한다
> (fail closed). ② `protocol: 'https'` 가 평문 `listen 443;` 으로 렌더되던 것 → **타입에서
> `https` 를 제거했다.** 렌더러가 TLS 종단을 못 내는데 타입으로 제공하면 거짓말이 된다.
> S16·S17 통과와 실제 TLS 렌더러가 생긴 뒤에 되살린다. ③ `default_server` 부재로 모르는
> Host 가 첫 테넌트로 들어가던 것 → 리스너마다 명시적 `default_server` 를 내고 기본은 `444`.
>
> 함께 실측으로 뒤집힌 것: `ipv6only` 기본값은 **`on`** (E30, `[::]` 와 `0.0.0.0` 은 공존),
> location 은 선언 순서가 아니라 **longest-prefix** (E31), `default_server` 가 없으면 모르는
> Host 가 **첫 번째 server 로 들어간다** (E32). 앞의 둘은 코드와 테스트가 틀린 사실을
> 고정하고 있었고, v3 에서 고쳤다.
>
> **현재 판정**
> - **S1** — `balancer_by_lua` 로 HTTP·TCP·UDP 전부 reload 없이 peer 를 바꿀 수 있다는
>   **primitive 만** 확인됐다. 가중치·재시도·failure penalty·drain·DNS 는 없는 구현이었다.
>   "멤버십 평면이 성립했다"는 S5 잔여·헬스·드레인·S15 까지 보류한다.
> - **S7** — 로그 행 수를 정본 신호로 썼다. 로테이션·stdout·무관 `emerg` 에 취약하므로
>   **error log 는 진단용 보조 신호로 강등**하고 판정 계약을 다시 써야 한다. nginx 는 HUP 에
>   동기 ACK 를 주지 않는다.
> - **S8** — CN 만 비교했다. key/SPKI·chain 바이트·SNI 별 자료는 미검증이다.
> - **S11** — **게이트 FAIL** (위 4차 검수 참조).
> - **v0.1 타입·API·DB 스키마 freeze: No-Go.** "S12 만 남았다"는 판정을 **철회한다.**
>   §12.0 의 게이트 표를 볼 것.
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

1. **`activation_epoch` 는 절대 재사용하지 않는다.** 롤백은 "E10 으로 되돌아가는" 것이 아니라
   **옛 topology 를 새 `E12` 로 활성화하는 것**이다. `topology_version` 은 E10 시절 값으로
   돌아가지만 epoch 는 앞으로만 간다. 지연된 `(E10, …)` RPC 는 자동으로 무효가 된다.
2. `topology_version` 이 같으면 멤버십 식별 공간이 같다는 뜻이므로, **헬스를 재투영할 수 있다.**
   epoch 가 달라도 상관없다. 이게 "롤백 후 최신 헬스 유지"를 안전하게 만드는 근거다.
3. 백엔드 UUID 는 **영구 재사용 금지.**

> **롤백은 옛 세대를 다시 게시하는 것이 아니다.** 세대에는 `activation_epoch` 가 구워져
> 있으므로(§6.5), 옛 바이트를 그대로 재활성화하면 epoch 가 재사용된다. 롤백은 옛 topology
> 와 TLS 자료를 **새 세대로 clone 하고 새 epoch 리터럴을 구워** 활성화한다. S8(세대 결박)과
> S11(새 epoch)을 합성하려면 이 경로가 필요하고, **별도로 검증해야 한다** (S19).

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
- 신임 리더는 **어떤 operation 보다 먼저 `fence(token)` 핸드셰이크를 완료**한다. 이게 끝나야
  자기가 리더라고 행동할 수 있다.
- **DP Agent 는 토큰을 side effect *전에* fsync 하고 ACK 한다.** 순서가 반대면, 부작용을
  낸 뒤 fsync 전에 죽었을 때 재시작 후 더 낮은 토큰을 다시 받아들인다.
- 더 높은 토큰을 본 뒤에는 더 낮은 토큰의 `prepare`/`commit`/`abort`/`rollback` 을
  **전부 거부**한다. 진행 중 operation 도 durable 하게 들고 있어 재시작 후에도 판정이 남는다.
- 토큰 검사와 상태 변경은 **하나의 임계구역**이다 (§ 3.6-4).

컨트롤 플레인은 자기가 리더라고 *믿을* 수 있을 뿐이다. 실제 심판은 DP Agent 다.

### 3.6 operation tuple — epoch 만으로는 부족하다

v3 은 "낮은 epoch 를 거부한다"까지였다. 그것만으로는 세 구멍이 남는다.

| 구멍 | 시나리오 |
|---|---|
| 취소된 미래 epoch | E12 활성 중 `E13` 을 준비하다 abort 했는데, 지연된 `E13` RPC 가 뒤늦게 도착 → 현재 규칙은 "더 높으니까" 받는다 |
| 같은 epoch payload 교체 | `E12` 로 두 번 stage 하면 뒤엣것이 앞엣것을 덮는다 |
| 리더 교체 | `activation_epoch` 는 리더가 누구인지 말해주지 않는다 |

**따라서 epoch 하나가 아니라 튜플 전체를 싣고, durable 상태에 CAS 한다.**

```
OperationTuple {
  leader_token          엄격 단조. § 3.5
  operation_id          이 apply 의 고유 ID
  transition_id         이 평면 전환의 고유 ID
  expected_current      DP 가 지금 이 좌표에 있어야 한다 (CAS 의 기대값)
  target                이 요청이 옮기려는 좌표
  plane                 http | stream
  membership_revision
  payload_digest        같은 좌표 재요청은 digest 가 같을 때만 cached ACK
}
```

DP Agent 의 수용 규칙:

1. `leader_token` 이 durable 최대 토큰보다 작으면 **거부**.
2. `expected_current` 가 DP 의 현재 좌표와 다르면 **거부** — 알려지지 않은 더 높은 epoch 도
   여기서 걸린다. "더 높으니까 받는다"가 아니라 "내가 아는 직전 좌표에서 오는 것만 받는다".
3. 같은 `(operation_id, transition_id)` 재요청은 `payload_digest` 가 같을 때만 **cached ACK**.
   다르면 거부한다 — 같은 좌표에 다른 내용을 밀어 넣는 경로를 없앤다.
4. 수용은 **durable CAS 한 번**으로 확정한다. 검사와 적용 사이에 yield 가 있으면 안 된다.

> **왜 4번을 못박는가.** S11 하네스가 정확히 여기서 깨졌다 — 토큰을 검사한 뒤
> `read_body()` 에서 yield 하고, 재개 후 재검사 없이 슬롯을 썼다. 그 사이 더 높은 토큰이
> 완주하면 낮은 토큰의 쓰기가 살아남는다. **검사와 적용은 하나의 임계구역이어야 한다.**

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
| `http2` | **https 만** | §4.9 — 이유는 "표현 불가" 가 아니다. 실측이 뒤집었다 |
| `http3` | **https 만** | §4.9 · S20 |
| `tls_policy_id` | **https 만** | §4.6 |

#### 4.6.1 OCSP stapling — **안 짓는다** (2026-08-18)

§4.6 후보 타입에 `ocsp_stapling: boolean` 이 있었다. **뺀다.** 재고 나서 정한 것이다.

**① 우리 테스트 하네스의 어떤 CA 도 OCSP URL 을 안 준다.**

| 인증서 출처 | AIA(OCSP 응답자 URL) |
|---|---|
| 자체서명 (골든·엔진 테스트) | **없다** |
| Pebble (S18 의 실물 CA) | **없다** (`infoAccess: null`) |

**② nginx 는 그걸 조용히 무시한다.** AIA 없는 인증서에 `ssl_stapling on` 을 켜면
`nginx -t` 는 **통과하고**, 로그에 `"ssl_stapling" ignored, issuer certificate not found`
경고만 남는다. 클라이언트에게는 `OCSP response: no response sent` 가 간다.

즉 지금 이걸 넣으면 **설정에는 있는데 아무 일도 안 하고, 그 사실을 아무도 못 잰다.**
이 저장소가 반복해서 잡아온 바로 그 모양이다.

**③ 그리고 주 CA 가 OCSP 를 접었다.** Let's Encrypt 는 **2025-05-07 에 인증서에서 OCSP
URL 을 제거**했고 **2025-08-06 에 응답자를 껐다**([발표](https://letsencrypt.org/2024/12/05/ending-ocsp)).
이유는 프라이버시다 — 응답자가 "누가 어느 사이트를 보는가" 를 알게 된다. 대체는 CRL 이다.

우리가 방금 지은 발급 경로(§8.2 ACME)의 기본 CA 가 **OCSP 를 아예 안 준다.** 그러니
`ssl_stapling on` 은 그 경로에서 정의상 no-op 다.

**되살릴 조건.** OCSP 를 계속 서비스하는 CA 를 지원하게 되고, **그 CA 로 스테이플이 실제로
나가는 것을 잴 수 있게** 되면 그때 다시 본다. 판정 도구는 이미 있다 —
`openssl s_client -status` 가 스테이플 유무를 구분한다(실측). 없는 것은 **CA 쪽**이다.

> 이건 "나중에" 가 아니라 **결정**이다. §12.0 이 S9(SNI 3분기 관측)를 "현행 유지" 로
> 닫은 것과 같은 종류 — 잴 수 없는 것을 넣으면 켰다는 사실만 남는다.

#### HSTS — 되돌릴 수 없는 유일한 설정 (2026-08-18)

이 제품의 다른 기본값들과 성질이 다르다. h2 는 잘못 켜도 끄면 그만이지만 **HSTS 는
클라이언트 쪽에서 되돌릴 수 없다** — `max-age` 동안 브라우저가 https 로만 가고, 인증서가
깨지면 사용자에게 우회 수단이 없다(경고를 무시하고 진행하는 버튼도 사라진다). 설정을
되돌려도 이미 나간 헤더는 회수가 안 된다.

그래서 **기본이 꺼짐**이고, 켜는 것은 사람이 정한다.

**preload 는 검증기가 요구조건을 강제한다** — 목록이 브라우저 빌드에 구워져 빼는 데
수개월이 걸리므로, `max-age` ≥ 1년과 `includeSubdomains` 없이는 저장이 안 된다. 안
지킨 채 제출하면 거절되거나 **준비 안 된 서브도메인이 함께 등재된다.**

> ⚠️ **`add_header` 는 상속이 아니라 대체다.** location 에 `add_header` 가 **하나라도**
> 있으면 상위 server 의 것이 **전부 사라진다.** 실측했다:
>
> | 위치 | HSTS |
> |---|---|
> | 자기 `add_header` 가 없는 location | 나온다 |
> | 자기 `add_header` 가 있는 location | **안 나온다** |
> | 500 응답 (`always` 덕분) | 나온다 |
>
> 렌더러는 지금 location 에 `add_header` 를 하나도 안 내고 **그 사실에 기대고 있다.**
> 골든이 그 불변식을 지킨다 — 응답 헤더 기능을 라우트에 붙이는 사람은 거기서 걸린다.

`always` 가 필요한 이유도 같은 맥락이다. 없으면 2xx/3xx 에만 붙는데, **인증서가 깨져
5xx 를 내는 동안이 바로 downgrade 를 막아야 하는 순간**이다.

#### 암호군 정책 — 왜 산출물이 둘인가 (2026-08-18 실측)

§4.6 이 *"TLS1.2 이하와 TLS1.3 산출물을 분리한다"* 고 적어 둔 이유가 실측으로 보인다:

```
ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256
  → TLS1.2 는 그것,  TLS1.3 은 TLS_AES_256_GCM_SHA384   (전혀 다른 것)
```

**`ssl_ciphers` 는 TLS1.3 에 안 걸린다.** 그걸 모르고 "약한 암호를 껐다" 고 믿으면 1.3
쪽은 손도 안 댄 것이다. 1.3 은 `ssl_conf_command Ciphersuites` 가 정하고(실측 확인),
둘 다 **server 별**로 걸린다 — `ssl_protocols`(S16)·`http2`(§4.9)와 같은 자리다.

**자유 문자열이 아닌 이유도 실물에 있다.** 오타 난 암호군 이름을 nginx 는 **그냥
무시하고** 남은 목록으로 협상한다. 설정에는 있는데 안 걸리는 그 모양이라, 닫힌 집합으로
둔다. 이름에 연도가 붙는 것은 권고 목록이 바뀌기 때문이다 — 내용이 바뀌면 **새 이름**을
만든다. 조용히 갈면 같은 설정이 어느 날 다른 암호군을 쓴다.

> ⚠️ **`ssl_conf_command` 는 오늘 관측되지 않는다.** `modern-2026` 의 1.3 목록이
> OpenSSL 기본값과 같아서, 그 줄을 빼도 협상 결과가 안 바뀐다(변이로 확인). 그래도 내는
> 이유는 **엔진 기본값이 바뀌어도 우리 설정이 안 바뀌게** 하기 위해서다. 안 내는 것은
> "지금 기본값과 같으니 생략" 이고, 기본값이 움직이는 날 조용히 따라 움직인다.

### 4.10 엔진 전역 설정 — 좁게 연다

nginx 의 main 컨텍스트에는 수십 개 디렉티브가 있다. **여기 여는 것은 재 보고 대가를
아는 것뿐이다.** 자유 문자열 주입 같은 일반 탈출구를 열면 렌더러가 보장하는 것이 통째로
무너진다 — `cipher_preset: custom` 을 없앤 것과 같은 이유다.

#### `worker_shutdown_timeout` — 모르는 것을 유계로 바꾸는 거래

S13 이 실측했다: **마커로는 옛 워커를 셀 수 없다.** HUP 뒤 옛 워커는 리스닝 소켓을
닫으므로 새 요청이 절대 안 가고, nginx 는 "어느 워커가 어느 세대인가" 를 안 알려준다.
그래서 GC 는 *"이 세대를 아직 누가 쓰는가"* 를 영영 모른다.

이 설정이 그걸 **유계로 바꾼다.** 상한이 있으면 *"이 시간이 지나면 아무도 안 든다"* 가
성립하고, 세대 보존을 시간 기반으로 만들 수 있다.

**값은 in-flight 다.** 실측:

| 설정 | in-flight 요청 |
|---|---|
| 없음 (기본) | **끝까지 간다** — 느린 요청이 200 으로 완료 |
| `2s` | **응답 없이 죽는다** — `curl exit=52` (empty reply), 본문 0 바이트 |

**502 도 부분 응답도 아니다.** 클라이언트는 이것을 네트워크 장애와 구분할 수 없고,
비멱등 요청이면 부작용이 이미 일어났을 수 있다. 그래서 **기본은 안 내는 것**이다 —
nginx 기본값(무한)이 안전한 쪽이고, 켜는 것은 사람이 정한다.

#### 그래서 세대 보존이 시간을 본다 (2026-08-18)

상한이 걸려 있으면 세대 보존이 **개수 말고 시간도** 본다.

- 세대 i 는 **세대 i+1 이 만들어진 순간** 비활성이 된다. 새 상태를 안 만들고 디스크의
  mtime 만으로 계산한다 — `serving_generations` 같은 원장을 두면 그 원장이 실제와
  어긋날 자리가 생긴다.
- 비활성이 된 지 **`worker_shutdown_timeout` × 2** 가 안 지난 세대는 개수 상한 밖이어도
  남긴다. 두 배인 이유는 상한이 *워커가 죽는 시각*이지 **publish→HUP 사이 지연까지
  덮지 않기** 때문이다.
- **상한이 없는 배포에는 이 보호가 없다.** 숨기지 않는다 — `undefined` 를 "안전하다" 로
  읽지 않는다. 그 경우 개수 상한만 남고, 대가는 위에 적은 그대로다.

### 4.9 HTTP 버전 — 무엇을 말할 수 있는가

> **이 절은 실측 위에 있다 (2026-08-18).** 아래 표의 "실측" 열은 엔진에 직접 물어본
> 결과이고, 그 중 하나는 이 문서가 원래 적어 둔 것을 **뒤집었다.**

| 버전 | 지금 | 실측 |
|---|---|---|
| HTTP/1.0 · 1.1 | **된다** | nginx 의 기본이고 모든 e2e·골든이 이걸로 측정됐다 |
| HTTP/2 | **안 된다** | 렌더러가 `http2` 를 한 번도 안 낸다. nginx 1.25.1+ 는 기본이 **off** 이므로 ALPN 이 `http/1.1` 로 떨어진다 — 클라이언트가 h2 를 제안해도 |
| HTTP/3 | **안 된다** | 설계에도 코드에도 단어가 없었다. 엔진 이미지는 `--with-http_v3_module` 로 빌드돼 있는데 안 쓴다 |

#### 실측이 뒤집은 것 — "타입상 http 에서 표현 불가" 는 틀렸다

이 문서는 `http2` 를 https 전용으로 두면서 이유를 *"타입상 http 에서 표현 불가"* 라고
적었다. **거짓이다.** 평문 리스너에 `http2 on;` 을 내면 nginx 는 그것을 받고, **h2c 가
실제로 동작한다**:

```
curl --http2-prior-knowledge http://127.0.0.1:19812/   → HTTP/2
curl (평범하게)                                        → HTTP/1.1
```

그래도 **v0 은 https 전용으로 둔다.** 이유가 바뀐다:

> 브라우저는 h2c 를 **안 쓴다** (사전 지식 없이는 업그레이드하지 않고, nginx 는 `Upgrade:
> h2c` 협상을 안 한다). 평문 리스너에 `http2` 를 열어 두면 운영자가 켜 놓고 **아무 일도
> 안 일어난다** — 이 저장소가 반복해서 잡아온 *"표시는 되는데 실제로는 안 걸린다"* 그대로다.
> h2c 가 필요한 곳은 내부 gRPC 인데, 그건 이름을 따로 붙여 여는 편이 정직하다.

#### HTTP/2 렌더 규칙 (실측)

| 실측 | 규칙 |
|---|---|
| **`http2` 는 server 별로 걸린다.** 같은 리스너에서 `a.test`(on) → `h2`, `b.test`(off) → `http/1.1` | `ssl_protocols`(S16)와 같다. **각 server 블록 안**에 낸다 — 리스너 단위가 아니다 |
| `http` 블록에 한 번 내면 전 server 에 걸린다 | 기본값을 http 레벨에 두는 길도 있지만 **안 쓴다.** server 별 재정의가 http 레벨을 덮는지 또 재야 하고, S16 이 같은 자리에서 이미 한 번 물었다 |
| nginx 1.25.1 부터 `http2 on;` 이 정본이고 기본은 off | capability 로 가른다 (§7.6 — `http_v2_module` + 버전). 없는 엔진에서 켜면 **검증기가 막는다**, 조용히 무시하지 않는다 |

#### HTTP/3 — 무엇이 다른가 (S20 실행 완료, 2026-08-18)

**h3 는 이 엔진에서 된다.** S20 이 실물 클라이언트(`ymuski/curl-http3`, quiche 0.18)로
쟀다 — 엔진은 openresty 1.31.1.1 + `--with-http_v3_module` + **OpenSSL 3.5.7**(서버측
QUIC API 가 들어온 판)이다. 넷을 확인했다:

| 잰 것 | 결과 |
|---|---|
| h3 로 실제 요청이 오간다 | `http_version=3`, 엔진의 `$server_protocol` = `HTTP/3.0` |
| 같은 포트에서 h1.1·h2·h3 공존 | 셋 다 200 — 앞의 둘은 TCP, h3 는 UDP |
| Alt-Svc 승격 | 1회차 h2 응답의 `Alt-Svc: h3=":N"` 을 캐시하고 **2회차가 h3 로 간다** |
| reload 중 진행 중인 h3 요청 | **안 끊긴다.** HUP 을 맞은 채로 응답이 끝난다 |

*"설정이 선다"* 와 *"서빙된다"* 는 다르므로, 판정은 `--http3-only` + `%{http_version}`
으로만 했다. `curl --http3` 은 실패 시 조용히 h2/h1 로 내려가므로 쓸 수 없다 — S16 에서
`s_client` 의 `Protocol :` 줄에 똑같이 물린 적이 있다. 그 플래그가 진짜 강제하는지도
먼저 쟀다(TCP 전용 서버에 던져 실패하는 것을 확인).

**그런데 ②가 깨졌다.** §4.5 겹침 검증에 잡히는가 — 안 잡힌다. 그리고 엔진도 안 잡는다.

설계에 미치는 영향 셋:

1. **QUIC 는 UDP 다.** `listen 443 quic` 은 **UDP/443** 을 점유하므로, §4.5 겹침 검증기가
   이걸 udp 예약으로 세야 한다. 같은 포트의 `udp` 리스너와 **충돌한다** — 지금 검증기는
   https 리스너를 tcp 로만 예약하므로 그 충돌을 못 본다.

   > **그 충돌이 무엇인지 실측했다 (E65).** 최악의 모양이다: `nginx -t` 가 **통과하고**,
   > 런타임도 **안 죽고**, UDP 소켓이 **둘 다 bind 되고**(대조군은 하나다), 데이터그램은
   > **stream 쪽이 먹는다.** h3 는 rc=28 로 조용히 죽고 **error.log 에 경고가 0 줄**이다.
   >
   > 즉 운영자가 볼 수 있는 신호가 **하나도 없다.** "거절당한다" 였으면 차라리 나았다.
   > 이건 h3 를 v0 모델에서 빼 두는 이유이자, 나중에 열 때 검증기가 먼저 갚아야 할 빚이다.
   > `transportOf()` 가 전송 **하나**를 돌려주는 지금 형태로는 표현할 수 없다 — h3 를 켠
   > https 리스너는 tcp 와 udp 를 **동시에** 예약한다.
2. **`reuseport` 는 address:port 당 하나뿐이다.** 두 리스너가 같은 포트에 quic 을 열면
   nginx 가 거절한다. 모델이 리스너당 소켓 하나이므로 자연히 지켜지지만, 검증기가 그
   사실에 기대고 있다는 것을 적어 둔다.
3. **`tls_passthrough` 는 h3 를 못 받는다.** `ssl_preread` 는 TCP 스트림 모듈이고 QUIC 는
   UDP 다. 패스스루 리스너에 h3 가 오면 **아예 도달하지 않는다** — 이건 기능 축소가 아니라
   구조적 사실이라 모델이 표현해서는 안 된다.



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
| `dns` | object? | `resolver_ref`, `valid_s`, `resolve_mode` — **`on_nxdomain`/`on_timeout` 없음** (S14: 엔진이 선택지를 안 준다. 표는 `DataplaneCapabilities.nativeDns`) |
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
  cipher_policy: CipherPolicyRef;   // → 구현됨 (2026-08-18). 아래 실측 참조
  hsts?: { max_age: number; include_subdomains: boolean; preload: boolean };
  // ocsp_stapling: **뺐다** (2026-08-18). 아래 §4.6.1 참조
};

type SniCertificateBinding = ResourceMeta & {
  tls_policy_id: uuid;
  hosts: string[];                   // handshake 단계 선택 키
  certificate_id: uuid;
  override?: { min_version?: '1.2' | '1.3'; cipher_policy?: CipherPolicyRef };
};
```

- `HttpsProfile.tls_policy_id` → `TlsPolicy` → `SniCertificateBinding[]`.
- **SNI 와 HTTP Host 불일치 정책**을 명시한다: `allow`(기본) \| `reject_421`.
  → **구현됨 (2026-08-18)** — `TlsPolicy.sniHostMismatch`.

  실측이 왜 필요한지 보여 준다. 테넌트 둘을 세우고 SNI 와 Host 를 엇갈리게 보내면:

  ```
  SNI=a.test + Host=b.test  →  인증서 a.test  /  응답 TENANT-B
  ```

  handshake 는 SNI 로, 요청은 Host 로 server 를 고르기 때문이다. **그 자체로 권한 상승은
  아니다** — 클라이언트가 처음부터 SNI=b 로 붙을 수 있었다. 위험은 운영자가 *"a 의
  인증서를 받았으면 a 의 트래픽"* 이라고 가정할 때 생기고, **HTTP/2 가 그 가정을 깬다**:
  브라우저는 인증서가 덮는 다른 오리진에 같은 커넥션을 재사용한다(RFC 7540 §9.1.1).
  그 RFC 가 **421 Misdirected Request** 를 답으로 정해 둔 이유다.

  **기본은 `allow` 다.** 막는 쪽을 기본으로 하면 SNI 를 안 보내는 옛 클라이언트가 끊긴다.
  멀티테넌트는 명시적으로 켠다.

  렌더는 `map` + `if` 다 — nginx 의 `if` 는 변수 하나만 보므로 두 값을 `:` 로 이어 붙여
  정규식 역참조로 비교한다. 경계 셋을 실측했다: `Host: a.test:443` 은 통과(`$host` 가
  포트를 뗀다) · `Host: A.TEST` 도 통과(소문자로 내린다) · **SNI 없음도 통과**(비교할
  것이 없다 — 여기서 막으면 옛 클라이언트가 통째로 끊긴다).

  ⚠️ `if` 는 **rewrite 단계**라 location 선택보다 앞이다(§7.x 의 `return 444` 로 한 번
  물렸다). 가드가 걸리면 그 server 의 어떤 location 도 안 돈다 — ACME 예약 라우트를
  포함해서. 그래도 문제가 안 되는 이유는 http-01 검증이 평문 80 으로 오고, 이 가드는
  **불일치일 때만** 걸리기 때문이다.
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

**구현 (2026-08-17) — 그리고 한동안 이 표가 거짓이었다.**

`trusted_proxy_cidrs` 를 "필수" 라고 적어 놓고 모델에는 **불리언 하나**만 있었다. 즉
신뢰 경계 없이 PROXY 수신을 켤 수 있었고, 문서만 읽으면 있다고 믿게 되는 상태였다.

**E63 으로 재고 나서야 얼마나 나쁜지가 분명해졌다.**

| 설정 | `$remote_addr` | `$proxy_protocol_addr` |
|---|---|---|
| realip 없음 | 실제 peer | **헤더가 말하는 값** |
| peer 를 신뢰 | 헤더 값 | 헤더 값 |
| peer 를 **불신** | **실제 peer** | 헤더 값 |

**`$proxy_protocol_addr` 는 어떤 경우에도 게이팅되지 않는다.** 신뢰 경계는 오직 realip 을
거친 `$remote_addr` 에만 걸린다. 그런데 렌더러는 `stream_realip` 이 없을 때 소스IP 해시를
바로 그 변수로 계산했다(옛 R18) — *"모듈 없이도 실 클라이언트 IP 를 준다"* 가 근거였고
그 문장은 참이지만, 빠진 절반이 **"그 값을 클라이언트가 정한다"** 였다. 공격자가 자기를
원하는 백엔드로 몰 수 있었다.

바꾼 것:

| | 지금 |
|---|---|
| 모델 | `acceptProxyProtocol?: { trustedCidrs: string[] }` — **불리언을 안 받는다.** 빈 목록도 거부 |
| 렌더 | `proxy_protocol` 과 `set_real_ip_from`/`real_ip_header` 가 **함께** 나간다 |
| 해시 | **언제나 `$remote_addr`.** capability 로 분기하지 않는다 |
| stream + `stream_realip` 없음 | **검증기가 막는다** — 신뢰 경계를 걸 방법이 없는 조합이다 |
| DB | `accept_proxy_cidrs text[]`, 빈 배열 금지. **옛 `true` 는 옮기지 않고 끈다** — 신뢰 경계를 지어낼 수 없다 |

아직 없는 것: `real_ip_from_header` · `forwarded_header_policy`. HTTP 헤더 파생은 v0.6 의
TLS/헤더 정책과 함께 다룬다. **컨트롤 플레인이 엔진 capability 를 조회하지 않는다** —
`streamRealip` 을 보수적으로 `false` 로 가정하므로, stream PROXY 수신은 지금 항상 막힌다.
capability 프로브는 별도 과제다.

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
GET    /api/v1/events                   # SSE — 스냅샷(`status`) + `revision`/`apply` 델타 + 하트비트 주석. 인증 필요.
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
| `superseded` | **`target_revision ≠ desired_head`.** 일반 apply 는 항상 head 만 적용한다. "더 최근 것이 적용됐다"는 모호했다 — 커밋만 되고 적용은 안 된 리비전이 있으면 판정이 갈린다 |

- **과거 리비전 적용은 명시적 rollback 으로만.** `R1` 커밋 → `R2` 적용 뒤에 `R1` plan 을
  `/apply` 로 되돌리는 경로는 없다.
- **롤백은 head 를 뒤로 옮기지 않는다.** desired 가 `R2` 인데 runtime 만 `R1` 로 되돌리면
  reconciler 가 다시 `R2` 를 적용해 버린다. 반대로 head 를 `R1` 로 되돌리면 리비전 단조
  계약이 깨진다.
  → **`R1` 의 내용으로 새 `ConfigRevision R3` 을 만들고 `rollback_of: R1` 을 붙인다.**
  head 는 앞으로만 간다. 새 activation operation 이 발행되므로 §3.3-1 의 epoch 규칙과도 맞는다.
  · 긴급 상황의 runtime-only 롤백은 **`reconcile_suspended`** 라는 별도 상태로 표시한다.
    이 상태에서는 reconciler 가 자동 재적용을 하지 않고, 해제는 명시적이다.
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
- **`key` 가 정본 식별자.** 모델에 UUID 가 없으므로 remap 표는 없다.
- **시크릿은 별칭만.** 대상 SecretStore 에 없으면 **plan 단계에서 실패**한다.
- **전체 매니페스트 검증 후 단일 changeset 으로 커밋.** 순차 CRUD 금지.
- 머지 정책: `--mode merge|replace` (replace 는 매니페스트에 없는 키를 지운다).
- 정본은 JSON 이다 (`GET|POST /api/v1/config/export|import`). YAML 예시는 모양만.

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

- **무엇이 새 epoch 를 쓰는지 분류기로 고정한다.** "렌더 결과가 byte 로 같으면" 은 기준이
  될 수 없다 — 부트스트랩 멤버십이 아티팩트에 들어가면 애초에 같을 수 없고, 세대에 epoch 가
  구워지므로 새 epoch 를 예약하면 byte 도 달라진다.

  | 변경 종류 | 좌표 |
  |---|---|
  | 리스너·라우트·풀·백엔드 **CRUD**, TLS 자료 | 새 세대 + **새 `activation_epoch`** |
  | `admin_state` · `weight` | **같은 epoch**, `membership_revision` 증가 |
  | 헬스 판정 | **같은 epoch**, `membership_revision` 증가 |

  즉 `admin_state`/weight 는 모델 변경이지만 **topology 식별 공간을 바꾸지 않으므로**
  세대를 새로 내지 않는다. `static_generation_revision`(디스크)과
  `applied_model_revision`(적용된 모델)을 따로 노출해 둘이 갈릴 수 있음을 드러낸다.
- **헬스 판정만이 순수 멤버십 경로다.** 헬스는 사용자 소유 필드가 아니므로 경합하지 않는다.
- DNS 변화는 대안 B 에서 엔진이 처리하고, 멤버십 평면 경로에서는 CP 가 재해석해
  설정 경로로 반영한다.

### 6.2 ApplyOperation 상태기계 (durable)

> **이 절은 v0.1 의 정본이다.** 6차 검수가 "§6.2 와 실제 상태기계가 서로 다른 스키마"
> 라고 지적했다. 문서와 코드가 다르면 어느 쪽이 계약인지 아무도 모른다. 아래는
> `src/dp/operation.ts` · `src/dp/apply.ts` 가 실제로 하는 것이고, 설계가 원래 그리던
> 더 넓은 상태기계는 §6.2.1 에 **비규범**으로 남겼다.

```
 preflight → publish_intent → published → membership_staged → reload_intent
                                                                    │
                                                    reload_observed ┘
                                                          │
                              ┌───────────────────────────┼──────────────────┐
                              ▼                           ▼                  ▼
                         activated            partially_activated         failed
                                                    (비종단 — 유한 재시도)

 어느 단계에서든:  fence(더 높은 토큰) ──→ superseded
```

**`superseded` 는 실패가 아니다.** 더 높은 토큰이 `fence` 를 통과하면 옛 리더는 더 이상
행동할 수 없으므로 그 자리에서 예약을 반납하고 저널을 닫는다. 놓아 주지 않으면 새 리더가
apply 경로를 영영 못 잡는다 — 옛 오퍼레이션을 `abort` 하려 해도 그 토큰이 이미 낡아서
거부되기 때문이다 (7차 반례 ①). **이미 넘어간 좌표는 건드리지 않는다** — 승계는
되돌리기가 아니다 (§3.3).

`no_operation` 은 저널이 없는 상태를 부르는 이름이다.

| 단계 | 뜻 | 다음으로 가는 조건 |
|---|---|---|
| `preflight` | 게시 전 검사 | manifest digest 대조 + `nginx -t` 통과 |
| `publish_intent` | 게시하겠다고 기록함 | `current` 가 목표 세대를 가리킴 (관측) |
| `published` | 게시됨 | — |
| `membership_staged` | **전 평면** 슬롯이 올라감 | — |
| `reload_intent` | HUP 을 보내겠다고 기록함 | 증거가 활성화를 증명 |
| `reload_observed` | 활성화가 증명됨 | 전 평면 commit |
| `activated` | 전 평면이 목표 좌표 | 종단 |
| `partially_activated` | 일부 평면만 넘어감 | **비종단** — 유한 재시도 |
| `partial_exhausted` | 재시도를 소진했는데도 일부 평면만 넘어갔다 | 종단 |
| `failed` | reload 상한 초과 또는 preflight 실패 | 종단 |
| `superseded` | 더 높은 리더 토큰이 들어와 소유권이 끊겼다 (§3.5) | 종단 |

**저널 항목** (`JournalEntry`)

| 필드 | 비고 |
|---|---|
| `op` | `ApplyOperation` 통째로 — 복구가 같은 오퍼레이션을 재개한다 |
| `phase` | 위 표 |
| `reloadAttempts` | 재전송 상한 (§6.4) |
| `seq` | 단계 전이 CAS. 한 명만 이긴다 (6차 반례 ③) |
| `progress` | 평면별 `pending`/`reserved`/`staged`/`committed`/`aborted`/`failed` |
| `evidence` | 마지막으로 관측한 `ActivationEvidence` (§6.3) |

**`ApplyOperation`**

| 필드 | 비고 |
|---|---|
| `leaderToken` | §3.5 — DP Agent 가 이걸로 옛 리더를 걸러낸다 |
| `operationId` / `transitionId` | 멱등 재시도 키 |
| `affectedPlanes` | 이 오퍼레이션이 건드리는 평면. **설정 apply 는 항상 둘 다** — 하나의 `nginx.conf` 가 http·stream 을 함께 지배하므로 비게 되는 평면도 전환이다 |
| `planes[plane]` | `{expectedCurrent, target, payloadDigest}` — 평면별 좌표 CAS |
| `targetGeneration` | 활성화할 세대 이름 |
| `generationDigest` | 그 세대의 **내용** digest (§7.2). 이름은 내용을 말하지 못한다 |

**아직 없는 필드.** `plan_id` · `target_revision` · `previous_revision` · `render_digest` ·
`last_error` 는 CP 쪽 개념이라 v0.1 DP 계약에 없다. §5.3 의 plan 이 생길 때 붙는다.

#### 6.2.1 원래 그리던 상태기계 (비규범 — v0.3+)

아래는 멤버십·롤백·GC 까지 포함한 전체 그림이다. **v0.1 은 이걸 구현하지 않는다** (§9.1.1).
여기 있는 상태를 지금 고정하면 구현할 때 호환성을 깨야 한다.

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

> ✅ 는 **v0.1 이 덮고 계측하는** 행이다. 지점 이름과 이 표의 대응은
> `tests/conformance/review5-crash-points.test.ts` 가 집합 일치로 검사한다.
> 9·10 행은 TLS·GC 라 v0.6, 11 행(롤백)은 §3.3 에 따라 3~8 행과 같은 경로다.
> 1 행은 CP 가 세대를 만드는 단계라 DP 의 크래시 표면이 아니다.

| # | 크래시 지점 | 관측으로 판정 | 복구 |
|---|---|---|---|
| 1 | `rendered` 기록 전 | — | 폐기 |
| 2 ✅ | 렌더 후, `validated` 기록 전 | 임시 세대 존재 | 삭제 후 재시도 |
| 3 ✅ | `publish_intent` 기록 후, symlink 교체 전 | symlink = 옛 세대 | 교체부터 재개 (멱등) |
| 4 ✅ | symlink 교체 후, `published` 기록 전 | **symlink 가 정본** | `published` 로 보정 |
| 5 ✅ | `reload_intent` 기록 후, HUP 전 | 마스터 cycle 불변 | HUP 전송 |
| 6 ✅ | HUP 후, `reload_observed` 기록 전 | 마스터 cycle 증가 | 워커 레지스트리로 판정 |
| 7 ✅ | `activated` 후, 평면 스냅샷 전송 전 | `plane_progress` 비어 있음 | 풀 스냅샷 재전송 |
| 8 ✅ | http 평면 ACK 후, stream 전송 전 | 평면 좌표 불일치 | `partial_transition` → 재시도 |
| 9 | 시크릿 materialize 후, 검증 전 | 다이제스트 대조 | 재검증, 불일치면 `failed` |
| 10 | GC 디스크 삭제 후, refcount 감소 전 | release ledger | § 8.4 |
| 11 | 롤백 중 | 혼재 | 이전 세대를 **새 epoch 로** 재게시 후 동일 절차 |

> **HUP 은 exactly-once 로 만들 수 없다.** 마스터 cycle 이 그대로라는 사실만으로는
> "신호를 못 보냈다"와 "보냈지만 아직 처리 전이다"를 구분할 수 없다. 재전송하면 워커
> cycle 이 하나 더 생기고, 안 하면 미전송 케이스가 멈춘다.
>
> → **exactly-once 요구를 버린다.** 대신 **식별 가능한 bounded duplicate** 를 허용한다:
> 재전송은 상한(기본 2회)을 두고, 최종 판정은 §6.3 의 세대 리터럴로 한다. 중복 cycle 은
> `serving_generations` 에 드러나므로 admission control(§6.4)이 흡수한다.
> **S12 의 합격 기준도 "추가 cycle 0" 이 아니라 "최종 세대가 정확하고 중복이 상한 이내"** 다.
> 더 강한 보장이 필요하면 crash 를 견디는 reload supervisor 가 있어야 한다.

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

> **v0.1 이 실제로 하는 것.** 아래 7 단계는 원래 설계다. 구현된 것과 아닌 것을 갈라 둔다 —
> 문서가 요구하고 코드가 안 하는 것을 그대로 두면 그게 §6.3 을 못 믿게 만든다.
>
> | 단계 | v0.1 | 어디 |
> |---|---|---|
> | 1 프리플라이트 (`nginx -t`) | ✅ | `preflight` 단계 · `FsEffects.configTest` (주입) |
> | 2 새 소켓 사전 bind 확인 | ❌ | — |
> | 3 error log 워터마크 | ✅ | `ActivationEvidence.errorLogGrowth` |
> | 4 워커 레지스트리 | ❌ | 타입에는 있고(`workersReported`) 수집기는 없다 |
> | 5 기대 워커 수 | ❌ | 위와 같다 |
> | 6 리스너별 합성 프로브 | ▲ | 세대 리터럴 HTTP 프로브 하나뿐 |
> | 7 실패 시 롤백 | ▲ | 좌표를 안 옮기고 `failed`. 자동 재게시는 없다 |
>
> 판정 규칙은 `provesActivation` 하나다. **세대가 맞는 것은 필요조건일 뿐이고**, 관측된
> 음성 신호가 하나라도 있으면 활성화가 아니다. 관측하지 못한 것(`undefined`)은 반증이
> 아니다 — 관측 못 한 것과 나쁜 것은 다르다.
>
> `masterPid` 는 타입에만 있고 판정에 쓰지 않는다. 6차 검수 지적이다. 쓰지 않을 필드를
> 계약에 두면 "본다" 는 착각을 만든다 — v0.1 계약에서 뺄지 수집기를 만들지 정해야 한다.

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
            유지하는 동안에도 **eligibility 는 계속 투영한다** — 옛 워커가 재시도할 때
            이미 `disabled` 된 peer 를 다시 고르면 안 된다. 리듀서는 serving 중인 **모든**
            호환 슬롯에 eligibility 를 쓴다.
6. abort    prepare 가 실패하면 E-new 슬롯을 버리고, 버퍼는 **기존 epoch 로 되돌린다.**
            prepare 동안에도 활성 epoch 는 헬스 갱신을 계속 받는다.
```

#### 시퀀스는 누가 발급하고 어디에 저장하는가

"durable sequence 를 붙인다"만으로는 부족하다. **PG 시퀀스(`nextval`)는 커밋 순서와 다르다.**

```
T1: nextval → 100, 아직 커밋 안 함
T2: nextval → 101, 커밋
    cut = 101 로 잡힌다
T1: 뒤늦게 커밋
    replay 는 > 101 만 재생 → **100 이 영구 누락**
```

그래서 **커밋된 연속 커서**를 따로 발급한다.

| 요소 | 규칙 |
|---|---|
| 이벤트 저장 | 헬스 판정 변경과 **outbox 삽입을 같은 트랜잭션**으로 한다. 이벤트 로그가 정본이다 |
| 커서 발급 | `nextval` 이 아니라 **잠금 행**(`SELECT … FOR UPDATE`)으로 다음 번호를 준다. 그래서 번호 순서 = 커밋 순서 |
| cut | 스냅샷과 high-water mark 를 **같은 MVCC 스냅샷/잠금** 안에서 읽는다. 따로 읽으면 그 사이가 유실된다 |
| replay | `> HWM` 을 순서대로 적용한다 |

#### abort — 버퍼를 옮기지 않는다

v3 은 "abort 시 버퍼를 기존 epoch 로 되돌린다"고 했다. **연산이 잘못 정의됐다** — 옛 슬롯에
이미 같은 이벤트가 적용됐다면 중복 또는 역순 적용이 된다.

**이벤트 로그가 단일 정본이고, 슬롯은 커서만 갖는다.** abort 는 staged 슬롯과 그 커서를
버릴 뿐 이벤트를 옮기지 않는다. 활성 epoch 는 자기 커서로 계속 진행한다.

### 6.6 멤버십 리듀서 — 소유자가 달라도 경합은 남는다

v2 는 "`admin_state`/weight 는 사용자 소유, 헬스는 프로버 소유라 경합하지 않는다"고 했다.
**소유가 다른 것과 경합이 없는 것은 다르다.** 둘 다 최종적으로 같은 peer eligibility 를
갱신하므로, 늦게 도착한 whole-peer 헬스 델타가 방금 내린 `disabled` 를 되돌릴 수 있다.

- **단일 리듀서**가 `{spec revision, raw health}` 를 합성해 eligibility 를 만들고 시퀀스를 발급한다.
- 헬스 프로듀서는 **헬스 필드만** 쓴다. peer 전체를 덮어쓰지 않는다.
- **`admin_state` 가 항상 우선한다.** `disabled`/`draining` 은 어떤 헬스 값으로도 뒤집히지 않는다.

#### 헬스 관측에도 ABA 가 있다

§3.3-2 는 `topology_version` 이 같으면 헬스를 재투영해도 된다고 했다. **그것만으로는 부족하다.**
같은 백엔드·같은 host:port·같은 프로브 설정이어도, **먼저 시작한 프로브 A 가 나중에 시작한
B 보다 늦게 끝나면** A 의 낡은 결과가 최신 상태를 덮는다. `disable → enable` 이나 DNS 의
A-B-A 도 같은 모양이다.

프로브 결과에 **관측 좌표**를 싣고 백엔드별로 CAS 한다.

| 필드 | 의미 |
|---|---|
| `probe_incarnation` | 프로브 설정이 바뀔 때마다 증가 |
| `probe_start_seq` | 이 프로브 실행의 시작 순번 (백엔드별 단조) |
| `resolved_endpoint_digest` | DNS 를 푼 **실제** 주소. 이름이 같아도 주소가 바뀌면 다른 관측이다 |

리듀서는 `probe_start_seq` 가 마지막으로 반영한 값보다 클 때만 적용한다. 늦게 도착한 낡은
완료는 버린다.

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
→ `membership/{plane}/{activation_epoch}-{topology_digest}-{revision}.json` 으로 **불변 키**를
지정하고, 활성 포인터는 별도 파일로 둔다. `topology_digest` 만으로는 같은 topology 를 새
epoch 로 롤백했을 때 슬롯을 구분하지 못한다.

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
- **세대 전체를 원자적으로 게시한다.** 파일 하나씩 rename 하면 여러 key/chain/OCSP/manifest 가
  한 세대로 **완성됐음**을 보장하지 못한다 — 중간 상태에서 reload 가 들어올 수 있다.
  `generations/.tmp-N/` 에 전부 쓰고 검증·fsync 한 뒤 `manifest.json` 과 `READY` 를 마지막에
  쓰고, **디렉토리를 rename** 한다.
- 경로는 도메인이 아니라 **자료 ID 기준**이다 (`certs/<certificate_id>/`). 같은 도메인에
  RSA·ECDSA 두 장이 붙을 수 있고, 도메인이 바뀌어도 자료는 그대로일 수 있다.
- **그리고 버전까지 경로에 들어간다** — `certs/<certificate_id>/<version>/`. v0.6 구현이
  이걸 빠뜨려서 다음이 일어났다:

  > 인증서를 갱신해도 **렌더 산출물이 글자 하나 안 바뀐다.** 경로가 같고 conf 의 나머지도
  > 같으니 digest 가 동일하다. 그런데 apply 는 *"산출물이 안 바뀌었다"* 를 멤버십 전용
  > 전환의 근거로 쓰므로(§6.5), **갱신이 세대를 안 만들고 조용히 통과한다.** 옛 인증서가
  > 계속 제시되는데 응답은 `activated` 다.

  §4.8 이 요구한 버전 고정 참조가 DB 에는 있었는데 **렌더까지 안 내려온 것**이다. 참조에만
  버전이 있고 산출물에 없으면 그 버전은 아무것도 안 한다. 버전을 경로에 넣으면 갱신이 곧
  다른 conf 가 되고 세대·digest·롤백이 전부 따라온다.
- 결박 대상은 leaf/key/chain 만이 아니다. **OCSP staple, 신뢰 CA 번들, 업스트림 클라이언트
  인증서** 등 런타임 TLS 자료 전부가 manifest 에 들어간다.
- 직후 **인증서-키 일치·SAN·not_after·권한(0400, DP uid)** 검증.
  → **구현됨 (2026-08-17, `src/dp/certinfo.ts`)** — 자료를 받는 자리(`POST
  /certificates/material`)와 `SecretStore.put` **양쪽**에서 검사한다. API 는 좋은 에러를
  주기 위해서고, 저장소는 **거짓을 들고 있지 않기 위해서**다 — 호출자가 하나 늘 때마다
  검사를 잊을 자리가 하나 는다. 권한은 `certificateFiles` 가 세대에 0400 으로 쓴다.

  안 하면 실패가 사라지는 게 아니라 **옮겨간다.** 무관한 키-체인 한 쌍은 저장되고 며칠 뒤
  apply 의 `nginx -t` 에서 터지는데, 그때 보이는 것은 *"설정이 이상하다"* 다. 만료는 더
  나쁘다 — 아무 데서도 안 터지고 **handshake 만 조용히 깨진다.**
- 세대 보존: 최근 N 개 + `serving_generations` 에 남아 있는 모든 세대.

**세대 conf 안의 인증서 경로는 `certs/...` 상대경로로 쓴다.** nginx 는 `ssl_certificate` 를
prefix 가 아니라 **conf_prefix(= conf 파일이 있는 디렉토리)** 기준으로 푼다. 이 성질 덕분에
같은 conf 가 두 상황에서 각각 옳게 동작한다.

| 호출 | conf_prefix | 인증서 경로 |
|---|---|---|
| `-c current/nginx.conf` (게시 후) | `…/current/` | symlink 를 따라 활성 세대의 인증서 |
| `-t -c generations/2/nginx.conf` (게시 **전**) | `…/generations/2/` | 그 세대 자신의 인증서 |

두 번째가 §6.2 의 `prepare` 를 가능하게 한다 — **게시하기 전에 새 세대를 그 자리에서
검증할 수 있다**(S8.prevalidate 로 확인). 절대경로를 구우면 세대 디렉토리를 옮길 수 없고,
경로에 세대 번호를 넣은 상대경로(`generations/2/certs/...`)를 쓰면 `current` 를 거칠 때
`current/generations/2/...` 로 풀려 깨진다.

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
선택형과 1:1 대응하지 않는다.

#### S14 실행 결과 (2026-08-18) — 위 표가 사실로 바뀌었다

통제 DNS(`spike/s14/dns.mjs`, 와이어 포맷 직접 구현)로 8/8 을 쟀다. `timeout` 을 만들려면
**응답을 안 주는** 서버가 필요한데 — 서버를 죽이면 ICMP port unreachable 이 돌아가 즉시
실패가 되지 timeout 이 아니다 — dnsmasq·CoreDNS 로는 그 침묵을 만들 수 없다.

| 잰 것 | 결과 |
|---|---|
| A 두 개 × HTTP·TCP·UDP | **셋 다 분산된다.** 서브시스템별 차이 없음 |
| `valid=` 대 레코드 TTL | **`valid=` 가 덮는다.** 같은 변경에 http(valid=2s) 1초, stream(TTL=8s) 5초 |
| AAAA 단독 | **붙는다.** A 레코드가 하나도 없어도 |
| SRV (`service=`) | **대상과 포트를 둘 다 준다.** 포트를 9099 로 돌리면 아무도 못 받는다 |
| 기존 연결 | **한 회차에서 안 끊기는 것을 봤다**(줄 수 4→17, 마지막이 여전히 `be-a-17`). 다만 **재현이 불안정하다** — 긴 연결이 아예 안 서는 회차가 있어 아직 확정하지 않는다 |

**그리고 실패 모드 셋이 실제로 갈린다:**

| DNS 응답 | 엔진 동작 | error.log |
|---|---|---|
| **NXDOMAIN** | **peer 를 뺀다 → 502** | `resolved (3: Host not found)` |
| **SERVFAIL** | 마지막으로 알던 peer 를 계속 쓴다 | `resolved (2: Server failure)` |
| **무응답(침묵)** | 마지막으로 알던 peer 를 계속 쓴다 | (조용하다) |

> **NXDOMAIN 만 fail-closed 다.** 그리고 셋 다 **설정할 수 없다** — 엔진이 각각 하나의
> 동작만 준다. 즉 우리 모델의 `on_nxdomain`/`on_timeout` **선택형은 대안 B 에서 표현
> 불가능하다.** 폴백으로 내려가면 그 두 필드는 값이 무엇이든 위 표대로 동작한다.
>
> **그 사실은 이제 `DataplaneCapabilities.nativeDns` 이다** (`src/engine/native-dns.ts`).
> `available: false` 면 표를 내놓지 않고, `true` 면 위 세 칸이 리터럴로 고정된다.
> 해독기는 `on_nxdomain`/`on_timeout`/`dns` 를 `unknown_field` 로 거절한다. 모델에
> 선택형을 두고 조용히 무시하는 길을 만들지 않는다.

**드레인도 마찬가지다.** (관측된 한 회차 기준) 기존 연결이 안 끊기는 것은 §7.3 표의 *"`quiesced`·deadline·강제
종료"* 가 안 된다는 것과 같은 동전의 양면이다 — 엔진은 **기다려 주지만 재촉할 수 없다.**

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
  - ⚠️ v0 렌더러는 아직 TLS 종단을 내지 않으므로 `https` 리스너를 제공하지 않는다 (§4.1).
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
  → **노출은 구현됨** — `GET /certificates` 가 `domains`·`notBefore`·`notAfter`·
  `expiresInDays` 를, `/metrics` 가 `bary_certificate_expiry_seconds{certificate=...}` 를
  낸다. **자동 갱신은 아직 없다** (ACME · S18).

  **사실은 설정이 아니라 바이트에서 온다.** changeset 으로 받으면 클라이언트가 만료일을
  거짓말할 수 있고, 그러면 알람이 안 울린다. `put` 시점에 뽑아 내용 주소 참조
  (`store://name@version`)에 매달아 두므로 사실도 내용의 함수가 된다 — 거짓말할 자리가
  없다. 조회는 `facts.json` 만 읽으므로 **개인키를 안 읽는다**: 만료를 보려고 목록 조회마다
  키를 읽어 들이면, 그 위험 때문에 결국 안 보게 된다.
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

#### ADR-ACME (2026-08-18) — S18 이 잰 것 위에서 정한다

§8.2 는 스스로를 후보라고 적어 뒀고 S18 을 대응 게이트로 걸었다. S18 이 통과했으므로
**아래를 확정한다.** 여기 없는 것은 여전히 미정이고, 미정인 채로 둔다.

**① 챌린지 토큰은 conf 가 아니라 shared dict 에 산다.**

토큰은 주문마다 바뀐다. conf 에 실으면 **갱신 한 번에 세대 전환이 한 번** 붙는데, 그
대가는 이 저장소가 실측해 뒀다 — 세대 전환당 트래픽 **2.6%** 손실. 인증서가 여럿이고
90 일 주기면 그게 곱해진다. 멤버십 평면이 백엔드에 대해 푼 문제와 같은 문제이고 같은
수법으로 푼다(S1).

- dict 는 `bary_acme` 로 **멤버십과 분리한다.** 같이 쓰면 멤버십 staging 이 LRU 로 토큰을
  밀어내고, 그 실패는 *"인증서 발급이 가끔 안 된다"* 로 보인다.
- 토큰에 **30 분 만료**를 건다. S18 이 실측했다: **버려진 주문을 CA 는 안 치운다**
  (`pending` 으로 남는다). 우리가 안 치우면 dict 가 차고, 차면 LRU 가 살아 있는 토큰을
  밀어낸다.
- **`*_lua` 가 없는 엔진에서는 이 경로가 없다.** 그런 배포의 http-01 은 세대 전환을
  동반하고, 그건 열등한 게 아니라 다른 계약이다 — capability 로 갈린다.

**② 예약 라우트는 `location ^~ /.well-known/acme-challenge/` 로, 모든 http/https server
블록에 낸다 — default_server 를 포함해서.**

default 에 안 내면 *"설정을 넣어야 인증서를 받고, 인증서가 있어야 설정이 선다"* 가 된다.
첫 발급 시점에는 그 도메인의 라우트가 아직 없다.

> **여기서 실제로 물렸다.** default server 의 거절을 **server 레벨 `return 444`** 로 내고
> 있었는데, nginx 의 server 레벨 `return` 은 **rewrite 단계**에서 실행되고 그건 location
> 선택보다 **앞이다.** 그래서 예약 라우트가 렌더는 되는데 **도달할 수가 없었다** —
> conf 는 옳아 보이고 `nginx -t` 도 통과하는데 요청이 그냥 끊긴다(curl 은 `000`).
> 거절을 `location / { return 444; }` 로 옮겨 고쳤다. 의미는 같고, 더 긴 접두사가 이제
> 이길 수 있다.

**③ 사용자 라우트는 예약 경로를 가로챌 수 없다** (`acme_path_reserved`).

`^~` 는 정규식을 막지만 **더 긴 접두사는 못 막는다** — nginx 의 location 은 최장 접두사가
이긴다. 가로채면 CA 의 요청이 사용자 라우트로 가고, 증상은 "챌린지 검증 실패" 라 인증서
설정을 아무리 봐도 이상이 없어 보인다. 검증기가 막는다. 위쪽 경로(`/.well-known/`)는
더 짧으므로 허용한다.

**④ 와일드카드는 dns-01 만.** S18 이 CA 쪽에서도 그렇다는 것을 확인했다 — 와일드카드
authz 에는 http-01 이 **아예 없다**(`dns-01, dns-account-01, dns-persist-01`). §8.2 의
"모델에서 강제" 를 그대로 둔다.

**⑤ nonce 재시도는 5 회.** RFC 8555 §6.5 의 *"한 번은 반드시"* 는 **하한이지 운영값이
아니다** — S18 이 실측했다(§12.0 S18 절).

**⑥ 주문·챌린지는 설정이 아니라 운영 상태다** (2026-08-18, 마이그레이션 009).

`config_revisions` 에 안 들어간다. `backend_health` 와 같은 부류다:

- 리비전은 **불변**인데 주문은 상태가 계속 바뀐다
- 주문이 리비전에 들어가면 갱신 한 번마다 새 리비전이 생기고, **롤백이 "그때 진행 중이던
  주문" 을 되살린다** — 그건 되돌릴 대상이 아니다
- 설정 diff 에 "주문이 processing 이 됐다" 가 섞이면 plan 의 impact 가 거짓말이 된다

설정에 남는 것은 `certificates.material_ref` 뿐이고, **발급과 게시는 다른 사건이다** —
주문이 성공하면 그 참조를 바꾸는 changeset 을 만든다.

**⑦ 상태는 CA 의 것과 1:1 이 아니다.** CA 는 `pending/ready/processing/valid/invalid` 를
말하는데 그것만으로는 *"언제 다시 시도할 것인가"* 를 표현할 수 없다. 우리 상태는
`pending · validating · ready · issued · failed · abandoned` 이고, 재시도·백오프·포기를
우리가 든다 — S18 이 실측한 대로 **버려진 주문을 CA 는 안 치운다.**

- **인증서당 살아 있는 주문은 하나.** 부분 유일 인덱스로 DB 가 진다 — 갱신 스케줄러는
  주기적으로 도는데 매 틱마다 새 주문을 내면 레이트리밋에 그대로 걸린다. 끝난 주문은
  기록으로 남으므로 부분 인덱스여야 한다(전체 유일이면 재시도가 불가능하다).
- **실행권은 시간 기반 lease 다.** 리더가 둘일 수 있는 순간(§3.5 승계)에 같은 주문을
  둘이 몰면 nonce 가 서로를 깨뜨리고 챌린지를 두 번 수락한다. `FOR UPDATE SKIP LOCKED`
  로 집는다. 죽은 리더를 영원히 기다릴 수 없으므로 만료가 필요하고, 그 대가("죽은 줄
  알았는데 살아 있는" 창)는 CA 쪽 멱등성이 흡수한다.
- **백오프는 지수이되 상한이 있다**(60s → 1h). 무한히 늘리면 사람이 고친 뒤에도 몇 시간을
  기다리게 되고, 그건 "포기" 와 구분되지 않는다 — 포기는 `abandoned` 라는 이름이 따로 있다.
- **포기를 조용히 하지 않는다.** 8 회에서 `abandoned` 로 멈추고 사람이 봐야 한다. 계속
  재시도하면서 아무 말도 안 하는 것이 더 나쁘다.

**⑧ 고아는 "주문이 끝났나" 가 아니라 "자료를 놓았나" 로 판정한다.**

S18 이 실측했다 — 버려진 주문을 CA 는 `pending` 으로 남긴다. 주문 상태로 물으면 **영영
안 걸린다.** 그래서 `placed_at` 을 기록하고(놓을 예정과 놓았다를 구분한다), 끝난 주문의
자료는 즉시·진행 중인 주문의 자료는 오래됐을 때 고아로 본다. DB 가 "놓지도 않은 것을
치웠다" 를 막는다.

**아직 미정으로 남기는 것.** 갱신 시점 정책(만료 30 일 전 + 지터), CA 레이트리밋 헤더
해석, EAB, dns-01 프로바이더 인터페이스. 스케줄러를 실제로 붙이는 회차에 정한다.

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

v3 의 ledger 는 **crash-safe 하지 않았다.** insert 와 refcount 감소를 나눠 놓았기 때문이다.

```
ledger insert 성공 → (crash) → refcount 감소 안 됨
재시도 → UNIQUE 충돌로 insert 실패 → **감소가 영구 누락**
```

**refcount 를 파생값으로 두지 않는다.** 정본은 불변 참조 테이블이다.

```sql
-- 세대가 어떤 시크릿 버전을 쓰는지. 세대 생성 시 함께 삽입되고 이후 바뀌지 않는다.
generation_secret_ref (generation, secret_version)  PRIMARY KEY (generation, secret_version)
```

- **참조 수 = 살아 있는 세대 중 이 버전을 참조하는 행의 수.** 별도 카운터가 없으므로
  이중 감소도 누락도 원리적으로 생기지 않는다.
- 세대 tombstone → 행 삭제 → 시크릿 상태 판정을 **한 트랜잭션**으로 한다.
- 시크릿 자체는 상태를 갖는다: `live → delete_pending → deleted`.
  `delete_pending` 으로 옮기는 것과 참조 0 확인은 같은 트랜잭션이다.
  새 세대가 그 버전을 참조하려 하면 `delete_pending` 인 동안은 **거부**한다 — 삭제 직전
  zero-ref 재확인만으로는 그 사이 끼어드는 참조를 막지 못한다 (TOCTOU).
- 외부 SecretStore 삭제는 `delete_pending` 상태에서만 하고, 성공하면 `deleted` 로 옮긴다.
  실패는 재시도 + 누수 경보이며 **세대 GC 를 막지 않는다.**

```
1. GC 후보 = §8.4 root 어디에도 없음 AND 보존 개수 초과 AND 롤백 보존 경과
2. [트랜잭션] 세대 tombstone + generation_secret_ref 행 삭제
              + 참조 0 이 된 시크릿을 delete_pending 으로
3. 디스크 삭제 (실패해도 2 는 이미 확정. 재시도 가능)
4. delete_pending + 유예 경과 → 외부 SecretStore 삭제 → deleted
```

각 단계의 크래시는 DB 상태를 읽어 그 지점부터 재개한다 (§ 6.2 표 #10).

---

## 9. 드라이버 인터페이스

**포크하지 않는다.** OSS 코어에 인터페이스를 두고 조직별 구현을 별도 레포로 주입한다.
라이선스: **Apache-2.0**.

### 9.1 확정 시점

각 인터페이스는 **최초 소비 버전 직전에 고정한다.**

| 인터페이스 | 확정 시점 |
|---|---|
| `DataplaneDriver` — **설정 평면만** | v0.1 이전 |
| `AuditSink` / `Notifier` / `AuthProvider` | v0.1 이전 |
| `DataplaneDriver` — **멤버십 평면** | v0.3 이전 (§6.5 커서와 **같이**) |
| `SecretStore` / `DNSProvider` | v0.6 이전 |
| `BackendDiscovery` | v0.7 |

v0.7 은 **참조 구현 + 로딩 하드닝 + 호환성 테스트 키트**다.

#### 멤버십 계약을 v0.1 에서 뺀다 — v4 결정의 철회

v1 부터 v4 까지 §15 R4 는 **"계약 v0.1 / 구현 v0.3"** 이었다. 이걸 철회한다.

5차 검수가 그 결정을 실증으로 무너뜨렸다. 멤버십 계약(`stage`/`commit`/`abort`/`applyHealth`)을
구현 없이 먼저 고정했더니, **정상적인 헬스 진행만으로 전환이 깨졌다.** `stage` 시점의
`membership_revision` 까지 exact CAS 하는 계약이었는데, 활성 epoch 안에서 헬스가 R1→R2 로
가면 `commit` 이 `coordinate_mismatch` 로 거부된다. nginx 는 새 세대를 서빙하는데 DP 좌표는
옛 epoch 에 남는다. 재현했다.

이건 계약의 버그가 아니라 **§6.5 의 cut/HWM/replay 없이는 계약을 쓸 수 없다**는 뜻이다.
topology epoch CAS 와 가변 membership 커서를 분리해야 하는데, 그 분리는 커서 스키마와
트랜잭션 프로토콜이 있어야 정의된다. 그건 v0.3 의 일이다.

**구현하지 않은 계약은 고정할 수 없다.** 고정한 것처럼 보였을 뿐이고, 그래서 5차까지
아무도 못 봤다. 멤버십은 §6.5 커서와 **같은 버전에서 같이** 고정한다.

### 9.1.1 v0.1 이 고정하는 것 — surface 확정

#### 동결을 둘로 나눈다 (6차 검수 뒤)

원래 질문은 "v0.1 **타입·API·DB 스키마** 를 고정할 수 있는가" 였다. 이걸 둘로 나눈다.

| | 무엇 | 언제 |
|---|---|---|
| **A. 타입·DP ABI** | 모델·렌더러·`DataplaneDriver`·세대 규약 | **지금** — 구현과 테스트가 있다 |
| **B. API·DB 스키마** | OpenAPI · PG DDL · changeset · auth/audit | **구현과 함께** |

**왜 나누는가.** 여섯 번의 검수가 같은 것을 가르쳤다 — **구현하지 않은 계약을 고정하면
반드시 깨진다.** §9.1 에서 멤버십 계약을 철회한 이유가 그것이고, 5차 반례 ⑤ 는 정상적인
헬스 진행만으로 그 계약이 깨지는 것을 보여 줬다.

지금 B 를 고정하면 같은 실수를 더 큰 규모로 반복한다. REST 서버도 정본 DB 도 reconciler 도
없는 상태에서 OpenAPI 와 DDL 을 적어 두면, 그건 계약이 아니라 **아직 검증되지 않은 희망**이다.
6차 검수의 표현대로 "C 계열은 실행 테스트가 아니라 명세뿐" 이다.

A 는 다르다. 렌더러는 61 개의 엔진 사실 위에 서 있고, DP ABI 는 반례 conformance
157 건과 실물 nginx e2e 14 건이 지킨다. 이건 고정할 수 있다.

**A 의 동결 대상은 `src/index.ts` 다.** 문서의 문장이 아니라 값이다 — 목록이 바뀌면
`tests/conformance/v01-surface.test.ts` 가 깨진다. 6차 검수가 "뺐다고 적은 기능이 공개
타입에 남아 있다" 고 지적했는데, 그건 표면이 코드로 정의돼 있지 않아서 생긴 일이다.

**B 로 미루는 것.** REST 서버 · OpenAPI · PG migration/DDL · `ConfigRevision`/changeset
sealing · `AuditSink`/`Notifier`/`AuthProvider` · §4 의 `ResourceMeta`. 이것들은 v0.1
**출시**에는 필요하지만 지금 고정할 근거가 없다.

> **B 진행 (2026-08-16).** PG DDL · `ConfigRevision` · changeset sealing · 감사가 생겼다
> (`src/store/`, `tests/store/` 19건, **실물 PostgreSQL**). 아직 **동결하지 않는다** —
> REST 서버와 apply 배선이 붙기 전까지는 이 스키마가 정말 필요한 모양인지 알 수 없고,
> "구현과 함께 고정한다" 는 것은 구현이 *끝나고* 고정한다는 뜻이다. `src/index.ts` 에도
> 안 올린다.
>
> 제약 층은 §4.0 이 정한 대로 나눴고, **어느 층이 무는지 실제로 재 봤다.** 애플리케이션
> 경로에서는 CHECK 가 물고, 복합 FK 는 **클래스를 속였을 때**의 방벽이다 — 두 장치가
> 각각 다른 것을 막는다. psql 로 직접 거짓 클래스를 넣어 FK 가 무는 것을 확인했다.



freeze 대상을 좁힌다. **여기 없는 것은 v0.1 의 타입·API·DB 스키마에 등장하지 않는다.**
"나중에 쓸지 모르니 필드만 미리" 는 금지다 — 표현 가능한 것은 언젠가 들어온다.

| | v0.1 에 **넣는다** | 근거 |
|---|---|---|
| 모델 | 리스너·풀·백엔드·라우트, **프로토콜별 판별 유니온** | 렌더러가 이미 셋을 구분해 렌더한다 |
| 프로토콜 | `http` · `tcp` · `udp` **평문** + `tls_passthrough` | E 계열 61건이 엔진 동작을 고정했다 |
| 알고리즘 | `round_robin` · `hash` · `source_ip_hash` | S6·S15 없이 정직하게 낼 수 있는 것 |
| 백엔드 반영 | **`nginx.conf` 에 렌더 → 세대 전환** | reload 로 바뀐다. 무중단 격리는 v0.3 |
| 활성화 | 세대 게시 · HUP · **`ActivationEvidence`** | S7 이 판정 절차를 실증했다 |
| apply | `ApplyOperation` — 소유권 예약 · 평면별 진행 · 종단 상태 | S11·S12 가 여기 걸려 있다 |
| 드라이버 | `DataplaneDriver` **설정 평면만** | 위 |
| 그 외 | 최소 auth/audit, `AuditSink`/`Notifier`/`AuthProvider` | API 가 요구한다 |

| | v0.1 에서 **뺀다** | 옮기는 곳 |
|---|---|---|
| 멤버십 드라이버 · 이중 zone · 헬스 프로버 | §6.5 커서와 함께 | **v0.3** |
| 드레인 관측 (S2) · `least_conn` (S6) | 기능 | v0.3 · 미정 |
| TLS 종단 · `SecretStore` · ACME · 인증서 세대 롤백 | S8·S16·S17·S18 | **v0.6** — 1단계 완료(2026-08-17): 업로드 인증서 종단·SNI 별 선택·SNI 별 policy·갱신·롤백. **남은 것: GC 원장(S13)**. OCSP stapling 은 **안 짓기로 했다** (§4.6.1 — 잴 수 없고, 주 CA 가 OCSP 를 접었다) (ACME·SNI↔Host·SecretStore GC 는 2026-08-18 구현) (만료 감시·자료 검증은 2026-08-17 구현) |
| **HTTP/2** (https, server 별 `http2 on`) | §4.9 실측 — capability 로 가른다 | **v0.6** |
| **HTTP/3 (QUIC)** | **S20 실행 완료 (2026-08-18) — h3 자체는 된다(7/8). 깨진 것은 ② 뿐이고, 그것이 결정적이다: quic↔udp 충돌을 엔진도 검증기도 못 잡는다(E65). 축소 규칙대로 h3 는 모델에서 계속 뺀다.** | v0.7 |
| SNI 결과 **3분기 관측**(S9) · `strict_priority` (S10) | 기능 | v0.2 · 미정 |
| GC 원장 (S13) | 세대 보존은 **수동 상한** + **시간 보호**로 대체 | v0.6 — 원장은 끝내 안 짓는다. S13 이 마커로는 옛 워커를 못 센다고 실측했고, `worker_shutdown_timeout` 이 그 대신 **상한**을 준다 (2026-08-18) |
| 백엔드 디스커버리 (S14 대안 B) | **S14 부분 통과 (2026-08-18, 7/8)** — 「기존 세션」만 재현 불안정. 실패 모드 표는 `DataplaneCapabilities.nativeDns` 로 표면화 (2026-08-18). 모델에 선택형 없음 | v0.7 |

**`tls_passthrough` 와 `source_ip_hash` 는 v0.1 에 있다 — 7차 검수 뒤 뒤집은 결정.**

7차 검수가 "뺐다고 적은 것이 공개 모델에 남아 있다" 고 지적했다. 맞는 지적인데, 답은
코드에서 빼는 것이 아니라 **문서를 사실에 맞추는 것**이었다.

원래 v0.2 로 미룬 것은 `tls_passthrough` **자체**가 아니라 **SNI 결과 3분기 관측**(S9)
이었다 — TLS-no-SNI / malformed / preread timeout 을 구분해 보여 주는 것. 패스스루 렌더
자체는 엔진 사실 9건(E26 계열)과 골든 2건이 이미 지키고 있고, `ssl_preread` 경로는
`render.ts` 에 있다. 부재·파싱 실패는 v0.1 에서 계속 `reject` 로 고정한다 (§4.1).

`source_ip_hash` 도 같다. `hash` 의 특수형이고 `stream_realip` 유무에 따른 변수 선택까지
엔진 제약 검증기가 다룬다 (§7.6).

**동작하고 검증된 것을 문서에서만 빼는 것은 축소가 아니다.** 그러면 문서와 코드가 다시
갈라진다 — 그게 지난 여섯 번의 패턴이었다.

이 절단으로 **v0.1 freeze blocker 에서 빠지는 것**: S2 · S6 · S8 · S9 · S10 · S13 · S14 ·
S15 · S16 · S17 · S18 · S19. 남는 것은 **S7(완료) · S11 · S12** 와 S5 의 평면 부분 전환뿐이다.

#### 그래도 남는 v0.1 blocker

범위를 줄여도 사라지지 않는 것이 넷이다. 전부 5차 검수에서 **녹색 테스트 상태로 재현됐다.**

1. ~~**소유권과 원자성.**~~ ✅ **해소** — `src/dp/agent.ts`.

   `(plane, target_activation_epoch)` 를 **단일 CAS 슬롯**으로 예약한다. 슬롯은 정본 튜플
   전체를 들고 있으므로 주인이 정해지고, 남의 슬롯에는 stage 도 abort 도 닿지 않는다.
   `ApplyRunner.run` 은 **게시보다 저널 기록보다 먼저** `reserve` 를 지난다 — §3.5 의
   "토큰을 side effect 전에 fsync 한다" 가 코드에서 성립한다.

   인스턴스 간 lost update 는 `AgentState.version` **durable CAS** 로 닫았다. 밀리면 다시
   읽고 **다시 판정한다** — 낡은 상태로 내린 판정을 재사용하지 않는다.

   종단 상태는 `activated` / `failed` / `aborted` **셋이 상호 배타적**이다. 실패도 슬롯을
   반납하므로 좌표가 영구히 잠기지 않고, 지연 commit 이 뒤늦게 좌표를 옮기지 못한다.
   `aborted`·`failed` 는 replay 를 거부하고 `activated` 만 통과시킨다 — 전부 거부하면
   복구가 깨지고 전부 통과시키면 abort 가 되살아난다.

   > **범위가 (전환, 토큰) 이다** (44차에 바뀌었고 45차에 계약으로 적었다).
   > 원장의 키가 `operationId:transitionId:leaderToken:plane` 이므로 **"모든 replay"**
   > 는 **같은 토큰**에 대해 참이다. 신임 리더가 같은 이름을 다시 내면 DP 는 통과시킨다.
   >
   > ⚠️ **레거시 기록에는 이 계약이 적용되지 않는다** (47차 E-47-1, 실측). 44차 이전
   > 코드가 남긴 키(`opId:tid:plane`)에는 토큰이 없어 **신원을 복원할 수 없고**, 그래서
   > 조회가 그것을 **이름 단위**로 본다. 옛 `aborted` 가 있는 이름은 **어떤 토큰의
   > 재발급도 영구히 거부**된다.
   >
   > ⚠️ **"이주는 불가능하다" 고 적었던 것은 과잉 주장이다** (48차 E-48-1, 실측).
   > **키에서는** 못 되살리지만 **상태에서는 되살린다** — `completed` 항목의 canonical
   > 첫 세그먼트와 저널의 op 가 둘 다 그 전환의 토큰을 들고 있다. 44차 이전은 이름
   > 단위 봉인이라 aborted 이름당 전환이 하나뿐이므로 대응이 **모호하지 않다.**
   > 즉 **조건부 이주**(재료가 있으면 변환, 없으면 비관 유지)가 건전하게 가능하다.
   >
   > **다만 그 재료는 `completed` 가지치기(보존 64)가 점진적으로 파괴한다 — 닫히는
   > 창이다.** 지금 이주를 안 하는 것은 판단이고, 하려면 그 창 안에 해야 한다.
   >
   > 46차가 "영구" 를 확정하고도 이 예외를 여기 안 적었다 — **계약을 적은 자리에
   > 예외를 안 적으면 그 계약은 절반만 참이다.**
   >
   > **포기는 전환에 붙지 이름에 붙지 않는다.** 이름에 붙이면 정당한 승계가 오살되고
   > (43차 CE-43-A), 옛 리더의 포기는 **그 리더의 시도**에 대한 판단이며, 신임의
   > 재발급은 **컨트롤 플레인의 결정**이다. DP 가 막는 것은 낡은 행위자의 부활뿐이다.
   >
   > **대가**: 운영자 abort 뒤 신임의 같은-이름 재발급을 DP 는 안 막는다.
   > **그 게이트는 v0.2 컨트롤 플레인에 있어야 한다.** 46차가 짚기를, 이 문장이 없으면
   > **설계 문서 자체가 "DP 가 막아 준다" 고 거짓말한다** — 실제로 그랬다.

   계약은 `tests/conformance/review5-reservation.test.ts` 에 있다 (14건). 뮤턴트 7종
   (예약 제거 · 주인 무시 · 남의 슬롯 삭제 · CAS 제거 · 저널 소유권 제거 · 슬롯 미반납 ·
   좌표 뺀 정본)이 전부 잡히는 것을 확인했다.
2. ~~**`ApplyOperation` 스키마.**~~ ✅ **해소** — `src/dp/operation.ts`.

   `ApplyOperation` 이 봉투 + **평면별** 목표 + 목표 세대를 싣는다. 저널이 이걸 통째로
   들고 다니므로 복구가 같은 오퍼레이션을 재개한다.

   두 평면이 **한 오퍼레이션으로** 넘어간다. 예약 → 게시 → **전 평면 staging** → HUP →
   증거 관측 → **전 평면 commit**. 한 평면의 예약이 막히면 이미 잡은 예약을 반납하고
   **아무 부작용도 내지 않는다.** 일부만 넘어가면 `partially_activated` 이고 결과의
   `progress` 가 평면별로 어디까지 갔는지 말한다 (§3.4).

   `ActivationEvidence` 가 명시적 타입이 됐고 **`commit` 의 인자다** — 근거 없이 좌표를
   옮길 수 없다. `provesActivation` 이 세대·config test·error log 증가분·워커 집합을 함께
   본다. 관측하지 못한 것(`undefined`)은 반증이 아니고 **관측해서 나쁜 것만** 반증이다.
   S7 이 실증한 것이 그거다 — 세대만 보면 4027ms 걸리던 판정이 error log 워터마크를
   넣자 71ms 가 됐다. e2e 가 실물 컨테이너에서 이 워터마크를 잰다.

   계약은 `tests/conformance/review5-apply-schema.test.ts`. 뮤턴트 8종이 전부 잡힌다.
3. ~~**모든 변이에 같은 envelope.**~~ ✅ **해소** — `src/dp/driver.ts`.

   `MutationEnvelope` 하나가 모든 변이를 지난다. `DataplaneDriver` 의 설정 경로도
   리더 토큰과 `affectedPlanes` 를 받으므로, 봉투 없이 부작용을 내는 경로가 없다.
   봉투가 말한 평면과 실린 목표가 **정확히 일치**해야 한다 — 무엇을 바꾸는지 말하지
   않는 변이는 감사도 롤백도 안 된다.

   **참조 구현(`LocalDataplaneDriver`)을 같이 뒀다.** 인터페이스만 두고 구현을 미루면
   §9.1 의 멤버십과 같은 일이 난다 — 쓰이지 않는 계약은 깨진 채로 통과한다.
4. ~~**fail-closed 타입.**~~ ✅ **해소** — `src/model/provisional.ts` · `src/validate/model.ts`.

   타입을 **두 층**으로 나눴다. `RawModel` 은 신뢰할 수 없는 입력이고(JSON·DB·API 에서
   온 그대로), `Model` 은 검증을 통과한 것이다. 리스너는 프로토콜 판별 유니온이라
   UDP 에 `acceptProxyProtocol` 을 넣으면 **컴파일이 막힌다.**

   검증기가 `RawModel` 을 받는 게 핵심이다. 좁혀진 타입을 받으면 정작 막아야 할 조합을
   **표현할 수가 없어서 아무것도 검사하지 못한다** — 타입은 런타임 입력을 대신하지 못한다.
   두 층은 같은 규칙을 각자 검사한다.

   새 거부 다섯: `listener_requires_default_pool` · `route_protocol_mismatch` ·
   `pool_protocol_mismatch` · `orphan_backend` · `option_not_supported`.

   덤으로 `render.ts` 의 `listener.defaultPool!` 논넌널 단언이 사라졌다. tcp·udp 리스너에
   기본 풀이 **타입으로** 필수가 됐기 때문이다. 그 단언이 가리고 있던 것이 바로 이
   반례였다 — 기본 풀 없는 TCP 리스너는 예외 없이 렌더 결과에서 통째로 빠졌다.

   계약은 `tests/conformance/review5-fail-closed.test.ts` (19건, positive control 4건 포함).
   뮤턴트 6종이 전부 잡힌다.

#### 그다음에 드러난 것

5. ~~**durable store 구현체가 없다.**~~ ✅ **해소** — `src/dp/store-fs.ts`.

   `FileStore` 가 넷을 세운다.

   · **원자적 교체** — 임시 파일 → 내용 fsync → rename → **부모 디렉토리 fsync**.
     rename 만 하면 디렉토리 엔트리가 아직 캐시에 있어 전원이 끊기면 되돌아간다.
   · **손상 ≠ 빈 것** — 체크섬·스키마·부분 쓰기를 검사하고 **던진다.** 여기서
     `undefined` 를 돌려주면 Agent 는 신규 부팅으로 알고 `maxLeaderToken` 을 0 으로
     되돌린다. **손상 하나가 §3.5 펜싱을 통째로 무너뜨리고 옛 리더에게 문을 연다.**
   · **버전 CAS** — 밀린 쓰기를 거부한다.
   · **프로세스 간 단일 writer** — 락 파일. 죽은 프로세스의 락은 pid 생존 확인 후
     회수한다. pid 재사용이라는 잔여 경합이 있지만 **안전한 쪽으로 틀린다**(안 열린다).

   계약은 `tests/conformance/review5-durable-store.test.ts` (17건). 프로세스 간 배제는
   **진짜 두 번째 node 프로세스를 띄워** 확인한다 — 같은 프로세스 안의 모의로는 증명되지
   않는 성질이다. e2e 도 `MemoryStore` 에서 `FileStore` 로 옮겼다. 뮤턴트 6종이 잡힌다.

   **증명하지 못한 것:** fsync 의 *순서*는 이 테스트로 확인되지 않는다. 전원 차단 주입이
   필요하고, 그건 파일시스템 수준 fault injection 이다. 코드에는 있지만 검증되지 않았다.

#### ⚠️ 6차 검수 — 위 "해소" 중 셋은 부분적이었다

전부 녹색 테스트 상태에서 재현했다. **닫혔다고 적은 것을 다시 연다.**

| | 무엇이 남았나 |
|---|---|
| blocker 1 | 펜싱이 `run()` 에만 있다. `drive()` 는 리더 토큰을 재검사하지 않아 **복구 경로로 들어오면 게시한다**. 판정은 `stale_leader` 인데 `publishCalls = 1` 이다. |
| blocker 2 | 증거가 **기록일 뿐 검사가 아니다.** `DpAgent.commit()` 이 `provesActivation` 을 부르지 않는다. 엉뚱한 세대·config test 실패·워커 0/4 로도 좌표가 움직인다. 러너가 검사하지만 §3.5 는 **Agent 가 최종 심판**이라고 말한다. |
| blocker 4 | ✅ **해소** — `src/model/decode.ts`. 아래 참조. |

##### 런타임 해독기 (6차 ①)

경계에서 `unknown` 을 해독한다. 세 규칙이다.

1. **모르는 값은 거부한다.** enum 은 아는 것만 통과한다.
2. **모르는 키도 거부한다.** 조용히 무시된 설정은 "저장은 됐는데 동작 안 함" 이 된다.
   `defaultPoool` 오타 하나가 기본 풀 없는 리스너를 만들고, 그건 렌더에서 사라진다.
3. **강제 변환하지 않는다.** `"8080"` 은 8080 이 아니라 오류다. 변환은 의미를 바꾼다.

역할을 갈라 뒀다. `decodeModel` 은 **모양과 타입**만 보고, `validateModel` 은 **의미**
(참조 무결성·소켓 충돌·프로토콜 정합)를 본다. `parseModel` 이 둘을 순서대로 돌린다 —
모양이 깨진 값에 참조 무결성을 물으면 진짜 원인이 오류 더미에 묻힌다.

`render` 도 해독을 한 번 더 한다. 타입이 `Model` 이라는 것은 컴파일 타임의 약속일
뿐이고, 캐스팅해 넣으면 그 약속은 없는 것과 같다. 6차 반례가 정확히 그 경로였다.

`protocol: 'https'` 는 이제 이렇게 끝난다.

```
validateModel  → 0 건        (의미 검증기다. 여기서 0 인 것이 맞다)
decodeModel    → invalid_enum
parseModel     → 아는 값이 아니다: "https"
render         → ModelValidationError
```

계약은 `tests/conformance/review6-runtime-decode.test.ts` (25건, positive control 3건
포함). 뮤턴트 7종이 전부 잡힌다 — enum 검사 제거 8건, 모르는 키 무시 4건, 필수 필드
제거 3건, 숫자 강제 변환 1건, 범위 검사 제거 1건, render 해독 제거 1건, 프로토콜별
필드 구분 제거 1건.

새로 드러난 것도 넷이다. ⑤ 를 빼고 전부 닫혔다.

##### 전역 apply 소유권 (6차 ②③④⑥⑦)

다섯 반례는 증상이 다르지만 원인이 하나였다. **예약이 슬롯만 독점하고 apply 실행권을
독점하지 않았다.** 저널도 `current` 도 HUP 도 전역인데 예약은 `(평면, epoch)` 별이다.

- **`activeOperation`** — 한 번에 한 오퍼레이션만 apply 경로를 갖는다. `reserveAll` 이
  전 평면을 **한 임계구역에서** 잡으므로 부분 예약이 남지 않는다.
- **저널 `seq` CAS** — 단계 전이를 한 명만 이긴다. 진 쪽은 다시 읽고 따라간다.
- **apply 실행 큐** — CAS 만으로는 부족했다. 진 러너가 다시 읽고 따라가는 사이 아직
  신호가 반영되지 않았으면 "재전송할 차례" 로 보여서 HUP 이 하나 더 나갔다(실측 2회).
  상태기계는 한 번에 하나만 돈다. 프로세스 간은 `FileStore` 락, 프로세스 안은 이 큐다.
- **매 단계 펜싱** — `drive()` 가 **부작용 앞에서** 토큰과 소유권을 다시 본다. 예약은
  과거의 승인일 뿐이다. 읽기 전용이라 durable 쓰기가 늘지 않는다.
- **`commit` 이 증거를 판정한다** — `provesActivation` 을 Agent 안에서 부른다. 러너도
  보지만 러너를 거치지 않는 호출이 있으면 그 검사는 없는 것과 같다. §3.5 는 Agent 가
  최종 심판이라고 말한다.
- **좌표 정규형** — `tupleFor` 가 `BigInt` 정규형으로 만들고 10진 정수가 아니면 거부한다.
- **`partially_activated` 는 비종단**이다. 유한 재시도 뒤 소유권과 남은 예약을 반납한다.

계약은 `tests/conformance/review6-apply-ownership.test.ts` (17건). 뮤턴트 6종이 잡힌다.

그중 하나(전역 소유권 검사 제거)는 처음에 **안 잡혔다.** 테스트가 "거부됐다" 만 봤는데,
끼어든 오퍼레이션이 예약을 훔친 뒤 다른 지점에서 막혀도 그건 참이었다. 거부되기 전에
자원을 가져갔는지까지 봐야 한다.

연속 오퍼레이션 문제는 **실물 e2e 가 먼저 잡았다.** 저널은 하나뿐이라 앞선 오퍼레이션의
종단 기록이 남는데, 그걸 그대로 두고 진행하면 남의 저널을 읽고 스스로 막힌다.

##### 세대와 오퍼레이션의 결박 (6차 E)

`publish()` 는 디렉토리와 `nginx.conf` 의 **존재만** 확인했고, `.tmp-N`·manifest·디렉토리
rename 을 하는 코드는 아예 없었다 — 테스트가 세대를 손으로 써 뒀을 뿐이다. 그래서
**같은 세대 이름 아래 임의의 바이트를 활성화하고 좌표까지 commit** 할 수 있었다.

- **`materializeGeneration`** — `.tmp-<이름>-<nonce>/` 에 전부 쓰고 fsync 한 뒤 통째로
  rename 한다. 반쯤 쓰인 세대가 `generations/` 에 보이는 순간이 없다. manifest 를
  **마지막에** 쓰므로 그게 있으면 나머지도 있다는 뜻이 된다.
- **세대는 불변이다.** 같은 이름에 다른 내용이 오면 거부한다. 둘 중 하나는 거짓말인데
  어느 쪽인지 알 방법이 없다.
- **`ApplyOperation.generationDigest`** — 이름이 아니라 **내용**이 무엇을 활성화하는지
  말한다.
- **`preflight` 단계** (§6.2 #2) — 게시 **앞에서** 디스크를 다시 읽어 manifest 와
  대조하고 `nginx -t` 를 돌린다. manifest 만 믿으면 manifest 만 맞고 내용이 바뀐 세대를
  활성화한다. `nginx -t` 를 **돌리지 못한 것**은 실패가 아니다 — 관측 못 한 것과
  거부당한 것은 다르다 (§6.3).

이걸로 §6.2 표 **2행**이 크래시 지점 매핑에 들어왔다. e2e 도 손으로 쓰던 세대를
materializer 로 바꿨다 — 컨테이너 e2e 는 manifest 없는 디렉토리라 실제로 막혔다.

계약은 `tests/conformance/review6-generation.test.ts` (17건). 뮤턴트 7종이 잡힌다.

#### 락과 쓰기 권한 (6차 ⑤)

세 우회의 원인이 하나였다. **락을 잡는 것과 쓰는 것이 연결돼 있지 않았다.** `open()` 만
경쟁했고 `save()` 는 아무것도 확인하지 않았다.

- 락 레코드에 **nonce** 를 둔다. pid 만으로는 놓았다 다시 잡은 같은 프로세스와 회수당한
  뒤의 옛 핸들을 구별하지 못한다. `save()` 는 매번 그게 아직 내 것인지 확인한다.
- `release()` 도 nonce 를 확인한다 — **내 락만 지운다.**
- 읽기 전용은 `ReadOnlyFileStore` 다. `save()` 가 타입에도 런타임에도 없다.
  "쓰기에만 쓰지 마세요" 는 계약이 아니다.
- 락 파일은 **완성된 상태로 건다** (`link`). `wx` 로 만들고 나서 내용을 쓰면 그 사이에
  남이 빈 파일을 읽고 "망가진 락" 으로 판단해 지울 수 있다.
- 읽을 수 없는 락은 **회수하지 않는다.** 자동 회수는 편하지만 판단이 틀리면 두 writer 가
  열린다. 가용성보다 단일 writer 가 먼저다 — 사람이 치우게 둔다.

계약은 `tests/conformance/review6-store-lock.test.ts` (12건). 뮤턴트 5종이 잡힌다.
**락 생성 자체의 원자성은 검증되지 않았다** — `link` 와 `wx`+쓰기는 중간 시점을 관측해야
갈린다. fsync 순서와 같은 부류로 남겨 둔다.

#### 다섯이 닫힌 뒤 남은 것 (6차 이전 판단 — 위 표로 갱신됨)

freeze 판정을 위해 **다음 검수가 확인해야 할 것**을 적어 둔다. 스스로 Go 라고 적는 것은
지금까지 다섯 번 틀렸다.

- fsync 순서가 검증되지 않았다 (위).
- ~~S12 의 크래시 지점이 §6.2 표에 매핑되지 않았다.~~ ✅ **해소** —
  `tests/conformance/review5-crash-points.test.ts`.

  durable 쓰기를 **상태의 차이로 분류**해 안정된 이름을 준다 (`reserve:http` ·
  `stage:stream` · `commit:http` · `journal:<phase>` …). 쓰는 쪽이 라벨을 들고 다니지
  않으므로 프로덕션 코드에 테스트용 인자가 새지 않는다.

  판정은 개수가 아니라 **집합 일치**다. 표의 3~8 행 각각에 대응하는 "A 후 B 전" 구간이
  존재하는지 본다. 덮지 않는 행(1·2·9·10·11)은 **왜 안 덮는지**를 코드에 적어 두고 11 행
  전체가 분류됐는지 검사한다 — 범위가 바뀌면 거기가 걸린다.

  뮤턴트 5종이 잡히고, 그중 둘(publish·reload 계측 제거)은 **옛 개수 검사가 정확히 못
  잡던 것**이다.

  그 과정에서 설계 결함이 하나 드러났다. 여러 평면 중 하나의 예약이 막혀 이미 잡은 것을
  놓을 때 `abort` 를 썼는데, abort 는 전환을 **종단으로 닫는다.** 그러면 크래시 한 번이
  그 `operation_id` 를 영구히 오염시켜 같은 오퍼레이션으로 재시도할 수 없다. 아무 부작용도
  내지 않았으므로 "없던 일" 이어야 한다 (§6.2 #1). `release` 를 따로 뒀다 — 슬롯과
  **멱등 기록을 함께** 지운다. 기록을 남기면 재시도의 `reserve` 가 캐시된 ACK 를 받아
  슬롯 없이 성공했다고 답한다.
- ~~e2e 가 http 평면만 실물로 확인한다.~~ ✅ **해소** — `tests/e2e/`.

  세대에 stream 블록을 넣어 **두 평면이 한 HUP 으로 함께** 넘어가는 것을 실물에서 본다.
  다만 갈라 적는다 — 마커 두 개가 바뀌는 것은 **엔진 사실**이고, 두 평면 로직의 증거는
  **좌표와 progress** 다.

  `FsEffects` 는 **DP 컨테이너 안에서** 태운다 (`agent-in-container.test.ts`). 호스트
  심볼릭 링크 교체가 컨테이너에 전파되지 않는 것은 `mv -T` 버그를 고친 뒤 Node 의
  `renameSync` 로 **다시 실측했고 결과가 같았다** — 플랫폼 제약이 맞고, §11.1 이 말한
  배치(에이전트는 DP 컨테이너 안)가 답이다. 그래서 우리 코드를 번들해 컨테이너에 넣고
  `FileStore` · `DpAgent` · `FsEffects` · `ApplyRunner` 를 전부 실물로 돌린다.

  거기서 S7 의 워터마크가 신호 시점 기준인 것까지 확인한다. **다만 bind 실패 자체는
  워터마크 없이도 잡힌다** — nginx 가 옛 설정을 유지해 마커가 안 바뀌기 때문이다.
  뮤테이션으로 확인했고, 그렇게 적어 뒀다. S7 의 기여는 *탐지 가능성* 이 아니라
  *탐지 지연* 이었고 그 지연은 여기서 재지 않는다.
- §6.5 커서·cut·replay 는 범위 축소로 **v0.3** 이다 — v0.1 freeze 의 blocker 가 아니다.

**순서.** 위 넷을 스키마로 먼저 정의하고, 재현된 반례를 conformance test 로 고정한 뒤,
구현이 그걸 통과하게 만들었다. 넷은 닫혔고 5번이 남았다.

### 9.2 계약 — v0.1 (설정 평면)

> **이 절은 정본이다.** 6차 검수가 "§9.2 와 실제 `DataplaneDriver` 가 전혀 다른 ABI"
> 라고 지적했다. 문서는 `capabilities/render/prepare/commit/abort/status` 와 멤버십
> 메서드를 말하는데 코드는 다른 것을 한다. 아래는 `src/dp/driver.ts` 다.
> 원래 그리던 넓은 계약은 §9.2.1 에 **비규범**으로 남겼다.

```ts
/** 모든 변이가 지나는 봉투. 설정이든 멤버십이든 같다 (§3.6). */
export type MutationEnvelope = {
  leaderToken: string;
  operationId: string;
  transitionId: string;
  affectedPlanes: Plane[];        // 비어 있으면 거부
};

export type ApplyOperation = MutationEnvelope & {
  planes: Partial<Record<Plane, PlaneTarget>>;   // { expectedCurrent, target, payloadDigest }
  targetGeneration: string;
  generationDigest: string;       // §7.2 manifest — 이름이 아니라 내용
};

export type ApplyResult = {
  phase: ApplyPhase;                                  // §6.2
  progress: Record<Plane, PlaneProgress | undefined>; // 평면별로 어디까지 갔나
  partialTransition: boolean;                         // §3.4
  evidence?: ActivationEvidence;                      // 좌표를 옮긴 근거 (§6.3)
};

export interface DataplaneDriver {
  /** §3.5 — 신임 리더는 어떤 operation 보다 먼저 이걸 끝낸다. */
  fence(leaderToken: string): Promise<{ maxToken: string }>;

  /** 게시 → staging → HUP → 활성화 판정 → 좌표 이동. **재진입 가능**하다 (§6.2). */
  applyConfig(op: ApplyOperation): Promise<ApplyResult>;

  /** 진행 중이던 것을 이어받는다. 무엇을 하던 중이었는지도 저널이 안다. */
  recoverConfig(): Promise<ApplyResult>;

  /**
   * 전환을 포기한다. **오퍼레이션을 통째로 받는다** — 봉투와 epoch 만으로 튜플을
   * 재구성하면 정본이 달라져 슬롯의 주인으로 인정받지 못한다.
   */
  abortConfig(op: ApplyOperation): Promise<void>;

  // ── v0.3 멤버십 평면 (§6.5) ───────────────────────────────────────────
  //
  // §9.1 이 한 번 철회했던 계약이다. *"구현하지 않은 계약을 먼저 고정했다가 5차 검수에서
  // 깨진 것이 그것"* 이었고, 이번에는 **구현과 함께** 붙인다.
  //
  // 설정 경로와 다른 점은 **reload 가 없다**는 것이다. 좌표는 `membership_revision` 만
  // 앞으로 가고 `activation_epoch` 는 그대로다 — 세대 전환도 HUP 도 워커 재생성도 없다.
  applyMembership(op: ApplyOperation, plane: Plane,
                  slots: Record<string, string[]>): Promise<PlaneAck>;

  // 슬롯을 그대로 밀어 넣는다 — **좌표를 안 옮긴다** (§6.4 재시작 복원).
  // `lua_shared_dict` 는 프로세스 수명이라 엔진 재시작에 통째로 빈다. 그건 상태가
  // *바뀐* 것이 아니라 *사라진* 것이므로, 좌표를 옮기면 없는 전환을 발명하게 된다.
  pushMembershipDirect(plane: Plane, epoch: string,
                       slots: Record<string, string[]>): Promise<void>;

  /**
   * **종단 뒤에도 도는 수렴** (10차 검수).
   *
   * 러너는 유한하다 — `activated` 로 끝나면 더 보지 않는다. 그런데 옛 writer 는 그
   * 뒤에도 착지할 수 있다. 컨트롤 플레인이 이걸 주기적으로 불러야 "덮여서 수렴한다" 가
   * 성립한다. **전제**: 옛 writer 가 언젠가는 멈춘다 — 그건 리더 선출의 몫이다.
   */
  reconcileConfig(): Promise<ReconcileResult>;

  status(): Promise<DriverStatus>;
}
```

**여기 없는 것.** `capabilities()` · `render()` · `prepare()` 는 v0.1 에 없다. 렌더는
컨트롤 플레인이 하고 그 결과를 세대로 materialize 한 뒤(§7.2) 이름과 digest 로 넘긴다.
멤버십 메서드는 §6.5 커서와 함께 **v0.3** 이다 (§9.1).

**참조 구현이 함께 선다.** `LocalDataplaneDriver`. 인터페이스만 두고 구현을 미루면 §9.1 의
멤버십과 같은 일이 난다 — 쓰이지 않는 계약은 깨진 채로 통과한다. 실제로 처음 쓴
`abortConfig(봉투+epoch)` 는 구현해 보고서야 튜플이 안 맞는다는 걸 알았다.

#### 9.2.0 지금 고정하는 capability (S14)

§9.2.1 스케치의 `supports.dnsResolve: boolean` 은 **부족하다.** S14 가 잰 것은
있느냐가 아니라, 있을 때 실패 모드가 **설정 불가능한 표**라는 것이다. 지금 표면에
있는 것은 이것이다 (`src/engine/native-dns.ts`):

```ts
export const NATIVE_DNS_FAILURE_MODES = {
  nxdomain: 'drop_peer',   // peer 를 뺀다 → 502
  servfail: 'keep_last',
  timeout:  'keep_last',
} as const;

export type NativeDnsCapabilities =
  | { available: false }
  | { available: true; failureModes: typeof NATIVE_DNS_FAILURE_MODES };

export type DataplaneCapabilities = {
  nativeDns: NativeDnsCapabilities;
};
```

필드가 늘어나는 것은 표면 이동이다. 구현하지 않은 칸을 여기에 미리 넣지 않는다.

#### 9.2.1 원래 그리던 계약 (비규범 — v0.3+ / v0.6+)

아래는 멤버십·TLS·시크릿·capability 까지 포함한 전체 그림이다. **v0.1 은 이걸 구현하지
않는다.** 지금 고정하면 구현할 때 호환성을 깨야 한다.

```ts
export interface ConfigSnapshot {
  /** 큰 수를 JSON 으로 왕복시켜야 하므로 decimal string 이다. number 는 안전 정수를 넘긴다. */
  revision: string;
  topology_version: string;
  topology_digest: string;
  activation_epoch: string;
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

/** 평면별 ACK. 집계값 하나로는 어느 평면이 stage/commit 됐는지 알 수 없어 재시도가 불가능하다. */
export interface PlaneAck {
  plane: 'http' | 'stream';
  activation_epoch: string;
  membership_revision: string;
  payload_digest: string;
  transition_id: string;
  preparedWorkers: number;
  activeWorkers: number;
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
    dnsResolve: boolean;                  // 1.27.3+ resolve (대안 B) — **불충분. 정본은 §9.2.0 nativeDns**
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

  // 멤버십 평면 — §3.6 operation tuple 을 통째로 싣는다.
  // epoch 하나로는 "허가된 operation" 을 증명하지 못한다.
  stageMembership(op: OperationTuple, s: MembershipSnapshot): Promise<PlaneAck>;
  commitMembership(op: OperationTuple): Promise<PlaneAck>;
  abortMembership(op: OperationTuple): Promise<void>;
  pushHealthDelta(op: OperationTuple, d: MembershipDelta): Promise<PlaneAck>;
  fence(leaderToken: string): Promise<{ maxToken: string }>;   // §3.5 — 모든 operation 보다 먼저
}
```

**오류 분류** (`DriverError.kind`): `validation` | `capability` | `stale_leader` |
`coordinate_mismatch` | `digest_mismatch` | `transient` | `conflict` | `permission` | `fatal`.

`epoch_mismatch` 를 `coordinate_mismatch` 로 넓혔다 — 거부 사유가 epoch 만이 아니다 (§3.6).

### 9.3 로딩 — 하드닝

- 동적 `import()` 는 **코어 재컴파일**을 없애지, **패키지 프로비저닝**을 없애지 않는다.
  컨테이너 배포에서는 여전히 이미지에 넣거나 볼륨으로 주입해야 한다. 실질 이득은
  "코어를 포크·재빌드하지 않아도 된다"까지다.
- 설정의 임의 패키지명을 로드하지 않는다. **이미지에 pin 된 allowlist** 만.
- `name + version + integrity(sha512)` 검증. `apiVersion` 불일치는 기동 실패.

정본은 `src/dp/loader.ts` 다. 핀은 이미지와 함께 가는 값이고, 설정은 **이름만** 고른다.

```ts
type DriverPin = {
  name: string;
  version: string;
  integrity: string;   // `sha512:` + 128 hex. 엔트리 파일 바이트
  apiVersion: number;  // 코어의 DRIVER_API_VERSION 과 같아야 한다
  path: string;        // 이미지에 프로비저닝된 엔트리
};
```

| | 언제 | 무엇을 안 하는가 |
|---|---|---|
| X5 | 이름이 핀 목록에 없다 | 파일을 열지 않는다 |
| X6 | 바이트의 sha512 가 핀과 다르다 | `import()` 하지 않는다 |
| X7 | 핀 또는 모듈의 `apiVersion` 이 코어와 다르다 | 모듈을 호출자에게 주지 않는다. 목록에 틀린 핀이 하나라도 있으면 `assertDriverPins` 가 기동을 멈춘다 — 쓰지 않을 핀이라며 건너뛰면 그게 곧 조용한 degrade 다 |

이름은 핀 목록에서 유일하다. 버전을 설정이 고르게 하면 선택지가 하나 더 생기고, 그 선택지가 곧 우회가 된다. 한 이름에 한 핀.

참조 구현은 `drivers/reference.mjs` 다. **코어를 import 하지 않는다.** 로더가
그 파일을 경로로 집어넣고, `capabilitiesFromDriver` 가 S14 표를 지킨다.
사내 레포의 CI 는 `node scripts/driver-compat.mjs <entry>` 를 돌린다 — 코어를
수정하지 않고 자기 엔트리가 로드되는지 잰다.

`BackendDiscovery` 는 아직 고정하지 않는다. 멤버십·렌더가 엔드포인트 집합을
받는 경로가 없다. 구현하지 않은 계약을 올리면 §9.1 이 막으려던 일이 난다.

기동 배선은 `src/dp/boot.ts` 다. `BARY_DRIVER_PINS` / `BARY_DRIVER_PINS_FILE` 이
없으면 핀을 안 읽는다. 있으면 목록 전체를 `assertDriverPins` 한 뒤 `BARY_DRIVER`
(핀이 하나면 생략) 를 `loadDriver` 로 집어넣고, `GET /api/v1/status` 의 `driver`
로 드러낸다. **설정 평면은 계속 `LocalDataplaneDriver`.** 로드하는 것은
capability 패키지이지 apply 구현이 아니다.

`BackendDiscovery` 는 아직 고정하지 않는다. 멤버십·렌더가 엔드포인트 집합을
받는 경로가 없다.

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
> **DP Agent 를 호스트에 두는 구성은 없다.** end-to-end 를 붙이다 확인했다 — 호스트에서
> `current` 심볼릭 링크를 바꿨더니 컨테이너가 보는 링크가 **비어 있었고**
> `open() "…/current/nginx.conf" failed (22: Invalid argument)` 가 났다 (Docker Desktop
> bind mount). 에이전트와 nginx 는 같은 파일시스템을 봐야 한다.

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
| S11 ❌ | **operation tuple 과 경합** | ① 롤백 후 옛 좌표 RPC 거부 ② cut 이후 델타 미유실 ③ staging 전 accept 없음 ④ 다중 serving epoch ⑤ 옛 리더 토큰 거부 ⑥ **동시 RPC** ⑦ 취소된 미래 epoch 거부 ⑧ 같은 좌표 다른 digest 거부 ⑨ DP 재시작 후 토큰 유지 — 전부 잘못된 peer 선택 0회 | 설계 재작업 (block) |
| S12 ✅ | 크래시 저널 | §6.2 표의 모든 지점(durable write·외부 side-effect 직전/직후)에서 복구 정확. **최종 세대가 정확하고 중복 cycle 이 상한 이내** (exactly-once 는 요구하지 않는다 — §6.2) | 설계 재작업 (block) |
| S13 ✅ | 마커·워커 레지스트리·GC | 옛 워커 잔존 중 오삭제 0회 + §8.4 GC 각 단계 크래시에서 **누수·이중감소 0회** + GC root 누락 0회 | GC 보수화 |
| S14 ~ | **대안 B 실증** | HTTP/TCP/UDP × A/AAAA/SRV × TTL/NXDOMAIN/timeout, 기존 세션 거동 | 폴백 자체가 없음 → 요구 재조정 |
| S15 | 밸런서 품질 | RR 공정성 편차 < 5%, hash 재매핑률, 재시도·failure penalty 동작, CPU/p99 오버헤드 < 10% | 알고리즘 축소 |
| S16 ✅ | SNI 별 TLS policy 렌더 | 비-default server 별 `ssl_protocols` 가 **실제 handshake 에 적용**되는가 | `override` 제거 |
| S17 ✅ | TLS 인증서 선택 렌더 | exact / 1라벨 와일드카드 / `default_server` 조합에서 SAN 미커버 인증서 제시 0회 | v0 은 exact host 만 |
| S18 ✅ | ACME 상태기계 | 오더·챌린지·재시도·고아 TXT 정리 (v0.6 전) | ACME 범위 축소 |
| S20 ❌ | **HTTP/3 (QUIC)** | ① h3 로 실제 요청이 오간다(설정이 서는 것과 다르다) ② UDP/443 점유가 §4.5 겹침 검증에 잡힌다 ③ 같은 포트 TCP(h1/h2)와 공존 ④ Alt-Svc 로 브라우저가 승격한다 ⑤ reload 중 h3 연결 거동 | v0 은 h1/h2 만 — h3 는 **모델에서 뺀다** (표현하면 안 걸리는 설정이 된다) |
| S19 ✅ | **롤백 경로 합성** | 옛 topology·TLS 자료를 **새 세대로 clone 하고 새 epoch 를 구워** 활성화. S8(세대 결박)과 S11(새 epoch)이 함께 성립하는가 | 설계 재작업 (block) |

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

**S8 실행 결과 (2026-08-11).** `./spike/s8/run.sh` → 11 PASS / 0 FAIL.

두 배치를 나란히 돌려 §7.2 의 근거를 눈으로 확인했다.

| 배치 | 인증서 위치 | 갱신 후 롤백 |
|---|---|---|
| A (v2/v3 설계) | 세대 디렉토리 안 | ✅ **그 시점의 key/chain 을 정확히 복원** |
| B (v0/v1 설계) | 세대 밖 mutable 경로 | ❌ **갱신된 인증서가 그대로 나온다** |

- **B 가 1차 검수 Critical #4 의 실물이다.** conf 는 되돌아가는데 인증서 파일은 이미 덮여
  있어 TLS 만 롤백되지 않는다. "롤백은 symlink 되돌리기 + reload 로 끝난다"가 왜 거짓이었는지.
- **게시 전 검증이 가능하다** (S8.prevalidate) — §6.2 `prepare` 단계가 성립한다. 위 §7.2 참조.
- **cert/key 불일치는 `nginx -t` 가 잡는다.** 다만 materialize 직후 자체 검증은 여전히 필요하다
  — `-t` 와 HUP 사이에 파일이 바뀔 수 있기 때문이다 (§6.2 표 #9).
- **GC root 의 근거를 실측했다.** 활성 세대의 인증서를 지워도 열린 fd 로 **트래픽은 계속
  흐르지만 다음 reload 는 실패한다.** 트래픽만 보면 알 수 없다 — 그래서 현재/서빙 세대는
  §8.4 의 GC root 여야 한다.

**S7 실행 결과 (2026-08-11).** `./spike/s7/run.sh` → 9 PASS / 0 FAIL.

- **오탐/미탐 0.** 정상 HUP 은 74ms 에 성공, 포트 점유 HUP 은 71ms 에 실패로 판정한다.
  점유를 풀고 재시도하면 8ms 에 활성화된다.
- **판정에는 음성 신호가 필요하다.** 워커 레지스트리만 쓰면 실패 판정이 타임아웃을 다 써
  4,027ms 가 걸렸다. error log 워터마크를 함께 보면 71ms 다 (§6.3).
- **A4.3 확인.** shared dict 마커는 "누가 응답했는가"를 말해주지 못한다 — in-flight 요청을
  gen1 워커가 처리하는 동안 마커는 이미 `2` 였다. 세대별 렌더 리터럴이어야 한다.
- → **ApplyOperation 스키마를 고정할 수 있다.** S7 은 더 이상 freeze block 이 아니다.

**S19 실행 결과 (2026-08-16).** `./spike/s19/run.sh` → 16 PASS / 0 FAIL.

**S8 과 S11 은 롤백에서 정면으로 만난다.** S8 은 "인증서가 세대 안에 있어야 롤백이 자료까지
되돌린다"고 하고, S11 은 "epoch 는 절대 재사용 금지"라고 한다. 그런데 세대에는 epoch 가
**구워져** 있다(§6.5-1). 옛 세대를 그대로 다시 게시하면 epoch 가 재사용되고, epoch 를 새로
쓰려고 새 세대를 만들면 옛 인증서를 어떻게 가져오느냐가 남는다. §3.3 이 답으로 내놓은
**"clone + 새 epoch 리터럴 재렌더"** 가 실제로 성립하는지가 S19 다.

- **성립한다.** 옛 자료를 새 세대로 clone 하고 epoch 를 다시 구워 활성화했더니, 워커가 든
  `GEN_EPOCH` 는 새 값(E30)이고 제시되는 인증서는 옛 값(gen1)이다. **두 요구가 동시에
  만족된다.** 롤백 세대는 게시 전에 그 자리에서 `nginx -t` 도 통과한다(§6.2 prepare).
- **롤백된 세대의 멤버십 평면이 살아 있다.** 롤백 뒤에 새 peer 를 staging 하면 그대로 먹는다
  — §3.3-2 의 "`topology_version` 이 같으면 헬스를 재투영할 수 있다"가 실물로 확인된다.
  롤백은 얼어붙은 스냅샷이 아니다.
- **clone 뒤에도 ABA 가 막힌다.** 늦은 E20·E10 의 `stage`/`activate` 가 전부 409 고 그동안
  트래픽은 흔들리지 않는다 (S11 P1 의 롤백판).

**그리고 clone 을 어떻게 하느냐가 전부다.** 두 가지 그럴듯한 방식이 각각 다르게 깨진다.

| clone 방식 | 증상 |
|---|---|
| `cp -r` 로 세대를 통째로 (배치 B) | **epoch 리터럴이 딸려온다.** 워커는 E10 을 들고 있는데 컨트롤 플레인은 E40 을 믿는다. 워커가 E10 슬롯만 보므로 E40 에 무엇을 staging 해도 **영영 안 닿는다** — 헬스가 죽은 세대가 된다. 조용히 옛 peer 로 흘러가면서 |
| 인증서를 symlink 로 (배치 C) | **평소에는 멀쩡하다.** 옛 세대를 GC 가 회수하는 순간 열린 fd 로 트래픽은 계속 흐르지만 **다음 reload 가 실패한다.** 트래픽만 보면 알 수 없다 (S8.gc_root 와 같은 함정) |

→ **롤백 clone 은 재렌더 + 바이트 복사여야 한다.** 배치 B 가 특히 위험한데, 나이브한
구현이 정확히 저 모양(`cp -r generations/N generations/M`)이 되기 쉽고 **트래픽은 정상으로
보이기 때문이다.** 잘못된 peer 를 고르는 게 아니라 *옛 peer 를 고집하는* 실패라 헬스가
죽어도 아무 알람이 안 울린다. v0.6 구현에서 `activation_epoch` 는 clone 이 아니라
**렌더 입력**이어야 한다.

**S19 는 프로젝트 block 이었고, 해제됐다.**

**S13 실행 결과 (2026-08-18).** `./spike/s13/run.sh` → 5 PASS / 0 FAIL.

합격 기준은 셋이었다: 옛 워커 잔존 중 **오삭제 0회** · GC 각 단계 크래시에서
누수·이중감소 0회 · root 누락 0회.

**두 번째는 이미 구조적으로 성립한다.** §8.4 가 정한 대로 우리는 **별도 refcount 를 안
둔다** — root 를 그때그때 정본(리비전·세대 디렉토리·주문·계정)에서 모은다. 감소시킬
카운터가 없으므로 이중 감소도 누락도 **표현할 수가 없다.** 크래시가 남길 수 있는 최악은
"이번에 안 지웠다" 이고, 다음 스윕이 같은 것을 다시 집는다.

**그런데 첫 번째가 문제였다.** 코드에 `serving_generations` 가 **아예 없다.** 세대 청소의
보호 목록은 방금 만든 것·게시된 것·미완 오퍼레이션뿐이고, **옛 워커가 아직 들고 있는
세대는 숫자 상한(기본 10개)으로만 우연히 보호된다.**

#### 마커로는 옛 워커를 셀 수 없다 — 길이 막혀 있다

이 게이트의 이름이 "마커·워커 레지스트리" 인 이유는 §6.3 의 세대 마커로 그걸 세려는
계획이 있었기 때문이다. **안 된다.**

옛 워커에 in-flight 를 걸어 살려 둔 뒤 마커를 40 회 두드렸더니 **새 세대만 답했다.**
HUP 뒤 옛 워커는 **리스닝 소켓을 닫고** in-flight 만 처리하므로, 새 요청이 옛 워커에
**절대 안 간다.** S7 의 A4.3 이 *"마커는 누가 응답했는가를 말하지 못한다"* 고 한 자리이고,
워커 레지스트리를 마커로 짓는 길은 여기서 끝난다.

nginx 는 "어느 워커가 어느 세대인가" 를 안 알려준다. 알 수 있는 것은 **몇 개 살아 있는가**
뿐이다(마스터의 자식 수).

#### 그래서 모르는 것을 유계로 바꾼다

`worker_shutdown_timeout` 이 잔존 창에 상한을 건다 — 실측했다(2초 상한에서 워커 3 → 2).
그러면 GC 는 *"어느 세대를 아직 쓰는가"* 를 몰라도 **"이 시간이 지난 세대는 아무도 안
든다"** 를 쓸 수 있다.

**지금은 그걸 안 낸다.** 상한을 걸면 in-flight 가 잘리므로(WebSocket·long-poll) 기본으로
켤 수 없고, 켜는 것은 트래픽 정책이라 모델 필드가 필요하다. **v0.6 은 숫자 상한에만
기댄다** — 그 사실과 대가를 여기 적어 둔다:

> 잔존 창이 유계가 아닌 배포에서, 오래 사는 연결(WebSocket)을 든 워커가 세대 전환 10 회를
> 넘겨 살아남으면 그 워커가 든 세대가 지워질 수 있다. S8 이 실측한 대로 **트래픽은 계속
> 흐르고 다음 reload 가 깨진다** — 트래픽만 보면 알 수 없다. 상한을 올리거나
> `worker_shutdown_timeout` 을 노출하는 것이 다음 회차의 일이다.

**S13 은 "GC 보수화" 를 실패 규칙으로 걸어 뒀고, 실제로 보수적인 쪽이 답이었다.**

**S18 실행 결과 (2026-08-17).** `./spike/s18/run.sh` → 8 PASS / 0 FAIL.

§8.2 는 스스로를 **비규범**이라고 적어 뒀다: *"§8.2 의 엔티티·상태·정책은 ADR-ACME 가
확정하기 전까지 구속력이 없다."* S18 은 그 ADR 이 딛고 설 사실을 만드는 게이트다.

**Pebble 을 쓴다.** Let's Encrypt staging 은 네트워크·레이트리밋·실제 DNS 가 필요하고,
무엇보다 **badNonce 를 일부러 낼 수 없다.** Pebble 은 못되게 구는 것이 기능이라
`PEBBLE_WFE_NONCEREJECT` 로 nonce 를 정해진 비율로 거절한다 — RFC 8555 §6.5 의 재시도
경로를 실제로 밟게 하는 유일한 방법이다. DNS 는 도커 네트워크 별칭에 기댄다.

- **발급이 끝까지 된다.** 계정 → 주문 → http-01 → finalize → 인증서. 받은 인증서를
  파싱해 SAN 을 확인하고, **우리가 만든 CSR 의 키와 맞는지**까지 본다 — 200 을 받은 것과
  쓸 수 있는 인증서를 받은 것은 다르다.
- **의존성 0 으로 성립한다** (§11.2). JWS 도 CSR 도 직접 만든다. `openssl` 셸아웃을 안
  고른 이유는, 엔진과 달리 그건 **CP 호스트**에 필요한 것이라 컨테이너 이미지 계약이
  바뀌기 때문이다.
- **와일드카드는 dns-01 만 나온다** (실측: `dns-01, dns-account-01, dns-persist-01`).
  §8.2 가 *"와일드카드는 dns-01 만 — 모델에서 강제"* 라고 한 것이 CA 쪽에서도 그렇다.
- **버려진 주문은 `pending` 으로 남는다.** CA 가 치워 주지 않는다 → 고아 정리는 **우리
  상태로 몰아야** 한다. §8.2 의 *"cleanup 보장 + 주기적 고아 스캔"* 이 선택이 아닌 이유다.
- 토큰을 안 서빙하면 주문이 **유한 시간에 `invalid`** 로 확정된다. 영영 `pending` 이면
  상태기계가 멈춘다 — 재는 것은 "실패한다" 가 아니라 "실패가 확정된다" 다.

**그리고 스파이크가 진짜 결함을 하나 찾았다.**

`nonceRetries` 를 RFC 문구 그대로 **1** 로 뒀더니 `happy` 가 finalize 에서 `badNonce` 로
죽었다. RFC 8555 §6.5 의 *"한 번은 반드시 재시도"* 는 **하한이지 운영값이 아니다** —
거부율 20% 에서 한 요청이 두 번 연속 거절될 확률이 4% 인데, 발급 한 바퀴에 요청이 15 개
남짓이라 절반 가까이가 어딘가에서 걸린다. 기본값을 5 로 올렸다. 실서비스 CA 의 거부율은
더 낮겠지만 **한 바퀴에 요청이 많다는 성질은 같다.**

**변이로 검사력을 확인했다.**

| 변이 | 어디서 잡히나 |
|---|---|
| ES256 을 DER 로 서명 (Node 기본값) | 전 시나리오가 `malformed: error in cryptographic primitive` — 내가 주석에 적어 둔 증상 그대로다 |
| thumbprint 필드 순서를 RFC 7638 과 다르게 | `happy` 만 `invalid`. 챌린지 검증이 **항상** 실패하는데 CA 는 왜인지 안 말해 준다 |
| SAN dNSName 을 constructed 태그로 | `openssl` 이 SAN 을 아예 못 읽는다 (단위 테스트) |

**S12 실행 결과 (2026-08-17).** `./spike/s12/run.sh` → 5 PASS / 0 FAIL, 49초.

**S8·S11·S12 가 block 등급이었고, 이것이 마지막이었다.**

`tests/conformance/review5-crash-points.test.ts` 가 이미 지점 15 개 × 직전/직후를 훑고
수렴을 확인한다. 그런데 거기서 죽는 방식은 **예외**다 — 자바스크립트 힙만 버려지고
파일시스템은 정상 종료한 상태로 남는다. S12 가 묻는 것은 그게 아니라 *"진짜로 죽으면"*
이다. 그래서 `process.abort()` 로, 실물 `FileStore`·실물 `FsEffects`·실물 nginx 위에서
전 지점(38 개)을 훑었다.

- **38/38 지점에서 복구가 gen-2 로 수렴한다.** 심볼릭 링크·서빙 세대가 모두 일치하고,
  죽은 주인의 락이 회수되며(6차 반례 ⑤), 복구가 쓰는 reload 는 지점당 0.68 회로 유계다.
- 주입은 **프로덕션 코드 밖**이다. `FaultStore` 가 아무 `DurableStore` 나 감싸므로 실물
  `FileStore` 를 감쌀 수 있고, `CrashClock.tick` 을 스파이크 쪽에서 덮어 예외 대신
  `abort()` 를 부른다. `classifyWrite` 주석이 세운 규칙(*"프로덕션 코드에 테스트용 인자가
  새지 않는다"*)을 그대로 지킨다.

**그리고 이 스파이크는 처음에 세 번 거짓말했다.** 셋 다 계측기 쪽이다.

| 무엇이 | 어떻게 드러났나 |
|---|---|
| manifest digest 를 셸에서 손으로 계산했다 | preflight 가 전부 거절 → baseline 이 `failed`. 통과했다면 **아무 일도 안 일어난 채 "복구가 잘 된다"** 가 나왔을 것이다. 실물 `materializeGeneration` 으로 바꿨다 |
| `grep -c '^POINT reload:before'` 가 실제 형식(`POINT <번호> reload:before`)과 안 맞았다 | 38 회 복구에 reload 0 회. 그건 "유계" 가 아니라 **아무것도 안 센 것**이다. 그래서 `S12.metric` 을 넣어 **지표부터 검증**한다 |
| 폴 정책을 `{attempts:3, intervalMs:50}` 으로 줬다 (프로덕션은 25×100ms) | 없는 실패가 생겼고 **회차마다 다른 지점**을 지목했다(#2·#15·#24 → #10). 비결정성이 단서였다 — 고정된 로직 결함이면 같은 지점이 나온다 |

한 가지 더: nginx 는 스윕 내내 살아 있는 별개 프로세스라, 한 번 gen-2 로 reload 되고
나면 prefix 를 되돌려도 계속 gen-2 를 서빙한다. 그대로 두면 뒤쪽 회차의 "수렴했다" 가
**앞 회차 덕**이 된다. 회차마다 엔진을 gen-1 로 되돌리고 확인한 뒤에 시작한다.

**변이로 검사력을 확인했다.** 죽은 주인의 락 회수를 끄면 `S12.sweep` 과 `S12.lock` 이
함께 빨개진다. 그런데 `finishOperation` 이 실행권을 영영 안 놓게 만든 변이(6차 반례 ④ —
*"이게 빠지면 좌표가 영구히 잠긴다"*)는 **처음에 안 잡혔다.** 복구가 *같은* 오퍼레이션만
다시 돌리면 자기 실행권에 막히지 않기 때문이다. 잠김은 **다음 오퍼레이션**에서만 보이므로
회차마다 gen-3 를 한 번 더 민다 — 그러자 잡혔다.

**S16·S17 실행 결과 (2026-08-17).** `./spike/s16/run.sh` → 5 PASS, `./spike/s17/run.sh` → 10 PASS.

이 둘은 **`https` 리스너 프로토콜을 되살리는 전제**다. §4.6 이 `https` 를 일부러 빼면서
*"S16·S17 통과와 실제 TLS 렌더러가 생긴 뒤에 되살린다"* 고 적어 둔 그 게이트다.

**S17 — 인증서 선택은 성립한다. 단, 렌더 규칙 둘이 붙는다.**

| 사실 | 렌더 규칙 |
|---|---|
| `server_name *.wild.test` 는 **다중 라벨을 삼킨다**(E22.2). `deep.x.wild.test` 가 와일드카드 인증서를 받는데, X.509 와일드카드는 한 라벨만 커버한다 | 와일드카드는 **`~^[^.]+\.suffix$` 앵커 정규식**으로 낸다. 나이브한 형태는 **SAN 미커버 인증서 제시**가 된다 — 합격 기준이 겨눈 바로 그 실패다 |
| **`server_name ~*` 는 `nginx -t` 가 거절한다** (`pcre2_compile() failed: quantifier does not follow a repeatable item`). `~*` 는 map 전용이다(E21) | 패스스루 SNI map 의 문법을 그대로 옮겨 쓰면 안 된다. `server_name` 은 `~` 만 받고, **대소문자는 nginx 가 SNI 를 내려서 비교**하므로 `~` 로 충분하다 (`X.WILD.test` 실측) |
| `default_server` 가 없으면 모르는 SNI 가 **첫 번째 server 의 인증서**를 받는다 — E32 의 TLS 판이다 | TLS 리스너마다 **`default_server` 를 반드시 낸다.** 멀티테넌트에서 이건 테넌트 간 누수다 |

SNI 가 아예 없어도 handshake 는 안 끊긴다 — `default_server` 인증서가 나간다. 즉
**"모르는 이름에 무엇을 제시할 것인가"는 설정으로 정해야 하는 값**이지, 비워 둘 수 있는
자리가 아니다.

**S16 — SNI 별 TLS policy 는 성립한다. `override` 를 유지한다.**

같은 리스너 위에서 비-default server 의 `ssl_protocols` 가 **실제 handshake 에 걸린다**:
`strict.test` 는 TLS1.2 를 거절하고 같은 포트의 default 는 받는다. 뒤집어도(default 가
1.3 전용, 비-default 가 1.2 허용) 비-default 가 이긴다 — **default_server 값이 리스너를
지배하지 않는다.** server 레벨이 http 레벨을 덮으므로, 렌더러는 policy 를 **각 server
블록 안**에 낸다.

> ⚠ **엔진 버전에 딸린 사실이다.** 오래된 nginx 에서는 `ssl_protocols` 가 사실상
> default_server 것만 살았다. 엔진 이미지를 바꾸면 이 스파이크를 다시 돌린다.

**그리고 이 측정은 한 번 틀렸다.** 처음 판정 지표가

```sh
openssl s_client -tls1_3 ... | sed -n 's/Protocol *: *//p'
```

였는데, `Protocol :` 줄은 **s_client 가 자기 설정을 찍는 것**이라 서버가 alert 70 으로
끊어도 그대로 `TLSv1.3` 이 나온다. 이 지표로는 **모든 조합이 통과로 보였고**, "http 레벨
`ssl_protocols` 조차 안 먹는다" 는 있을 수 없는 결론이 나왔다 — 그 말도 안 되는 결론이
계측기를 의심하게 만든 유일한 단서였다. 판정을 *handshake 가 실제로 섰는가*
(`Cipher is (NONE)` / `alert protocol version` / `unsupported protocol`) 로 바꾸자 답이
뒤집혔다.

그래서 S16 프로브는 **자기 계측기를 먼저 검증한다**(`S16.instrument`): 의심의 여지 없이
걸려야 하는 http 레벨 정책이 안 걸리면 지표가 죽은 것이므로, 나머지 판정을 신뢰하지 않는다.

### 12.1 이후 단계

| 단계 | 내용 | 완료 판정 |
|---|---|---|
| **v0.1** 골격 ✅ | (동결은 둘로 나뉜다 — §9.1.1) 타입 모델(판별 유니온) + PG + `ConfigRevision`/`activation_epoch`/changeset sealing + **소유권 예약을 포함한** ApplyOperation + DP Agent + conf AST 렌더러 + 최소 auth/audit + `DataplaneDriver` **설정 평면** 계약 확정 (§9.1.1) | `curl` 로 `:999→A:11` 이 뜨고, 모순 조합은 저장이 거부되며, AST 퍼즈 테스트와 §6.2 크래시 표가 통과한다. **5차 반례 7건이 conformance test 로 고정돼 통과한다** |
| **v0.2** L4 ✅ | 풀/백엔드, LB 알고리즘, UDP 프로파일, SNI 패스스루 + 폴백, 소켓 겹침 검증기, 라우트 컴파일러(축소 계약) | SNI 로 두 백엔드가 갈리고, http 443 ↔ stream 443 중복이 저장 단계에서 막힌다 |
| **v0.3** 멤버십 ✅ | 이중 zone 멤버십 평면 + epoch 결박 + 헬스 프로버 + 드레인 관측 + **§6.5 커서·cut·replay 와 멤버십 드라이버 계약 확정** (§9.1) | 백엔드 down 시 reload 없이 격리되고, apply 중 헬스 변화가 경합하지 않는다 (S11 시나리오 회귀 테스트). **활성 epoch 안의 헬스 진행이 전환 중인 commit 을 깨지 않는다** |
| **v0.4** CLI | export/import ✅ · 나뉜 changeset 단계 ✅ (`changeset new\|patch\|plan`, `commit --plan`, `apply --plan`). 리소스별 하위 명령은 아직 | 같은 매니페스트를 두 번 import 해도 결과가 같다. `apply --plan` 은 changeset 을 안 연다 |
| **v0.5** GUI slice | SSE ✅ (`GET /api/v1/events`). 3화면은 아직 | 클릭만으로 v0.3 시나리오 재현 |
| **v0.6** TLS | `SecretStore`/`DNSProvider` 확정 → ACME 상태기계, 업로드, 자동 갱신, 세대 결박 롤백 + GUI 잔여 화면 | 무중단 갱신 관측 + 갱신 후 롤백 시 옛 인증서 복원 |
| **v0.7** 드라이버 | 로딩 하드닝 ✅ · 참조+키트 ✅ · 기동 배선 ✅ (`BARY_DRIVER_PINS` → status.driver). 설정 평면은 `LocalDataplaneDriver`. `BackendDiscovery` 는 받는 쪽이 없어 아직 고정하지 않는다 | 사내 레포가 코어 수정 없이 빌드·로드 (`node scripts/driver-compat.mjs <entry>`) |
| **v1.0** | 전체 RBAC, 백업/복구 리허설, SPOF 런북, 문서 | RTO/RPO 리허설 합격 |

> **v0.1 완료 판정 통과 (2026-08-16).** `tests/e2e/v01-curl.test.ts` 10건이 실물로 판정한다 —
> REST → PG(changeset·plan·commit) → render → materialize → 게시 → HUP → 활성화 증거 →
> 좌표 이동 → **`curl :999` 가 `BACKEND_A_11` 을 받는다.**
>
> **데몬은 DP 컨테이너 *안에서* 돈다.** 취향이 아니라 실측이다 — 호스트에서 `current`
> 심볼릭 링크를 바꾸면 컨테이너 안에서는 여전히 옛 세대를 가리킨다(다시 재봤다).
> §3.2 · §11.1 이 "DP Agent 는 DP 와 같은 호스트에 산다" 고 한 것이 이 뜻이다.
>
> **배선하면서 실물이 결함 넷을 드러냈다.** 전부 *한 번도 실행된 적 없는 경로* 였다.
>
> | # | 무엇 | 왜 안 잡혔나 |
> |---|---|---|
> | ① | `verifyGeneration` 이 **중첩 디렉토리를 못 읽는다** | 세대가 평평한 테스트만 있었다. §7.2 레이아웃은 처음부터 `http/`·`lua/`·`certs/<id>/` 로 중첩인데, `admin/marker.conf` 하나를 넣자마자 *"manifest 에 없는 'admin' 이 있다"* 로 막혔다 |
> | ② | `ApplyResult.failure` 를 **아무도 안 채운다** | 타입에 있고 주석은 *"조용히 실패하지 않는다"* 인데 `resultOf` 가 안 실었고 `lastFailure` 는 **쓰기만 하고 읽는 데가 없는 필드**였다. ① 을 진단하지 못한 이유가 이것이다. 저널에 적도록 고쳤다 — 재기동·승계 뒤에도 남아야 한다 |
> | ③ | 컨테이너에서 **자기 락을 회수 못 한다** | `FileStore` 가 pid 생존으로 판정했고 "pid 재사용은 잔여 경합" 이라고 적혀 있었다. §11.1 배포에서는 잔여 경합이 아니라 **확정**이다 — 데몬은 늘 pid 1 이라 재기동이 아예 안 됐다. 락 레코드에 프로세스 시작 시각을 넣었다 |
> | ④ | 렌더러에 **활성화 마커를 굽을 자리가 없다** | §6.3 은 세대별 렌더 리터럴을 요구하는데 렌더러는 모델만 안다. 세대 안의 `admin/` 조각으로 뺐다 — `include` 가 `ssl_certificate` 처럼 **conf_prefix 기준**이라 성립한다(E62 로 실측) |
>
> ①②③ 은 **단위 217 · conformance 381 · 골든 10 · 모델 13 이 전부 초록인 상태에서** 살아
> 있었다. 실물 배선이 아니면 안 드러나는 자리가 남아 있다는 뜻이다.

> **v0.2 완료 판정 통과 (2026-08-17).** `tests/e2e/v02-l4.test.ts` 7건. tcp·udp·SNI
> 패스스루를 **REST 로 넣어 실제 트래픽까지** 몰았다. 모델·검증기·렌더러는 셋을 전부터
> 지원했지만 **API 로 끝까지 가 본 적이 없었다** — "지원한다" 와 "돈다" 사이가 v0.1
> 배선에서 결함 넷을 낸 자리다.
>
> **패스스루는 인증서로 판정한다.** 본문만 보면 종단해서 프록시해도 같은 답이 나온다.
> `a.test` 로 붙으면 백엔드 a 의 인증서가, `b.test` 면 b 의 것이 그대로 온다 — 그게
> "종단하지 않는다" 의 유일한 증거다. 매칭 없는 SNI 와 SNI 부재는 둘 다 거부된다(§4.1).
>
> 변이 넷으로 판별력을 확인했다: `listen` 에서 `udp` 제거 · SNI 매칭 무시 · 매칭 없는
> SNI 를 첫 풀로 · 소켓 겹침 탐지 무력화 — **각각 자기 테스트가 잡는다.**
>
> 이번 회차의 실패는 우리 것이 아니라 **무대의 것**이었다. UDP 백엔드를
> `content_by_lua_block { ngx.say(...) }` 로 짰는데 *`API disabled in the current
> context`* 로 죽는다 — TCP 에서는 멀쩡하고 **UDP 에서만** 막힌다. `return` 디렉티브로
> 바꿨다. UDP 를 실제로 쏴 보기 전에는 안 드러나는 종류다.
>
> **남은 것**: 포트 노출은 여전히 손이다(§11.3). 리스너를 만들 때마다 배포 설정에 한 줄을
> 더해야 밖에서 닿는다.

> **v0.3 진행 (2026-08-17) — 2단계까지.** `reload 없이 백엔드가 바뀐다`가 섰다.
> `tests/e2e/v03-membership.test.ts` 5건이 실물로 판정한다.
>
> 판정은 *"트래픽이 옮겨갔다"* 가 아니다 — 세대를 새로 만들고 HUP 을 보내도 그렇게 된다.
> **안 일어난 일**을 잰다: 마스터 PID 불변 · **워커 기동 수 불변**(HUP 은 워커를 새로
> 띄운다) · 활성 세대 불변 · 세대 디렉토리 수 불변.
>
> **판정 기준은 렌더 산출물이다.** 멤버십 평면이 켜지면 백엔드가 conf 에 없으므로,
> 백엔드만 바뀐 변경은 산출물이 **바이트 단위로 같다.** "백엔드 테이블만 바뀌었나" 같은
> 다른 근거로 재면 렌더에 영향을 주는 필드가 하나 늘 때마다 조용히 틀려진다.
>
> **실물이 낸 것 셋.**
>
> | # | 무엇 |
> |---|---|
> | ① | **부트스트랩에 dict 가 있어야 한다.** §6.5-1 은 HUP *전에* 적재하라는데, 그 시점에 도는 것은 **옛 세대**다. 첫 apply 에서 그게 부트스트랩이므로 dict 와 admin 이 거기 이미 있어야 한다. 모양이 capability 에 따라 달라져 셸이 못 쓴다 → **데몬이 만든다**(`--write-bootstrap`). `streamLua` 가 켜지면 리스너가 없어도 stream 블록을 낸다 |
> | ② | **재시작이 멤버십을 되돌렸다.** `lua_shared_dict` 는 프로세스 수명이라 엔진 재시작에 통째로 빈다. 처음엔 세대 아티팩트로 복원했는데, 그건 그 세대가 만들어질 때의 스냅샷이라 **그 뒤의 멤버십 전용 변경이 사라진다** — :12 로 옮긴 백엔드가 :11 로 되살아났다. 정본은 **head 리비전**이다 |
> | ③ | **멤버십은 lease 를 안 받는다.** lease 는 apply 실행권에 매달려 있는데 §6.5-6 은 *"prepare 동안에도 활성 epoch 는 헬스 갱신을 계속 받는다"* 고 한다 — 설정 전환 중에 헬스가 멈추면 죽은 백엔드로 트래픽이 계속 간다. 지키는 것은 좌표 CAS 다 |
>
> **3단계 (2026-08-17) — 헬스 프로버.** 죽은 백엔드가 **reload 없이** 슬롯에서 빠지고,
> 살아나면 돌아온다. 판정은 `GET /health/backends` 로 드러나고 `unknown` 을 숨기지 않는다
> (아직 못 잰 것과 산 것은 다르다 — §6.7 프로버 장애).
>
> **범위**: TCP 연결 검사만이다. HTTP 상태 코드도, 프로토콜별 헬스체크도, 드레인
> 관측(S2)도 없다. 흉내내면 "헬스체크가 있다" 가 절반만 참이 된다.
>
> §6.6 이 요구한 것 셋을 지켰다 — **단일 리듀서**(커밋된 모델 ∩ 원시 헬스) ·
> **커서는 `nextval` 이 아니다**(잠금 행. `nextval` 은 커밋 순서와 달라 cut 이후 커밋된
> 낮은 번호가 영구 누락된다) · **판정 변경과 이벤트를 같은 트랜잭션에서**.
>
> **실물이 낸 것 둘.** ① 연속 횟수를 *상태의 연속*으로 셌다 — `healthy` 인 동안 실패가
> 몇 번 이어져도 매번 1 로 리셋돼 임계값에 **영원히 도달하지 못했다.** 프로버가
> `ECONNREFUSED` 를 보는데 판정은 `healthy` 로 굳었다. 세는 것은 **결과의 연속**이다.
> ② 관측 순번을 **프로세스 메모리에서 1 부터** 셌다 — 재기동한 프로세스의 1 번이 저장된
> 큰 값보다 작아 **자기 관측을 전부 버린다.** 저장된 최대값에서 이어 붙인다.
>
> **cut·replay (2026-08-17) — 창을 논증으로 닫았다.** §6.5-2·4 는 HWM 을 기록하고 활성화
> 뒤 그 이후 이벤트를 재생하라고 한다. **이벤트를 재생하는 대신 다시 유도한다** — 리듀서가
> 델타가 아니라 *상태*에서 계산하므로(커밋된 모델 ∩ 현재 헬스) 활성화 직후 한 번 더
> 계산하면 결과가 같다. 순서를 지킬 것이 없으면 커서도 필요 없고, 이벤트 로그는 감사
> 기록으로 남는다.
>
> ▲ **닫혔다는 것은 논증이지 측정이 아니다.** 재투영을 빼는 변이가 아무 테스트도 안
> 깨뜨린다 — staging 이 이미 옳으므로 차이가 나는 것은 staging 과 활성화 사이에 헬스가
> 바뀌는 경우뿐이고, 그걸 밖에서 결정적으로 만들 방법이 없다.
>
> **그리고 그 작업이 1단계의 구멍을 드러냈다**: 멤버십 평면이 `ip_hash`/`hash` 를
> 산출물에서 없애면서 밸런서는 `math.random` 이었다 — `source_ip_hash` 가 **표현은 되는데
> 안 지켜지고** 있었다. 세 알고리즘을 Lua 로 옮겼다. 다만 `% n` 이라 **consistent 는
> 아니다** — 멤버십이 자주 바뀌는 평면에서 재매핑률이 다르다(S15 가 잴 축).

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

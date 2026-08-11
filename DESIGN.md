# barycenter — 설계 문서 (초안 v0)

> nginx 를 실행 엔진으로 쓰는 **HTTP / TCP / UDP 리버스프록시·로드밸런서 컨트롤 플레인**.
> GUI · API · CLI 어디서든 같은 일을 할 수 있고, 설정은 파일이 아니라 **모델**이다.
>
> 작명 — 무게중심(barycenter): 두 천체가 서로를 도는 **공통 질량중심**. 다체 시스템이 실제로 공전하는 균형점이 로드밸런싱의 은유. CLI 는 `bary`.
> 최종 결정이 아니라 **논의를 위한 초안**이다. § 13 미결정 사항을 먼저 볼 것.

---

## 1. 목적과 비(非)목적

### 목적
- 도메인 기반 HTTP(S) 라우팅과 TLS 수명주기를 GUI 에서 관리한다.
- **TCP / UDP 를 단순 포워딩이 아니라 업스트림 풀 기반 로드밸런싱으로** 관리한다.
- 인바운드 포트와 백엔드 포트를 자유롭게 분리한다 (`:999 → A:11`, `:888 → B:11`).
- GUI · API · CLI 가 **동일한 능력**을 갖는다.
- OSS 코어 + 비공개 드라이버로 사내 사정을 코어 밖에서 흡수한다.

### 비목적 (v1 범위 밖 — 명시적으로 안 한다)
- API 게이트웨이 기능 (플러그인 체인, 컨슈머, 레이트리밋 정책 엔진) — APISIX/Kong 영역.
- WAF, 봇 관리, 캐시 정책 세밀 제어.
- **멀티 노드 클러스터 관리** — v1 은 *단일 데이터플레인 인스턴스*만 관리한다. (§ 11)
- 서비스 메시, mTLS 자동 발급 (백엔드 방향).
- nginx 설정 파일 직접 편집 UI — 그건 Nginx UI 가 하는 일이고, 우리 모델과 충돌한다.

### 설계 원칙
1. **모델이 정본, nginx.conf 는 산출물.** 사람이 conf 를 손대는 순간 모델이 거짓이 된다.
2. **API 가 유일한 진입점.** GUI 도 CLI 도 API 클라이언트다. 내부 지름길을 만들지 않는다.
3. **적용은 항상 검증 후 원자적으로.** 잘못된 설정으로 프록시 전체가 죽는 경로를 없앤다.
4. **사내 사정은 드라이버로.** 코어에 특정 조직 가정을 넣지 않는다.

---

## 2. 왜 만드는가 — 갭 요약

기존 도구는 **GUI 가 있으면 L4 LB 가 약하고, L4 LB 가 되면 GUI 가 없다.**

- **Nginx Proxy Manager**: stream 이 `포트 → 호스트:포트` 1:1 포워딩. 업스트림 풀·헬스체크
  없음. **SNI 라우팅 미지원**([issue #4119](https://github.com/NginxProxyManager/nginx-proxy-manager/issues/4119)),
  UDP PROXY protocol 없음, CLI 없음.
- **Traefik**: 대시보드가 **읽기 전용**. 설정은 파일/라벨/CRD.
- **HAProxy Data Plane API**: API·CLI 는 훌륭하나 **UDP 미지원**, OSS GUI 없음.
- **Caddy**: admin API 는 좋으나 GUI 없음, L4 는 커뮤니티 플러그인.
- **APISIX**: 게이트웨이 형태 + etcd 의존. LB 관리 도구로 쓰기엔 과하고 대시보드 유지보수 축소.
- **Nginx UI**: 설정 파일 에디터. 모델이 없어 검증·롤백·API 대칭이 성립하지 않는다.

**우리의 좌표**: NPM 의 사용성 + HAProxy DPA 의 API 규율 + nginx stream 의 UDP 지원.

---

## 3. 아키텍처

```
   ┌── Web GUI (SvelteKit)
   ├── CLI (bary)                    모두 같은 REST API 만 호출
   └── IaC / 스크립트
             │
             ▼
      ┌─────────────────┐
      │   API 서버      │  인증·인가 · 검증 · 감사 · 낙관적 동시성
      └────────┬────────┘
               ▼
      ┌─────────────────┐
      │  선언 모델 (DB) │  Listener / Route / UpstreamPool / Backend / Certificate
      └────────┬────────┘
               │ generation++ (변경 알림)
               ▼
      ┌─────────────────┐        ┌──────────────────┐
      │   Reconciler    │◄───────┤  Health Prober   │ 백엔드 상태 → 유효 업스트림 계산
      │  debounce·렌더  │        └──────────────────┘
      │  검증·스왑·롤백 │
      └────────┬────────┘
               ▼  DataplaneDriver 인터페이스
      ┌─────────────────┐
      │  nginx driver   │  conf 렌더 → nginx -t → 원자 스왑 → reload
      │  (OpenResty)    │  + 동적 업스트림은 lua shared dict 로 reload 없이
      └─────────────────┘
```

**컨트롤 플레인과 데이터 플레인은 프로세스가 분리된다.** 컨트롤 플레인이 죽어도 트래픽은
계속 흘러야 한다. 이건 타협 불가 요구다 — 관리 UI 버그가 서비스 장애가 되면 안 된다.

---

## 4. 데이터 모델

프록시 중립 스키마다. `nginx` 라는 단어가 스키마에 등장하지 않는 것이 목표.

### 4.1 Listener — 무엇을 듣는가

| 필드 | 타입 | 비고 |
|---|---|---|
| `id` | uuid | |
| `name` | string | 사용자 식별용 |
| `protocol` | enum | `http` \| `https` \| `tcp` \| `udp` \| `tls_passthrough` |
| `bind_address` | string | 기본 `0.0.0.0`. 특정 NIC 바인딩 지원 |
| `port` | int | **인바운드 포트.** 백엔드 포트와 무관 |
| `default_pool_id` | uuid? | `tcp`/`udp` 는 필수 (라우트 매칭이 없으므로) |
| `tls_config_id` | uuid? | `https` 일 때 기본 인증서 |
| `accept_proxy_protocol` | bool | 앞단에 다른 LB 가 있을 때 |
| `enabled` | bool | 끄면 렌더에서 제외 (삭제와 구분) |

**포트 리매핑은 여기서 자연히 풀린다.** `Listener(port=999, tcp) → Pool A(backend a:11)`,
`Listener(port=888, tcp) → Pool B(backend b:11)`. 인바운드와 백엔드 포트가 애초에 다른
객체에 산다.

### 4.2 Route — 어떻게 매칭하는가

`http` / `https` / `tls_passthrough` 리스너에만 존재한다.

| 필드 | 타입 | 비고 |
|---|---|---|
| `listener_id` | uuid | |
| `match.host` | string[] | `api.example.com`, `*.example.com` |
| `match.path_prefix` | string? | HTTP 만 |
| `match.sni` | string[] | `tls_passthrough` 만 — **ssl_preread 기반** |
| `upstream_pool_id` | uuid | |
| `priority` | int | 명시적 우선순위. 암묵적 정렬 규칙을 만들지 않는다 |
| `tls.certificate_id` | uuid? | 라우트별 인증서 (SNI) |
| `tls.min_version` | enum | `1.2` \| `1.3` |
| `redirect_http_to_https` | bool | |
| `request_headers` | map | 추가/제거 |
| `timeouts` | object | connect / read / send |
| `websocket` | bool | Upgrade 헤더 전달 |

### 4.3 UpstreamPool — 어디로 보내는가

| 필드 | 타입 | 비고 |
|---|---|---|
| `name` | string | |
| `algorithm` | enum | `round_robin` \| `least_conn` \| `ip_hash` \| `hash` |
| `hash_key` | string? | `algorithm=hash` 일 때 |
| `health.type` | enum | `passive` \| `active_tcp` \| `active_http` \| `none` |
| `health.interval_s` / `timeout_s` / `rise` / `fall` | int | |
| `health.http_path` / `expect_status` | | `active_http` 일 때 |
| `send_proxy_protocol` | enum | `none` \| `v1` \| `v2` — **TCP 만. UDP 는 nginx 미지원** |
| `sticky` | object? | HTTP: 쿠키 / L4: `ip_hash` 로 대체 |

### 4.4 Backend — 풀의 멤버

| 필드 | 타입 | 비고 |
|---|---|---|
| `pool_id` | uuid | |
| `host` | string | IP 또는 DNS 이름 |
| `port` | int | **백엔드 포트** |
| `weight` | int | 기본 1 |
| `max_conns` | int? | |
| `admin_state` | enum | `enabled` \| `drain` \| `disabled` — **드레인은 필수 기능** |
| `health_state` | enum | 관측값 (읽기 전용): `healthy` \| `unhealthy` \| `unknown` |
| `is_backup` | bool | 전부 죽었을 때만 |

### 4.5 Certificate

| 필드 | 타입 | 비고 |
|---|---|---|
| `name` / `domains[]` | | |
| `source` | enum | `acme` \| `uploaded` |
| `acme.challenge` | enum | `http-01` \| `dns-01` |
| `acme.dns_provider` | string? | **드라이버 이름** — 사내 DNS 는 비공개 드라이버 |
| `not_after` | timestamp | 만료 모니터링·알림의 근거 |
| `secret_ref` | string | 실제 키는 SecretStore 드라이버가 보관 (§ 9) |

**개인키는 메인 DB 에 평문으로 두지 않는다.** SecretStore 드라이버 경유.

---

## 5. API

### 5.1 규약
- `/api/v1/...`, JSON, REST.
- **낙관적 동시성 필수** — 모든 리소스에 `version` 필드. `If-Match` 불일치 시 `409`.
  GUI 와 CLI 가 동시에 편집하는 게 정상 시나리오이므로 last-write-wins 를 허용하지 않는다.
- 인증: API 토큰(스코프 포함) + OIDC(사람). 인가는 RBAC.
- 모든 변경은 **감사 로그**(who/what/before/after/generation).

### 5.2 엔드포인트 (핵심)

```
GET    /api/v1/listeners                POST /api/v1/listeners
GET    /api/v1/listeners/{id}           PATCH|DELETE /api/v1/listeners/{id}
GET    /api/v1/routes                   POST /api/v1/routes           (+ {id})
GET    /api/v1/pools                    POST /api/v1/pools            (+ {id})
GET    /api/v1/pools/{id}/backends      POST ...                      (+ {id})
PATCH  /api/v1/backends/{id}            # admin_state 변경 = 드레인/복귀
GET    /api/v1/certificates             POST ...  POST {id}/renew

# 적용·관찰 — 여기가 NPM 과 갈리는 지점
POST   /api/v1/plan                     # dry-run: 렌더 diff + 검증 결과만 반환
POST   /api/v1/apply                    # 즉시 reconcile 트리거 (평소엔 자동)
GET    /api/v1/status                   # generation, 마지막 적용 시각/결과, 드리프트
GET    /api/v1/config/rendered          # 현재 렌더된 conf 전문 (디버깅 필수)
GET    /api/v1/health/backends          # 프로버 관측 상태
GET    /api/v1/events                   # SSE: 상태·헬스·적용 결과 스트림
GET    /api/v1/audit                    # 감사 로그
```

`POST /plan` 은 **GUI 의 "저장" 버튼이 무엇을 바꿀지 미리 보여주기 위한 것**이다.
로드밸런서 설정에서 "무슨 일이 일어날지 모르고 저장" 은 사고의 주된 원인이다.

### 5.3 CLI (`bary`)

API 를 얇게 감싼다. 별도 로직 금지.

```bash
bary listener create --name game --protocol tcp --port 999 --pool pool-a
bary pool create --name pool-a --algorithm least_conn
bary backend add --pool pool-a --host 10.0.0.11 --port 11 --weight 2
bary backend drain <id>                 # 무중단 배포용
bary route create --listener web --host api.example.com --pool api-pool --tls auto
bary plan                               # diff 미리보기
bary apply
bary get config --rendered              # 렌더 결과
bary export > barycenter.yaml           # 선언형 덤프
bary import barycenter.yaml               # GitOps 진입점
```

`export`/`import` 를 v0 부터 넣는다. **GUI 로 만든 설정을 git 에 넣을 수 있어야**
실무에서 채택된다.

---

## 6. Reconciler — 프로젝트의 심장

```
변경 이벤트(모델 or 헬스) 
  → 디바운스 (기본 2s, 최대 지연 10s)
  → 렌더: 모델 → conf 파일 트리 (임시 디렉토리)
  → 검증: nginx -t -c <임시 prefix>
  → 실패 → 적용 안 함, generation 유지, 오류를 API/GUI 에 노출
  → 성공 → 원자적 스왑 (symlink swap) → reload (SIGHUP)
  → 사후 확인: 마스터 생존 + 리스너 소켓 바인딩 확인
  → 실패 → 직전 conf 로 되돌리고 다시 reload → 알림
```

### 반드시 지킬 것

- **디바운스는 옵션이 아니다.** nginx reload 는 새 워커를 띄우고 **옛 워커는 기존 연결이
  끝날 때까지 살아 있다**. 장수 TCP 세션 + 잦은 reload = 워커/메모리 누적.
  헬스체크가 백엔드를 넣었다 뺐다 하면 reload 폭풍이 난다.
- **`worker_shutdown_timeout` 은 양날.** 안 걸면 워커가 안 죽고, 걸면 세션이 끊긴다.
  기본값을 정하고 **문서에 트레이드오프를 명시**한다.
- **헬스 변화는 reload 를 유발하지 않아야 한다.** → § 7.3 동적 업스트림.
- **드리프트 감지**: 렌더 산출물의 해시를 저장하고 주기적으로 실제 파일과 대조.
  누가 손으로 conf 를 고쳤으면 `status` 에 드리프트로 표시한다(자동 덮어쓰기 전에 알린다).

---

## 7. nginx 렌더링

### 7.1 요구사항 예시가 어떻게 떨어지는가

**`:999 → A:11`, `:888 → B:11`** (TCP):

```nginx
stream {
    upstream pool_a { least_conn; server 10.0.0.11:11 weight=2 max_fails=3 fail_timeout=10s; }
    upstream pool_b { least_conn; server 10.0.0.21:11; }

    server { listen 999;      proxy_pass pool_a; proxy_timeout 10m; proxy_protocol on; }
    server { listen 888;      proxy_pass pool_b; }
}
```

**UDP** (게임/DNS/VPN):

```nginx
stream {
    upstream dns_pool { server 10.0.1.5:53; server 10.0.1.6:53; }
    server {
        listen 8853 udp;
        proxy_pass dns_pool;
        proxy_responses 1;      # 응답 개수 — 프로토콜별로 다르다
        proxy_timeout 5s;
    }
}
```

**443 SNI 패스스루** (NPM 에 없는 것):

```nginx
stream {
    map $ssl_preread_server_name $tls_backend {
        mail.example.com   pool_mail;
        db.example.com     pool_db;
        default            pool_default;
    }
    server {
        listen 443;
        ssl_preread on;
        proxy_pass $tls_backend;
    }
}
```

**HTTP 도메인 라우팅 + TLS 종단**:

```nginx
http {
    upstream api_pool { least_conn; server 10.0.2.10:8080; server 10.0.2.11:8080; }
    server {
        listen 443 ssl;
        http2 on;
        server_name api.example.com;
        ssl_certificate     /etc/barycenter/certs/api.example.com/fullchain.pem;
        ssl_certificate_key /etc/barycenter/certs/api.example.com/privkey.pem;
        ssl_protocols TLSv1.2 TLSv1.3;
        location / {
            proxy_pass http://api_pool;
            proxy_set_header Host $host;
            proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto $scheme;
            proxy_http_version 1.1;
            proxy_set_header Upgrade $http_upgrade;   # websocket=true 일 때만
            proxy_set_header Connection $connection_upgrade;
        }
    }
}
```

### 7.2 파일 레이아웃

```
/etc/barycenter/
├── current -> generations/000123/        # 원자 스왑 대상 symlink
├── generations/000123/
│   ├── nginx.conf
│   ├── http/{listener-*.conf, upstream-*.conf}
│   └── stream/{listener-*.conf, upstream-*.conf}
└── certs/<domain>/{fullchain.pem, privkey.pem}
```

세대(generation) 디렉토리를 N개 보존한다 → **롤백이 symlink 되돌리기 + reload 로 끝난다.**

### 7.3 순수 nginx vs OpenResty — 핵심 분기

| | 순수 nginx (reload) | OpenResty (`balancer_by_lua`) |
|---|---|---|
| 백엔드 추가/제거 | reload 필요 | **reload 불필요** (shared dict 갱신) |
| 액티브 헬스체크 | **없음**(Plus 상용) — 컨트롤 플레인이 대행 | lua 로 구현 가능 |
| 구조 변경(리스너/라우트) | reload | reload (동일) |
| 복잡도 | 낮음 | 중간 |
| 선례 | — | NPM 도 OpenResty 기반 |

**권고: OpenResty.** 이유는 하나다 — *헬스체크가 reload 를 유발하면 안 되기 때문*.
nginx OSS 에 액티브 헬스체크가 없으므로 컨트롤 플레인이 프로브를 대행해야 하는데,
그 결과를 반영하는 수단이 reload 뿐이면 백엔드 하나 깜빡일 때마다 프록시 전체가 흔들린다.
`balancer_by_lua` 로 **업스트림 멤버십만 런타임 상태로 빼면** 구조 변경만 reload 하면 된다.

### 7.4 nginx 의 한계 — 문서에 명시할 것

- **UDP 는 PROXY protocol 미지원** ([nginx#1061](https://github.com/nginx/nginx/issues/1061))
  → 백엔드가 실 클라이언트 IP 를 못 얻는다. 우회 없음. GUI 에서 UDP + PROXY protocol 조합은
  **선택 자체를 막는다**(저장 후 안 되는 것보다 낫다).
- UDP "세션" 은 client IP:port 기반 유사 세션. `proxy_responses` 를 프로토콜에 맞게 정해야
  하고, 틀리면 응답이 잘리거나 세션이 안 닫힌다.
- 액티브 헬스체크 부재(§ 7.3).
- `proxy_timeout` 기본 10분 — 장수 세션(게임, VPN)에서 반드시 조정 대상.

---

## 8. TLS / 인증서

- **ACME**: `http-01`(80 포트 도달 필요) + `dns-01`(프로바이더 드라이버).
- 갱신은 만료 30일 전 자동, 실패 시 알림. `not_after` 를 상태 API 에 노출.
- **인증서 교체는 reload 를 유발한다** → 갱신도 디바운스 큐에 태운다.
- 업로드 인증서도 1급 시민(사내 CA, 와일드카드 구매분).
- 개인키는 SecretStore 드라이버 경유. **GUI 는 개인키를 절대 되돌려주지 않는다**(쓰기 전용).

---

## 9. 드라이버 인터페이스 — OSS / 사내 경계

**포크하지 않는다.** OSS 코어에 인터페이스를 두고 조직별 구현을 별도 레포로 주입한다.
포크는 릴리스마다 충돌하고 단방향 sync 는 실제로 밀린다 — 코어가 활발히 움직이는 초기일수록
그 비용이 크다.

라이선스: **Apache-2.0** (특허 조항 때문에 MIT 보다 낫다. 비공개 드라이버 유지에 문제없음).

```ts
// 1. 데이터플레인 — nginx 외 백엔드로 확장할 여지
export interface DataplaneDriver {
  render(model: Model): Promise<RenderedConfig>;
  validate(config: RenderedConfig): Promise<void>;   // 실패는 throw ValidationError
  apply(config: RenderedConfig): Promise<void>;
  rollback(generation: number): Promise<void>;
  status(): Promise<DataplaneStatus>;
}

// 2. ACME DNS-01 — 조직 내부 DNS 는 여기로
export interface DNSProvider {
  present(domain: string, token: string): Promise<void>;
  cleanUp(domain: string, token: string): Promise<void>;
}

// 3. 백엔드 디스커버리 — 인벤토리/레지스트리에서 풀 멤버 자동 채우기
export interface BackendDiscovery {
  resolve(selector: string): Promise<Backend[]>;
  watch(selector: string, signal: AbortSignal): AsyncIterable<Backend[]>;
}

// 4. 인증/인가 — 조직 OIDC 및 RBAC 매핑
export interface AuthProvider {
  authenticate(credentials: Credentials): Promise<Principal>;
  authorize(p: Principal, action: Action, resource: ResourceRef): Promise<boolean>;
}

// 5. 시크릿 저장소 — 개인키·API 토큰
export interface SecretStore {
  get(ref: string): Promise<Buffer>;
  put(ref: string, data: Buffer): Promise<void>;
  delete(ref: string): Promise<void>;
}

// 6. 감사/알림 싱크
export interface AuditSink { emit(event: AuditEvent): Promise<void>; }
export interface Notifier  { notify(alert: Alert): Promise<void>; }
```

**로딩 방식**: 드라이버는 **npm 패키지**로 배포하고 설정에 패키지명을 적으면 런타임에
동적 `import()` 로 로드한다. 코어를 다시 빌드할 필요가 없다 — Go 였다면 재컴파일이나
플러그인 런타임이 필요했을 지점이고, **Node 선택의 실질적 이득**이다.
드라이버는 `BarycenterDriver` 규약(이름·버전·팩토리)을 default export 한다.

---

## 10. Web GUI

- 스택: **SvelteKit** (Svelte 5 runes). 코어와 같은 TypeScript 타입을 공유한다.
- 핵심 화면
  1. **Listeners** — 포트별 목록. 프로토콜 배지, 연결된 풀, 상태.
  2. **Routes** — 도메인/SNI ↔ 풀 매핑. HTTP 와 TLS 패스스루를 한 화면에서 구분 표시.
  3. **Pools & Backends** — 멤버 헬스 상태 실시간(SSE), **드레인 토글**.
  4. **Certificates** — 만료 임박 정렬, 갱신 버튼, ACME 실패 사유 노출.
  5. **Plan/Diff 모달** — 저장 전 무엇이 바뀌는지. *채택률을 좌우하는 화면.*
  6. **Rendered Config** — 읽기 전용 conf 뷰어. 신뢰 확보용.
  7. **Audit** — 누가 무엇을 언제.
- 실시간: SSE (스냅샷 + 델타, 하트비트). GUI 는 상태를 폴링하지 않는다.

---

## 11. 배포 형태

- 컨트롤 플레인 + 데이터 플레인 **별도 컨테이너**. 컨트롤 플레인 재시작이 트래픽에 영향 없어야 한다.
- **배포 1급 경로는 컨테이너 이미지**다. 코어가 Node 라 단일 바이너리가 아니므로
  (§ 13-1 에서 감수한 트레이드오프), `docker compose` 한 장으로 컨트롤+데이터 플레인이
  같이 뜨는 것이 기본 설치 경험이어야 한다. 바이너리 배포는 Node SEA 로 v1.0 이후 검토.
- 상태 저장소: PostgreSQL (기본), SQLite (단일 노드 간편 모드).
- 설정 볼륨 공유: `/etc/barycenter` 를 양쪽이 마운트. reload 트리거는 컨트롤 플레인 → 데이터 플레인
  (유닉스 소켓 또는 사이드카 에이전트. 컨트롤 플레인이 nginx 프로세스를 직접 소유하지 않는다).
- **⚠️ 동적 포트 노출이 실제로 제일 어렵다.** `:999`, `:888` 처럼 임의 포트가 계속 늘어나는데,
  Kubernetes 에서 이걸 노출하려면 hostNetwork / hostPort / LoadBalancer 중 하나를 골라야 하고
  셋 다 제약이 있다(예: Cilium 의 `nodeport-addresses` 설정이 HostPort 바인딩까지 함께
  제한하는 사례가 알려져 있다).
  → **v1 권장 배포는 전용 VM + hostNetwork**. k8s 네이티브 배포는 별도 과제로 분리한다.

---

## 12. 로드맵

| 단계 | 내용 | 완료 판정 |
|---|---|---|
| **v0.1** 코어 | 모델 + PG + REST API + nginx 렌더/검증/스왑/롤백 | `curl` 로 `:999→A:11` 이 뜬다 |
| **v0.2** L4 | 업스트림 풀, LB 알고리즘, UDP, **SNI 패스스루** | SNI 로 두 백엔드가 갈린다 |
| **v0.3** CLI | `bary` 전 리소스 CRUD + `plan`/`apply`/`export`/`import` | GUI 없이 전부 가능 |
| **v0.4** GUI | 7개 화면 + SSE + Plan 모달 | 클릭만으로 v0.2 시나리오 재현 |
| **v0.5** TLS | ACME http-01/dns-01, 업로드, 자동 갱신 | 만료 전 무중단 갱신 관측 |
| **v0.6** 헬스 | 액티브 프로브 + OpenResty 동적 업스트림 + 드레인 | 백엔드 down 시 **reload 없이** 격리 |
| **v0.7** 드라이버 | 6개 인터페이스 확정 + 참조 구현 | 사내 레포가 코어 수정 없이 빌드 |
| **v1.0** | RBAC, 감사, 문서, 백업/복구 | — |

**PoC 우선순위**: v0.1 + v0.2 만 먼저. *SNI 라우팅 · 업스트림 풀 · 포트 리매핑* 셋이
차별점의 전부이고, 여기서 막히면 나머지는 의미가 없다.

---

## 13. 미결정 사항 — 착수 전 결정 필요

1. **구현 언어** — ✅ **Node.js + TypeScript** 로 확정 (2026-08-11).
   - 런타임은 **Node** (Bun 아님). 생태계 호환성과 배포 예측 가능성을 우선.
   - 코어/API: TypeScript. GUI: SvelteKit. CLI(`bary`): 같은 코어 타입을 공유하는 얇은 래퍼.
   - ⚠️ **감수한 트레이드오프**: Go 대비 **단일 바이너리 배포를 잃는다**. 이 도메인의
     선례(Traefik·Caddy)가 Go 인 이유가 그것이므로, 설치 경험을 컨테이너로 보완하지 않으면
     채택률에서 손해를 본다 → § 11 참고.
   - 대신 얻는 것: 드라이버를 **npm 패키지 + 동적 `import()`** 로 로드할 수 있어
     재컴파일이 필요 없다 (§ 9). 사내 드라이버 배포 경로가 훨씬 짧아진다.
2. **OpenResty 를 v0.1 부터 넣을 것인가**, v0.6 까지 순수 nginx 로 갈 것인가.
   (권고: 렌더러 추상화를 처음부터 두되 OpenResty 전환은 v0.6)
3. **프로젝트명** — ✅ `barycenter` 로 확정 (2026-08-11). GitHub 동명 레포 0건 확인.
4. **레포 위치** — ✅ 확정 (2026-08-11).
   - 공개 정본: **`mack-erel/barycenter`** (Apache-2.0). 여기가 유일한 코어 정본이다.
   - 사내 드라이버: 별도 비공개 레포에서 코어를 **npm 의존으로 참조**. **포크하지 않는다** (§ 9).
5. **v1 에서 멀티 인스턴스를 정말 뺄 것인가.** 뺀다는 게 현재 전제다.
6. **UDP 헬스체크를 어떻게 정의할 것인가** — UDP 는 응답 없음이 정상인 프로토콜이 많다.
   (잠정: 프로토콜별 프로브를 드라이버로 뺀다)

---

## 14. 리스크

- **NPM 이 stream 을 제대로 만들면 차별점의 절반이 사라진다.** issue #4119 가 오래 열려 있는 건
  유리하지만 영구 보장은 아니다. → 우리 해자는 stream 기능 자체보다 **API/CLI 대칭 + 검증·롤백**
  쪽에 두는 편이 안전하다.
- **L4 LB 는 L7 보다 운영 난이도가 높다** — 세션 유지, PROXY protocol, 그레이스풀 드레인.
  GUI 로 감싸면 사용자가 실수할 표면이 넓어진다. → `plan` 미리보기와 **불가능 조합의 사전 차단**이
  안전장치다.
- **reload 폭풍**이 최대 기술 리스크. § 6·§ 7.3 이 그에 대한 답이다.
- **스코프 크리프** — 플러그인/게이트웨이/WAF 로 번지면 APISIX 와 겹치고 진다. § 1 비목적을 지킬 것.

---

## 참고

- [NGINX TCP/UDP Load Balancing](https://docs.nginx.com/nginx/admin-guide/load-balancer/tcp-udp-load-balancer/)
- [ngx_stream_proxy_module](https://nginx.org/en/docs/stream/ngx_stream_proxy_module.html)
- [NPM issue #4119 — SNI 라우팅 미지원](https://github.com/NginxProxyManager/nginx-proxy-manager/issues/4119)
- [nginx#1061 — UDP PROXY protocol 미지원](https://github.com/nginx/nginx/issues/1061)
- [Nginx Proxy Manager](https://nginxproxymanager.com/) · [Traefik](https://traefik.io/traefik)

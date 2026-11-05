# 데이터 공급 런북 — 백엔드 출처 · 주소 집합 출처

barycenter 는 두 가지 목록을 바깥에서 받는다.

- **풀의 백엔드 출처** (디스커버리): DNS SRV · Consul · Kubernetes · 파일에서 백엔드 주소를 받는다.
- **주소 집합 출처**: Cloudflare · AWS · GCP · Fastly · 임의 URL 에서 대역 목록을 받는다.

설정이 없으면 지금과 같다. 출처를 켠 풀과 집합만 바뀐다.

## 1. 풀의 백엔드 출처

### 무엇을 하나

데몬이 출처에 주기적으로 묻는다. 받은 주소가 그 풀의 정적 백엔드를 대신한다.
멤버십 평면(lua)에서만 바뀐다. 세대 · 리비전 · reload 가 없다. 헬스 · 드레인과 같은 투영 경로(`projectHealth`)를 쓴다.

정적 백엔드는 지우지 않는다. 다음 때에 쓰인다.

- 출처가 아직 한 번도 답하지 않았다.
- 이 데몬에 그 출처가 설정되지 않았다.
- 엔진에 멤버십 평면이 없다(러너가 꺼진다).

### 안전장치

| 사건 | 동작 |
|---|---|
| 출처 오류 · 타임아웃 · 이상한 답 | **마지막 성공 목록을 지킨다.** 한 번도 성공하지 않았으면 정적 백엔드 |
| 정상 응답이 빈 목록 | `emptyMeans: keep`(기본)이면 마지막 목록을 지킨다. `empty` 면 백엔드 0 (요청이 실패한다) |
| 출처 설정(`source` · `query` · `port`)을 바꿈 | 들던 목록을 버린다. 새 질문의 답을 기다리는 동안 정적 백엔드 |
| 출처를 끔 | 정적 백엔드로 돌아간다 |
| 답에 IP 가 아닌 값 · 1024 개 초과 | 그 답 전체를 버린다(`invalid` · `too-large`). 반쪽 목록을 쓰지 않는다 |

발견한 백엔드는 헬스 프로버가 재지 않는다. 헬스는 출처가 진다(Consul 은 `passing` 만, Kubernetes 는 `ready` 만 받는다).

### 풀에 켜기

```sh
bary pool discovery --name app --source consul --query api
bary pool discovery --name app --source kubernetes --query prod/api --port 8080
bary pool discovery --name app --source dns-srv --query _http._tcp.api.internal --empty empty
bary pool discovery --name app --off
```

명령은 커밋까지 한다. 적용(`bary apply`)은 하지 않는다. GUI 는 풀 설정의 「백엔드 출처」 구획이다.

| 출처 | `query` | 받는 것 |
|---|---|---|
| `dns-srv` | SRV 이름 | 가장 낮은 priority 의 target 을 A · AAAA 로 푼 주소. weight 는 쓰지 않는다 |
| `consul` | 서비스 이름 | `GET /v1/health/service/<이름>?passing=true` 의 `Service.Address`(없으면 `Node.Address`) |
| `kubernetes` | `네임스페이스/서비스` | 그 서비스의 EndpointSlice 에서 `ready` 인 IP. 포트는 슬라이스의 첫 포트 (`--port` 로 덮는다) |
| `file` | 파일 이름 | `BARY_DISCOVERY_FILE_DIR/<이름>` 의 `[{"host","port"}]`. 시험 · 수동용 |

### 데몬 설정 (env)

| 변수 | 기본 | 뜻 |
|---|---|---|
| `BARY_DISCOVERY_INTERVAL_MS` | `30000` | 폴링 간격. ±10% 지터 |
| `BARY_DISCOVERY_TIMEOUT_MS` | `5000` | 한 번 묻는 시간 상한 |
| `BARY_DISCOVERY_DNS_SERVERS` | 시스템 | SRV 를 물을 서버 IP (쉼표) |
| `BARY_DISCOVERY_CONSUL_URL` | — | Consul https 주소. 없으면 Consul 출처가 꺼진다 |
| `BARY_DISCOVERY_CONSUL_TOKEN_FILE` | — | ACL 토큰 파일 (선택) |
| `BARY_DISCOVERY_K8S_URL` | 클러스터 안이면 `https://$KUBERNETES_SERVICE_HOST:$KUBERNETES_SERVICE_PORT` | API 서버 |
| `BARY_DISCOVERY_K8S_TOKEN_FILE` | 클러스터 안 `…/serviceaccount/token` | 서비스 계정 토큰 |
| `BARY_DISCOVERY_K8S_CA_FILE` | 클러스터 안 `…/serviceaccount/ca.crt` | API 서버 CA |
| `BARY_DISCOVERY_FILE_DIR` | — | 파일 출처의 디렉터리. 없으면 파일 출처가 꺼진다 |

규칙:

- 주소는 **https 만** 받는다. Consul 을 평문(`:8500`)으로만 열었다면 TLS(`:8501`)를 켠다.
- **반만 설정하면 기동을 거부한다.** 예: 토큰 파일만 주고 주소를 안 줌 · 클러스터 밖에서 K8s 주소만 줌 · 못 읽는 토큰 파일.
- 토큰은 파일로만 받는다. 데몬은 **부를 때마다** 파일을 읽는다. 회전한 토큰이 재기동 없이 들어간다.
- Kubernetes 권한: 그 네임스페이스의 `endpointslices` 에 `list`(`discovery.k8s.io`).

### 누가 도나

- 러너는 모든 노드에서 돈다. `/discovery` 는 그 노드가 본 것을 말한다.
- 멤버십 투영은 리더가 한다. 클러스터 모드(`BARY_CLUSTER=1`)의 팔로워도 자기 nginx 에 투영한다.

### 상태 보기

```sh
bary get discovery              # 모든 풀
bary get pools/app/discovery    # 풀 하나
```

GUI 는 풀 상세의 「출처에서 받은 백엔드」 상자다(받은 주소 · 마지막 갱신 · 오류).

| `state` | 뜻 |
|---|---|
| `pending` | 아직 묻지 않았다. 정적 백엔드 |
| `ok` | 마지막 질문이 성공했다 |
| `error` | 마지막 질문이 실패했다. `advertised` 가 참이면 마지막 목록을 쓰는 중 |
| `unconfigured` | 이 데몬에 그 출처가 설정되지 않았다. 정적 백엔드 |

### 실패의 뜻 (`error.reason`)

| 사유 | 뜻 | 할 일 |
|---|---|---|
| `unconfigured` | 출처 설정 · 토큰 파일이 없다 | env 를 본다 |
| `insecure` | 평문 주소 | https 로 바꾼다 |
| `unavailable` | 닿지 못함 · 타임아웃 · 5xx | 출처의 상태 · 망을 본다 |
| `unauthorized` | 401 · 403 | 토큰 · ACL · RBAC 를 본다 |
| `not-found` | 404 · NXDOMAIN · 파일 없음 | `query` 를 본다 |
| `too-large` | 응답 · 주소 수가 상한을 넘음 | 출처를 좁힌다 |
| `invalid` | 해석 실패 · IP 가 아닌 값 · FQDN 슬라이스 | 출처의 답을 본다 |

### 로그 · 이벤트

| 이름 | 언제 |
|---|---|
| `discovery.source_failed` (로그 warn) | 풀이 **새로** 실패했다(성공 → 실패, 또는 사유가 바뀜). 같은 실패를 매 주기 다시 내지 않는다 |
| `discovery.source_recovered` | 실패했다가 성공했다 |
| `discovery.changed` · `discovery.projected` | 쓰는 목록이 바뀌어 멤버십을 다시 투영했다 |
| SSE `discovery` | 위 셋과 같은 때. `{pool, state, …}` |
| 지표 `bary_discovery_failure_total{reason}` · `bary_discovery_change_total` | |

알림 어댑터는 `discovery.source_failed` 를 받으면 된다.

## 2. 주소 집합 출처

### 무엇을 하나

집합의 `source` 가 출처 레지스트리의 이름이다. 옛 저장값 `cloudflare` 도 그 이름 하나다 — 그대로 읽힌다.
출처가 있는 집합은 손으로 고치지 않는다. 목록을 다시 받는다.

| 출처 | 받는 곳 | 옵션 |
|---|---|---|
| `cloudflare` | `ips-v4/` · `ips-v6/` (**둘 다** 받아야 성공) | `family` |
| `aws` | `ip-ranges.amazonaws.com/ip-ranges.json` | `family` · `services`(예: `CLOUDFRONT`) · `regions`(예: `GLOBAL`) |
| `gcp` | `www.gstatic.com/ipranges/cloud.json` | `family` · `services`(예: `Google Cloud`) · `regions`(= `scope`) |
| `fastly` | `api.fastly.com/public-ip-list` | `family` |
| `url` | `sourceOptions.url` (https 만) | `family` · `url` · `jsonPath`(예: `prefixes.ip_prefix`. 없으면 한 줄에 하나, `#` 는 주석) |

### 만들기 · 다시 받기

```sh
bary address-set create --name cf --source cloudflare           # = --cloudflare
bary address-set create --name cloudfront --source aws --service CLOUDFRONT
bary address-set create --name office --source url --url https://lists.example/office.txt
bary address-set refresh --name cf
```

`create` 는 CLI 가 목록을 한 번 받아 처음 대역으로 넣는다. `refresh` 는 데몬이 받는다.
둘 다 **커밋까지** 한다. 같은 목록이면 아무것도 쓰지 않는다(순서만 다른 것도 같다).

GUI: 주소 집합 설정의 「출처」 · 「목록 다시 받기」 단추, 목록의 「마지막 갱신」 칸.

### 주기 갱신 (env)

| 변수 | 기본 | 뜻 |
|---|---|---|
| `BARY_ADDRESS_SOURCE_INTERVAL_MS` | 없음 = 꺼짐 | 주기 (60000 ~ 604800000). 리더만 돈다 |
| `BARY_ADDRESS_SOURCE_AUTOAPPLY` | `1` | `0` 이면 커밋까지만. 주기가 없는데 이것만 주면 기동을 거부한다 |

주기 갱신은 바뀐 때만 커밋한다. 작성자는 `address-source` 다(감사 · 리비전에 남는다).
자동 적용은 ACME 게시와 같은 규칙이다. **다른 변경이 적용 대기에 있으면 커밋까지만** 한다(`address_set.refresh_held`).
집합을 쓰는 리스너의 conf 가 바뀌므로 적용은 세대 전환(reload)이다.

### 실패하면

집합을 그대로 둔다. 마지막으로 받은 목록이 계속 쓰인다. 기록(`address_set_refresh`)에 사유가 남고, 「마지막 갱신」 은 마지막 **성공** 시각이다.

| 사유 | 뜻 |
|---|---|
| `unavailable` · `not-found` · `insecure` · `too-large` | 위 표와 같다 |
| `invalid` | 대역이 아닌 줄 · 모양이 다른 JSON · 거른 뒤 빈 목록(거르기를 틀리게 적음) |
| `commit` | 받았지만 커밋이 실패했다(검증 · head 경합). 다음 주기가 다시 한다 |

| 이름 | 언제 |
|---|---|
| `address_set.refresh_failed` (로그 warn) | 받기 · 커밋 실패. **알림 어댑터가 받을 이름** |
| `address_set.refreshed` · `address_set.refresh_held` | 커밋했다(적용함 · 미룸) |
| SSE `address_set` | `{key, outcome}` |
| 지표 `bary_address_set_refresh_total{outcome,reason}` | |

API: `POST /api/v1/address-sets/{key}/refresh`(write) — 200 `committed` · `unchanged`, 409 `no_source`, 502 `address_source_failed`.
`GET /api/v1/address-sets/refresh-status`(read).

## 3. 업그레이드

마이그레이션 033 이 돈다.

- `pools.discovery jsonb` 를 더한다.
- `address_sets.source` 의 CHECK 를 목록(`cloudflare`)에서 이름 모양으로 바꾼다. 있는 행은 그대로다.
- `address_sets.source_options jsonb` 와 `address_set_refresh` 표를 더한다.

옛 리비전으로 롤백해도 된다. 새 칸이 없는 모델은 정적이다.

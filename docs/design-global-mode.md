# 전역 모드 — 여러 지역 인스턴스를 한 화면에서 읽는다 (설계안)

> 상태: **설계안. 구현 전이다.** 2026-10-18 사용자 결정으로 B안(정본에 전역 모드를 둔다)을
> 골랐고, 이 문서는 그 모양을 정한다. 여기 적힌 결정은 리뷰에서 바뀔 수 있다 — 바뀌면 이
> 문서를 고친다.
>
> 요청: stardust(orc 경유). 지역 대시보드(`dev-icn-vtr.barycenter.tinyuniver.se`)와 전역
> 대시보드(`barycenter.tinyuniver.se`)를 함께 보고 싶다.

## 0. 한 줄

**전역 인스턴스는 데이터 플레인도 PG 도 없는 `barycenterd` 다.** 지역 인스턴스들을 auditor 토큰으로
읽어 한 화면에 모으고, **쓰기는 하지 않는다** — 쓰기는 그 지역의 GUI 로 넘긴다.

## 1. 왜 읽기 전용인가

쓰기를 전역에 열면 같은 설정을 두 곳(전역·지역)에서 바꿀 수 있게 된다. barycenter 의 쓰기는
changeset → plan → apply 를 지나고, 그 상태(리비전·etag·리더 lease)는 **지역 PG 에 산다.**
전역이 대신 쓰면:

- 전역이 본 리비전과 지역이 가진 리비전 사이에 창이 생긴다(전역이 낡은 화면으로 plan 을 낸다).
- 세션이 인스턴스 메모리에 있어서(§10) 전역에서 철회한 권한이 지역에 언제 미치는지 정할
  계약이 없다 — stardust Regional 의 「계약 1(철회 효력 시점)」과 같은 문제다.
- 지역 하나가 안 닿을 때 「일부만 적용됐다」를 표현해야 하는데, 지금 모델에 그 자리가 없다.

이 셋을 풀 이유가 지금은 없다. 그래서 **전역은 관측이고, 변경은 지역이다.**

## 2. 모양

```
                  운영자 브라우저 (OIDC 로그인, 전역용 클라이언트)
                              │
                 barycenter.tinyuniver.se  (메시 전용)
                              │
                ┌─────────────┴─────────────┐
                │  barycenterd  (BARY_MODE=global)
                │  · GUI (같은 빌드, 전역 화면 켜짐)
                │  · /api/v1/regions…  읽기 프록시 + 요약
                │  · PG 없음 · 데이터 플레인 없음 · 리더 선출 없음
                └──────┬───────────────┬────┘
              TLS + Bearer(auditor)  TLS + Bearer(auditor)
                       │               │
        dev-icn-vtr 지역 barycenterd   다른 지역 barycenterd
        tokens.json: {name:"global", role:"auditor", …}
```

### 2.1 레지스트리 — 파일 하나

지역 목록은 **정적 파일**이다(`BARY_GLOBAL_REGIONS`, JSON). DB 를 안 쓰는 이유: 전역에 PG 를
두면 전역이 또 하나의 정본이 되고, 그 정본의 백업·복구·리더 선출이 따라온다. 지역 목록은
자주 안 바뀌고, 바뀌면 배포 행위다.

```json
[
  {
    "name": "dev-icn-vtr",
    "api": "https://10.17.47.52:8443",
    "gui": "https://dev-icn-vtr.barycenter.tinyuniver.se",
    "ca": "/etc/barycenter/global/dev-icn-vtr-ca.pem",
    "token": "/etc/barycenter/global/dev-icn-vtr.token"
  }
]
```

- `name` 은 **키**다. URL·화면·로그에 그대로 쓰인다. `^[a-z0-9][a-z0-9-]{0,62}$`.
- `api` 는 지역의 관리 API(메시 주소). `gui` 는 쓰기를 넘길 곳. `ca` 는 지역 API 서버 인증서를
  검증할 CA, `token` 은 그 지역 auditor 토큰의 평문 파일(0600)이다.
- 모르는 키·중복 이름·`https` 아닌 `api` 는 **기동을 거부한다**(해독기와 같은 규칙).

### 2.2 인스턴스 간 인증 — 지역마다 auditor 토큰 하나

지역 쪽에 **새 코드가 필요 없다.** 지역마다 `tokens.json` 에
`{"name":"global","role":"auditor","hash":"sha256:…"}` 한 줄을 두고, 전역은 그 평문을
지역별 파일(`token` 칸, 0600)에서 읽어 `Authorization: Bearer` 로 붙는다.

auditor 는 `read` 스코프뿐이다. 전역이 실수로 쓰기 경로를 부르면 **지역이 403 으로 막는다** —
읽기 전용이 전역 코드의 약속이 아니라 지역의 권한으로 선다.

**mTLS(인증서 CN → `tokens.json` 이름)를 안 고른 이유.** 그 길은 이미 있지만
(`principalFromClientCert`), `BARY_TLS_CLIENT_CA_FILE` 은 `rejectUnauthorized: true` 라서
**그 리스너의 모든 접속**이 인증서를 내야 한다 — 지역 GUI 를 쓰는 브라우저 사용자까지다.
그러려면 지역에 전역 전용 리스너를 하나 더 열거나 클라이언트 인증서를 선택으로 바꿔야 하고,
둘 다 지역 코드를 바꾼다. 위험은 토큰과 같다: 전역이 털리면 어느 쪽이든 모든 지역의 읽기가
나가고, 끊는 법도 같다(그 지역 `tokens.json` 에서 `global` 줄을 지우고 재시작). 그래서
1차는 토큰이다. 지역 리스너를 나누는 일이 다른 이유로 생기면 그때 mTLS 로 옮긴다.

> ⚠️ auditor 의 `read` 는 `/config/export`·`/backup` 도 읽는다. 비밀 바이트는 없지만 백엔드
> 주소를 포함한 전체 설정이다. 전역의 토큰 파일은 그 무게로 다룬다(§5).

### 2.3 전역 API — 프록시는 허용 목록으로만

| 경로 | 하는 일 |
|---|---|
| `GET /api/v1/regions` | 레지스트리 + 지역마다 요약(`status` 의 4-way, 리비전, 마지막 성공 시각) |
| `GET /api/v1/regions/:name/<허용 경로>` | 그 지역의 같은 경로를 **그대로** 중계한다 |
| `GET /api/v1/regions/:name/events` | 지역 SSE 를 중계한다(지역마다 연결 하나, 화면이 고른 지역만) |

허용 경로(지금 GUI 가 읽는 것): `status` · `listeners` · `pools` · `backends` ·
`backends/status` · `routes` · `certificates` · `tls-policies` · `sni-bindings` ·
`acme/orders` · `audit` · `config/rendered` · `events`.

- **허용 목록 밖은 404 다.** `config/export`·`backup` 은 일부러 뺀다 — 화면에 필요 없고,
  전역을 지나는 순간 전체 설정이 한 곳에 모인다.
- **GET 외 메서드는 라우트 자체가 없다.** 프록시가 메서드를 그대로 넘기는 일이 없게, 중계는
  GET 만 만든다.
- 응답 본문은 **해석하지 않고 넘긴다.** 전역이 지역의 응답 모양을 알면 두 벌이 되고, 지역
  버전이 다르면 그 사이에서 깨진다. 요약(`/regions`)만 `status` 를 읽는다.

### 2.4 못 닿은 지역은 「모른다」 다

이 저장소가 반복해 배운 *"관측하지 못한 것과 관측해서 아니라고 한 것은 다르다"* 를 그대로 쓴다.

| 지역 응답 | 요약에 싣는 것 |
|---|---|
| 200 | 그 상태 그대로 + `observedAt` |
| 타임아웃·연결 실패·TLS 실패 | `reachable: false`, **상태는 `unknown`** — 마지막 값을 지금 값처럼 보이지 않는다. 마지막 성공 시각만 따로 싣는다 |
| 401·403 | `reachable: true`, `auth: "rejected"` — 인증서·tokens.json 설정 문제다. 장애와 섞지 않는다 |

요약은 지역마다 **독립 타임아웃**(기본 3초)으로 동시에 묻는다. 지역 하나가 느려도 화면 전체가
기다리지 않는다.

### 2.5 GUI — 같은 빌드, 지역 고르기 하나

- 전역 모드면 첫 화면이 **지역 목록**(`/regions` 요약)이다.
- 지역을 고르면 지금의 읽기 화면들(Status·Listeners·Pools·Routes·Certificates·Audit·Rendered)이
  `/api/v1/regions/<name>/…` 를 본다. 화면 코드는 API 기준 경로만 바꾼다.
- **쓰기 버튼은 안 그린다.** 그 자리에 「`<지역>` 에서 편집」 링크(`gui` 주소)를 둔다.
- 화면마다 지역 이름과 그 지역의 리비전을 늘 보인다 — 어느 지역을 보는지 헷갈리면 안 된다.

### 2.6 전역 데몬이 안 하는 것

PG 연결 · 마이그레이션 · 리더 선출 · 데이터 플레인 드라이버 · ACME · 헬스 프로브 · SecretStore.
전역 모드는 이것들을 **켜지 않는다**(설정해도 기동 거부 — 켰다고 믿는 상태를 만들지 않는다).
켜는 것은 API 서버 · GUI · OIDC 로그인 · 지역 클라이언트뿐이다.

## 3. 로그인

전역도 지역과 같은 OIDC Authorization Code 흐름이다. 전역용 OIDC 클라이언트를 따로 둔다
(redirect URI 가 호스트 이름 하나에 묶인다 — 지역마다 하나, 전역 하나).

전역에 로그인한 사람의 역할은 **전역 화면에 들어올 자격**만 정한다. 지역에 무엇을 읽어 오는지는
전역 인증서(auditor)가 정한다 — 즉 **전역에 들어온 사람은 모든 지역의 읽기 화면을 본다.**
지역별로 보이는 사람을 가르는 것은 이번 범위가 아니다(필요해지면 레지스트리에 역할 조건을 붙인다).

## 4. 무엇을 새로 만드나

| 자리 | 일 |
|---|---|
| `src/bin/barycenterd.ts` | `BARY_MODE=global` 분기 — PG·DP·리더 없이 API·GUI 만 세운다 |
| `src/global/registry.ts` (새) | 레지스트리 해독(모르는 키 거부) |
| `src/global/client.ts` (새) | 지역 클라이언트(TLS 검증 + Bearer) · 타임아웃 · 「모른다」 판정 |
| `src/api/server.ts` | 전역 라우트(`/regions…`), GET 허용 목록 중계, SSE 중계 |
| `gui/` | 지역 목록 화면, API 기준 경로, 쓰기 숨김·「지역에서 편집」 링크 |
| `deploy/install.sh` | `--mode global`, 레지스트리·클라이언트 인증서 경로 |
| 테스트 | 허용 목록 밖 404 · GET 외 없음 · 못 닿은 지역 `unknown` · 401/403 구분 · 지역 실물 둘 띄운 e2e |

지역 쪽 변경은 **없다**(문서와 tokens.json 한 줄뿐).

## 5. 운영 계약

- 전역은 **메시 전용**이다. 공개 443 에 안 올린다.
- 전역의 토큰 파일들 = 모든 지역의 전체 설정 읽기 권한. 회전·폐기 절차를 런북에 둔다.
  지역에서 끊는 법: 그 지역 `tokens.json` 에서 `global` 줄을 지우고 재시작.
- 전역이 죽어도 **지역은 아무 영향이 없다** — 전역은 지역에 아무것도 안 쓴다.

## 6. 정할 것 (리뷰에서)

0. **인스턴스 간 인증**: 지역별 auditor 토큰(§2.2, 권장 — 지역 변경 없음) 또는 mTLS(지역에 전역
   전용 리스너를 더 연다).

1. **SSE 중계를 처음부터 넣나**, 아니면 1차는 요약 + 읽기 화면만(폴링 없이 열 때 한 번 읽기)으로 가나.
   권장: 1차에 넣는다 — 지금 GUI 의 Status·Pools 가 SSE 로만 그린다(§10, 폴링하지 않는다).
2. **전역에 들어올 역할**: auditor 이상 전부인가, admin 만인가. 권장: auditor 이상.
3. **이름**: `BARY_MODE=global` 과 「전역 모드」라는 말. 지역 쪽은 따로 이름을 안 붙인다(기본이 지역이다).

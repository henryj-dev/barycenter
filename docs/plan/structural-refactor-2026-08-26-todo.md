# 구조 개선 실행 목록 — 2026-08-26

[`structural-refactor-2026-08-26.md`](./structural-refactor-2026-08-26.md) 의 실행판.
계획은 "무엇을 왜" 를 적고, 이 문서는 **"무엇을 어떤 순서로, 무엇이 초록이어야 다음으로
가는가"** 만 적는다.

---

## 0. 이 문서의 체계

### 0.1 왜 저장소의 기존 todo 형식을 안 쓰나

`docs/audit-*-todo.md` 는 **항목 목록**이다. 항목마다 재현물과 판정이 붙지만, 항목 사이에
순서 강제가 없고 "여기까지 됐다" 를 사람이 선언한다. 이 계획은 P3 처럼 **중간 상태가
위험한** 작업을 포함하므로 그 형식으로는 부족하다.

여기서는 세 가지를 더 건다.

1. **작업(Task)에 안정 ID** — `P3.T7` 은 문서가 개정돼도 같은 작업을 가리킨다
2. **단계마다 게이트(GATE)** — 통과 못 하면 다음 단계 작업을 **시작하지 않는다**
3. **봉인(SEAL)** — 게이트 통과를 파일로 남기고, 다음 단계가 그 파일을 요구한다

### 0.2 상태 표기

```
작업:  ☐ 미착수     ◐ 진행중     ☑ 완료
단계:  🔒 잠김      🔓 열림      ✅ 봉인됨
```

**🔒 잠긴 단계의 작업은 시작하지 않는다.** 앞 단계가 봉인되면 자동으로 🔓 가 된다.

### 0.3 봉인 — 이 문서의 강제 장치

`scripts/gate.mjs` (P0.T2 에서 만든다) 가 판정한다.

```sh
node scripts/gate.mjs P1            # P1 의 게이트 검사를 전부 돌린다
node scripts/gate.mjs P1 --seal     # 전부 초록이면 봉인 파일을 쓴다
node scripts/gate.mjs --status      # 현재 어디까지 봉인됐나
```

봉인 파일:

```
docs/metrics/gates/P1.json
{
  "phase": "P1",
  "sealed": true,
  "head": "<커밋 SHA>",
  "at": "2026-08-27T...",
  "checks": [ { "id": "G-P1.1", "ok": true, "measured": 0, "limit": 0 }, ... ]
}
```

**강제 규칙 셋** — `gate.mjs` 가 스스로 지킨다.

| 규칙 | 동작 |
|:--|:--|
| **R1 순서** | 선행 단계가 봉인 안 됐으면 이 단계 게이트 실행을 **거부**한다 |
| **R2 최신성** | 봉인 파일의 `head` 가 현재 `origin/main` 의 조상이 아니면 봉인을 **무효화**한다 |
| **R3 재검** | `--seal` 은 검사를 **다시 돌린다.** 이전 결과를 재사용하지 않는다 |

R2 가 핵심이다. 봉인해 놓고 나중에 그 단계 코드를 되돌리면 봉인이 자동으로 풀린다.

### 0.4 작업 하나의 모양

```
### P1.T3 — 제목
선행 · 산출 · 핀 · 되돌리기 단위
【작업】   손으로 할 일. 번호가 곧 커밋 단위
【테스트】 TC-P1.T3.a 형식. 이름 · 단언 · 없으면 놓치는 것
【통과】   전부 기계 판정. 사람 판단이 들어가는 항목은 통과 조건이 아니다
```

**「통과」에 사람 판단을 넣지 않는다.** "코드가 읽기 좋아졌다" 는 통과 조건이 아니다.
"`wc -l` 이 1000 미만" 은 통과 조건이다.

### 0.5 테스트케이스 작성 규칙

각 TC 는 세 줄을 갖는다.

```
TC-<작업ID>.<a|b|c>  <테스트 이름 — 파일에 그대로 들어갈 문장>
  단언:   무엇을 expect 하는가
  검출:   이 테스트가 없으면 무엇을 놓치나   ← 이 줄을 못 쓰면 테스트를 쓰지 마라
```

**「검출」줄을 못 쓰는 테스트는 만들지 않는다.** 이 저장소가 검출력 0 인 불변식을 다섯 개
쌓은 이유가 그 질문을 나중에 물었기 때문이다.

### 0.6 `Pinned-by:` 표식 (저장소 게이트)

`src/` 를 바꾸는 모든 커밋에 필요하다. 각 작업의 **핀** 칸이 지정한다.

```
Pinned-by: tests/unit/foo.test.ts -t "이름"        행동이 바뀌는 커밋
Pinned-by: none — <동치성을 판정하는 것>            순수 이동·삭제 커밋
```

`none` 의 근거에 **"리팩터링이라서" 를 쓰지 않는다.** 무엇이 동치성을 판정하는지 적는다.

---

## 진행 현황

| 단계 | 상태 | 게이트 | 봉인 |
|:--|:--|:--|:--|
| P0 기준선 | 🔓 열림 | `gate.mjs P0` | ☐ |
| P1 라우트 표 | 🔒 잠김 | `gate.mjs P1` | ☐ |
| P2 죽은 절 삭제 | 🔒 잠김 | `gate.mjs P2` | ☐ |
| P3 서술자 표 | 🔒 잠김 | `gate.mjs P3` | ☐ |
| P4 agent.ts 분해 | 🔒 잠김 (P2 필요) | `gate.mjs P4` | ☐ |
| P5 ControlPlane 분해 | 🔒 잠김 | `gate.mjs P5` | ☐ |
| P6 install.sh | 🔒 잠김 | `gate.mjs P6` | ☐ |
| P7 렌더러 분할 (선택) | 🔒 잠김 | `gate.mjs P7` | ☐ |
| P8 테스트 파일 분할 | 🔒 잠김 | `gate.mjs P8` | ☐ |
| P9 구조 게이트 | 🔒 잠김 (전부 필요) | `gate.mjs P9` | ☐ |

**선행 관계**

```
P0 ─┬─ P1 ──────────────┐
    ├─ P2 ─── P4 ───────┤
    ├─ P3 ──────────────┼─ P9
    ├─ P5 ──────────────┤
    ├─ P6 ──────────────┤
    ├─ P8 ──────────────┘
    └─ P7 (선택)
```

`P2 → P4` 만 직렬이다(같은 파일). 나머지는 P0 만 끝나면 병렬 가능하되, **동시 워크트리
최대 2**. P3 이 도는 동안은 하나만 더 연다.

---

# P0 — 기준선과 강제 장치 🔓

**브랜치** `chore/baseline-metrics` · **선행** 없음

이 단계는 나머지 전부의 **회계 장부이자 강제 장치**를 만든다. 여기를 건너뛰면 이 문서는
그냥 산문이 된다.

### ☐ P0.T1 — `scripts/metrics.mjs`

```
선행:      없음
산출:      scripts/metrics.mjs · docs/metrics/baseline-2026-08-26.json
핀:        불필요 (src/ 무변경)
되돌리기:  단독 커밋
```

**【작업】**

1. 다음을 JSON 으로 뱉는 스크립트를 쓴다. `git ls-files` 로 추적 파일만 본다.

```jsonc
{
  "at": "<ISO>", "head": "<SHA>",
  "files":    { "src/dp/agent.ts": { "total": 2485, "code": 1104, "comment": 1251 }, ... },
  "oversize": { "src": [...], "tests": [...], "deploy": [...], "gui": [...] },
  "auditNarrative": { "total": 373, "byFile": { "src/dp/agent.ts": 201, ... } },
  "kindExpansions": ["src/store/config-store.ts", "src/web/edit.ts", ...],
  "routes": { "inTable": 24, "handWired": 6 },
  "netLines": { "insertions": 0, "deletions": 0 }
}
```

2. `--diff <기준선.json>` 으로 델타를 뱉는 모드를 넣는다. 단계마다 이걸로 진척을 잰다.

**【테스트】**

```
TC-P0.T1.a  metrics 는 같은 트리에서 두 번 돌려도 같은 값을 낸다
  단언:  at/head 를 뺀 나머지가 deep-equal
  검출:  파일 순회 순서나 glob 비결정성 — 델타가 노이즈로 오염되는 것

TC-P0.T1.b  metrics 는 추적되지 않는 파일을 세지 않는다
  단언:  임시 파일 하나를 만들고 돌려도 files 키 수가 안 늘어난다
  검출:  node_modules · dist · .omc 가 섞여 수치가 부풀려지는 것
```

**【통과】**

- [ ] `node scripts/metrics.mjs > docs/metrics/baseline-2026-08-26.json` 성공
- [ ] TC-P0.T1.a · b 초록
- [ ] `oversize.src` 가 정확히 5 개, `auditNarrative.total` 이 373 — **기준선이 문서와 맞다**

---

### ☐ P0.T2 — `scripts/gate.mjs` (강제 장치)

```
선행:      P0.T1
산출:      scripts/gate.mjs · docs/metrics/gates/.gitkeep
핀:        불필요 (src/ 무변경)
되돌리기:  단독 커밋
```

**【작업】**

1. 단계별 검사 정의를 **데이터로** 둔다 — 검사 추가가 코드 수정이 아니게.

```js
const GATES = {
  P1: { needs: ['P0'], checks: [
    { id: 'G-P1.1', how: 'grep', ... , limit: 0 },
    { id: 'G-P1.2', how: 'lines', file: 'src/api/server.ts', limit: 500 },
    ...
  ]},
  ...
};
```

2. §0.3 의 R1·R2·R3 을 구현한다.
3. `--status` 는 진행 현황 표를 그대로 뱉는다 (이 문서와 대조 가능하게).

**【테스트】**

```
TC-P0.T2.a  선행이 봉인되지 않으면 게이트 실행을 거부한다
  단언:  P0 봉인 없이 `gate.mjs P1` → 종료코드 ≠ 0, "선행 P0 이 봉인되지 않았다"
  검출:  순서 강제가 실제로는 안 걸리는 것 — 이 문서 전체의 전제가 무너진다

TC-P0.T2.b  봉인 후 그 단계 커밋을 되돌리면 봉인이 무효가 된다
  단언:  seal 의 head 가 HEAD 의 조상이 아니면 --status 가 "무효" 로 표시
  검출:  R2 미구현 — 봉인해 놓고 코드를 되돌려도 다음 단계가 열려 있는 것

TC-P0.T2.c  --seal 은 검사를 다시 돌린다
  단언:  검사를 일부러 실패하게 만든 뒤 --seal → 봉인 파일이 안 쓰인다
  검출:  R3 미구현 — 예전 초록 결과로 봉인하는 것

TC-P0.T2.d  게이트는 이빨이 있다 (음성 대조)
  단언:  각 검사마다 위반 상태를 인위로 만들고 게이트가 실패하는지 본다
  검출:  ★ 검출력 0 인 게이트. 이 저장소가 불변식에서 다섯 번 겪은 병이다
```

> **TC-P0.T2.d 는 선택이 아니다.** 이 계획이 고치려는 병 중 하나가 "잡지 못하는 검사를
> 쌓아 두는 것" 이다. 새로 만드는 게이트가 같은 병에 걸리면 계획이 자기모순이 된다.

**【통과】**

- [ ] TC-P0.T2.a ~ d 전부 초록
- [ ] `node scripts/gate.mjs --status` 가 P0 을 제외한 전부를 🔒 로 표시

---

### ☐ P0.T3 — 전체 검증 기준선

```
선행:      P0.T1, P0.T2
산출:      docs/metrics/verify-baseline.log
핀:        불필요
```

**【작업】**

```sh
npm run verify 2>&1 | tee docs/metrics/verify-baseline.log
node scripts/mutate.mjs --limit 200 2>&1 | tee docs/metrics/mutate-baseline.log
```

뮤테이션 **생존율**을 기록한다 — P2·P4·P5 의 비교 기준이다.

**【통과】**

- [ ] `npm run verify` 종료코드 0
- [ ] 두 로그가 커밋됨
- [ ] 뮤테이션 생존율이 로그 마지막 줄에 숫자로 남음

---

## 🚪 GATE P0 — 통과 못 하면 어떤 단계도 시작하지 않는다

| # | 검사 | 명령 | 통과 기준 |
|:--|:--|:--|:--|
| G-P0.1 | 기준선 존재 | `test -f docs/metrics/baseline-2026-08-26.json` | 존재 |
| G-P0.2 | 기준선 정확성 | `jq '.oversize.src\|length' <기준선>` | `= 5` |
| G-P0.3 | 서술 카운트 | `jq '.auditNarrative.total' <기준선>` | `= 373` |
| G-P0.4 | 게이트 이빨 | `npx vitest run tests/unit/gate.test.ts` | 초록 (TC-P0.T2.d 포함) |
| G-P0.5 | 전체 검증 | `npm run verify` | 종료코드 0 |

```sh
node scripts/gate.mjs P0 --seal
```

---

# P1 — API 라우트 표로 되돌린다 🔒 (P0 필요)

**브랜치** `refactor/route-table-auth`

### ☐ P1.T1 — 가드 테스트를 **먼저** 넣는다

```
선행:      GATE P0 봉인
산출:      tests/unit/route-auth-guard.test.ts
핀:        불필요 (tests/ 만)
되돌리기:  단독 커밋
```

> 이 작업이 P1 의 **진짜 산출물**이다. 최악의 사고는 `{ kind: 'none' }` 이 실수로 기존
> 라우트에 붙는 것이고, 이 테스트만이 그걸 잡는다. **코드보다 먼저 넣는다.**

**【작업】**

1. 현재 `ROUTES` 의 `(method, path, scope)` 전체를 **스냅샷 상수**로 테스트에 박는다.
2. 아래 세 TC 를 쓴다. 아직 `auth` 필드가 없으므로 a·b 는 P1.T2 이후 초록이 된다 —
   **먼저 빨간 것을 확인하고 커밋한다.**

**【테스트】**

```
TC-P1.T1.a  인증 없는 라우트는 정확히 셋이다
  단언:  ROUTES.filter(r => r.auth.kind === 'none').map(키) 가
         ['GET /healthz', 'GET /readyz', 'POST /api/v1/session/logout'] 과 정확히 일치
  검출:  ★ 인증 우회. 기존 라우트에 kind:'none' 이 붙는 사고

TC-P1.T1.b  모든 라우트가 auth 를 선언한다
  단언:  ROUTES 전부 r.auth !== undefined, kind 가 세 값 중 하나
  검출:  auth 없이 추가된 라우트가 기본값으로 조용히 통과하는 것

TC-P1.T1.c  bearer 라우트의 (method, path, scope) 집합이 기준선과 같다
  단언:  스냅샷 상수와 deep-equal (순서 무관, 집합 비교)
  검출:  이동 중 스코프가 바뀌거나 라우트가 사라지는 것 — P1 전체의 안전벨트
```

**【통과】**

- [ ] TC-P1.T1.c 초록 (a·b 는 이 시점 빨강이 정상)
- [ ] 스냅샷 상수의 항목 수가 `apiRouteTable().length` 와 일치

---

### ☐ P1.T2 — `RouteAuth` 모델 도입 (순수 리네임)

```
선행:      P1.T1
산출:      src/api/server.ts (Route · route())
핀:        none — 순수 리네임. 기존 라우트의 method·path·scope 가 불변이고
           TC-P1.T1.c 와 SURFACE-API.json 동결 비교가 그것을 판정한다.
되돌리기:  단독 커밋
```

**【작업】**

```ts
type RouteAuth =
  | { kind: 'none' }
  | { kind: 'bearer'; scope: Scope }
  | { kind: 'session' };
```

1. `Route.scope: Scope` → `Route.auth: RouteAuth`
2. `route()` 시그니처를 맞추고 **기존 호출부 전부**를 `{ kind: 'bearer', scope }` 로 기계 변환
3. `apiRouteTable()` 은 당분간 `scope` 를 그대로 뱉는다 (동결 무변경 유지)

> ⚠️ **`src/api/auth.ts` 의 `Scope` 를 건드리지 않는다.** 그건 토큰 권한이고
> (`ALL_SCOPES` · `scopesOfRole` · `can`), 거기에 `'public'` 을 넣으면
> "public 스코프를 가진 토큰" 이라는 없는 개념이 생긴다.

**【테스트】** 새 TC 없음. TC-P1.T1.a·b·c 가 전부 초록으로 바뀌는 것이 판정이다.

**【통과】**

- [ ] `npm run typecheck` 통과
- [ ] TC-P1.T1.a · b · c **전부 초록**
- [ ] `git diff SURFACE-API.json` **비어 있음** ← 동결이 안 움직여야 한다
- [ ] `src/api/auth.ts` diff **비어 있음**

---

### ☐ P1.T3 ~ P1.T7 — 다섯을 하나씩 표로 옮긴다

```
선행:      P1.T2
산출:      src/api/server.ts (ROUTES · handle())
핀:        각 커밋마다 실제 재현물 필수 ← 인가 판정 경로가 바뀐다
되돌리기:  라우트 하나 = 커밋 하나. 개별 revert 가능
```

| 작업 | 라우트 | auth |
|:--|:--|:--|
| P1.T3 | `GET /healthz` | `none` |
| P1.T4 | `GET /readyz` | `none` |
| P1.T5 | `POST /api/v1/session/logout` | `none` |
| P1.T6 | `GET /api/v1/oidc/authorization-request` | `session` |
| P1.T7 | `POST /api/v1/oidc/token` | `session` |

**GUI 정적 폴백(`:1077`)은 옮기지 않는다.** 라우트가 아니라 표가 미스한 뒤의 폴백이다.
표 우회가 아니라 표의 기본값이라는 것을 **코드 주석 한 줄로 명시**한다.

**【작업】** (각 작업 공통)

1. 손 분기를 지우고 `ROUTES` 에 항목을 추가
2. 핸들러 본문을 `(c: Ctx, api: ApiOptions) => Promise<void>` 시그니처로 이식
3. 그 라우트의 재현물을 **먼저** 쓰고 부모 트리에서 빨간지 확인

**【테스트】** — 라우트마다 둘씩

```
TC-P1.T3.a  /healthz 는 토큰 없이 200 과 {ok:true} 를 낸다
  단언:  Authorization 헤더 없이 요청 → 200, 본문 {ok:true}
  검출:  이동 중 auth:'none' 이 안 붙어 401 이 되는 것 (오케스트레이터가 프로세스를 죽인다)

TC-P1.T3.b  /healthz 는 라우트 표를 통해 매치된다
  단언:  apiRouteTable() 에 GET /healthz 가 있다
  검출:  손 분기를 남긴 채 표에도 넣어 이중 처리되는 것

TC-P1.T4.a  /readyz 는 준비 안 됨에 503 을 낸다
  단언:  control.readiness() 가 ok:false → 503 (200 아님)
  검출:  이동 중 상태코드 매핑이 뭉개져 오케스트레이터가 트래픽을 계속 보내는 것
TC-P1.T4.b  /readyz 가 표에 있다

TC-P1.T5.a  logout 은 인증 없이도 쿠키 둘을 만료시킨다
  단언:  토큰 없이 POST → 204, set-cookie 에 SESSION_COOKIE·LOGIN_COOKIE 만료 둘
  검출:  auth 를 붙여 버려 로그아웃이 인증을 요구하게 되는 것 (세션이 끊긴 사용자가 못 나감)
TC-P1.T5.b  logout 응답 본문에 신원이 실리지 않는다
  단언:  204 이고 본문 길이 0
  검출:  이식 중 json() 로 바꿔 신원이 새는 것

TC-P1.T6.a  oidc 미설정이면 authorization-request 는 404 oidc_not_configured
  단언:  api.oidcRp === undefined → 404, code:'oidc_not_configured'
  검출:  이동 중 500 이나 스택 노출로 바뀌는 것
TC-P1.T6.b  PKCE verifier·nonce 가 응답 본문에 없다
  단언:  본문에 verifier/nonce 키가 없다. state 와 로그인 쿠키만 나간다
  검출:  ★ 이식 중 검증자가 브라우저로 새는 것 — 보안 회귀

TC-P1.T7.a  oidc/token 은 code 없으면 400 이다
  단언:  본문에 code 누락 → 400
  검출:  이동 중 검증 순서가 뒤바뀌어 미인증 요청이 교환 로직에 닿는 것
TC-P1.T7.b  oidc/token 은 Bearer 를 요구하지 않는다
  단언:  Authorization 없이 정상 흐름이 진행된다 (400/200 이지 401 아님)
  검출:  auth:'session' 대신 'bearer' 가 붙어 로그인 자체가 불가능해지는 것
TC-P1.T7.c  oidc/token 이 표에 있고 auth.kind 가 'session' 이다
  단언:  apiRouteTable() 조회
  검출:  ★ 가장 민감한 표면이 여전히 표 밖에 남는 것
```

**【통과】** (각 작업)

- [ ] 해당 TC 전부 초록
- [ ] TC-P1.T1.a·b·c **여전히 초록** ← 회귀 감시
- [ ] `Pinned-by` 가 가리키는 테스트가 부모 트리에서 **빨강**임을 확인한 로그
- [ ] `npm run test:e2e` 초록

---

### ☐ P1.T8 — `handle()` 을 접는다

```
선행:      P1.T3 ~ P1.T7
핀:        none — 손 분기가 전부 제거된 상태의 정리. TC-P1.T1.* 와
           tests/e2e 가 동치성을 판정한다.
```

**【작업】** 최종 모양:

```
URL 파싱 → 라우트 매치 → auth 판정(none|bearer|session) → 핸들러 → 에러 매핑 → GUI 폴백
```

**【테스트】**

```
TC-P1.T8.a  handle() 본문에 경로 리터럴 비교가 없다
  단언:  handle() 소스에 /url\.pathname\s*===/ 가 0 회 (GUI 폴백은 함수 밖)
  검출:  ★ §2 의 재발. 이 정규식이 P9 의 G3 이 된다
```

**【통과】**

- [ ] TC-P1.T8.a 초록
- [ ] `npm run verify` 초록

---

### ☐ P1.T9 — 동결을 갱신한다

```
선행:      P1.T8
산출:      src/api/freeze.ts · SURFACE-API.json
핀:        none — 표는 이미 확정됐고 이 커밋은 그 표의 직렬화만 바꾼다.
           TC-P1.T9.a 가 새 표면을 판정한다.
되돌리기:  ★ 단독 커밋으로 둔다 — revert 비용이 가장 크다
```

**【작업】**

1. `FrozenRoute` 를 `{ method, path, auth }` 로 넓힌다
2. `openApiOf` 가 `x-auth` (와 bearer 인 경우 `x-scope`) 를 뱉게 한다
3. `SURFACE-API.json` 재생성
4. **diff 를 눈으로 리뷰한다** — 아래 다섯이 새로 나타나야 한다

**【테스트】**

```
TC-P1.T9.a  동결 표면이 이전에 없던 다섯을 포함한다
  단언:  SURFACE-API.json 의 paths 에 /healthz · /readyz · /api/v1/session/logout ·
         /api/v1/oidc/authorization-request · /api/v1/oidc/token 이 전부 있다
  검출:  ★ 이 단계 전체의 목적. 하나라도 빠지면 P1.T3~T7 중 하나를 잘못한 것

TC-P1.T9.b  동결은 표에서만 생성된다
  단언:  ROUTES 에서 항목 하나를 빼면 생성물이 달라진다 (기존 drifted 검사 확장)
  검출:  동결이 손으로 편집된 파일이 되는 것

TC-P1.T9.c  bearer 아닌 라우트에는 x-scope 가 없다
  단언:  auth.kind !== 'bearer' 인 항목에 x-scope 키가 없다
  검출:  none/session 에 가짜 스코프가 박혀 계약이 거짓말하는 것
```

**【통과】**

- [ ] TC-P1.T9.a · b · c 초록
- [ ] `SURFACE-API.json` diff 에 **추가만** 있고 기존 항목 변경 없음
- [ ] `SURFACE.txt` 도 함께 갱신됨

---

### ☐ P1.T10 — `ROUTES` 를 도메인별로 가른다

```
선행:      P1.T9
산출:      src/api/routes/*.ts · src/api/server.ts
핀:        none — 순수 이동. ROUTES 의 항목 순서·내용이 불변이고
           TC-P1.T1.c 와 SURFACE-API.json 동결 비교가 판정한다.
```

> P1.T9 까지 해도 `server.ts` 는 **1203 − 136 ≈ 1073 줄로 선 위에 남는다.** `ROUTES` 배열
> 자체가 `:198` 부터 800 줄 가까이 되기 때문이다. P9 의 G1 이 이걸 막는다.

```
src/api/routes/
  changesets.ts     plan · commit · patch · etag
  certificates.ts   cert · acme
  backup.ts         backup · restore
  observability.ts  status · metrics · backends
  session.ts        oidc · logout
  probes.ts         healthz · readyz
src/api/server.ts   조립 + handle() 만
```

**【테스트】**

```
TC-P1.T10.a  분할 전후 ROUTES 가 순서까지 동일하다
  단언:  (method, path, auth) 배열이 순서 포함 deep-equal (스냅샷 대조)
  검출:  이동 중 항목이 빠지거나 순서가 바뀌어 매칭 우선순위가 달라지는 것
```

**【통과】**

- [ ] TC-P1.T10.a 초록
- [ ] `wc -l src/api/server.ts` **< 500**
- [ ] `src/api/routes/*.ts` 각각 **< 400**
- [ ] `git diff SURFACE-API.json` **비어 있음**

---

## 🚪 GATE P1

| # | 검사 | 명령 | 통과 기준 |
|:--|:--|:--|:--|
| G-P1.1 | 손 분기 제거 | `handle()` 내 `url.pathname ===` 개수 | `= 0` |
| G-P1.2 | server.ts 크기 | `wc -l src/api/server.ts` | `< 500` |
| G-P1.3 | 라우트 모듈 크기 | `wc -l src/api/routes/*.ts` | 각 `< 400` |
| G-P1.4 | 표 항목 증가 | `apiRouteTable().length` | 기준선 `+5` |
| G-P1.5 | 동결 포함 | `SURFACE-API.json` 에 oidc/token | 존재 |
| G-P1.6 | auth.ts 무변경 | `git diff <P0>..HEAD -- src/api/auth.ts` | 비어 있음 |
| G-P1.7 | 가드 테스트 | `npx vitest run tests/unit/route-auth-guard.test.ts` | 초록 |
| G-P1.8 | 전체 검증 | `npm run verify` | 종료코드 0 |

```sh
node scripts/gate.mjs P1 --seal
```

**G-P1.6 이 중요하다.** `Scope` 를 건드리는 순간 토큰 모델이 오염된다.

---

# P2 — 검출력 0 으로 측정된 절을 지운다 🔒 (P0 필요)

**브랜치** `refactor/drop-dead-invariants`

### ☐ P2.T1 — 주장을 재측정한다 (삭제 없음)

```
선행:      GATE P0 봉인
산출:      docs/metrics/dead-clause-2026-08-26.md
핀:        불필요 (측정만, src/ 무변경)
```

**【작업】**

대상 여섯을 하나씩 **꺼 보고** 전체 스위트를 돌린다.

| # | 자리 | 코드가 한 주장 |
|:--|:--|:--|
| D1 | `src/dp/agent.ts:917`–`:937` (I6 b) | "검출력은 여전히 0 이다" |
| D2 | `src/dp/agent.ts:1830` | "빼도 600 개가 전부 초록" |
| D3 | `src/dp/agent.ts:948` 주변 (I7 1절) | "지금은 이빨이 없다" |
| D4 | `src/dp/apply.ts:441` | "검출력 0 이고, **도달 가능성은 열려 있다**" |
| D5 | `src/dp/driver.ts` 서술 49곳 | (주석만) |
| D6 | `src/dp/operation.ts` 서술 10곳 | (주석만) |

```sh
npm run verify 2>&1 | tail -30
node scripts/mutate.mjs --file src/dp/agent.ts --limit 120
node scripts/mutate.mjs --file src/dp/apply.ts  --limit 60
```

측정표를 문서로 남긴다 — 나중에 "왜 지웠나" 의 답이 된다.

**【테스트】** 새 TC 없음. 측정이 산출물이다.

**【통과】**

- [ ] `docs/metrics/dead-clause-2026-08-26.md` 에 D1~D6 각각 **꺼 본 결과**가 숫자로 기록
- [ ] 각 항목이 `삭제` / `무대 필요` / `주석이 낡음` 셋 중 하나로 **분류**됨

---

### ☐ P2.T2 — `삭제` 분류를 지운다

```
선행:      P2.T1
핀:        none — 검출력 0 으로 재측정됨(docs/metrics/dead-clause-2026-08-26.md).
           전체 스위트 초록, 생존 뮤턴트 N/M.
되돌리기:  절 하나 = 커밋 하나
```

**【작업】**

1. 절과 **그 절을 감싸던 서술 주석을 함께** 지운다

> ⚠️ **주석만 지우고 코드를 남기지 않는다.** 그러면 왜 죽었는지 아무도 모르는 죽은 코드가
> 되어 상황이 더 나빠진다. 반대도 안 된다.

2. `DESIGN.md` 의 불변식 절에 **한 문장씩** 남긴다

```
I6(b) — 저널 주장을 전제로 삼아 발화하던 절. 28·29·30차를 오간 끝에
        검출력 0 으로 측정돼 뺐다. 실측: <커밋 SHA>.
```

**【테스트】**

```
TC-P2.T2.a  삭제된 절의 근거가 DESIGN.md 에 정확히 한 줄로 있다
  단언:  삭제 절 ID 마다 DESIGN.md 에 매칭 줄이 1 개
  검출:  근거 없는 삭제 — 3년 뒤 "왜 없어졌나" 를 아무도 답 못 하는 것

TC-P2.T2.b  DESIGN.md 가 이 단계로 100 줄 넘게 자라지 않는다
  단언:  git diff --numstat 의 DESIGN.md 추가 줄 ≤ 100
  검출:  ★ 이력을 코드에서 문서로 옮기기만 하는 것 — 같은 병의 장소만 바뀜
```

**【통과】**

- [ ] TC-P2.T2.a · b 초록
- [ ] `npm run verify` 초록
- [ ] 뮤테이션 생존율이 P0 기준선 대비 **악화 없음**

---

### ☐ P2.T3 — `무대 필요` 분류에 무대를 만든다 (D4)

```
선행:      P2.T1
산출:      tests/conformance/apply-unreached-path.test.ts
핀:        ★ 이 새 테스트가 곧 재현물이다 (none 아님)
```

> `apply.ts:441` 은 "검출력 0 이지만 **도달 가능성은 열려 있다**" 고 적혀 있다.
> **지우면 안 된다.** 도달하는 무대를 만들어 검출력을 0 이 아니게 한다.

**【테스트】**

```
TC-P2.T3.a  <그 절이 지키는 상황>에 실제로 도달한다
  단언:  해당 분기가 실행되고 절이 발화한다 (InvariantViolation 또는 정의된 거절)
  검출:  ★ 절이 계속 장식으로 남는 것. 이 테스트가 그 절의 존재 근거가 된다

TC-P2.T3.b  절을 제거하면 TC-P2.T3.a 가 빨개진다
  단언:  뮤테이션으로 확인 — 절 제거 뮤턴트가 죽는다
  검출:  ★ 무대를 만들었다고 적었지만 실은 안 지나가는 것 (이 저장소가 28~30차에 반복한 실수)
```

**【통과】**

- [ ] TC-P2.T3.a 초록, **부모 트리에서 빨강**임을 확인
- [ ] TC-P2.T3.b — 절 제거 뮤턴트가 **죽는다**
- [ ] `apply.ts:441` 의 "검출력 0" 주석이 측정 결과로 **갱신**됨

---

### ☐ P2.T4 — `agent.ts` 밖 서술을 정리한다 (D5·D6)

```
선행:      P2.T2
핀:        none — 주석만 바뀐다. git diff 가 .ts 코드 줄 무변경임을 판정한다.
```

**【작업】**

`driver.ts`(49) · `operation.ts`(10) · 그 외 9 파일(약 40)의 `N차` 서술을 정리한다.

기준 — **지금 코드를 읽는 데 필요한가?**

| 서술 | 처리 |
|:--|:--|
| "왜 이렇게 짰나" | **남긴다.** 자산이다 |
| "N차에 이렇게 했다가 M차에 되돌렸다" | `DESIGN.md` 또는 삭제 |
| "재 보니 아니었다" 류 자기 정정 | 결론만 남기고 과정 삭제 |

**【통과】**

- [ ] `src` 전체 `N차` 카운트 **< 100** (기준선 373)
- [ ] 이 작업의 diff 에 **코드 줄 변경 0** (`git diff -U0` 로 확인)

---

## 🚪 GATE P2

| # | 검사 | 명령 | 통과 기준 |
|:--|:--|:--|:--|
| G-P2.1 | agent.ts 축소 | `wc -l src/dp/agent.ts` | 기준선 대비 `-200` 이상 |
| G-P2.2 | 서술 카운트 | `grep -rE '[0-9]+차' --include='*.ts' src \| wc -l` | `< 100` |
| G-P2.3 | 주석 비율 | agent.ts · apply.ts | 각 `< 40%` |
| G-P2.4 | 무대 확인 | TC-P2.T3.a·b | 초록 |
| G-P2.5 | 뮤테이션 비악화 | 생존율 대 P0 기준선 | `≤ 기준선` |
| G-P2.6 | DESIGN.md 증가 | `git diff --numstat -- DESIGN.md` | `≤ 100` 줄 |
| G-P2.7 | 전체 검증 | `npm run verify` | 종료코드 0 |

```sh
node scripts/gate.mjs P2 --seal
```

**G-P2.5 가 이 단계의 핵심이다.** "죽었다" 는 주장이 맞다면 지워도 생존율이 안 나빠진다.
나빠지면 그 절은 살아 있었던 것이고, **되돌린다.**

---

# P3 — 리소스 서술자 표 🔒 (P0 필요) ★ 본 수술

**브랜치** `refactor/resource-descriptors`

> **절대 규칙 — P3.T1 없이 P3.T2 로 가지 않는다.** 계획 전체에서 가장 중요한 한 걸음이다.

### ☐ P3.T1 — 동치성 오라클

```
선행:      GATE P0 봉인
산출:      tests/store/differential-descriptor.test.ts
핀:        불필요 (tests/ 만)
```

**【작업】**

1. 구 구현을 `readModelLegacy` · `applyOpLegacy` 로 **이름만 바꿔 보존**한다
   (P3.T11 에서 지운다)
2. 아홉 종류 전부를 덮는 PG 픽스처를 만든다
3. 기존 `tests/store/audit-model-roundtrip.test.ts` 가 아홉을 다 도는지 확인, 빠지면 채운다

**【테스트】**

```
TC-P3.T1.a  구·신 readModel 이 같은 Model 을 낸다 — 아홉 종류 전부
  단언:  같은 DB 상태에 대해 deep-equal. 키 순서 무관, 값은 엄격 비교
  검출:  ★ 조용한 데이터 손상. 컬럼 하나가 빠지거나 타입이 바뀌는 것

TC-P3.T1.b  구·신 applyOp 가 같은 DB 상태를 만든다
  단언:  같은 PatchOp 배열을 각각 먹인 뒤 readModelLegacy 결과가 deep-equal
  검출:  ★ 쓰기 경로의 손상. 읽기만 보면 못 잡는다

TC-P3.T1.c  구·신 applyOp 가 같은 입력에 같은 오류를 낸다
  단언:  잘못된 PatchOp 열 종(미지 참조·중복키·문법 위반)에 대해
         StoreError 의 status·code 가 동일
  검출:  ★ 오류 경로만 달라지는 것 — 정상 경로 테스트로는 절대 안 잡힌다

TC-P3.T1.d  roundtrip 이 아홉 종류를 전부 돈다
  단언:  audit-model-roundtrip 이 커버하는 kind 집합 === ResourceKind 전체
  검출:  덮이지 않은 종류를 모른 채 옮기는 것
```

**【통과】**

- [ ] TC-P3.T1.a ~ d 전부 초록 (**구·신이 같은 구현을 가리키는 상태**이므로 자명히 초록)
- [ ] 픽스처가 아홉 종류를 전부 채움 — `kind` 별 행 수 ≥ 2

> 이 시점의 초록은 "테스트가 돈다" 는 확인일 뿐이다. **의미는 P3.T4 부터 생긴다.**

---

### ☐ P3.T2 — 서술자 타입과 표 (아무도 안 쓴다)

```
선행:      P3.T1
산출:      src/store/descriptors.ts · src/model/decode.ts (디코더 노출)
핀:        none — 추가만 한다. 어떤 경로도 이 표를 아직 안 쓰므로 행동이 바뀔 수 없다.
```

**【작업】**

```ts
type ResourceDescriptor<T> = {
  kind: ResourceKind;
  table: string;
  modelField: keyof Model;
  columns: readonly string[];
  rowToDomain: (row: Row) => T;
  domainToParams: (body: T) => unknown[];
  refs: readonly { column: string; table: string }[];
  dependsOn: readonly ResourceKind[];
  decoder: Decoder<T>;
};
```

> ⚠️ `decoder` 가 `src/model/decode.ts`(931줄)를 판다. P3 은 `config-store.ts` 만
> 건드리는 단계가 **아니다.**

**【테스트】**

```
TC-P3.T2.a  서술자 표가 ResourceKind 를 빠짐없이 덮는다
  단언:  Object.keys(DESCRIPTORS).sort() === 모든 ResourceKind .sort()
  검출:  ★ 종류 하나가 빠진 채 드라이버가 조용히 건너뛰는 것.
         P9 의 G2 와 함께 §1 재발을 구조적으로 막는다

TC-P3.T2.b  dependsOn 위상 정렬이 기존 opsOf 순서와 같다
  단언:  topoSort(DESCRIPTORS) === opsOf 가 내던 kind 순서
  검출:  ★ 순서 계약 파괴. 참조되는 쪽이 뒤로 가면 롤백 재적용이
         unknown_reference 로 죽는다 — 원래 모델은 멀쩡한데 되돌리기만 실패한다

TC-P3.T2.c  dependsOn 에 순환이 없다
  단언:  topoSort 가 예외 없이 끝난다
  검출:  순환 참조를 넣어 위상 정렬이 무한 루프/부분 정렬이 되는 것

TC-P3.T2.d  서술자의 columns 가 실제 테이블 컬럼의 부분집합이다
  단언:  SURFACE-DDL.sql 파싱 결과와 대조
  검출:  ★ 오타 컬럼. 런타임까지 안 잡히면 프로덕션에서 터진다
```

**【통과】**

- [ ] TC-P3.T2.a ~ d 전부 초록
- [ ] `config-store.ts` 의 기존 코드 경로 diff **없음** (표만 추가)

---

### ☐ P3.T3 — 갈림길을 놓는다 (`pool` 관통)

```
선행:      P3.T2
핀:        none — 순수 이동. TC-P3.T1.* 차등 테스트가 동치성을 판정한다.
되돌리기:  ★ 이 커밋부터 P3.T11 전까지는 종류 단위 revert 가 가능하다
```

**【작업】**

네 드라이버(`readModel` · `applyOp` · `opsOf` · `shapeCheck`)에
"서술자가 있으면 서술자로, 없으면 기존 코드로" 갈림길을 둔다. `pool` 만 서술자를 탄다.

```ts
// TODO(P3.T11): 아홉이 다 넘어오면 이 갈림길과 legacy 경로를 지운다.
```

> 이 갈림길은 **일시적이고 삭제 예정이다.** 그 사실을 코드가 아니라 이 문서와 P9 의 G2 가
> 안다. 회수하지 않으면 이 계획이 이 저장소의 병을 그대로 재현한 것이다.

**【테스트】**

```
TC-P3.T3.a  pool 은 서술자 경로를, 나머지 여덟은 legacy 경로를 탄다
  단언:  경로 계측(카운터)으로 확인
  검출:  갈림길이 안 걸려 전부 legacy 로 도는 것 — 초록인데 아무것도 안 옮겨진 상태
```

**【통과】**

- [ ] TC-P3.T1.a ~ c **초록** ← 여기서부터 의미가 있다
- [ ] TC-P3.T3.a 초록
- [ ] `npm run test:store` · `npm run test:golden` 초록

---

### ☐ P3.T4 ~ P3.T10 — 나머지 여덟 (커밋 여덟)

```
선행:      P3.T3
핀:        none — 순수 이동. tests/store/differential-descriptor.test.ts 가
           구·신 구현을 같은 입력에 물려 deep-equal 을 판정한다.
되돌리기:  종류 하나 = 커밋 하나
```

**순서 — 어려운 것을 뒤로.**

| 작업 | kind | 비고 |
|:--|:--|:--|
| P3.T4 | `certificate` | |
| P3.T5 | `tlsPolicy` | |
| P3.T6 | `backend` | pool 참조 (`poolRef`) |
| P3.T7 | `sniBinding` | listener·certificate 참조 |
| P3.T8 | `httpRoute` | listener 참조 |
| P3.T9 | `passthroughRoute` | listener·pool 참조 |
| P3.T10a | `listener` | ★ 가장 큼 (`applyOp` 95줄), tls 가 cert·policy 참조 |
| P3.T10b | `engine` | ★ key 가 없는 예외 |

**【테스트】** (각 작업)

```
TC-P3.T<n>.a  <kind> 가 서술자 경로에서 legacy 와 동일한 Model 을 낸다
  단언:  TC-P3.T1.a 를 해당 kind 로 좁혀 실행
  검출:  그 종류의 컬럼 매핑 오류

TC-P3.T<n>.b  <kind> 의 쓰기가 legacy 와 동일한 DB 상태를 만든다
  단언:  TC-P3.T1.b 를 해당 kind 로 좁혀 실행
  검출:  그 종류의 파라미터 순서·타입 오류

TC-P3.T<n>.c  <kind> 의 참조 해석이 legacy 와 같다   ← refs 가 있는 종류만
  단언:  미지 참조에 대해 같은 code(unknown_reference)와 같은 status
  검출:  ★ FK 해석 경로가 서술자로 넘어오며 뭉개지는 것
```

`engine` 전용:

```
TC-P3.T10b.a  engine 은 key 가 'engine' 하나로 고정된다
  단언:  다른 key 로 put 하면 legacy 와 같은 오류
  검출:  key 없는 리소스를 일반 드라이버가 잘못 다루는 것
```

**【통과】** (각 작업)

- [ ] 해당 TC 전부 초록
- [ ] **누적**: 그때까지 넘어온 모든 kind 의 TC 여전히 초록
- [ ] `npm run test:store` · `npm run test:golden` 초록
- [ ] `git diff SURFACE-DDL.sql` **비어 있음**

---

### ☐ P3.T11 — 갈림길과 legacy 를 지운다

```
선행:      P3.T4 ~ P3.T10 전부
핀:        none — 아홉 전부가 서술자 경로를 타는 것을 TC-P3.T3.a 가 판정한 뒤의 정리.
되돌리기:  ★ 이 커밋 이후 revert 비용이 급증한다. 서두르지 않는다
```

**【작업】**

1. 갈림길 · `readModelLegacy` · `applyOpLegacy` · `shapeCheck` 의 kind 표 삭제
2. **`tests/store/differential-descriptor.test.ts` 도 함께 삭제**

> 비교 대상이 사라졌으므로 그 테스트는 이제 자기 자신과 자기 자신을 비교한다.
> 남기면 그것이 **다음 세대의 죽은 코드**다 — P2 에서 지운 것과 똑같은 병이다.
> 대신 `audit-model-roundtrip` 이 회귀를 계속 지킨다.

**【테스트】**

```
TC-P3.T11.a  legacy 심볼이 남아 있지 않다
  단언:  src 에 readModelLegacy / applyOpLegacy / 갈림길 플래그가 0 회
  검출:  ★ 임시 갈림길이 영구가 되는 것 — 이 계획이 스스로에게 건 조건
```

**【통과】**

- [ ] TC-P3.T11.a 초록
- [ ] `differential-descriptor.test.ts` **삭제됨**
- [ ] `npm run verify` 초록

---

### ☐ P3.T12 — `EditKind` 를 없앤다

```
선행:      P3.T11
산출:      src/web/edit.ts
핀:        none — 순수 이동. tests/unit 의 patch 빌더 테스트가 출력 동일성을 판정한다.
```

**【작업】**

1. `EditKind` → `Exclude<ResourceKind, 'engine'>`
2. `putXxxPatch` 아홉 → 서술자 `decoder` 를 타는 **하나**

**【테스트】**

```
TC-P3.T12.a  분류가 하나의 원천에서 온다
  단언:  src 에서 리소스 종류 아홉 리터럴이 나열된 파일이 descriptors.ts 하나뿐
  검출:  ★ §1 재발. 이 단언이 P9 의 G2 가 된다

TC-P3.T12.b  patch 빌더 출력이 종류별로 이전과 동일하다
  단언:  아홉 종류 각각에 대해 이전 putXxxPatch 출력 스냅샷과 deep-equal
  검출:  통합 중 body 모양이 바뀌어 GUI 가 만드는 patch 가 거절되는 것
```

**【통과】**

- [ ] TC-P3.T12.a · b 초록
- [ ] `wc -l src/web/edit.ts` **< 300**

---

## 🚪 GATE P3

| # | 검사 | 명령 | 통과 기준 |
|:--|:--|:--|:--|
| G-P3.1 | config-store 크기 | `wc -l src/store/config-store.ts` | `< 1000` |
| G-P3.2 | edit.ts 크기 | `wc -l src/web/edit.ts` | `< 300` |
| G-P3.3 | 분류 단일 원천 | 종류 리터럴 나열 파일 수 | `= 1` |
| G-P3.4 | 갈림길 회수 | legacy 심볼 grep | `= 0` |
| G-P3.5 | 차등 테스트 회수 | `test ! -f tests/store/differential-descriptor.test.ts` | 없음 |
| G-P3.6 | 스키마 무변경 | `git diff <P0>..HEAD -- SURFACE-DDL.sql` | 비어 있음 |
| G-P3.7 | 표 완전성 | TC-P3.T2.a·b·c·d | 초록 |
| G-P3.8 | 전체 검증 | `npm run verify` | 종료코드 0 |

```sh
node scripts/gate.mjs P3 --seal
```

**G-P3.6 이 안전벨트다.** 스키마를 안 건드리는 리팩터링인데 DDL 이 움직였으면
**어딘가에서 데이터 모양을 바꾼 것**이다. 즉시 멈추고 원인을 찾는다.

---

# P4 — `agent.ts` 분해 🔒 (P2 필요)

**브랜치** `refactor/agent-modules`

> P2 에서 200 줄 이상 빠진 상태에서 시작한다. **죽은 코드를 지고 이사하지 않는다.**

### ☐ P4.T1 — 공개 표면 스냅샷

```
선행:      GATE P2 봉인
산출:      tests/unit/agent-surface.test.ts
핀:        불필요 (tests/ 만)
```

**【테스트】**

```
TC-P4.T1.a  agent 모듈의 export 이름 집합이 고정이다
  단언:  import * as A 의 Object.keys(A).sort() 가 스냅샷과 일치
  검출:  ★ 이동 중 export 가 빠지거나 이름이 바뀌는 것. 순수 이동의 유일한 자동 판정자

TC-P4.T1.b  DpAgent 의 공개 메서드 목록이 고정이다
  단언:  프로토타입 메서드 이름 집합이 스냅샷과 일치
  검출:  분해 중 메서드가 private 로 바뀌거나 사라지는 것
```

**【통과】**

- [ ] TC-P4.T1.a · b 초록 (이동 전이므로 자명히 초록)

---

### ☐ P4.T2 ~ P4.T7 — 모듈을 하나씩 꺼낸다

```
선행:      P4.T1
핀:        none — 순수 이동. import 경로 외 diff 가 대칭이고
           TC-P4.T1.a·b 와 tests/conformance·tests/model 전체가 판정한다.
되돌리기:  모듈 하나 = 커밋 하나
```

| 작업 | 산출 | 내용 |
|:--|:--|:--|
| P4.T2 | `src/dp/agent/types.ts` | 프로토콜 타입 · 에러 클래스 |
| P4.T3 | `src/dp/agent/store.ts` | `DurableStore` · `MemoryStore` |
| P4.T4 | `src/dp/agent/transitions.ts` | 순수 상태기계 헬퍼 |
| P4.T5 | `src/dp/agent/invariants/{index,fencing,monotonic,durability}.ts` | 불변식 |
| P4.T6 | `src/dp/agent/serial.ts` | ★ CAS 낙관적 동시성 래퍼 |
| P4.T7 | `src/dp/agent/agent.ts` | `DpAgent` — 평면 상태기계만 |

> ★ **P4.T6 이 이 단계의 핵심이다.** `serial()` 은 이 파일에서 가장 잘 만들어진 부분이다 —
> 재읽기 + CAS 재시도 + prune + 불변식 검사를 한 통로로 모은 설계가 정확하다.
> **이 단계의 목표 절반은 그것을 훼손하지 않는 것이다.**

**P4.T7 추가 작업**: 읽기 전용 투영 15 개쯤을 `AgentStateView` 로 묶어 클래스 표면을 좁힌다.

**【철칙】 한 줄도 고치지 않는다.**
발견한 개선점은 **적어 두고 다음 사이클로 넘긴다.**

**【테스트】**

```
TC-P4.T5.a  불변식 디스패처가 분해 전과 같은 절 집합을 돈다
  단언:  발화 가능한 InvariantViolation 메시지 집합이 스냅샷과 일치
  검출:  ★ 분해 중 절 하나가 디스패처에 등록 안 돼 조용히 사라지는 것

TC-P4.T6.a  serial 의 CAS 재시도 횟수와 종료 조건이 불변이다
  단언:  StoreConflict 를 N 번 던지는 가짜 store 로 재시도 횟수·최종 결과 확인
  검출:  ★ 이동 중 재시도 상한이나 예외 전파가 바뀌는 것
```

**【통과】** (각 작업)

- [ ] TC-P4.T1.a · b 초록
- [ ] `git diff --numstat` 의 추가/삭제가 **대칭** (import 줄 차이 ±10 이내)
- [ ] `npm run test:conformance` · `npm run test:model` 초록

---

## 🚪 GATE P4

| # | 검사 | 명령 | 통과 기준 |
|:--|:--|:--|:--|
| G-P4.1 | 파일 크기 | `wc -l src/dp/agent/*.ts src/dp/agent/invariants/*.ts` | 각 `< 600` |
| G-P4.2 | 표면 불변 | TC-P4.T1.a·b | 초록 |
| G-P4.3 | 불변식 집합 불변 | TC-P4.T5.a | 초록 |
| G-P4.4 | serial 불변 | TC-P4.T6.a | 초록 |
| G-P4.5 | 뮤테이션 동일 | 생존율 대 GATE P2 시점 | **동일** |
| G-P4.6 | 전체 검증 | `npm run verify` | 종료코드 0 |

```sh
node scripts/gate.mjs P4 --seal
```

**G-P4.5 는 "동일" 이지 "비악화" 가 아니다.** 순수 이동이므로 뮤테이션 결과가 바뀌면
**뭔가를 고친 것**이다. 찾아서 되돌린다.

---

# P5 — `ControlPlane` 분해 🔒 (P0 필요)

**브랜치** `refactor/control-plane-modules`

### ☐ P5.T1 — 공개 표면 스냅샷

```
선행:      GATE P0 봉인
산출:      tests/unit/control-plane-surface.test.ts
핀:        불필요
```

**【테스트】**

```
TC-P5.T1.a  ControlPlane 의 공개 메서드 목록이 고정이다
  단언:  프로토타입 공개 메서드 이름 집합(25개)이 스냅샷과 일치
  검출:  ★ 분해 중 메서드 유실. 이 클래스는 API 서버가 직접 판다
```

**【통과】** TC-P5.T1.a 초록, 스냅샷 항목 수 = 현재 공개 메서드 수

---

### ☐ P5.T2 ~ P5.T5 — 책임별로 꺼낸다 (순수 이동)

```
핀:        none — 순수 이동. TC-P5.T1.a 와 tests/store·tests/e2e 가 판정한다.
```

| 작업 | 산출 | 메서드 |
|:--|:--|:--|
| P5.T2 | `src/control/observability.ts` | `gauges` `membershipSlotKeys` `certificateExpiry` `backendStatus` `readiness` |
| P5.T3 | `src/control/operations.ts` | `operation` `findOperation` `status` `cancel` `recordPhase` |
| P5.T4 | `src/control/resources.ts` | `reclaimSlots` `certificateFiles` `restageMembership` `projectHealth` |
| P5.T5 | `src/control/apply-orchestrator.ts` | `apply` `applyMembershipOnly` `claim` `sweep` `recover` |

**【테스트】**

```
TC-P5.T2.a  readiness 는 원격 드라이버에서 engine 키를 싣지 않는다
  단언:  원격 드라이버 → {ok, dataplane} 만. 로컬 → engine 포함
  검출:  ★ 「못 물었다」와 「죽었다」를 접는 것. 이 창구의 존재 이유가 사라진다

TC-P5.T3.a  cancel 은 종단 상태의 오퍼레이션을 다시 취소하지 않는다
  단언:  이미 종단인 id 에 대해 정의된 거절
  검출:  이동 중 상태 검사가 빠지는 것
```

**【통과】** (각 작업)

- [ ] TC-P5.T1.a 초록
- [ ] `git diff --numstat` 대칭
- [ ] `npm run test:store` · `npm run test:e2e` 초록

---

### ☐ P5.T6 — `apply()` 214줄을 단계 함수로 가른다

```
선행:      P5.T5
핀:        ★ 실제 재현물 필수 — 단계 경계가 바뀌므로 행동이 바뀔 수 있다
되돌리기:  ★ 단독 커밋. P5 에서 유일하게 순수 이동이 아니다
```

> **P4/P5 의 "한 줄도 고치지 않는다" 철칙에 대한 유일한 예외다.**
> 그러므로 이동 커밋들과 **반드시 분리한다.**

**【작업】**

`apply()` 를 단계별 순수 함수로 가른다. 각 함수 **80 줄 이하**.
단계 경계는 기존 코드의 실제 순서를 따르고 **재배치하지 않는다.**

**【테스트】**

```
TC-P5.T6.a  apply 의 단계 순서가 분해 전과 같다
  단언:  각 단계에 계측을 걸어 호출 순서 배열이 스냅샷과 일치
  검출:  ★ 분해하며 단계를 재배치하는 것. 이 순서는 계약이다

TC-P5.T6.b  중간 단계 실패 시 남는 상태가 분해 전과 같다
  단언:  각 단계에서 인위 실패를 주입하고 결과 DB·저널 상태를 분해 전과 비교
  검출:  ★ 부분 적용 경계 변화. 정상 경로 테스트로는 절대 안 잡힌다

TC-P5.T6.c  apply 는 exclusiveApply 큐 밖에서 실행되지 않는다
  단언:  동시 호출 둘이 직렬화된다
  검출:  ★ 분해하며 큐 밖으로 새는 것 — HUP 이 두 번 나가는 6차 반례의 재발
```

**【통과】**

- [ ] TC-P5.T6.a · b · c 초록, **부모 트리에서 빨강** 확인
- [ ] `apply()` 를 대체한 어느 함수도 **80 줄 이하**
- [ ] `npm run test:e2e` 초록

---

## 🚪 GATE P5

| # | 검사 | 명령 | 통과 기준 |
|:--|:--|:--|:--|
| G-P5.1 | 파일 크기 | `wc -l src/control/*.ts` | 각 `< 600` |
| G-P5.2 | 함수 크기 | apply 계열 최대 함수 줄 수 | `≤ 80` |
| G-P5.3 | 표면 불변 | TC-P5.T1.a | 초록 |
| G-P5.4 | 단계 순서 | TC-P5.T6.a | 초록 |
| G-P5.5 | 부분 적용 경계 | TC-P5.T6.b | 초록 |
| G-P5.6 | 직렬화 유지 | TC-P5.T6.c | 초록 |
| G-P5.7 | 전체 검증 | `npm run verify` | 종료코드 0 |

```sh
node scripts/gate.mjs P5 --seal
```

---

# P6 — `install.sh` 계열 분기 통합 🔒 (P0 필요)

**브랜치** `refactor/install-family-once`

### ☐ P6.T1 — 계열 값을 한 자리에서 푼다

```
선행:      GATE P0 봉인
핀:        불필요 (deploy/ 는 src/ 가 아니다). 커밋 메시지에 5종 결과를 적는다
```

**【작업】**

`:296` 의 `case` **직후에** 전부 변수로 푼다.

```sh
PKG_INSTALL=   USERADD=       PG_DATA_DIR=
PG_SOCKET_DIR= INIT_SYSTEM=   SVC_WRITE_FN=
```

그 뒤 `:345` · `:514` · `:546` · `:725` 및 기동 경로의 재분기 제거.
`install_packages_deb/_el/_amzn/_apk` 함수 계열은 **남긴다** — 정당한 관용구다.

**【테스트】**

```
TC-P6.T1.a  계열을 보는 자리가 정확히 하나다
  단언:  install.sh 에서 OS_ID/FAMILY 를 분기 조건으로 쓰는 case/if 가 1 개
  검출:  ★ §4 재발. 이 단언이 P9 의 G1 보조 검사가 된다

TC-P6.T1.b  다섯 배포판에서 설치가 끝까지 간다
  단언:  tests/install/run.sh 가 5 종 전부 초록
  검출:  ★ 변수화 중 특정 배포판 경로만 깨지는 것. 단위 테스트로 대체 불가

TC-P6.T1.c  풀린 변수 여섯이 배포판마다 전부 비지 않는다
  단언:  case 직후 여섯 변수가 모두 non-empty (set -u 로 조기 실패)
  검출:  새 배포판을 넣을 때 변수 하나를 빠뜨리고 런타임까지 가는 것
```

**【통과】**

- [ ] TC-P6.T1.a · b · c 초록
- [ ] `npm run test:install` — **5 종 전부 초록**

> **단위 테스트로 대체 불가.** 다섯 전부 초록이 아니면 이 단계는 끝난 게 아니다.

---

## 🚪 GATE P6

| # | 검사 | 명령 | 통과 기준 |
|:--|:--|:--|:--|
| G-P6.1 | 파일 크기 | `wc -l deploy/install.sh` | `< 1000` |
| G-P6.2 | 계열 분기 | TC-P6.T1.a | `= 1` |
| G-P6.3 | 실물 설치 | `npm run test:install` | 5 종 전부 초록 |
| G-P6.4 | 문법 | `bash -n deploy/install.sh` · `shellcheck` | 경고 0 |

```sh
node scripts/gate.mjs P6 --seal
```

---

# P7 — 렌더러 분할 🔒 (선택)

**브랜치** `refactor/render-split`

> `src/conf/render.ts` 1640 줄은 **감사가 면제한 유일한 파일**이다. 중복이 아니라 그냥
> 크다. **하지 않기로 결정해도 된다.**

### ☐ P7.T0 — 할지 말지 결정한다 (문서 작업)

**하지 않기로 하면** `docs/size-waivers.txt` 에 사유와 함께 적고 **P7 을 봉인 처리한다.**

```
src/conf/render.ts — 균질한 순수 함수 35개의 렌더러. 중복 아님. 2026-08-26 판정.
```

`gate.mjs P7 --seal --waived` 로 면제 봉인. **사유 없는 면제는 거부된다.**

### ☐ P7.T1 — (하기로 한 경우) 분할

```
src/conf/render/  upstream.ts  http.ts  stream.ts  tls.ts  index.ts
핀:  none — 순수 이동. tests/golden 14 종이 nginx conf 실물 출력을 고정한다.
```

**【테스트】**

```
TC-P7.T1.a  분할 전후 렌더 출력이 바이트 단위로 같다
  단언:  골든 14 종 전부 무변경
  검출:  ★ 이동 중 노드 순서나 공백이 바뀌는 것. nginx conf 는 순서가 의미다
```

**【통과】** 골든 14 종 초록, 각 모듈 < 600 줄

---

## 🚪 GATE P7

| # | 검사 | 통과 기준 |
|:--|:--|:--|
| G-P7.1 | 결정이 기록됨 | 분할했거나, `size-waivers.txt` 에 사유 있음 |
| G-P7.2 | 골든 무변경 | 14 종 초록 |

---

# P8 — 1000줄 초과 테스트 분할 🔒 (P0 필요)

**브랜치** `test/split-oversized`

> **이 단계가 없으면 P9 의 G1 이 자기 계획으로 즉시 빨개진다.**

### ☐ P8.T1 — 테스트 이름 대장을 뜬다

```
산출:  docs/metrics/test-inventory-before.json
핀:    불필요
```

```sh
npx vitest run --reporter=json > docs/metrics/test-inventory-before.json
```

**【통과】** 전체 테스트 이름·개수가 기록됨

---

### ☐ P8.T2 ~ P8.T4 — 셋을 분할한다

```
핀:  불필요 (tests/ 만)
```

| 작업 | 파일 | 분할 |
|:--|:--|:--|
| P8.T2 | `tests/conformance/review17-deadlock.test.ts` 1677 | 시나리오 군별 3 파일 |
| P8.T3 | `tests/model/two-leaders.test.ts` 1332 | 리더 교체 / 펜싱 / 승계 |
| P8.T4 | `tests/engine/engine_facts.sh` 1024 | 사실 묶음별, `run.sh` 가 조립 |

**【테스트】**

```
TC-P8.T2.a  분할 전후 테스트 이름 집합이 완전히 동일하다
  단언:  vitest --reporter=json 의 (describe > it) 전체 경로 집합이
         test-inventory-before.json 과 정확히 일치
  검출:  ★ 분할 중 테스트가 사라지거나 describe 중첩이 바뀌는 것.
         커버리지가 조용히 줄어드는 유일한 자동 판정자

TC-P8.T4.a  engine_facts 분할 후 사실 개수가 같다
  단언:  run.sh 가 보고하는 사실 총계가 분할 전과 같다
  검출:  셸 분할에서 파일 하나가 run.sh 에 안 엮이는 것
```

**【통과】** (각 작업)

- [ ] TC-P8.T2.a 초록 — **이름 집합 완전 일치**
- [ ] 분할된 각 파일 **< 1200 줄**

---

## 🚪 GATE P8

| # | 검사 | 통과 기준 |
|:--|:--|:--|
| G-P8.1 | 테스트 파일 크기 | `tests/**` 각 `< 1200` |
| G-P8.2 | 이름 집합 동일 | TC-P8.T2.a 초록 |
| G-P8.3 | 엔진 사실 총계 | TC-P8.T4.a 초록 |
| G-P8.4 | 전체 검증 | `npm run verify` 종료코드 0 |

```sh
node scripts/gate.mjs P8 --seal
```

---

# P9 — 구조 게이트 🔒 (P1~P8 전부 필요)

**브랜치** `ci/structural-guards`

> **P9 를 안 하면 3년 뒤 같은 감사를 다시 받는다.** P1~P8 은 증상 치료다.
> 원인("아무것도 제거되지 않는다")은 게이트로만 고쳐진다.
>
> 이 저장소는 이미 이걸 안다 — `scripts/pinned.mjs` 첫 주석:
> *"규칙이 산문이라서 안 지켜진다. 그래서 게이트로 옮긴다."*

### ☐ P9.T1 — G1 파일 크기 게이트

| 대상 | 상한 |
|:--|--:|
| `src/**` | 1000 |
| `deploy/**.sh` `scripts/**.sh` | 1000 |
| `tests/**` | 1200 |
| `gui/src/**` | 800 |

면제는 `docs/size-waivers.txt` — **파일명 + 사유 한 줄**. 사유 없으면 거부.

**【테스트】**

```
TC-P9.T1.a  G1 은 위반을 잡는다 (음성 대조)
  단언:  1001 줄 임시 파일을 src/ 에 두면 게이트가 실패한다
  검출:  ★ 검출력 0 인 게이트

TC-P9.T1.b  사유 없는 면제는 거부된다
  단언:  size-waivers.txt 에 파일명만 적으면 게이트가 실패한다
  검출:  면제 목록이 사유 없는 도피처가 되는 것

TC-P9.T1.c  면제 목록이 3 개를 넘으면 실패한다
  단언:  4 번째 항목에 게이트 실패
  검출:  ★ 면제로 게이트를 무력화하는 것
```

---

### ☐ P9.T2 — G2 분류 전개 게이트

`ResourceKind` 아홉 리터럴이 `src/store/descriptors.ts` **밖에서** 나열되면 실패.

```
TC-P9.T2.a  G2 는 위반을 잡는다
  단언:  다른 파일에 아홉 리터럴 나열을 넣으면 실패
  검출:  ★ §1 재발이 게이트를 그냥 통과하는 것
```

---

### ☐ P9.T3 — G3 라우트 표 게이트

`handle()` 본문에 `url.pathname ===` 리터럴 비교가 있으면 실패.

```
TC-P9.T3.a  G3 는 위반을 잡는다
  단언:  handle() 에 경로 비교 하나를 넣으면 실패
  검출:  ★ §2 재발

TC-P9.T3.b  GUI 폴백은 오탐이 아니다
  단언:  현재 코드에서 게이트가 초록
  검출:  게이트가 항상 빨개서 무시되기 시작하는 것
```

---

### ☐ P9.T4 — G4 주석 밀도 **경고** (실패 아님)

주석 비율 45% 초과 파일을 `verify` 요약에 띄운다. **막지 않는다.**

> 이 저장소의 주석은 대체로 자산이다. 막으면 좋은 주석까지 죽는다.
> **재는 것만으로 충분하다.**

```
TC-P9.T4.a  G4 는 경고만 하고 종료코드를 바꾸지 않는다
  단언:  45% 초과 파일이 있어도 verify 종료코드 0
  검출:  경고가 조용히 차단으로 승격되는 것
```

---

### ☐ P9.T5 — G5 규약을 `CLAUDE.md` 에 적는다

> 검출력 0 으로 측정된 절은 주석을 붙이는 것이 아니라 **지운다.**
> 근거는 `DESIGN.md` 한 문장과 커밋 SHA 로 남긴다.

---

### ☐ P9.T6 — CI 에 건다

`.github/workflows/verify.yml` 에 G1~G4 를 넣는다.
`gate.mjs --assert-order` 도 함께 — 단계 봉인 없이 그 단계 코드가 들어오면 CI 실패.

**【통과】** CI 한 바퀴 초록, 인위 위반 PR 에서 빨강 확인

---

## 🚪 GATE P9 — 최종

| # | 검사 | 통과 기준 |
|:--|:--|:--|
| G-P9.1 | G1~G3 이빨 | TC-P9.T1.a·b·c, T2.a, T3.a·b 전부 초록 |
| G-P9.2 | G4 무해 | TC-P9.T4.a 초록 |
| G-P9.3 | 면제 3 개 이하 | `wc -l docs/size-waivers.txt` ≤ 3, 각 사유 있음 |
| G-P9.4 | CI 초록 | `verify.yml` 한 바퀴 |
| G-P9.5 | 최종 델타 | `metrics --diff` 결과가 목표표를 만족 |
| G-P9.6 | 순 삭제 | `git diff --shortstat <P0>..HEAD` 삭제 − 추가 ≥ 3000 |

```sh
node scripts/gate.mjs P9 --seal
```

**G-P9.6 이 이 계획 전체의 판정이다.**
나머지가 다 초록이어도 이게 빨갛면 **복잡도를 옮기기만 한 것**이다.

---

## 최종 목표표 (G-P9.5)

| 지표 | 기준선 | 목표 |
|:--|--:|--:|
| 1000줄 초과 소스 | 5 | 0 (면제 최대 1) |
| 1000줄 초과 테스트/스크립트 | 4 | 0 |
| `src/dp/agent.ts` 계열 최대 | 2485 | < 600 |
| `src/store/config-store.ts` | 1943 | < 1000 |
| `src/control/plane.ts` 계열 최대 | 1041 | < 600 |
| `src/api/server.ts` | 1203 | < 500 |
| `src/web/edit.ts` | 987 | < 300 |
| `deploy/install.sh` | 1051 | < 1000 |
| 분류 전개 자리 | 5 | 1 |
| 동결 밖 API 엔드포인트 | 5 | 0 |
| `src` 내 `N차` 서술 | 373 | < 100 |
| **순 삭제 줄 수** | — | **≥ 3,000** |

---

## 부록 — 막혔을 때

| 상황 | 조치 |
|:--|:--|
| 게이트가 빨간데 원인을 모르겠다 | `gate.mjs <P> --explain` 이 실패 검사의 측정값과 상한을 뱉는다 |
| 봉인했는데 다음 단계에서 회귀 발견 | 앞 단계를 revert → R2 가 봉인을 자동 무효화 → 다시 연다 |
| `Pinned-by` 를 뭘로 달지 모르겠다 | 행동이 바뀌면 재현물, 안 바뀌면 `none — <판정자>`. 판정자를 못 적으면 그 커밋은 순수 이동이 아니다 |
| P3 중간에서 멈춰야 한다 | 갈림길이 살아 있으면 안전하다. **P3.T11 전이면 그대로 두고 나가도 된다** |
| 일정이 부족하다 | `P0 + P1 + P9` 만 해도 실제 구멍(OIDC 동결 밖)이 닫힌다. 단 G1 상한을 그 시점 실측에 맞춰 조정하고 사유를 적는다 |

# 구조 개선 계획 — 2026-08-26

`d4121e4...HEAD` (500 커밋 · 511 파일 · +108,353 / −347) 에 대한 thermo-nuclear 코드 품질
감사의 후속이다. 감사가 찾은 것을 **이 저장소의 게이트가 허용하는 순서**로 배치한다.
심각도 순이 아니라 **의존과 게이트 비용 순**이다.

---

## 0. 전제

### 0.1 이 계획의 성공 조건은 "줄어드는 것"이다

감사의 진단은 실력 부족이 아니었다. **아무것도 제거되지 않는다** 였다 — 500 커밋에 삭제
347 줄. 감사 회차마다 절이 하나씩 붙고, 나중 회차가 그 절이 죽었다고 증명하면 절을
지우는 대신 **죽었다는 주석을 하나 더 붙였다.** 리소스 종류가 늘 때마다 표에 행 하나가
아니라 스위치 다섯에 갈래 하나씩이 붙었다.

그래서 각 단계의 종료 판정에 **삭제 줄 수**를 넣는다. "나아졌다" 는 판정이 아니다.

목표: **순 −3,000 줄.** 나머지 지표는 전부 이것의 부산물이다.

### 0.2 이미 있는 안전망 — 이 계획을 가능하게 하는 것

| 자산 | 규모 | 이 계획에서의 역할 |
|:--|:--|:--|
| 테스트 | 211 파일 / 40,057 줄 | 행동 보존의 1차 증거 |
| `tests/store/audit-model-roundtrip.test.ts` | — | P3 의 동치성 오라클 씨앗 |
| `tests/golden/` 14 종 (nginx conf 실물) | — | 렌더 출력 회귀 감지 |
| `tests/install/run.sh` (배포판 5 종 컨테이너) | — | P7 의 유일한 판정자 |
| `npm run mutate` (`scripts/mutate.mjs`) | 규칙 생성식 | P2 에서 "죽었다"를 **증명**하는 도구 |
| `SURFACE-API.json` / `SURFACE-DDL.sql` 동결 | — | P1 · P3 의 변경을 리뷰 가능한 diff 로 만듦 |
| `scripts/verify.sh` (+`--quick`) | 도커 게이트 분리 | 단계별 검증 명령 |

이 정도가 없었으면 P3 은 제안하지 않았다. 있으니까 한다.

### 0.3 ⚠️ 재현물 게이트 — 이 계획의 가장 큰 제약

`scripts/pinned.mjs` 와 `scripts/git-hooks/commit-msg` 가 **`src/` 를 바꾸는 모든 커밋**에
재현물 표식을 요구한다.

```
Pinned-by: tests/conformance/foo.test.ts -t "이름"
Pinned-by: none — <왜 없어도 되는지>
```

표식이 `none` 이 아니면 게이트가 **그 테스트를 부모 트리에 대고 돌려 빨간지 확인한다.**
초록이면 막힌다. 맨 `none` 도 막힌다 — `none — <근거>` 형식이어야 한다
(`^none\s+[—-]\s+\S`).

**이것이 리팩터링 계획에 뜻하는 바:**

순수 리팩터링 커밋은 정의상 행동을 안 바꾸므로 **빨개질 테스트가 없다.** 따라서 대부분의
커밋이 `none` 을 쓰게 된다. 그런데 `none` 을 남발하면 게이트가 뜻을 잃는다. 이 계획은
커밋을 두 종류로 명확히 가른다:

| 종류 | 표식 | 예 |
|:--|:--|:--|
| **행동을 바꾸는 커밋** | 실제 재현물 필수 | P1-3 (라우트를 표로 옮김 — 스코프 판정이 바뀔 수 있다) |
| **순수 이동/삭제 커밋** | `none — 순수 이동. 동치성은 <X> 가 판정` | P4 전부, P3-D 각 종류 |

**규칙:** `none` 을 쓸 때는 근거 자리에 **무엇이 동치성을 판정하는지**를 반드시 적는다.
"리팩터링이라서" 는 근거가 아니다. "`tests/store/differential-descriptor.test.ts` 가
구·신 구현을 같은 입력에 물려 deep-equal 을 본다" 가 근거다.

각 단계의 **핀 전략** 칸이 이것을 지정한다.

### 0.4 작업 규약

`CLAUDE.md` 에 따라 각 단계 = 워크트리 하나 = 브랜치 하나 = **push 까지**.
커밋만 쌓고 push 를 미루면 그 단계는 아직 메인에 반영되지 않은 것이다.

```sh
python3 scripts/claude-hooks/enter-worktree.py <이름>
# 새 워크트리에서 먼저: .claude/worktree-bootstrap.md
#   · e2e 를 돌 거면 rm -f node_modules && npm ci  (심링크는 컨테이너에서 끊긴다)
# 작업 · 커밋
git fetch origin && git rebase origin/main && git push origin HEAD:<branch>
```

### 0.5 기준선 (2026-08-26 실측)

```
1000줄 초과 코드 파일        9
  2485  src/dp/agent.ts
  1943  src/store/config-store.ts
  1677  tests/conformance/review17-deadlock.test.ts
  1640  src/conf/render.ts
  1332  tests/model/two-leaders.test.ts
  1203  src/api/server.ts
  1051  deploy/install.sh
  1041  src/control/plane.ts
  1024  tests/engine/engine_facts.sh

src 내 `N차` 서술 주석         373  (agent.ts 201 · apply.ts 73 · driver.ts 49 · 그 외 50)
리소스 분류 전개 자리            5
동결(SURFACE-API.json) 밖 엔드포인트  5
주석 비율 50% 파일               2  (agent.ts · apply.ts)
```

---

## 1. 단계 지도

```
P0 기준선
 │
 ├─ 레인 A ─ P1 라우트 표 (§2)          ─┐
 │                                       │
 ├─ 레인 B ─ P2 죽은 절 삭제 (§3a) ─ P4 agent.ts 분해 (§3b)
 │                                       │
 ├─ 레인 C ─ P3 서술자 표 (§1) ★         ├─→ P9 게이트
 │                                       │
 ├─ 레인 D ─ P5 ControlPlane 분해       ─┤
 │                                       │
 ├─ 레인 E ─ P6 install.sh (§4)         ─┤
 │                                       │
 └─ 레인 F ─ P8 테스트 파일 분할        ─┘

                P7 렌더러 분할 (선택 · 언제든)
```

**병렬 가능성.** A·B·C·D·E·F 는 파일이 겹치지 않아 동시 진행이 가능하다. 단
**P2 → P4 는 같은 파일(`agent.ts`)이라 직렬이다.**

실무 권고: 워크트리를 **동시에 셋 이상 열지 않는다.** P3 이 `config-store.ts` 를 크게
흔들므로, P3 이 도는 동안은 레인 하나만 더 연다. rebase 충돌 비용이 병렬 이득을 넘는다.

**P9 는 앞의 전부에 의존한다.** 예외 없다 — P9 를 안 하면 3년 뒤 같은 감사를 다시 받는다.

---

## P0 — 기준선을 못 박는다

**브랜치** `chore/baseline-metrics` · **크기** 작음 · **위험** 없음 · **의존** 없음

리팩터링 전에 "무엇이 나아졌는가" 를 나중에 말로 때우지 않으려면 지금 재야 한다.
이 저장소는 이미 감사 보고서를 남기는 습관이 있다(`docs/audit-*.md`). 그 습관에
**숫자**를 붙이는 것이 이 계획 전체의 회계 장부가 된다.

### 할 일

1. `scripts/metrics.mjs` — 다음을 JSON 으로 뱉는다.
   - 파일별 총줄 / 코드줄 / 주석줄, 1000줄 초과 목록
   - `src` 내 `N차` 서술 주석 개수
   - `ResourceKind` 리터럴이 나열된 파일 목록 (분류 전개 자리)
   - `apiRouteTable()` 항목 수 대 `handle()` 내 경로 리터럴 수
2. 결과를 `docs/metrics/baseline-2026-08-26.json` 에 커밋한다.
   **`.omc/` 가 아니다** — 그건 무시되는 운영 산출물이고, 이건 계획의 증거다.
3. 전체 검증 초록 확인 + 소요 시간 기록.

```sh
npm run verify 2>&1 | tee docs/metrics/verify-baseline.log
node scripts/metrics.mjs > docs/metrics/baseline-2026-08-26.json
```

### 핀 전략

`src/` 를 안 건드린다 → 표식 불필요. `scripts/` 와 `docs/` 만 바뀐다.

### 종료 판정

- `docs/metrics/baseline-2026-08-26.json` 커밋됨
- `npm run verify` 초록, 소요 시간 기록됨
- push 완료

### 롤백

해당 없음. 추가만 한다.

---

## P1 — API 라우트 표로 되돌린다 (§2)

**브랜치** `refactor/route-table-auth` · **크기** 중간 · **위험** 중간(인증 경로) ·
**의존** P0

### 문제

`src/api/server.ts:161` 에 제대로 된 `route()` 헬퍼가 있고 `ROUTES` 는 `scope` 로 인가를
모는 진짜 디스패치 표다. 그런데 `:942` 의 `handle()` 이 **표를 보기도 전에 여섯을 손으로
분기한다.**

```
:957   GET  /healthz
:972   GET  /readyz
:979   POST /api/v1/session/logout
:990   GET  /api/v1/oidc/authorization-request
:1015  POST /api/v1/oidc/token
:1077  GET  <GUI 정적, /api/ 아닌 모든 경로>
```

여섯 다 같은 이유로 거기 있다 — `Scope` 모델에 "인증 없음" 도 "Bearer 아닌 세션 인증" 도
말할 방법이 없다. **모델에 빠진 경우 하나가 디스패처 앞머리의 `if` 여섯이 됐다.**

이건 미관 문제가 아니다. `apiRouteTable()`(`:176`)은 "OpenAPI 동결이 이 표를 본다" 고
적혀 있고 `tests/unit/v10-open.test.ts:123` 이 거기서 `SURFACE-API.json` 을 생성해
동결한다. 실측:

```
oidc / session-logout / healthz / readyz  →  SURFACE-API.json 0 건, SURFACE.txt 0 건
```

**OIDC 토큰 교환 — 이 애플리케이션에서 보안상 가장 민감한 표면이 구조상 동결 계약 밖에
있다.** 동결이 표를 읽는데 엔드포인트가 표에 없기 때문이다. 이 라우트들에 대해 동결
테스트는 **빨개질 수 없다.**

### 정정 — `Scope` 를 넓히면 안 된다

초안에서 "`Scope` 에 `'public'`·`'session'` 을 넣자" 고 했는데 틀렸다. 확인해 보니
`Scope` 는 라우트 속성이 아니라 **토큰 권한**이다:

```
src/api/auth.ts:23   export type Scope = 'read' | 'write' | 'apply' | 'admin'
src/api/auth.ts:25   ALL_SCOPES
src/api/auth.ts:40   scopesOfRole(role)
src/api/auth.ts:342  can(p, scope)
```

여기에 `'public'` 을 넣으면 "public 스코프를 가진 토큰" 이라는 없는 개념이 생기고,
`scopesOfRole` 과 토큰 스펙 검증(`:89`–`:100`)까지 오염된다.
**올바른 모양은 `Route` 에 별도의 판별 유니온이다.**

### 커밋 단위

**P1-1 · 가드 테스트를 먼저 넣는다** — 이 단계의 진짜 산출물

`ROUTES` 전체를 훑어 인증 없는 라우트가 **정확히 셋**(healthz · readyz · logout)임을
단언하는 테스트. 최악의 사고는 `{ kind: 'none' }` 이 실수로 기존 라우트에 붙는 것이고,
이 테스트만이 그것을 잡는다.

> 핀: 이 커밋은 `tests/` 만 바꾼다 → 표식 불필요.

**P1-2 · 모델을 넓힌다 (순수 리네임)**

```ts
type RouteAuth =
  | { kind: 'none' }                    // /healthz · /readyz · logout
  | { kind: 'bearer'; scope: Scope }    // 기존 전부
  | { kind: 'session' };                // OIDC 로그인 왕복
```

`route()` 헬퍼를 맞추고 기존 호출부를 `{ kind: 'bearer', scope }` 로 기계 변환한다.
**행동이 안 바뀐다.**

> 핀: `none — 순수 리네임. 기존 라우트의 method·path·scope 가 한 글자도 안 바뀌고,
> tests/unit/v10-open.test.ts 의 동결 비교가 무변경을 판정한다.`

**P1-3 ~ P1-7 · 다섯을 하나씩 표로 옮긴다** (커밋 다섯)

`/healthz` → `/readyz` → `session/logout` → `oidc/authorization-request` → `oidc/token`

GUI 정적 폴백은 **옮기지 않는다.** 그건 라우트가 아니라 표가 미스한 뒤의 폴백이다.
표 우회가 아니라 표의 기본값 — 구분해서 코드에 적는다.

> 핀: 이 다섯은 **행동을 바꿀 수 있다**(인가 판정 경로가 달라진다). 각 커밋마다 해당
> 엔드포인트의 인증 동작을 고정하는 재현물을 쓰고, 부모 트리에서 빨간지 확인한다.

**P1-8 · `handle()` 을 접는다**

남는 모양:

```
URL 파싱 → 라우트 매치 → auth 판정(none|bearer|session) → 핸들러 → 에러 매핑
```

**P1-9 · 동결을 갱신한다**

`FrozenRoute`(`src/api/freeze.ts:10`)와 `openApiOf`(`:12`)가 `x-scope` 만 뱉으므로
`auth.kind` 를 표현하게 넓히고 `SURFACE-API.json` 을 재생성한다.

**이 diff 를 반드시 눈으로 리뷰한다.** OIDC 둘 · 프로브 둘 · logout 이 새로 나타나야
한다. 안 나타나면 P1-3~7 을 잘못한 것이다.

**P1-10 · `ROUTES` 를 도메인별로 가른다** ← 초안에 없던 것

P1-9 까지 해도 `server.ts` 는 1203 − 136 ≈ **1073 줄로 여전히 선 위다.** `ROUTES` 배열
자체가 `:198` 부터 800 줄 가까이 되기 때문이다. P9 의 게이트가 이걸 막는다.

```
src/api/routes/
  changesets.ts   plan · commit · patch · etag
  certificates.ts cert · acme
  backup.ts       backup · restore
  observability.ts status · metrics · backends
  session.ts      oidc · logout
  probes.ts       healthz · readyz
src/api/server.ts   조립 + handle() 만
```

> 핀: `none — 순수 이동. ROUTES 의 항목 순서·내용이 불변이고
> tests/unit/v10-open.test.ts 의 SURFACE-API.json 동결 비교가 그것을 판정한다.`

### 검증

```sh
npm run typecheck
npx vitest run tests/unit tests/store      # v10-open · oidc-spikes · backend-status 가 표를 판다
npm run test:e2e                           # 인증 경로 실물
node scripts/mutate.mjs --file src/api/server.ts --limit 40
```

### 종료 판정

- `handle()` 본문에 경로 리터럴 비교 **0 개** (GUI 폴백 제외)
- `SURFACE-API.json` 이 OIDC 두 개 · 프로브 두 개 · logout 을 포함
- `apiRouteTable()` 항목 수가 정확히 **+5**
- `src/api/server.ts` < 500 줄, `src/api/routes/*` 각각 < 400 줄
- push 완료

### 롤백

P1-9 의 `SURFACE-API.json` 재생성이 되돌리기 가장 까다롭다. **P1-9 를 단독 커밋으로**
두어 `git revert` 한 방에 되돌아가게 한다.

---

## P2 — 검출력 0 으로 측정된 절을 지운다 (§3-a)

**브랜치** `refactor/drop-dead-invariants` · **크기** 중간 · **위험** 낮음(순수 삭제) ·
**의존** P0 · **P4 의 선행**

### 문제

```
src/dp/agent.ts   total=2485  code=1104  comment=1251 (50%)
src/dp/apply.ts   total= 967  code= 441  comment= 489 (50%)
```

`N차` 감사 회차 서술이 프로덕션 `src/` 에 **373 곳**, 그중 201 곳이 `agent.ts` 하나다.
`assertInvariants`(`:794`–`:1027`)는 233 줄인데 실행되는 내용은 60 줄 남짓이다.

주석 자체는 진지하고 좋다. 문제는 그것이 **개정 이력**이고, 코드가 사는 파일 안에서
**자기 옛 판본과 논쟁하고 있다**는 것이다. 그리고 코드가 스스로 이렇게 적고 있다:

| 자리 | 코드가 한 주장 |
|:--|:--|
| `src/dp/agent.ts:897` | "(b) 는 지금 **장식이다**" |
| `src/dp/agent.ts:916` | "**검출력은 여전히 0 이다.** 되찾았다고 적고 싶었지만 재 보니 아니었다" |
| `src/dp/agent.ts:948` | "**지금은 이빨이 없다** — 뮤테이션으로 확인했다" |
| `src/dp/agent.ts:996` | "원래 절(검출력 0)보다는 낫다" |
| `src/dp/agent.ts:1830` | "**이 가드는 지금 검출력이 0 이다** (재 봤다 — 빼도 600 개가 전부 초록)" |
| `src/dp/apply.ts:441` | "**검출력 0 이고, 도달 가능성은 열려 있다**" |

아무것도 못 잡는 게 증명된 검사를, 아무것도 못 잡는다는 해설로 감싸서 두는 것 —
이것이 다듬을 게 아니라 **지울** 복잡도의 정의다.

### 범위 — 초안보다 넓힌다

초안은 `agent.ts` 와 `apply.ts:441` 만 봤다. `driver.ts`(49곳) · `operation.ts`(10곳) ·
그 외 9 파일(약 40곳)이 계획 밖에 남았다. **전부 포함한다.**

### 커밋 단위

**P2-1 · 주장을 재현한다 (커밋 없음, 측정만)**

절을 하나씩 끄고 전체 스위트를 돌린다. 초록이면 주장이 확인된 것이다.

```sh
npm run verify 2>&1 | tail -30
node scripts/mutate.mjs --file src/dp/agent.ts --limit 120
node scripts/mutate.mjs --file src/dp/apply.ts  --limit 60
```

측정 결과를 `docs/metrics/dead-clause-2026-08-26.md` 에 남긴다 — 나중에 "왜 지웠나" 의
답이 된다.

**P2-2 ~ · 셋으로 갈라 처리한다**

| 재측정 결과 | 처리 |
|:--|:--|
| **검출력 0 확인** | **삭제.** 커밋 메시지에 "재측정: 생존 뮤턴트 N/M, 전체 초록" |
| **"도달 가능성이 열려 있다"** (`apply.ts:441`) | **지우지 말고 무대를 만든다.** 그 경로에 도달하는 테스트를 쓴다 → 검출력 0 이 아니게 되고 남길 근거가 생긴다 |
| **재측정이 초록이 아님** | 그 **주석이 낡은 것**이다. 주석을 고치고 절은 남긴다 |

> **주의.** 이 단계는 "주석을 정리한다" 가 아니다. **주석과 함께 그 주석이 감싸던 죽은
> 코드를 지운다.** 코드를 남기고 주석만 지우면 상황이 더 나빠진다 — 왜 죽었는지 아무도
> 모르는 죽은 코드가 된다.

> 핀: 삭제 커밋은 `none — 검출력 0 으로 재측정됨(<로그 경로>). 전체 스위트 초록,
> 생존 뮤턴트 N/M.` / 무대를 만드는 커밋은 **그 새 테스트가 곧 재현물**이다.

**P2-마지막 · 서술을 옮긴다**

삭제한 절의 근거는 `DESIGN.md` 의 불변식 절에 **한 문장씩**:

> I6(b) — 저널 주장을 전제로 삼아 발화하던 절. 28·29·30차를 오간 끝에 검출력 0 으로
> 측정돼 뺐다. 실측: `<커밋 SHA>`.

**길게 쓰지 않는다. 이력은 git 이 진다.**

> ⚠️ `DESIGN.md` 는 이미 3,415 줄 변경된 큰 문서다. 이 단계가 그걸 더 키우는 방향이라는
> 점을 인지하고, **삭제 절당 한 문장** 상한을 지킨다. 넘으면 `docs/archive/` 로 뺀다.

### 종료 판정

- `src/dp/agent.ts` **최소 −200 줄**
- `src` 전체 `N차` 카운트 **373 → 100 미만**
- `agent.ts` · `apply.ts` 주석 비율 50% → 40% 미만
- 전체 검증 초록, 뮤테이션 생존율이 P0 대비 악화되지 않음
- push 완료

### 롤백

순수 삭제라 `git revert` 가 깨끗하다. 단 `DESIGN.md` 이동 커밋은 분리해 둔다.

---

## P3 — 리소스 서술자 표 (§1) ★ 본 수술

**브랜치** `refactor/resource-descriptors` · **크기** 큼 · **위험** 높음 ·
**의존** P0 · **분할 필수**

### 문제

리소스 종류는 아홉이다(`pool` `backend` `listener` `httpRoute` `passthroughRoute`
`certificate` `tlsPolicy` `sniBinding` `engine`). **층마다 그 목록을 손으로 걷는다.**

| 자리 | 모양 | 비용 |
|:--|:--|--:|
| `src/store/config-store.ts:256` `readModel` | `SELECT` 아홉 + 행→도메인 매퍼 아홉 | 274 줄 |
| `src/store/config-store.ts:561` `applyOp` | 아홉 갈래 `switch (op.kind)` | 295 줄 |
| `src/store/config-store.ts:1446` `opsOf` | 스프레드 아홉, 순서가 계약 | 21 줄 |
| `src/store/config-store.ts:1468` `shapeCheck` | kind → `keyof Model` 표 + decode | 61 줄 |
| `src/web/edit.ts` | `EditKind` + 종류마다 `PutXxxOp` 타입과 `putXxxPatch` 함수 | 987 줄 |

`src/web/edit.ts:9` 는 분류를 `EditKind` 로 **다시 선언한다** — `'engine'` 만 뺀 채,
`config-store.ts:52` 의 `ResourceKind` 와 타입 수준 관계가 **하나도 없이.**
서로 맞아야 하는 목록이 둘인데 맞는지 보는 장치가 없다.

열 번째 리소스를 넣으려면 전개 자리 다섯에 DDL 까지 고쳐야 하고, **컴파일러는 그중 둘만
잡아 준다.**

### 절대 규칙

**한 번에 하지 않는다.** 교살자(strangler) 방식으로 종류 하나씩 옮긴다.
**P3-A 없이 P3-B 로 가지 않는다.** 이게 계획 전체에서 가장 중요한 한 걸음이다.

### P3-A · 동치성 오라클을 먼저 세운다

옮기기 전에 "옮긴 게 같다" 를 **기계가 판정하게** 만든다.

1. `tests/store/differential-descriptor.test.ts` 신설
   - 같은 PG 픽스처에 대해 **구 `readModel` 과 신 `readModel` 을 둘 다 돌려 deep-equal**
   - `applyOp` 도 같은 방식 — 같은 `PatchOp` 배열을 두 구현에 먹이고 결과 DB 상태 비교
2. 기존 `tests/store/audit-model-roundtrip.test.ts` 가 아홉 종류 전부를 도는지 확인.
   빠진 종류가 있으면 **지금 채운다.**

> 핀: `tests/` 만 바꾼다 → 표식 불필요. 이 커밋이 이후 모든 P3 커밋의 `none` 근거가 된다.

### P3-B · 서술자 타입과 표를 만든다 (아무도 안 쓴다)

`src/store/descriptors.ts` 신설:

```ts
type ResourceDescriptor<T> = {
  kind: ResourceKind;
  table: string;
  modelField: keyof Model;
  columns: readonly string[];
  rowToDomain: (row: Row) => T;
  domainToParams: (body: T) => unknown[];
  refs: readonly { column: string; table: string }[];  // poolRef · listenerRef 통합
  dependsOn: readonly ResourceKind[];                  // opsOf 의 순서 계약을 데이터로
  decoder: Decoder<T>;                                 // shapeCheck 가 쓰던 것
};
```

`config-store.ts:1449` 의 주석 순서 계약("**순서가 계약이다**")은 `dependsOn` 필드가 되고
위상 정렬이 처리한다. 배열 리터럴 순서를 바꾸지 말아 달라고 후대에 부탁하는 주석 대신에.

> ⚠️ `decoder` 필드가 `src/model/decode.ts`(931줄)를 판다. P3 은 `config-store.ts` 만
> 건드리는 단계가 **아니다** — `decode.ts` 의 디코더 노출 방식도 함께 손본다.

> 핀: `none — 추가만 한다. 아직 어떤 경로도 이 표를 안 쓰므로 행동이 바뀔 수 없다.`

### P3-C · 종류 하나로 관통한다 (`pool`)

네 드라이버(`readModel` · `applyOp` · `opsOf` · `shapeCheck`) 각각에 "서술자가 있으면
서술자로, 없으면 기존 코드로" 갈림길을 둔다. P3-A 의 차등 테스트가 초록이면 성공.

> 이 갈림길은 **일시적이고, 삭제 예정이며, 그 사실을 코드가 아니라 이 계획이 안다.**
> P3-E 가 회수하지 않으면 이 계획은 이 저장소의 병을 그대로 재현한 것이다.

### P3-D · 나머지 여덟을 하나씩 (커밋 여덟)

어려운 순서를 뒤로 둔다:

```
pool → certificate → tlsPolicy → backend → sniBinding
     → httpRoute → passthroughRoute → listener → engine
```

`listener` 가 가장 크고(`applyOp` 에서 95 줄), `engine` 은 key 가 없는 예외라 마지막이다.

각 커밋마다:

```sh
npx vitest run tests/store/differential-descriptor.test.ts
npm run test:store
npm run test:golden
```

> 핀: `none — 순수 이동. tests/store/differential-descriptor.test.ts 가 구·신 구현을
> 같은 입력에 물려 deep-equal 을 판정한다.`

### P3-E · 갈림길과 구 코드를 지운다

아홉이 다 넘어오면 갈림길 · 구 `readModel` · 구 `applyOp` switch · `shapeCheck` 의 kind
표를 **삭제한다.**

**P3-A 의 차등 테스트도 함께 삭제한다** — 비교 대상이 사라졌으므로. 남기면 그것이 다음
세대의 죽은 코드다. (이 계획이 P2 에서 지적한 바로 그 병이다.)

### P3-F · `EditKind` 를 없앤다

`src/web/edit.ts` 의 `EditKind` → `Exclude<ResourceKind, 'engine'>`.
`putXxxPatch` 아홉을 서술자의 `decoder` 를 타는 **하나**로 접는다.
987 줄에서 대부분이 사라진다.

### 종료 판정

- `src/store/config-store.ts` **< 1000 줄** (현 1943)
- `src/web/edit.ts` **< 300 줄** (현 987)
- `ResourceKind` 를 손으로 펴는 자리 = **0** (`descriptors.ts` 제외)
- `SURFACE-DDL.sql` **무변경** ← 스키마는 안 건드렸다. 바뀌었으면 뭔가 잘못됐다
- 갈림길 코드 잔재 0, 차등 테스트 삭제됨
- `npm run verify` 초록
- push 완료

### 롤백

P3-C~D 는 커밋 단위가 종류 하나라 **개별 revert 가능**하다. 갈림길이 남아 있는 동안은
언제든 그 종류만 구 경로로 되돌아간다 — 교살자 방식을 쓰는 이유가 이것이다.
P3-E 이후에는 revert 비용이 급증하므로 **P3-E 를 서두르지 않는다.**

---

## P4 — `agent.ts` 를 이음매대로 가른다 (§3-b)

**브랜치** `refactor/agent-modules` · **크기** 중간 · **위험** 낮음 · **의존 P2**

P2 에서 이미 200 줄 이상 빠진 상태에서 시작한다. 죽은 코드를 지고 이사하지 않는다.

### 분해

```
src/dp/agent/
  types.ts           프로토콜 타입 · 에러 클래스        (현 :31–:180)
  store.ts           DurableStore · MemoryStore        (현 :366–:424)
  transitions.ts     순수 상태기계 헬퍼                 (현 :527–:793)
  invariants/
    index.ts         디스패처
    fencing.ts       I1 · I5
    monotonic.ts     I3 · I6
    durability.ts    I7
  serial.ts          CAS 낙관적 동시성 래퍼  ★
  agent.ts           DpAgent — 평면 상태기계만
```

★ **`serial()`(`:1651`)은 이 파일에서 가장 잘 만들어진 부분이다.** 재읽기 + CAS 재시도 +
prune + 불변식 검사를 한 통로로 모은 설계가 정확하다. 독립 모듈로 꺼내면 재사용도 되고
단독 테스트도 된다. **이 단계는 그것을 훼손하지 않는 것이 목표의 절반이다.**

`DpAgent` 의 읽기 전용 투영 15 개쯤(`coordinate` · `stagedDigest` · `lastActivated` ·
`decisionView` …)은 `AgentStateView` 로 묶어 클래스 표면을 좁힌다.

### 검증 — 이 단계는 순수 이동이다

**한 줄도 고치지 않는다.** `git diff --stat` 의 추가/삭제가 대칭이 아니면 뭔가 고친
것이고, 그건 이 단계에 속하지 않는다. 발견한 개선점은 **적어 두고 다음 사이클로 넘긴다.**

> 핀: `none — 순수 이동. import 경로 외 diff 가 대칭이고, tests/conformance 와
> tests/model 전체가 무변경으로 통과한다.`

### 종료 판정

- `src/dp/agent/` 의 어느 파일도 **600 줄 초과 없음**
- 뮤테이션 결과가 P2 종료 시점과 **동일**
- `npm run verify` 초록
- push 완료

---

## P5 — `ControlPlane` 을 가른다 ← 초안에 없던 단계

**브랜치** `refactor/control-plane-modules` · **크기** 중간~큼 · **위험** 중간 ·
**의존** P0

### 왜 초안에서 빠졌나

감사 §5 의 크기 장부에 **올려 놓고** 계획을 짤 때 그 표를 끝까지 대조하지 않았다.
`src/control/plane.ts` 1041 줄이 통째로 계획 밖에 있었다. 명백한 누락이다.

### 문제 — `agent.ts` 와 같은 병, 일부는 더 나쁘다

```
src/control/plane.ts:119   export class ControlPlane   ← :119–:1041, 클래스 하나가 920줄
```

메서드 25 개에 책임이 최소 넷:

| 책임 | 메서드 |
|:--|:--|
| apply 오케스트레이션 | `apply`(**214줄**) · `applyMembershipOnly` · `claim` · `sweep` · `recover` |
| 관측 · 메트릭 | `gauges` · `membershipSlotKeys` · `certificateExpiry` · `backendStatus` · `readiness` |
| 오퍼레이션 조회 | `operation` · `findOperation` · `status` · `cancel` · `recordPhase` |
| 슬롯 · 인증서 자원 | `reclaimSlots` · `certificateFiles` · `restageMembership` · `projectHealth` |

**`apply()` 하나가 214줄이다** — `agent.ts` 에서 지적한 어느 메서드보다 크다.

### 분해

```
src/control/
  plane.ts            ControlPlane — 조립과 위임만
  apply-orchestrator.ts  apply · applyMembershipOnly · claim · sweep · recover
  observability.ts    gauges · membershipSlotKeys · certificateExpiry · backendStatus · readiness
  operations.ts       operation · findOperation · status · cancel · recordPhase
  resources.ts        reclaimSlots · certificateFiles · restageMembership · projectHealth
```

`apply()` 214줄은 이동만으로 안 된다. **단계별 함수로 가른다** — P4 의 "순수 이동" 규칙에
대한 유일한 예외이므로, **별도 커밋**으로 분리하고 재현물을 실제로 단다.

### 검증

```sh
npm run test:store        # leader · health · acme-runner
npm run test:e2e          # apply 실물 경로
node scripts/mutate.mjs --file src/control/plane.ts --limit 60
```

> 핀: 이동 커밋은 `none — 순수 이동. diff 대칭.` /
> `apply()` 분해 커밋은 **실제 재현물 필수** — 단계 경계가 바뀌므로 행동이 바뀔 수 있다.

### 종료 판정

- `src/control/` 의 어느 파일도 **600 줄 초과 없음**
- `apply()` 를 대체한 어느 함수도 **80 줄 초과 없음**
- push 완료

---

## P6 — `install.sh` 의 계열 분기를 한 자리로 (§4)

**브랜치** `refactor/install-family-once` · **크기** 작음 · **위험** 중간 · **의존** P0

### 문제

1051 줄. `FAMILY` 를 `:296` 에서 정해 놓고 `:345` · `:514` · `:546` · `:725` 및 서비스
기동 경로에서 **다섯 번 더 갈린다.** 배포판 관련 리터럴이 19 곳.

`install_packages_deb`/`_el`/`_amzn`/`_apk` 함수 계열 자체는 **정당한 관용구다. 남긴다.**
문제는 나머지 스크립트가 자기가 어느 배포판 위에 있는지 계속 되묻는 것이다.

### 할 일

`:296` 의 `case` **직후에** 계열 의존 값을 전부 변수로 푼다:

```sh
PKG_INSTALL=   USERADD=       PG_DATA_DIR=
PG_SOCKET_DIR= INIT_SYSTEM=   SVC_WRITE_FN=
```

그 뒤 `:345` · `:514` · `:546` · `:725` 및 기동 경로의 재분기를 제거한다. 남은 약 700 줄이
계열과 무관해지고 **하나의 선형 설치로 읽힌다.** 여섯 번째 배포판을 넣는 일이 분기 자리
다섯 군데 사냥이 아니라 **블록 하나**가 된다.

### 검증 — 이 단계는 실물만이 판정한다

```sh
npm run test:install     # 배포판 5 종 실물 컨테이너 (커밋 29d3419)
```

**다섯 전부 초록이 아니면 이 단계는 끝난 게 아니다.** 단위 테스트로 대체 불가.

> 핀: `deploy/` 는 `src/` 가 아니다 → 표식 불필요. 단 `tests/install/run.sh` 결과를
> 커밋 메시지에 적는다.

### 종료 판정

- `deploy/install.sh` **< 1000 줄**
- `FAMILY`/`OS_ID` 를 보는 자리가 정확히 **1 곳**
- 배포판 5 종 전부 초록
- push 완료

---

## P7 — 렌더러 분할 (선택 · 우선순위 낮음)

**브랜치** `refactor/render-split` · **크기** 중간 · **위험** 낮음 · **의존** 없음

`src/conf/render.ts` 1640 줄. **감사가 면제한 유일한 파일이다** — 작은 순수 함수 35 개쯤으로
지어졌고 `:1353` 의 `render()` 하나로 들어간다. 덮는 nginx 관심사들(upstream / http server /
stream server / tls / realip / ratelimit)이 블록마다 **실제로 다르다.** 중복이 아니라
그냥 크다.

```
src/conf/render/
  upstream.ts   http.ts   stream.ts   tls.ts   index.ts
```

골든 테스트 14 종이 출력을 고정하므로 안전하다.

> **하지 않기로 결정해도 된다.** 그 경우 그 결정을 `docs/size-waivers.txt` 에 사유와 함께
> 적는다 — "크지만 균질하다, 의도적으로 남긴다." P9 의 게이트가 그 파일을 읽는다.

---

## P8 — 1000줄 초과 테스트 파일 ← 초안에 없던 단계

**브랜치** `test/split-oversized` · **크기** 중간 · **위험** 낮음 · **의존** 없음

### 왜 필요한가 — 초안의 자기모순

초안 8단계는 "추적되는 코드 파일 중 1000줄 초과가 있으면 실패" 하는 게이트를 넣기로 했다.
그런데 초안 어디에서도 안 건드리는 1000줄 초과 파일이 **넷** 남았다:

```
1677  tests/conformance/review17-deadlock.test.ts
1332  tests/model/two-leaders.test.ts
1041  src/control/plane.ts            ← P5 가 처리
1024  tests/engine/engine_facts.sh
```

**1~7 단계를 전부 끝내도 게이트가 즉시 빨개진다.** 계획이 자기 종료 조건을 만족시키지
못했다. 테스트 파일 셋을 면제할지 분할할지 정하지 않고 게이트만 적은 것이 원인이다.

### 결정

**테스트에는 별도 상한(1800줄)을 두고, 그 아래인 셋은 분할하되 게이트는 소스보다 느슨하게
간다.** 이유 — 테스트 파일이 큰 것과 소스가 큰 것은 비용이 다르다. 테스트는 읽는 빈도가
낮고, 시나리오 응집도가 파일 크기보다 중요할 때가 있다.

### 할 일

| 파일 | 처리 |
|:--|:--|
| `tests/conformance/review17-deadlock.test.ts` 1677 | 시나리오 군별로 3 파일 분할 |
| `tests/model/two-leaders.test.ts` 1332 | 리더 교체 / 펜싱 / 승계 로 3 분할 |
| `tests/engine/engine_facts.sh` 1024 | 사실 묶음별 분할, `run.sh` 가 조립 |

> 핀: `tests/` 만 바꾼다 → 표식 불필요.

### 종료 판정

- `tests/` 의 어느 파일도 **1200 줄 초과 없음**
- 테스트 **개수와 이름이 분할 전후로 동일** (`vitest --reporter=json` 비교로 증명)
- push 완료

---

## P9 — 다시 자라지 않게 못을 박는다

**브랜치** `ci/structural-guards` · **크기** 작음 · **의존 P1~P8 전부** ·
**이 계획에서 가장 중요한 단계**

### 왜 이것이 핵심인가

**P1~P8 은 증상 치료다.** 원인은 "아무것도 제거되지 않는다" 이고, 그건 리팩터링으로 안
고쳐진다. 게이트로 고친다. **P9 를 안 하면 3년 뒤 같은 감사를 다시 받는다.**

이 저장소는 이미 이걸 안다 — `scripts/pinned.mjs` 의 첫 주석이 "**규칙이 산문이라서 안
지켜진다. 그래서 게이트로 옮긴다**" 이다. 같은 처방을 구조에 적용한다.

### 게이트 정의 — 초안에서 미정이던 것을 확정한다

`scripts/verify.sh` 에 넣는다.

**G1 · 파일 크기 게이트**

| 대상 | 상한 | 면제 |
|:--|--:|:--|
| `src/**` | 1000 줄 | `docs/size-waivers.txt` (파일명 + 사유 한 줄) |
| `deploy/**.sh` `scripts/**.sh` | 1000 줄 | 동일 |
| `tests/**` | 1200 줄 | 동일 |
| `gui/src/**` | 800 줄 | 동일 |

`docs/size-waivers.txt` 의 예상 내용 — P7 을 안 하기로 하면 첫 줄:

```
src/conf/render.ts — 균질한 순수 함수 35개의 렌더러. 중복 아님. 2026-08-26 판정.
```

**G2 · 분류 전개 게이트**
`ResourceKind` 의 아홉 리터럴이 `src/store/descriptors.ts` **밖에서** 나열되면 실패.
§1 의 재발을 구조적으로 막는다.

**G3 · 라우트 표 게이트**
`handle()` 함수 본문에 `url.pathname ===` 리터럴 비교가 있으면 실패.
§2 의 재발을 막는다. (GUI 폴백은 함수 밖으로 뺐으므로 예외 불필요.)

**G4 · 주석 밀도 경고 — 실패시키지 않는다**
주석 비율 45% 초과 파일을 `verify` 요약에 띄운다. **막지 않는다** — 이 저장소의 주석은
대체로 자산이고, **재는 것만으로 충분하다.** 막으면 좋은 주석까지 죽인다.

**G5 · 죽은 절 규약** — `CLAUDE.md` 에 한 줄

> 검출력 0 으로 측정된 절은 주석을 붙이는 것이 아니라 **지운다.** 근거는 `DESIGN.md`
> 한 문장과 커밋 SHA 로 남긴다.

### 종료 판정

- G1~G4 가 CI(`verify.yml`)에서 돌고 **초록**
- `docs/size-waivers.txt` 의 항목이 **3 개 이하**이고 각각 사유가 있음
- P0 기준선 대비 최종 델타가 `docs/metrics/final-<날짜>.json` 에 기록됨
- push 완료

---

## 2. 예상 결과

| 지표 | 기준선 | 목표 |
|:--|--:|--:|
| 1000줄 초과 소스 | 5 | 0 (면제 최대 1) |
| 1000줄 초과 테스트/스크립트 | 4 | 0 |
| `src/dp/agent.ts` | 2485 | 최대 파일 600 미만 |
| `src/store/config-store.ts` | 1943 | < 1000 |
| `src/control/plane.ts` | 1041 | 최대 파일 600 미만 |
| `src/api/server.ts` | 1203 | < 500 |
| `src/web/edit.ts` | 987 | < 300 |
| `deploy/install.sh` | 1051 | < 1000 |
| 분류 전개 자리 | 5 | 1 |
| 동결 밖 API 엔드포인트 | 5 | 0 |
| `src` 내 `N차` 서술 | 373 | < 100 |
| **순 삭제 줄 수** | — | **약 −3,000** |

**마지막 행이 진짜 목표다.** 나머지는 그 부산물이다.

---

## 3. 위험 목록

| 위험 | 완화 |
|:--|:--|
| P3 에서 조용한 데이터 손상 | **P3-A 차등 테스트를 먼저.** 없으면 진행 금지 |
| P1 에서 인증 우회 | `kind: 'none'` 이 정확히 셋임을 단언하는 테스트를 **P1-1 로** |
| P2 에서 살아 있는 절을 죽은 것으로 오판 | 주석을 믿지 말고 **매번 재측정.** 뮤테이션 결과를 커밋에 기록 |
| P5 `apply()` 분해에서 단계 경계 변형 | 이동과 분해를 **다른 커밋으로.** 분해 커밋에 실제 재현물 |
| 계획이 임시 갈림길을 남김 | P3-E 를 별도 커밋으로 강제. G2 가 잔재를 잡음 |
| `Pinned-by: none` 남발로 게이트 무력화 | `none` 근거에 **동치성 판정자**를 반드시 명시 (§0.3) |
| 워크트리 병렬로 rebase 지옥 | 동시 레인 **최대 2**. P3 이 도는 동안은 1 개만 추가 |
| P9 를 안 하고 끝냄 | **P9 는 선택이 아니다.** 이 계획의 존재 이유 |
| e2e 가 워크트리에서 거짓 실패 | `.claude/worktree-bootstrap.md` — `rm -f node_modules && npm ci` 선행 |

---

## 4. 최소 실행 경로

전부 할 여력이 없으면 순서대로 잘라라. **각 지점에서 멈춰도 저장소는 지금보다 낫다.**

| 경로 | 얻는 것 |
|:--|:--|
| **P0 + P1 + P9** | 실제로 열린 구멍(OIDC 가 동결 밖)을 닫고 재발을 막는다. 노력 대비 실질이 가장 크다 |
| **+ P2** | 코드가 스스로 죽었다고 적은 것을 지운다. 위험 대비 삭제량이 가장 좋다 |
| **+ P3** | 큰 수술. **P3-A 를 할 각오가 있을 때만** |
| **+ P4 P5 P6** | 정리 |
| **+ P7 P8** | 마감 |

단 **P9 의 게이트 정의는 어디서 멈추느냐에 따라 달라진다.** P8 을 안 하면 G1 의 테스트
상한을 1800 줄로 두거나 `tests/**` 를 대상에서 빼야 한다. 멈추는 지점에서 게이트를
그 상태에 맞게 확정하고, **면제는 반드시 사유와 함께 `docs/size-waivers.txt` 에 적는다.**
사유 없는 면제는 이 계획이 고치려는 병 그 자체다.

---

## 5. 이 계획이 스스로에게 거는 조건

이 문서는 `docs/audit-*.md` 계열과 같은 운명을 맞을 수 있다 — 잘 쓰였고, 지켜지지 않고,
다음 회차가 "왜 안 했나" 를 적는 것. 그걸 막는 장치는 하나뿐이다.

**P0 의 `scripts/metrics.mjs` 와 P9 의 게이트.** 계획은 잊히지만 게이트는 안 잊힌다.

따라서 이 계획을 **P0 부터 시작하지 않는 것은 이 계획을 시작하지 않는 것이다.**

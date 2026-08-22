# 투두 — 검수 수정

실행 순서대로 편 체크리스트다. **왜 이 순서인가**는 [`audit-2026-08-22-plan.md`](./audit-2026-08-22-plan.md),
**무엇이 문제인가**는 [`audit-2026-08-22.md`](./audit-2026-08-22.md) 에 있다. 여기서는 안 되풀이한다.

한 블록이 **커밋 하나**다. 블록 안의 순서는 지킨다 — 재현물을 먼저 쓰고 **빨간 것을 눈으로
확인한 뒤** 고친다. 순서를 뒤집으면 이미 초록인 테스트를 쓰게 되고 `pinned.mjs` 가 잡는다.

---

## 실행 기록 — 2026-08-22

**W0 · W1 · W2 완료.** Critical 1 · High 7 이 전부 닫혔다. 커밋 18 개, 전부
`pinned.mjs` 의 "수정 전에 빨갛다" 를 통과했다. 표면 A 는 **111 심볼 그대로** —
동결 카운터를 안 썼다. 라우트는 41 → 42, 마이그레이션 011·012·013 이 늘었다.

**W3 의 결함 셋도 구현했다** — `audit-w3-surface` 브랜치에 있다. main 에는 안 올렸다:
A 표면이 동결돼 있고 `surface.mjs` 에 해제 경로가 아예 없다(§W3). W4 는 설계 결정이
먼저이므로 손대지 않았다.

### 계획과 달라진 것 — 다섯

계획대로 안 간 자리다. **왜 달라졌는지가 그 자체로 결과**이므로 남긴다.

1. **W0-a 는 계획이 틀렸다.** "이미지 기본값을 `127.0.0.1` 로 되돌린다" 는 컨테이너에서
   **API 를 아예 못 열게 만든다** — 도커의 포트 퍼블리시가 루프백 바인드에 안 닿는다.
   바인드를 바꾸는 대신 **기동 시 노출 경고**(`listen.exposed`)를 넣고, Dockerfile 에
   왜 `0.0.0.0` 인지 적었다(다음 사람이 "보안 문제네" 하고 되돌리면 API 가 안 열린다).
2. **W2-1 은 배선이 아니라 삭제였다.** `checkEngineConstraints` 를 배선하려고 규칙을
   다시 읽었더니 **도달 불가**였다 — 그 조합은 `validateModel` 의 규칙 셋(풀 프로토콜
   계열 · sendProxyProtocol tcp 전용 · stream PROXY 수신)에 이미 전부 막힌다. 경고 쪽은
   렌더러가 `$proxy_protocol_addr` 를 안 쓰게 되면서 사실이 아니게 됐다.
   24차의 규칙을 그대로 적용했다: *"도달 불가한 방어는 방어가 아니라 죽은 코드다."*
3. **W1-3 의 FK 를 트리거로 바꿨다.** `backend_health` 에 `ON DELETE CASCADE` FK 를 걸자
   **기존 헬스 스위트 7 건이 빨개졌다** — 프로버는 스냅샷 모델을 들고 판정을 쓰는데 FK 는
   live `backends` 를 본다. 백엔드를 지우는 커밋과 프로버 틱이 겹치면 §6.7 대로 판정이
   동결된다. 지금까지 무해했던 경합이 장애가 되는 것이라 되돌렸다.
4. **W0-8 의 절반은 안 고쳤다.** `LeaderElection.tryAcquire` 가 재획득 때 옛 `pg.Client`
   를 `end()` 하지 않는 것은 **재현물을 못 썼다** — "끊긴 것으로 관측됐는데 서버 세션은
   살아 있는" 상태를 밖에서 결정적으로 만들 방법이 없다(백엔드를 종료시키면 세션도 함께
   사라져 두 구현이 같은 결과를 낸다). 계획 §7.3 의 규칙대로 방어적으로 고치지 않고
   **검수 항목으로 되돌렸다.** 판단 근거는 `tests/unit/audit-shutdown-release.test.ts`
   머리에 적었다.
5. **B-11 에 네 번째 자리가 있었다.** 재현물을 쓰다 나왔다 — `plans.id` 는 uuid 컬럼이라
   uuid 아닌 경로 파라미터가 PG `22P02` 로 **500** 이 됐다. `:id` 를 받는 라우트 전부가
   해당된다. 자리마다 고치는 대신 `22P02` 를 400 으로 옮겨 부류째 닫았다.

### 새로 생긴 게이트

- **`scripts/reachable.mjs`** — 배선 없는 export 와 미사용 import 를 전수로 잡는다.
  `verify.sh` 와 적합성 스위트 양쪽에 걸었다. 검수가 손으로 찾은 넷을 그대로 짚고,
  **`RenderedFact` 는 게이트가 스스로 더 찾았다.** 예외 17 건은 전부 이유가 적혀 있다.
- **`tests/store/audit-model-roundtrip.test.ts`** — 커밋한 모델을 그대로 되읽는지 잰다.
  B-01 부류(필드는 있는데 저장 안 됨)를 앞으로 자동으로 잡는다.

### 전체 검증 결과

`npm run verify` (도커 포함) — **S12 하나를 빼고 전부 초록.**

| 스위트 | 결과 |
|---|---|
| typecheck · 표면 · **도달성** · 재현물 핀 · 훅 | ok |
| unit | 537 |
| conformance | 405 |
| 모델 | 13 |
| store (실물 PG) | 139 |
| golden (`nginx -t`) | 44 |
| **e2e (실제 nginx)** | **60** |
| engine facts | PASS=76 FAIL=0 SKIP=2 |
| spike S1/S5 · S7 · S8 · S11 · S13 · S16 · S17 · S18 · S19 | 전부 FAIL=0 |
| **spike S12** | **PASS=4 FAIL=1** — 아래 |

#### S12 는 간헐 실패다 — 이 회차의 변경과 무관하다

크래시 지점 38 개 중 **#25 `reload:after`** 하나가 수렴하지 못했다(`phase` 가 비었다).
근거 둘로 이 회차의 회귀가 아니라고 판단했다.

1. **단독 재실행 3 회가 전부 `PASS=5 FAIL=0`** 이다. 같은 트리, 같은 `dist/`.
2. **이 회차는 `src/dp/apply.ts` 와 `src/dp/agent.ts` 를 한 줄도 안 건드렸다** —
   S12 가 재는 것이 정확히 그 둘(전환 상태기계와 저널)이다. `src/dp/` 에서 바뀐 것은
   `materialize.ts`(경로 이탈 거부) · `loader.ts`(드라이버 로드) · `effects-fs.ts`
   (죽은 import 제거)뿐이고, 셋 다 S12 의 수렴 경로 밖이다.

> ⚠️ **간헐 실패를 "통과" 로 세지 않는다.** 이건 닫힌 것이 아니라 **새 검수 항목**이다 —
> 게이트가 가끔 빨간 것은 그 게이트를 믿을 수 없다는 뜻이고, 이 저장소는 그 부류를
> 반복해서 잡아 왔다(e2e 의 잔존 컨테이너 · PG 포트 충돌). #25 는 `reload:after` 에서
> 죽은 뒤 복구가 저널의 phase 를 못 읽는 자리이므로, **`agent.ts` 를 읽는 회차**(W4 의
> B-15 와 같은 회차)에서 함께 봐야 한다.

### 환경 — 워크트리에서 e2e 를 돌리려면

`.claude/settings.json` 이 `node_modules` 를 메인 트리에서 **심링크**한다. e2e 는 작업
디렉토리를 컨테이너에 마운트하므로 그 심링크가 **컨테이너 안에서 끊긴다** — `pg` 를
못 찾아 데몬이 기동 실패하고, 5 개 스위트가 훅 타임아웃으로 스킵된다(로그는 비어 있어
원인이 안 보인다). `.claude/worktree-bootstrap.md` 가 적어 둔 대로 `rm -f node_modules
&& npm ci` 로 바꾸면 통과한다.

---

## 착수 전 (한 번)

- [ ] 훅이 이 클론에 걸려 있는지 — `git config core.hooksPath` 가
      `scripts/git-hooks` 를 가리켜야 한다. 아니면 `./scripts/git-hooks/install.sh`
- [ ] 도커 — `docker info` (W0-2·W0-5 부터 필요)
- [ ] 기준선 초록 — `npm run verify:quick`
- [ ] 동결 상태를 적어 둔다 (착수 시점: **A 111 심볼 · 3 회차 동결 · B 41 라우트**)
      ```sh
      node scripts/surface.mjs --check
      node scripts/surface.mjs --freeze-check
      node scripts/freeze-b.mjs --check
      ```
- [ ] 워크트리에서 작업한다 — `AGENTS.md`. push 까지가 한 사이클이다

## 운영 DB 조사 (W1 착수 전)

W1-2 의 CHECK 이 기존 행에 걸리면 마이그레이션이 실패한다. **먼저 센다.**

- [ ] key 문법 위반 행
      ```sql
      WITH bad AS (
        SELECT 'certificates' t, key FROM certificates
        UNION ALL SELECT 'pools',       key FROM pools
        UNION ALL SELECT 'backends',    key FROM backends
        UNION ALL SELECT 'listeners',   key FROM listeners
        UNION ALL SELECT 'http_routes', key FROM http_routes
        UNION ALL SELECT 'passthrough_routes', key FROM passthrough_routes
        UNION ALL SELECT 'tls_policies',       key FROM tls_policies
        UNION ALL SELECT 'sni_certificate_bindings', key FROM sni_certificate_bindings)
      SELECT * FROM bad WHERE key !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$';
      ```
- [ ] 옛 리비전 스냅샷에도 있는지 (롤백이 막힌다)
      ```sql
      SELECT revision FROM config_revisions
       WHERE model::text ~ '"key":"[^"]*[^A-Za-z0-9._"-]';
      ```
- [ ] W2-3 이 좁힐 문자열 — `redirect_to` 에 `$` 가 있거나 `path_prefix` 가 `/` 로 시작 안 하는 행
      ```sql
      SELECT key, redirect_to, path_prefix FROM http_routes
       WHERE redirect_to LIKE '%$%' OR (path_prefix IS NOT NULL AND path_prefix !~ '^/');
      ```
- [ ] W0-3 이 막을 토큰 — `BARY_TOKENS` 의 `role` 값이 `auditor|operator|admin` 인지 눈으로

---

## W0 · 즉시 (표면 불변 · 마이그레이션 없음)

순서 무관. **단 W0-1 을 제일 먼저** — 나머지 S-01 작업이 그 위에 선다.

### ☐ W0-1 · S-01a — 세대 경로 이탈 방어 `[S]`

- [ ] `tests/conformance/audit-key-escape.test.ts` — `key='../../../../pwned'` 로
      `materializeGeneration` 이 던지는지, `verifyGeneration` 이 `..` manifest 를 거부하는지
- [ ] **빨강 확인** — `npx vitest run tests/conformance/audit-key-escape`
- [ ] `src/dp/materialize.ts` — `join(tmp, rel)` 결과가 tmp 밖이면 거부, `verifyGeneration`
      도 같은 검사. **일반 `Error` 로 던진다** (새 `GenerationError` 종류는 W3-2)
- [ ] `npm run verify:quick`
- [ ] 커밋 — `Pinned-by: tests/conformance/audit-key-escape.test.ts -t "세대 밖 경로는 만들지도 검증하지도 않는다"`

### ☐ W0-2 · S-02 — https 의 `real_ip_header` `[S]`

- [ ] `tests/conformance/audit-https-realip.test.ts` — 렌더에 `real_ip_header proxy_protocol`
      이 있는가 + `streamRealip:false` 로도 https+PROXY 가 저장되는가
- [ ] **빨강 확인**
- [ ] `src/conf/render.ts:494` — 조건을 `'http' || 'https'` 로
- [ ] `src/validate/model.ts:281` — 제외 목록에 `https` 추가
- [ ] `npm run verify:quick`
- [ ] 커밋 — `Pinned-by: tests/conformance/audit-https-realip.test.ts -t "https 는 PROXY 주소를 remote_addr 로 올린다"`
- [ ] ⚠️ 골든은 **아직 재생성하지 않는다** — W0-4 와 묶어서 한 번에 (§W0 마무리)

### ☐ W0-3 · S-03 — role fail-closed + 토큰 해독 `[S]`

- [ ] `tests/unit/audit-token-spec.test.ts` — 모르는 role 이 거부되는가, `scopes` 가
      문자열이면 거부되는가, 모르는 키가 거부되는가
- [ ] **빨강 확인**
- [ ] `src/api/auth.ts` — `scopesOfRole` 이 `admin` 만 전권, 나머지는 던진다
- [ ] `src/bin/barycenterd.ts` — `loadTokens()` 에 `TokenSpec` 해독기
- [ ] `npm run verify:quick`
- [ ] 커밋 — `Pinned-by: tests/unit/audit-token-spec.test.ts -t "모르는 role 은 admin 이 아니라 거부다"`
- [ ] 릴리스 노트 항목으로 적어 둔다 → §릴리스 노트

### ☐ W0-4 · B-02 — capability 매핑 통합 `[S]`

- [ ] `tests/unit/audit-render-caps.test.ts` — `writeBootstrap` 과 `main()` 이 같은
      매핑을 쓰는가 (`capsOf(probe)` 를 export 해 직접 비교)
- [ ] **빨강 확인**
- [ ] `src/bin/barycenterd.ts` — `capsOf(probe)` 하나로 합치고 두 자리에서 부른다
- [ ] `npm run verify:quick`
- [ ] 커밋 — `Pinned-by: tests/unit/audit-render-caps.test.ts -t "부트스트랩과 런타임이 같은 capability 를 쓴다"`

### ☐ W0-5 · B-03 — `replace` 삭제 순서 `[XS]`

- [ ] `tests/store/audit-restore-delete.test.ts` — 리스너+풀을 만들고 둘 다 빠진
      매니페스트로 `restore` → FK 위반 없이 지워지는가 (**실물 PG**)
- [ ] **빨강 확인** — `npx vitest run tests/store/audit-restore-delete --no-file-parallelism`
- [ ] `src/store/manifest.ts:146-154` — delete 를 `KINDS` 역순으로
- [ ] `npm run test:store`
- [ ] 커밋 — `Pinned-by: tests/store/audit-restore-delete.test.ts -t "리소스를 지우는 복구가 FK 를 안 깬다"`

### ☐ W0-6 · B-06 — SSE 구독 누수 `[XS]`

- [ ] `tests/unit/audit-sse-early-close.test.ts` — 스냅샷 도중 `close` 를 쏘고
      `hub.size === 0` 인가
- [ ] **빨강 확인**
- [ ] `src/api/events.ts` — `req.on('close')` 를 `writeHead` 직후로, `writeSse` try/catch
- [ ] `npm run verify:quick`
- [ ] 커밋 — `Pinned-by: tests/unit/audit-sse-early-close.test.ts -t "스냅샷 도중 끊겨도 구독이 남지 않는다"`

### ☐ W0-7 · B-11 — 500 을 4xx 로 `[XS]`

- [ ] `tests/unit/audit-bad-input-status.test.ts` — `/plans/%` · `/audit?limit=-5` ·
      `rollback to_revision=abc` 셋 다 500 이 아닌가
- [ ] **빨강 확인**
- [ ] `src/api/server.ts` — 파라미터 해독을 `try` 안으로, `limit` 하한 1
- [ ] `src/store/config-store.ts:914` — `to_revision` 을 `/^\d+$/` 로 먼저
- [ ] `npm run verify:quick`
- [ ] 커밋 — `Pinned-by: tests/unit/audit-bad-input-status.test.ts -t "깨진 입력은 500 이 아니다"`

### ☐ W0-8 · B-16 — 커넥션 누수와 락 반납 `[XS]`

- [ ] `tests/unit/audit-leader-reacquire.test.ts` — `#lost` 뒤 재획득이 옛 클라이언트를 닫는가
- [ ] **빨강 확인**
- [ ] `src/control/leader.ts` — 새로 잡기 전에 `end()`
- [ ] `src/bin/barycenterd.ts:545-563` — `stop()` 이 store 를 `release()`
- [ ] `npm run verify:quick`
- [ ] 커밋 — `Pinned-by: tests/unit/audit-leader-reacquire.test.ts -t "재획득이 옛 세션을 닫는다"`

### ☐ W0-9 · B-13 — changeset patch 누적 상한 `[XS]`

- [ ] `tests/store/audit-patch-cap.test.ts` — 상한을 넘는 누적 PATCH 가 409 인가
- [ ] **빨강 확인**
- [ ] `src/store/config-store.ts:682-697` — 누적 op 개수·바이트 상한
- [ ] `npm run test:store`
- [ ] 커밋 — `Pinned-by: tests/store/audit-patch-cap.test.ts -t "누적 patch 는 유계다"`

### ☐ W0-10 · S-10 — 보안 헤더와 심볼릭 링크 `[S]`

- [ ] `tests/unit/audit-response-headers.test.ts` — JSON·정적 응답에 `nosniff` 와
      `frame-ancestors 'none'` 이 있는가 + GUI 루트 밖을 가리키는 심볼릭 링크가 거부되는가
- [ ] **빨강 확인**
- [ ] `src/api/server.ts` — 응답 헤더
- [ ] `src/web/serve-gui.ts` — `realpathSync` 로 이탈 확인
- [ ] `npm run verify:quick`
- [ ] 커밋 — `Pinned-by: tests/unit/audit-response-headers.test.ts -t "정적 응답이 스니핑과 프레임을 막는다"`

### ☐ W0-a · S-05a — 이미지 기본 바인드 `[XS]` (게이트 밖)

- [ ] `deploy/Dockerfile` — `BARY_LISTEN=127.0.0.1:8088`
- [ ] `deploy/docker-compose.yml` 이 그대로 도는지 확인 (컨테이너 안 루프백이면
      포트 퍼블리시가 안 먹는다 — **compose 쪽 바인드를 함께 봐야 한다**)
- [ ] 커밋 — `src/` 가 아니므로 `Pinned-by` 불필요

### ☐ W0 마무리 — 골든 재생성과 릴리스

- [ ] 골든 한 번에 재생성 (W0-2·W0-4 가 렌더 산출물을 바꿨다)
- [ ] `npm run verify` **전부 초록**
- [ ] `node scripts/pinned.mjs origin/main` — W0 커밋 전부가 핀을 통과하는가
- [ ] `node scripts/surface.mjs --check` — **여전히 111 심볼이어야 한다.** 움직였으면
      어딘가에서 표면을 건드린 것이니 되돌린다
- [ ] push → 배포. **세대 전환 한 번**이 든다 (전환당 트래픽 2.6%) — 창을 잡는다

---

## W1 · 저장 결손 (마이그레이션)

도커 필요. 마이그레이션이나 라우트를 더한 커밋마다 `freeze-b --write` 를 잊지 않는다.

### ☐ W1-0 · 제안#1 — 모델 왕복 속성 테스트 `[M]` ← **먼저**

- [ ] `tests/store/audit-model-roundtrip.test.ts` — 임의 모델 → changeset/plan/commit →
      `modelAt` → 입력과 같은가. `hsts`·`cipherPolicy`·`sniHostMismatch`·`http2`·`engine`
      을 담은 모델을 반드시 포함시킨다
- [ ] **빨강 확인** — 다섯 필드에서 빨개져야 한다. 안 빨개지면 테스트가 그 필드를 안 담은 것
- [ ] 커밋 — `Pinned-by: none — 게이트 자체를 만드는 커밋이다 (src/ 를 안 바꾼다)`
      *(테스트만 담은 커밋이면 `src/` 변경이 없어 표식이 필요 없다. 확인: `git diff --cached --name-only -- src/`)*

### ☐ W1-1 · B-01 — 다섯 필드를 실제로 저장 `[L]`

- [ ] `src/store/migrations/011_tls_policy_fields.sql`
      — `tls_policies` + `hsts jsonb`, `cipher_policy text`, `sni_host_mismatch text`
      — `listeners` + `http2 boolean`
      — `engine_settings` 단일 행 테이블 (`only_one boolean PRIMARY KEY CHECK (only_one)`)
- [ ] `src/store/config-store.ts` — `applyOp`(tlsPolicy·listener) · `readModel` 맞춤
- [ ] `src/store/manifest.ts` — `engine` 을 최상위 키로 export/import
- [ ] W1-0 이 **초록**으로 바뀌는가
- [ ] `npm run test:store` · `npm run test:golden`
- [ ] `node scripts/freeze-b.mjs --write` → `SURFACE-DDL.sql` 갱신 커밋에 포함
- [ ] 커밋 — `Pinned-by: tests/store/audit-model-roundtrip.test.ts -t "커밋한 모델을 그대로 되읽는다"`
- [ ] 릴리스 노트 → §릴리스 노트 (롤백 시 HSTS 소실)

### ☐ W1-2 · S-01b — 리소스 key 문법 `[M]`

> ⚠️ **`decodeModel` 에는 넣지 않는다.** 넣으면 옛 리비전이 해독 불가가 되어 롤백이 죽는다.
> 계획 §7.1 을 읽고 착수한다.

- [ ] §운영 DB 조사가 끝났는가 — 위반 행이 0 인가. 있으면 **먼저 고친다**
- [ ] `tests/store/audit-key-syntax.test.ts` — `../` 를 담은 key 가 PATCH 에서 400 인가,
      DB CHECK 이 직접 INSERT 도 막는가
- [ ] **빨강 확인**
- [ ] `src/store/config-store.ts` — `shapeCheck` 에 `assertKeySyntax`
      (`FsSecretStore` 의 이름 규칙과 **같게** 맞춘다)
- [ ] `src/store/migrations/012_key_syntax.sql` — 여덟 테이블 CHECK
- [ ] `npm run test:store`
- [ ] `node scripts/freeze-b.mjs --write`
- [ ] 커밋 — `Pinned-by: tests/store/audit-key-syntax.test.ts -t "경로가 되는 key 는 저장되지 않는다"`

### ☐ W1-3 · B-04 + B-10 — 드레인 수명과 잔존 행 `[M]`

- [ ] `tests/store/audit-drain-lifecycle.test.ts` — 드레인을 풀 수 있는가,
      `deadline_at` 이 지나면 저절로 빠지는가, 백엔드를 지우면 헬스·드레인 행이 같이 지워지는가
- [ ] **빨강 확인**
- [ ] `src/api/server.ts` — `DELETE /api/v1/backends/:id/drain` (`write`)
- [ ] `src/control/drain.ts` — `drainKeys` 가 `deadline_at` 을 읽는다
- [ ] `src/store/migrations/013_drain_fk.sql` — 백엔드 삭제 시 `backend_drain`·`backend_health` 정리
- [ ] `src/cli/backend.ts` · `src/bin/bary.ts` — `bary backend undrain`
- [ ] `npm run test:store`
- [ ] `node scripts/freeze-b.mjs --write` — **라우트가 늘었다. 41 → 42**
- [ ] 커밋 — `Pinned-by: tests/store/audit-drain-lifecycle.test.ts -t "드레인을 풀 수 있고 만료되면 저절로 풀린다"`

### ☐ W1 마무리

- [ ] `npm run verify` 전부 초록
- [ ] `node scripts/pinned.mjs origin/main`
- [ ] `node scripts/surface.mjs --check` — 111 심볼 유지
- [ ] `node scripts/freeze-b.mjs --check` — 42 라우트
- [ ] push → 배포. **마이그레이션 세 개 + 세대 전환 한 번**

---

## W2 · 배선 복구 (표면 불변으로 설계)

### ☐ W2-0 · 제안#2 — 도달성 게이트 `[M]` ← **먼저**

- [ ] `scripts/reachable.mjs` — `src/index.ts` 에서 도달 못 하고 `src/bin/**` 에서도
      안 불리는 export 를 실패로. `surface.mjs` 의 TS 프로그램 구성을 재사용한다
- [ ] 지금 빨개지는 것을 확인 — `checkEngineConstraints`, `certCoversHost`,
      `validateHeaderValue`, `poolsReachedBy`
- [ ] `scripts/verify.sh` 에 `run "도달성 " node scripts/reachable.mjs` 한 줄
- [ ] 커밋 — `src/` 를 안 바꾸므로 `Pinned-by` 불필요
- [ ] ⚠️ 이 시점부터 `verify` 가 **빨갛다.** W2-1~W2-3 이 닫을 때까지 그렇다.
      한 줄 추가를 W2-3 커밋까지 미뤄도 된다 — **팀 상황에 맞춰 고른다**

### ☐ W2-1 · S-04 — 엔진 제약 배선 `[S]`

- [ ] `tests/conformance/audit-proxy-chain.test.ts` — PROXY 수신+송신 체인이
      `stream_realip` 없이 저장되지 않는가
- [ ] **빨강 확인**
- [ ] `src/store/config-store.ts` — `EngineCapabilities` 를 들고 `plan`/`commit` 에서 호출.
      **`validateModel` 안에 넣지 않는다** (`ValidationCapabilities` 는 표면이다)
- [ ] `src/bin/barycenterd.ts` — `ConfigStore` 에 capability 주입
- [ ] `npm run verify:quick`
- [ ] 커밋 — `Pinned-by: tests/conformance/audit-proxy-chain.test.ts -t "PROXY 체인은 stream_realip 없이 저장되지 않는다"`

### ☐ W2-2 · B-05 — SAN 커버리지 `[M]`

- [ ] `tests/store/audit-san-coverage.test.ts` — SAN 이 `b.test` 뿐인 인증서를
      `a.test` 에 바인딩하면 거부되는가
- [ ] **빨강 확인**
- [ ] `src/store/config-store.ts` — `SecretStore` 주입, `plan`/`commit` 에서
      `certCoversHost` 로 대조 (자료 없는 인증서는 건너뛴다)
- [ ] `src/control/plane.ts` · `src/bin/barycenterd.ts` — 주입 배선
- [ ] **주석에 적는다** — `render()` 의 fail-closed 계약에는 안 들어간다는 사실
- [ ] `npm run test:store`
- [ ] 커밋 — `Pinned-by: tests/store/audit-san-coverage.test.ts -t "SAN 이 안 덮는 인증서는 바인딩되지 않는다"`

### ☐ W2-3 · S-11 + B-14 — 문자열 검증과 죽은 코드 `[M]`

- [ ] §운영 DB 조사의 `redirect_to`/`path_prefix` 위반이 0 인가
- [ ] `tests/conformance/audit-directive-strings.test.ts` — `$` 를 담은 `redirect.to`,
      `/` 로 시작 안 하는 `pathPrefix`, 호스트가 아닌 `backend.host` 가 전부 4xx 인가
- [ ] **빨강 확인**
- [ ] `src/model/decode.ts` — `redirect.to` 에 `validateHeaderValue`, `pathPrefix` 문법,
      `backend.host` 에 `normalizeHost`
- [ ] `src/conf/render.ts:27` · `src/validate/model.ts:18` — `poolsReachedBy` import 제거
- [ ] W2-0 의 도달성 게이트가 **초록**으로 바뀌는가
- [ ] `npm run verify:quick`
- [ ] 커밋 — `Pinned-by: tests/conformance/audit-directive-strings.test.ts -t "검증 안 된 문자열이 디렉티브로 안 간다"`
- [ ] 릴리스 노트 → §릴리스 노트 (입력 계약 축소)

### ☐ W2-4 · S-08a — 백엔드가 admin 포트를 못 겨눈다 `[S]`

- [ ] `tests/conformance/audit-admin-port-backend.test.ts` — `127.0.0.1:<adminPort>` 를
      백엔드로 둔 모델이 거부되는가
- [ ] **빨강 확인**
- [ ] `src/control/plane.ts:741-752` — `assertAdminPortFree` 가 백엔드도 본다
      (stream admin 포트도 함께)
- [ ] `npm run verify:quick`
- [ ] 커밋 — `Pinned-by: tests/conformance/audit-admin-port-backend.test.ts -t "백엔드가 admin 포트를 겨누지 못한다"`

### ☐ W2-5 · B-09 — DNS 부분 실패 격리 `[S]`

- [ ] `tests/unit/audit-resolve-slots.test.ts` — peer 하나가 해석 실패해도 나머지가
      슬롯에 들어가는가
- [ ] **빨강 확인**
- [ ] `src/control/membership.ts:111-128` — `Promise.allSettled`, 실패 peer 는 빼고 로그.
      TTL 캐시는 **별건으로 미룬다** (지금은 실패 격리만)
- [ ] `npm run verify:quick`
- [ ] 커밋 — `Pinned-by: tests/unit/audit-resolve-slots.test.ts -t "peer 하나가 안 풀려도 나머지는 간다"`

### ☐ W2-6 · S-09 — 드라이버 무결성 TOCTOU `[M]`

- [ ] `tests/unit/audit-driver-toctou.test.ts` — 해시 확인 뒤 파일을 바꿔치기하면
      로드가 거부되는가
- [ ] **빨강 확인**
- [ ] `src/dp/loader.ts` — 읽은 바이트를 직접 로드하거나 fd 를 유지해 동일성 확인.
      "엔트리 파일 하나만 핀된다" 는 사실을 주석 계약으로 명시
- [ ] `npm run verify:quick`
- [ ] 커밋 — `Pinned-by: tests/unit/audit-driver-toctou.test.ts -t "검사한 바이트와 실행한 바이트가 같다"`

### ☐ W2 마무리

- [ ] `npm run verify` 전부 초록 (도달성 게이트 포함)
- [ ] `node scripts/pinned.mjs origin/main`
- [ ] `node scripts/surface.mjs --check` — **111 심볼 유지가 이 웨이브의 성공 조건이다.**
      움직였으면 W2-1·W2-2 의 배치 지점이 계획과 달라진 것이니 되돌려 다시 본다
- [ ] push → 배포

> **여기까지 오면 Critical 1 · High 7 이 전부 닫힌다.** W3·W4 는 별도 판단이다.

---

## W3 · **분할했다** — 결함은 냈고, 설정 표면만 동결 뒤에 남았다

처음에 이 웨이브를 "동결 해제 결정이 나야 전부 나간다" 로 묶어 뒀는데, **그게 틀렸다.**
한 커밋에 결함과 설정을 함께 담아 둔 탓에 **결함까지 동결 뒤에 갇혀 있었다.**

다시 재 봤다: `HealthProber`·`probeHttp`·`HttpProbeOpts`·`probeBackend` 는 **전부
`SURFACE.txt` 밖**이다. 그래서 B-07 의 진짜 결함 — *5xx 를 healthy 로 보던 판정,
곧 죽은 백엔드가 트래픽을 계속 받던 것* — 은 **동결을 안 건드리고 낼 수 있었다.**
프로브 동시성 상한(32)도 같이 갔다. 커밋 `7884a74`, 표면 111 심볼·동결 그대로.

**결함과 설정은 다른 것이다.** 죽은 백엔드가 트래픽을 받는 것은 결함이고, 그것을
*좁히는* 손잡이는 기능이다. 앞의 것은 지금 고칠 수 있었다.

동결 뒤에 남은 것은 셋이고 전부 표면 안이다.

| 남은 것 | 왜 표면 안인가 |
|---|---|
| B-07 좁히기 설정 (`Pool.healthCheck`) | `Model` 을 넓힌다 |
| B-12 dict 크기 (`Model['engine']`) | `Model` 을 넓힌다 |
| S-01c `GenerationError('path_escape')` | `GenerationError` 가 표면 안에 있다 |

풀리면 `healthCheckOf` 의 **본문 한 곳**만 `pool.healthCheck` 를 읽도록 바뀐다 —
다리는 이미 놓았다. 나머지는 `origin/audit-w3-surface` 에 그대로 있다.

---

## W3 (원래 기록) · 표면 회차 — 구현은 끝났고 동결 해제 결정만 남았다

> ☑ **구현 완료 · `audit-w3-surface` 브랜치에 있다.** main 에는 **안 올렸다.**
>
> `surface.mjs --write` 가 하드 차단한다:
>
> ```
> A 표면은 이미 동결됐다 — 해제·버전 전환 결정 없이 기준을 옮길 수 없다
> ```
>
> **해제 플래그가 없다.** `--write`·`--round`·`--freeze`·`--check`·`--freeze-check` 뿐이고,
> 동결된 기준을 옮기는 길은 코드에 아예 없다. `SURFACE.txt` 머리에는 *"이 파일은
> `scripts/surface.mjs` 가 만든다. 손으로 고치지 않는다"* 가 적혀 있다.
>
> **이 저장소가 그 결정을 사람에게 유보한 것**이므로 우회하지 않았다. 스크립트를 고치거나
> 기준을 손으로 쓰는 것은 게이트를 무력화하는 것이고, 그건 이 저장소가 111 심볼·3 회차로
> 쌓아 온 것을 조용히 버리는 일이다.
>
> **결정이 나면**: `git merge audit-w3-surface` → `node scripts/surface.mjs --write`
> (카운터 3 → 0) → `npm run verify`. 그 한 번이면 끝난다.

### 브랜치에 든 것

| 항목 | 무엇 | 표면에서 움직이는 것 |
|---|---|---|
| **B-07** | 5xx 를 healthy 로 세지 않는다 + 풀별 헬스체크 정의 + 프로브 동시성 상한 | `Pool.healthCheck` |
| **B-12** | dict 크기를 `engine` 으로 연다 + `in:` 카운터 만료 | `EngineSettings` ×2 |
| **S-01c** | 경로 이탈에 `GenerationError('path_escape')` | `GenerationError['kind']` |

`surface.mjs --check` 를 뺀 나머지 게이트는 그 브랜치에서 **전부 초록**이다 —
typecheck · 도달성 · 훅 · unit 541 · conformance 409 · 모델 13.

기본값은 보존했다. dict 는 1024 의 배수를 `m` 으로 내 **설정을 안 바꾼 배포의 렌더
바이트가 한 글자도 안 변한다**(안 그러면 전 배포가 다음 apply 에서 세대 전환을 한다).
헬스 판정만 의도적으로 바뀐다 — 그게 B-07 의 내용이다.

### 아직 브랜치에도 없는 것

제안 6(레이트리밋)·7(헤더 조작)·8(타임아웃 프로필)·9(운영 상태 API)는 **결함이 아니라
기능**이라 손대지 않았다. 같은 동결 해제를 쓰므로, 열기로 했다면 같은 회차에 함께 넣는
편이 리셋을 한 번으로 줄인다.

- [ ] `node scripts/surface.mjs --check` 로 현재 카운터 확인 후 결정
- [ ] ☐ W3-1 · B-07 백엔드별 헬스체크 정의 (`Pool.healthCheck`) `[L]`
      — 재현물 `tests/store/audit-healthcheck-spec.test.ts` `-t "5xx 는 healthy 가 아니다"`
      — 프로브 동시성 상한과 DB 갱신 묶기도 여기서
- [ ] ☐ W3-2 · S-01c 경로 이탈에 타입 있는 종류 (`GenerationError['kind']`) `[XS]`
      — W0-1 의 일반 `Error` 를 `'path_escape'` 로 승격
- [ ] ☐ W3-3 · 제안6 레이트리밋·커넥션 제한 `[L]`
- [ ] ☐ W3-4 · 제안7·8 헤더 조작 · 타임아웃/버퍼 프로필 `[L]`
- [ ] ☐ B-12 dict 크기 설정화 + `in:` 카운터 정리 `[M]`
- [ ] ☐ 제안#9 운영 상태 조회 API `[M]` (표면 A 는 안 움직인다 — 라우트만. B 재생성)
- [ ] 회차 마지막에 **한 번만** — `node scripts/surface.mjs --write`
- [ ] `npm run verify --freeze-gate` 가 이 회차 동안 빨간 것은 정상이다

---

## W4 · 결정이 필요했던 것들 — 셋은 답이 하나뿐이라 닫았다

체크박스는 "결정했다" 이지 "구현했다" 가 아니다.

착수해 보니 셋은 **범위 결정이 아니라 결함**이었다. "어느 쪽이든 될 수 있다" 가 아니라
한쪽이 틀린 것이라, 결정이 아니라 수정이었다. 나머지는 진짜로 답이 여럿이다.

- [x] ☑ **W4-1 · B-08 + 제안#10** — **비대칭으로 닫았다.** 두 표에 같은 정책을 주는
      것이 더 단순해 보이지만, 그건 단순한 것이 아니라 **둘이 다른 것이라는 사실을 안
      본 것**이다.
      · `health_events` — 프로덕션에서 **아무도 안 읽는다**(테스트만). replay 는
        `projectHealth()` 가 대체했고 정본은 `backend_health` 다. 006 머리말의
        "이벤트 로그가 단일 정본이다" 는 지금 사실이 아니다 → 기본 30 일 상한.
      · `audit` — `GET /api/v1/audit` 가 읽는 **진짜 감사 추적**이다. 기본값으로 칼을
        대면 업그레이드가 조용히 남의 보존 요건을 위반한다 → **안 정하면 안 지운다.**
      · `config_revisions` 는 **안 건드렸다.** 롤백과 시크릿 GC root 가 걸려 있어
        보존 창을 좁히면 되돌릴 수 있는 범위가 같이 줄어든다. 별건이다.
      · 지우는 양에 주기 상한을 뒀다 — 처음 켜는 배포가 한 트랜잭션으로 밀면 그 동안
        `emit()` 의 `health_cursor FOR UPDATE` 뒤로 프로버가 줄을 서고, 그게 §6.7 의
        판정 동결이다. 커서 자체는 안 되감는다(번호 재사용 → §6.6 이 깨진다).
- [x] ☑ **W4-2 · S-06 · S-07** — **범위 결정이 아니라 결함이었다.** `verifyJwtSig` 가
      RS256 을 구현해 뒀는데 기동 코드가 문자열 키를 넘겨서 **그 경로가 프로덕션에서
      도달 불가**였다. 실물 IdP 는 거의 다 RS256 이므로, 이 상태의 OIDC 는 HMAC 비밀을
      나눠 갖는 구성에서만 동작한다 — 그런 구성을 내주는 IdP 는 거의 없다.
      `azp` 도 같다: `aud` 배열에 이름만 얹힌 남의 클라이언트 토큰이 지났다.
      JWKS 회전과 PKCE·nonce 는 **안 했다** — 그건 진짜로 설계 결정이다(아래 남은 것).
- [x] ☑ **W4-2 · S-05b** — **서버 TLS 는 정하고, mTLS 는 안 정했다.** 개인키를 받는
      엔드포인트를 평문으로 여는 것은 정책 문제가 아니라 결함이라 선택지가 하나뿐이다.
      클라이언트 인증서를 **신원**으로 쓰는 것은 역할 매핑 설계가 필요하고 섞으면
      권한의 진실이 둘이 된다 — `BARY_TLS_CLIENT_CA_FILE` 이 여는 것은 **망 관문**까지다.
- [x] ☑ **S-06 나머지 · PKCE + nonce** — 닫았다. 결정이 아니라 결함이었다: 가로챈
      `code` 를 막는 장치가 없었고, 이 RP 는 SPA 라 `client_secret` 없는 배포가 정상이라
      `code` 가 그 자체로 자격증명이었다. `/oidc/token` 은 이제 `code_verifier` 를
      **요구한다** — 선택으로 두면 다운그레이드가 공격자의 선택이 된다.
      **JWKS 회전은 여전히 안 했다** (아래 남은 것).
- [x] ☑ **S-10b · 컨테이너 비-root** — 닫았다. `USER` 한 줄로 안 되는 이유가 정확히
      맞았다(특권 포트). 포트 권한만 파일 capability 로 주고 나머지는 비-root 다.
      실물 compose 배포로 검증했다: `quickstart.sh --clean` → `uid=10001` · 트래픽 정상.
      quickstart 에 ⑦ 판정을 더했다 — 이 이미지는 e2e 가 안 만지므로 재는 자리가
      없으면 다음 사람이 `USER` 를 지워도 아무도 모른다.
- [ ] ☐ **B-15 — 분류를 고친다.** 검수가 "성장이 안 보인다" 로 적었는데 **틀렸다.**
      · `agentStateBytes` 게이지가 **이미** 이 표의 성장을 잰다. 그것도 파일 크기
        수준으로 — "저장소는 payload 를 불투명하게 다룬다"(9차 검수)는 계약을 안 깨려고
        일부러 그렇게 돼 있다. 원장 내부를 들여다보는 접근자를 더하려던 것이 그 계약을
        깨는 일이었다. **안 더했다.**
      · 자르기는 **의도적 유보**다. `terminal` 은 감사 기록이 아니라 **부활 방지 장치**이고,
        주석이 "토큰 낡은 것만 자르는 규칙도 안전하지 않다"는 반례까지 적어 뒀다
        (후보가 fence 를 건너 승계돼 낡은 토큰의 종단 기록을 지금 후보가 읽는다).
      · 유일하게 성립하는 얼개는 "목표 epoch 이 좌표에 추월된 항목" 인데, 그러려면
        키가 아니라 **값에 epoch 을 적고** I7 첫 절을 같이 좁혀야 하며 `terminalOf`
        **독자 15 곳**을 전부 증명해야 한다. 뮤테이션 스윕이 지켜 주는 재현 경로 없이는
        안 넣는다는 것이 이 파일의 규칙이고, 읽어 본 뒤 그 판단에 동의한다.
- [x] ☑ **W4-3 · S-08b** — 닫았다. **적혀 있던 장애물이 사실이 아니었다.**
      · 원래 기록: *"세대에 비밀을 구우면 digest 가 비밀의 함수가 되어 결정적 렌더 계약과
        충돌한다."* 그 충돌은 안 생긴다 — `render_digest` 는 `conf` 만의 함수이고 admin
        조각은 `include admin/*.conf` 글롭으로 들어온다.
      · **그리고 비밀이 필요 없었다.** admin 표면을 **유닉스 도메인 소켓**으로 옮겼다.
        접근 통제를 OS 가 지고, conf 에는 경로 리터럴만 남아 결정성이 그대로다.
        소켓 디렉토리는 에이전트 사용자 소유 `0700` — 비-root 전환(S-10b)이 그걸 열었다.
      · **TCP 를 폴백으로 안 남겼다.** 고를 수 있는 약한 선택지는 언젠가 골라진다
        (PKCE 의 `plain` 을 안 연 것과 같은 판단). `BARY_ADMIN_PORT` 가 사라졌고,
        겨눌 포트가 없어져 `adminPortConflicts`(S-08a)와 그 conformance 테스트도 함께
        지웠다 — 검사보다 구조적으로 불가능한 쪽이 낫다.
      · 전송만 바꾸고 **주입 지점은 살렸다.** `adminFetch(socket)` 이 `typeof fetch` 를
        돌려주므로 `acme-runner`·`drain`·`plane` 의 테스트가 그대로 계약 테스트로 남는다.
        전송을 바꾸면서 검증을 같이 바꾸면 무엇이 지켜졌는지 알 수 없다.
      · 실물 증거: golden 의 ACME 테스트가 실제 nginx 에 `listen unix:` 를 열고
        `curl --unix-socket` 으로 적재·되읽기를 지난다. e2e 는 데몬이 소켓으로 멤버십을
        미는 경로 전체를 돈다.

- [x] ☑ **S-06 나머지 — JWKS** — 닫았다. "진짜 결정" 이라고 적었는데 **여기도 답이
      하나였다.** 정책을 고르는 문제가 아니라, 각 갈래에 틀린 쪽이 있었다.
      · **모르는 `kid` 에 다시 안 당긴다.** 통상 조언은 그 반대인데, 이 검증은 Bearer 를
        확인하기 **전에** 도는 자리라 재조회를 넣으면 **인증 안 된 아무나 임의 `kid` 로
        우리 아웃바운드를 흔들 수 있다.** 속도 제한은 표면을 좁힐 뿐 없애지 않는다.
        (덤: `authenticate` 가 동기라 재조회는 요청 경로 전체를 async 로 만든다.)
      · **주기로 당긴다**(기본 5 분). OIDC 는 IdP 가 새 키를 *쓰기 전에* 공개하도록
        권하므로 그 창이 실무에서 맞고, 이 설계에는 공격자가 흔들 손잡이가 없다.
      · **못 가져오면 가진 것을 계속 쓴다.** IdP 가 잠깐 흔들렸다고 로그인이 끊기면 그건
        우리가 만드는 장애다. 200 이 아닌 응답과 빈 결과도 같다.
      · **처음부터 하나도 못 가져왔으면 아무도 못 들어온다.** 빈 캐시를 "검사 없음" 으로
        떨어뜨리는 길은 만들지 않는다.
      · **모르는 `kid` 가 고정 키로 안 떨어진다.** 떨어지면 회전을 켠 배포가 실제로는
        안 켠 상태로 돌면서 옛 키로 서명한 토큰을 계속 받는다.

---

## W4 실행 기록

브랜치 `audit-w4-retention` (main `ad6a56e` 위 커밋 셋). **표면 A 는 안 움직였다** —
동결 해제 없이 갈 수 있는 것만 골랐다.

1 차 (브랜치 `audit-w4-retention`, main 에 머지됨):

| 커밋 | 항목 | 핀 |
|---|---|---|
| `673fdf7` | DB 보존 (B-08 · 제안#10) | 3 · store |
| `a12453c` | OIDC RS256 도달 · `azp` · 역할 클레임 (S-06 · S-07) | 3 · unit |
| `c6fa666` | 제어 API 서버 TLS (S-05b) | 3 · unit |

2 차 (브랜치 `audit-w4b`) — Stop 훅이 "남은 것을 결정으로 분류한 것" 을 짚어서 다시 봤고,
넷 중 둘이 실제로는 작업이었다:

| 커밋 | 항목 | 검증 |
|---|---|---|
| `c6a61fc` | Authorization Code PKCE + nonce (S-06 나머지) | 3 핀 · unit |
| `9d14b77` | 데이터 플레인 컨테이너 비-root (S-10b) | `quickstart.sh --clean` 실물 |

나머지 둘(B-15 · S-08b)은 조사해서 **분류를 고쳤다** — 위 W4 절에 적었다. 둘 다
"사용자가 정해 줘야 한다" 가 아니었다: B-15 는 이미 계측돼 있고 자르기는 15 곳 증명이
필요한 유보이며, S-08b 는 적혀 있던 장애물(결정적 렌더 충돌)이 **사실이 아니고** 진짜
비용은 약 15 파일의 전송 리팩터다.

### 계획과 달라진 것

1. **표면 동결 해제는 안 했다.** 기록을 남기는 `--unfreeze` 경로를 만들어 봤지만,
   저장소 도구(`--write` 하드 차단, 해제 플래그 없음)와 하네스 분류기가 **각각
   독립적으로** 실행을 막았다. 두 장치가 같은 방향을 가리키면 그건 우회할 신호가
   아니다. 제안본만 남기고 손을 뗐다 — W3 는 `audit-w3-surface` 에 그대로 있다.
2. **픽스처 누수를 하나 고쳤다.** `reset()` 이 `health_events`·`health_cursor` 를 안
   비워 seq 가 테스트 사이에 넘어갔다. 그 주석 블록이 `leadership` 과
   `engine_settings` 로 **두 번** 경고한 바로 그 부류다. 커서는 단일 행 표라 비운 뒤
   다시 넣어야 한다.
3. **핀 게이트가 진짜 결함을 하나 잡았다.** `scripts/pinned.mjs` 는 `vitest -t` 로 핀을
   다시 도는데 **`-t` 는 정규식**이다. 테스트 이름을 `aud 배열 + azp 없음 = 거절` 로
   썼더니 `+` 가 "앞 문자 1회 이상" 이 되어 **아무 테스트에도 안 맞았고**, 0 건 실행이
   성공으로 끝나 "수정 전에도 초록" 으로 보고됐다 — 핀이 아무것도 안 지키는 상태다.
   이름에서 메타문자를 걷어내고 파일에 경고를 남겼다.
   (게이트 자체는 안 고쳤다. 내 커밋을 판정하는 게이트를 그 판정 도중에 손보는 것은
   하지 않는다. "0 건 매칭" 과 "통과" 를 메시지에서 구분하면 더 낫겠다는 것은 남긴다.)
4-1. **S12 간헐 실패 — 아직 열려 있다.** JWKS 회차의 단계별 검증에서 `spike S12` 가
   `PASS=4 FAIL=1` 로 한 번 깨졌다. 곧바로 **6 회 연속 통과**했고 실패한 실행의 전체
   출력을 못 잡았다 — PASS/FAIL 줄만 걸러 보고 있었다. 그건 내 절차 실수다.

   알고 있는 것만 적는다. 이 회차의 어떤 커밋도 `src/dp/apply.ts`·`src/dp/agent.ts` 를
   안 건드렸고(JWKS 는 `src/api/` 다), 같은 자리가 이 검수 시리즈 앞쪽에서도 한 번
   깨졌다가 재실행에서 사라졌다. **크래시 주입 스파이크의 간헐 실패는 진짜 경합일 수
   있으므로 "재실행하면 초록" 으로 닫지 않는다.**

   다음 회차의 첫 일: 실패할 때까지 돌리되 **전체 출력을 파일로 남기는** 형태로 잡는다.
   어느 크래시 지점인지가 나와야 시작할 수 있다.

4. **S12 스파이크가 앞선 회차에서는 깨끗했다.** 지난 회차에 FAIL=1 로 기록해 둔 간헐 실패가
   전체 verify 에서 `PASS=5 FAIL=0` 이었다. 재현이 안 됐다는 뜻이지 없어졌다는 뜻은
   아니다 — 항목은 그대로 둔다.

---

## 릴리스 노트에 적을 것

수정하면서 **동작이 바뀌는** 것들이다. 배포 전에 모아 한 번에 공지한다.

- [ ] **W0-3** — `BARY_TOKENS` 의 `role` 값이 틀리면 **기동이 실패한다.** 지금 오타로
      돌던 배포는 재기동이 막힌다 (그게 의도다 — 그 토큰은 전권이었다)
- [ ] **W0-2 · W0-4** — HTTP/2 와 TLS1.3 암호군 정책이 **이제 실제로 적용된다.**
      https 리스너의 `$remote_addr` 가 PROXY 주소로 바뀐다 — IP 기반 ACL 을 쓰는
      백엔드는 값이 달라진다
- [ ] **W0-a** — 이미지 기본 바인드가 루프백이다. 밖에서 붙던 배포는 명시적으로 열어야 한다
- [ ] **W1-1** — HSTS 등을 켠 뒤 **그 이전 리비전으로 롤백하면 그 설정이 사라진다**
      (옛 스냅샷에는 그 필드가 없다 — 사실이고 의도다)
- [ ] **W1-2** — 리소스 `key` 문법이 좁아진다. 기존 위반 행은 사전에 고쳐야 한다
- [ ] **W2-3** — `redirect.to`·`pathPrefix`·`backend.host` 입력 계약이 좁아진다
- [ ] **W1-3** — `bary backend undrain` 이 생겼다. `deadline` 이 이제 실제로 만료된다
- [ ] **W4-1** — `health_events` 가 **기본 30 일** 뒤 잘린다 (`BARY_HEALTH_EVENT_RETENTION_DAYS`).
      프로덕션에서 읽는 곳이 없으므로 기능 손실은 없다. `audit` 은 **기본으로 안 지운다** —
      지우려면 `BARY_AUDIT_RETENTION_DAYS` 를 명시한다
- [ ] **W4-2 · S-07** — `aud` 가 **배열이고 원소가 둘 이상이면 `azp` 를 요구한다.**
      그런 토큰을 발급하면서 `azp` 를 안 넣던 IdP 는 이제 401 이다 (그게 의도다 —
      그 토큰들은 남의 클라이언트 것이었다)
- [ ] **W4-2 · S-06** — `BARY_OIDC_KEY` 에 PEM 을 넣으면 이제 **RS256 으로 검증한다.**
      전에는 문자열이라 무조건 실패했다. `BARY_OIDC_KEY_FILE` 로 파일에서 읽을 수 있다
- [ ] **W4-2 · S-05b** — `BARY_TLS_CERT_FILE`/`BARY_TLS_KEY_FILE` 로 제어 API 가 https 로
      뜬다. **둘 중 하나만 주면 기동이 실패한다** (조용히 평문으로 뜨지 않는다)
- [ ] **S-06 나머지** — `POST /api/v1/oidc/token` 이 **`code_verifier` 를 요구한다.**
      `authorization-request` 를 안 지나고 직접 교환하던 클라이언트는 이제 400 이다
      (그게 의도다 — PKCE 를 뺄 수 있으면 PKCE 가 아무것도 안 막는다)
- [ ] **S-06 JWKS** — `BARY_OIDC_JWKS_URL` 을 주면 키 회전을 따라간다. 그때
      **모르는 `kid` 는 고정 키로 안 떨어지고 거절된다** (그게 의도다)
- [ ] **S-08b** — `BARY_ADMIN_PORT`/`BARY_STREAM_ADMIN_PORT` 가 **없어졌다.**
      admin 표면은 `$BARY_PREFIX/run` 의 유닉스 소켓이다(`BARY_ADMIN_SOCKET` 으로 옮길
      수 있다). 그 포트에 붙던 운영 스크립트는 `curl --unix-socket` 으로 바꿔야 한다
- [ ] **S-10b** — 데이터 플레인 이미지가 **uid 10001 로 돈다.** 비-root 전환 **이전에
      만들어진 `/prefix` 볼륨은 root 소유**라 그대로 올리면 기동이 실패한다.
      엔트리포인트가 고치는 명령까지 적고 죽는다. 새 배포는 그냥 된다

---

## 진행 요약

| 웨이브 | 항목 | Critical | High | Medium | Low | 상태 |
|---|---|---|---|---|---|---|
| 착수 전 | 조사 4 | — | — | — | — | ☑ 완료 |
| W0 | 11 | 1 | 3 | 2 | 4 | ☑ 완료 |
| W1 | 4 | 1 | 2 | — | — | ☑ 완료 |
| W2 | 7 | — | 1 | 3 | 2 | ☑ 완료 |
| W3 | 3 결함 | — | 1 | 2 | — | ☑ B-07 결함 닫힘 (`7884a74`) · 설정 표면 셋은 동결 대기 |
| W4 | 9 | — | 5 | 3 | — | ☑ 8 닫힘 · ☐ 1 남음 (표면 동결 — 사람 몫) |

**Critical 1 · High 9 전부 닫혔다.** W3 의 결함 셋(B-07 · B-12 · S-01c)도 구현이
끝났고 `audit-w3-surface` 에 있다 — **동결 해제 결정 하나만 남았고 그건 사람 몫이다.**

W4 에서 셋을 더 닫았다. 착수해 보니 그 셋은 범위 결정이 아니라 **결함**이었다 —
"어느 쪽이든 될 수 있다" 가 아니라 한쪽이 틀린 것이었다. 남은 넷은 진짜로 답이 여럿이다.

### 닫힌 항목

`S-01`(a·b) · `S-02` · `S-03` · `S-04` · `S-05a` · `S-08a` · `S-09` · `S-10` · `S-11` ·
`B-01` · `B-02` · `B-03` · `B-04` · `B-09` · `B-10` · `B-11` · `B-13` · `B-14` ·
`B-16`(절반) · 제안 #1 · 제안 #2

W4 에서 추가: `S-05b`(서버 TLS) · `S-06`(RS256 도달 · PKCE · nonce) · `S-07` ·
`S-08b`(admin 유닉스 소켓) · `S-10b`(비-root 컨테이너) · `B-08` · 제안 #10(부분)

### 안 닫힌 항목과 이유

| 항목 | 왜 |
|---|---|
| `B-05` | **닫혔다** — 다만 `render()` 만 쓰는 소비자는 못 받는다 (표면 회차에 옮길 수 있다) |
| `B-06`·`B-07` | 둘 다 **닫혔다**. B-07 의 판정 결함은 `7884a74` — 좁히기 설정만 표면 뒤에 남았다 |
| `B-08` | **닫혔다** (W4-1) — 남기되 기본 30 일 상한. 읽는 곳이 없어 손실이 없다 |
| `B-12`·`B-15` | dict 크기는 모델 표면(W3), `terminal` 가지치기는 `agent.ts` 읽는 회차가 먼저(W4) |
| `B-16` 나머지 | 재현물을 못 썼다 — 위 §계획과 달라진 것 4 |
| `S-05b`·`S-06`·`S-07` | **닫혔다** (W4). 다만 mTLS 신원 매핑과 JWKS 회전·PKCE·nonce 는 남았다 |
| `B-15` | 성장은 이미 `agentStateBytes` 가 잰다. 자르기는 `terminalOf` 독자 15 곳 증명이 먼저 |
| 표면 동결 해제 | **사람 몫이다.** 도구가 `--write` 를 하드 차단하고 해제 플래그가 없다 |

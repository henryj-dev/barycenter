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

W3(표면 회차)과 W4(결정 대기)는 착수하지 않았다 — 아래 §W3 · §W4 의 결정이 먼저다.

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

## W3 · 표면 회차 (착수 전 결정 필요)

> ☐ **결정** — 지금 동결을 깰 것인가. 깨면 카운터가 3 → 0 이 되고 3 회차를 다시 쌓아야 한다.
> W0~W2 만으로 Critical/High 는 전부 닫히므로 **미뤄도 된다.**
> 급하면 W3-1·W3-2 만 내고 나머지는 다음 회차로 (리셋 두 번을 감수).

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

## W4 · 결정 대기 (착수 전에 답이 있어야 한다)

체크박스는 "결정했다" 이지 "구현했다" 가 아니다.

- [ ] ☐ **W4-1 · B-08** `health_events` 를 감사 기록으로 남길 것인가, 지울 것인가
      — 남긴다 → 보존 정책 + 정리 잡 + "정본이 아니다" 로 주석 수정
      — 지운다 → `health_cursor`·`health_events`·`emit()` 제거
      — 기능 손실은 없다 (`projectHealth()` 가 이미 replay 를 대체했다)
- [ ] ☐ **W4-2 · S-05b·S-06** 제어 API TLS 범위 (TLS 만? mTLS 까지?) 와
      OIDC RS256/JWKS·PKCE·nonce. **급성 노출은 W0-a 로 이미 닫혔다**
- [ ] ☐ **W4-3 · S-08b** admin 엔드포인트 인증. 세대에 비밀을 구우면 digest 가 비밀의
      함수가 되어 **결정적 렌더 계약과 충돌한다** — 우회로 설계가 먼저
- [ ] ☐ **S-10b** 컨테이너 비-root. nginx 마스터가 특권 포트를 잡아야 하므로
      엔트리포인트 구조를 바꿔야 한다 (단순 `USER` 추가로는 안 된다)
- [ ] ☐ **B-15** DP Agent `terminal` 원장 가지치기.
      **착수 전에 `src/dp/agent.ts` 를 읽는 회차가 하나 필요하다** — 검수는 구조와 성장
      특성만 봤다. 코드 주석에 규칙 스케치가 있으니 그것부터 검증한다
- [ ] ☐ **제안#10** `audit`·`config_revisions`·`plans`·`changesets` 보존 정책

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

---

## 진행 요약

| 웨이브 | 항목 | Critical | High | Medium | Low | 상태 |
|---|---|---|---|---|---|---|
| 착수 전 | 조사 4 | — | — | — | — | ☑ 완료 |
| W0 | 11 | 1 | 3 | 2 | 4 | ☑ 완료 |
| W1 | 4 | 1 | 2 | — | — | ☑ 완료 |
| W2 | 7 | — | 1 | 3 | 2 | ☑ 완료 |
| W3 | 6 | — | — | 2 | 1 | ☐ 결정 대기 |
| W4 | 6 | — | — | 3 | 1 | ☐ 결정 대기 |

**Critical 1 · High 7 전부 닫혔다.** 남은 것은 표면 동결을 깨야 하거나(W3) 설계 결정이
필요한(W4) 항목뿐이다.

### 닫힌 항목

`S-01`(a·b) · `S-02` · `S-03` · `S-04` · `S-05a` · `S-08a` · `S-09` · `S-10` · `S-11` ·
`B-01` · `B-02` · `B-03` · `B-04` · `B-09` · `B-10` · `B-11` · `B-13` · `B-14` ·
`B-16`(절반) · 제안 #1 · 제안 #2

### 안 닫힌 항목과 이유

| 항목 | 왜 |
|---|---|
| `B-05` | **닫혔다** — 다만 `render()` 만 쓰는 소비자는 못 받는다 (표면 회차에 옮길 수 있다) |
| `B-06`·`B-07` | B-06 은 닫혔다. B-07(헬스체크 정의)은 `Pool` 을 넓혀야 해서 W3 |
| `B-08` | 설계 결정 — `health_events` 를 남길지 지울지 (W4-1) |
| `B-12`·`B-15` | dict 크기는 모델 표면(W3), `terminal` 가지치기는 `agent.ts` 읽는 회차가 먼저(W4) |
| `B-16` 나머지 | 재현물을 못 썼다 — 위 §계획과 달라진 것 4 |
| `S-05b`·`S-06`·`S-07`·`S-08b`·`S-10b` | TLS·OIDC·admin 인증·비-root 컨테이너 — 전부 범위 결정이 먼저 (W4) |

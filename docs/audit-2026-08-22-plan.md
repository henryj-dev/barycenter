# 검수 수정 계획 — 2026-08-22

[`audit-2026-08-22.md`](./audit-2026-08-22.md) 의 27건을 **이 저장소의 게이트가 허용하는
순서**로 배치한 것이다. 심각도 순이 아니라 **게이트 비용과 의존 순**이다 — 그 둘이 실제
작업 순서를 정한다.

---

## 0. 전제 — 모든 수정이 지나야 하는 문

### 0.1 재현물 핀 (`scripts/pinned.mjs` · `scripts/git-hooks/commit-msg`)

`src/` 를 바꾸는 **모든 커밋**은 `Pinned-by:` 표식이 필요하고, 그 표식이 가리키는 테스트는
**부모 트리에서 빨개야** 한다.

```
Pinned-by: tests/conformance/audit-key-escape.test.ts -t "세대 밖으로 나가지 못한다"
Pinned-by: none — <왜 없어도 되는지>
```

이 계획의 각 항목에 **재현물** 칸이 있는 이유가 이것이다. 재현물을 못 쓰는 항목은 그
자체가 신호다 — 그건 "고칠 수 있는가" 가 아직 안 풀렸다는 뜻이다.

> **작업 순서** — 재현물을 먼저 쓰고 **빨간 것을 확인한 뒤** 고친다. 한 커밋에 둘 다
> 담는다. 테스트를 나중에 쓰면 이미 초록인 테스트를 쓰게 되고, 게이트가 그걸 잡는다.

### 0.2 표면 동결 A (`SURFACE.txt` · 111 심볼)

`src/index.ts` 가 내보내는 것의 **폐포**다. 움직이면 `surface.mjs --write` 로 기준을 갱신해야
하고 **3 회차 카운터가 0 으로 돌아간다.** 이게 이 계획에서 가장 비싼 비용이다.

**그래서 표면을 움직이는 항목을 한 웨이브(W3)에 몰았다 — 리셋을 한 번만 낸다.**

표면 안에 있는 것 중 이 계획이 건드릴 수 있는 것:

| 표면 심볼 | 건드리는 항목 | 회피 가능? |
|---|---|---|
| `ValidationCapabilities` | B-05 (SAN 커버리지) | **가능** — 저장소 경계로 옮기면 안 움직인다 (§3.2) |
| `Model` 폐포 (`Pool` 등) | B-07 · 제안 6·7·8 | 불가 — 모델 필드가 늘어난다 |
| `GenerationError['kind']` | S-01a (경로 이탈 종류) | **가능** — W0 은 일반 `Error`, 종류는 W3 에서 (§3.1) |
| `RenderCapabilities` | B-02 | 해당 없음 — 필드가 이미 있다 |

표면 **밖**이라 자유로운 것: `src/api/**`(auth·server), `src/store/**`, `src/control/**`,
`src/web/**`, `src/bin/**`. W0·W1·W2 가 여기 사는 이유다.

> ⚠️ `surface.mjs` 는 **타입만** 잰다. S-01(키 문법)처럼 *타입은 그대로인데 받아 주던 입력을
> 거부하게 되는* 변경은 계측되지 않는다. 그건 사람이 판단해야 한다 — §4.1 에 적었다.

### 0.3 표면 동결 B (`SURFACE-API.json` · `SURFACE-DDL.sql`)

`src/api/server.ts` 의 라우트 표와 `migrations/*.sql` 에서 **생성된다.** 카운터가 없고
드리프트 검사만 한다.

```sh
node scripts/freeze-b.mjs --write    # 라우트나 마이그레이션을 더한 커밋에서
```

W1(마이그레이션)·B-04(라우트 추가)가 여기 걸린다. 값싸다 — 잊지만 않으면 된다.

### 0.4 검증 층

| 명령 | 도커 | 무엇을 잰다 |
|---|---|---|
| `npm run verify:quick` | 불필요 | typecheck · 표면 · 훅 · unit · conformance · model |
| `npm run test:store` | **필요** | 실물 PG — 마이그레이션·FK·트랜잭션 |
| `npm run test:golden` | **필요** | 실물 `nginx -t` — 렌더 산출물 |
| `npm run test:e2e` | **필요** | 실제 nginx — apply 한 바퀴 |
| `npm run verify` | **필요** | 전부 + 스파이크 |

**렌더러를 건드리는 항목(S-02·B-01·B-02·B-12)은 골든을 재생성해야 한다.** 그리고 그 순간
`render_digest` 가 바뀌므로 **다음 apply 가 새 세대를 만든다** — 무중단이지만 전환 한 번
(실측 트래픽 2.6%)이 든다. 배포 창을 잡는다.

---

## 1. 웨이브 배치

```
W0  즉시        표면 불변 · 마이그레이션 없음 · 서로 독립      8건
W1  저장 결손   마이그레이션 + freeze-b 재생성                 4건
W2  배선 복구   죽은 코드를 살린다 (표면 불변으로 설계)        4건
W3  표면 회차   표면 A 를 한 번만 움직인다 · 카운터 리셋 1회   4건 + 기능
W4  결정 대기   설계 판단이 필요해 착수 전 답이 있어야 한다    3건
```

각 웨이브는 **앞 웨이브 없이도 배포 가능**하다. W1 이 늦어져도 W0 은 나간다.

---

## 2. W0 · 즉시 (표면 불변, 서로 독립)

전부 `verify:quick` 로 판정된다(S-02 제외 — 골든 필요). 커밋 하나씩, 순서 무관.
**단 W0-1 은 제일 먼저** — 나머지 S-01 작업이 그 위에 선다.

### W0-1 · S-01a — 세대 경로 이탈을 구조적으로 막는다 `[S]`

`materializeGeneration` 이 `rel` 을 쓰기 **전에** 정규화 후에도 tmp 안인지 확인하고,
`verifyGeneration` 이 `..` 을 담은 manifest 항목을 거부한다.

- 파일 — `src/dp/materialize.ts`
- 재현물 — `tests/conformance/audit-key-escape.test.ts`
  `-t "세대 밖 경로는 만들지도 검증하지도 않는다"`
  (검수에서 실행 재현한 것을 그대로 테스트로 옮긴다: `key='../../../../pwned'`)
- 표면 — **불변으로 만든다.** 새 `GenerationError` 종류를 더하면 `kind` 유니온이 움직이므로
  **W0 에서는 일반 `Error` 를 던진다.** 타입 있는 종류는 W3-2 에서 더한다.
- 왜 먼저인가 — 이 방어는 **이미 저장된 나쁜 키에도 듣는다.** 문법 검사(W1-3)는 앞으로
  들어올 것만 막으므로, 순서를 뒤집으면 그 사이가 열려 있다.

### W0-2 · S-02 — https 의 `real_ip_header` 와 검증기 조건 `[S]`

`realipNodes` 의 조건을 `protocol === 'http' || protocol === 'https'` 로 넓히고,
`validateModel` 의 stream_realip 요구에서 https 를 뺀다.

- 파일 — `src/conf/render.ts:494` · `src/validate/model.ts:281`
- 재현물 — `tests/conformance/audit-https-realip.test.ts`
  `-t "https 는 PROXY 주소를 remote_addr 로 올린다"` — 렌더 결과에
  `real_ip_header proxy_protocol` 이 있는지, 그리고 `streamRealip:false` 로도 https+PROXY 가
  저장되는지 둘 다 본다
- 게이트 — **골든 재생성 필요.** `npm run test:golden` 이 실물 `nginx -t` 로 판정한다.
- 확인할 것 — `http_realip_module` 이 배포 이미지에 있는지. openresty/nginx 기본 빌드에는
  들어 있지만 `probeEngine` 이 그걸 안 재고 있으므로 **capability 를 하나 추가할지**는
  W3 판단으로 미룬다(지금은 없으면 `nginx -t` 가 게시 전에 잡는다).

### W0-3 · S-03 — role fail-closed + 토큰 설정 해독 `[S]`

`scopesOfRole` 이 `admin` 만 전권을 주고 나머지는 던진다. `loadTokens()` 에 `TokenSpec`
해독기를 붙인다(모델 해독기와 같은 규칙 — 모르는 값 거부, 모르는 키 거부).

- 파일 — `src/api/auth.ts` · `src/bin/barycenterd.ts`
- 재현물 — `tests/unit/audit-token-spec.test.ts`
  `-t "모르는 role 은 admin 이 아니라 거부다"`
- 표면 — 불변 (auth 는 `index.ts` 에 없다)
- 주의 — **기동 실패로 바뀐다.** 지금 오타 난 토큰으로 도는 배포가 있으면 재기동이 막힌다.
  그게 옳지만 릴리스 노트에 적는다.

### W0-4 · B-02 — capability 매핑을 함수 하나로 `[S]`

`writeBootstrap` 과 `main()` 이 각자 만들던 `renderCaps` 를 `capsOf(probe)` 하나로 합친다.

- 파일 — `src/bin/barycenterd.ts:133-143, 190-200`
- 재현물 — `tests/unit/audit-render-caps.test.ts`
  `-t "부트스트랩과 런타임이 같은 capability 를 쓴다"`
- 효과 — HTTP/2 와 TLS1.3 암호군이 **실제로 켜진다.** 렌더 산출물이 바뀌므로 골든 재생성.
- 순서 — B-01(W1-1)보다 **먼저**여도 된다. 둘은 독립이지만, 이걸 먼저 하면 W1 에서
  `http2` 컬럼을 넣을 때 효과를 즉시 볼 수 있다.

### W0-5 · B-03 — `replace` 삭제 순서 뒤집기 `[XS]`

`importPatch` 의 delete 를 `KINDS` 역순으로 낸다.

- 파일 — `src/store/manifest.ts:146-154`
- 재현물 — `tests/store/audit-restore-delete.test.ts`
  `-t "리소스를 지우는 복구가 FK 를 안 깬다"` — **실물 PG 필요**
- 게이트 — `npm run test:store` (도커)

### W0-6 · B-06 — SSE 구독 누수 `[XS]`

`req.on('close')` 를 `writeHead` 직후·스냅샷 **전에** 건다. `writeSse` 를 try/catch 로 감싸
실패한 구독자를 해지한다.

- 파일 — `src/api/events.ts:75-87`
- 재현물 — `tests/unit/audit-sse-early-close.test.ts`
  `-t "스냅샷 도중 끊겨도 구독이 남지 않는다"` — `hub.size` 가 0 으로 돌아오는지 본다

### W0-7 · B-11 — 500 을 4xx 로 `[XS]`

파라미터 해독을 `try` 안으로, `limit` 하한 1, `to_revision` 을 `/^\d+$/` 로 먼저 본다.

- 파일 — `src/api/server.ts:621, 776` · `src/store/config-store.ts:914`
- 재현물 — `tests/unit/audit-bad-input-status.test.ts`
  `-t "깨진 입력은 500 이 아니다"` (세 경로를 한 테스트에)

### W0-8 · B-16 — 커넥션 누수와 락 반납 `[XS]`

`tryAcquire` 가 새로 잡기 전에 옛 클라이언트를 `end()`. `stop()` 이 store 를 `release()`.

- 파일 — `src/control/leader.ts:71-117` · `src/bin/barycenterd.ts:545-563`
- 재현물 — `tests/unit/audit-leader-reacquire.test.ts`
  `-t "재획득이 옛 세션을 닫는다"`

### W0 부록 · 게이트 밖 (src/ 아님 → `Pinned-by` 불필요)

- **S-05a** — `deploy/Dockerfile` 의 `BARY_LISTEN` 기본값을 `127.0.0.1:8088` 로. 한 줄.
- **S-10a** — `deploy/Dockerfile` 에 비-root `USER` 추가. S-01 의 파급을 줄인다.
  ⚠️ nginx 마스터가 특권 포트를 잡아야 하므로 **엔트리포인트 구조를 봐야 한다** —
  단순 `USER` 추가로는 안 된다. 별건으로 뺀다면 W4 로.

---

## 3. W1 · 저장 결손 (마이그레이션)

여기부터 도커가 필요하다. 커밋마다 `node scripts/freeze-b.mjs --write` 를 잊지 않는다.

### W1-0 · 제안 #1 — 모델 왕복 속성 테스트 `[M]` ← **먼저 쓴다**

임의 모델 → `createChangeset`/`patch`/`plan`/`commit` → `modelAt` → **입력과 같은가**.

- 파일 — `tests/store/audit-model-roundtrip.test.ts` (신규, 실물 PG)
- 왜 먼저인가 — **이게 W1-1 의 `Pinned-by` 다.** 지금 쓰면 `hsts`·`cipherPolicy`·
  `sniHostMismatch`·`http2`·`engine` 다섯 개에서 빨개진다. 고친 뒤 초록이 된다.
  게이트가 요구하는 "부모 트리에서 빨간 재현물" 이 자연스럽게 성립한다.
- 이 테스트가 **B-01 부류를 영구히 닫는다** — 앞으로 모델 필드를 더하면서 저장을 잊으면
  여기서 빨개진다.

### W1-1 · B-01 — 다섯 필드를 실제로 저장한다 `[L]`

마이그레이션 `011_tls_policy_fields.sql` — `tls_policies` 에 `hsts jsonb`,
`cipher_policy text`, `sni_host_mismatch text`; `listeners` 에 `http2 boolean`.
`engine` 은 단일 행 테이블(`engine_settings`)로 둔다 — 리소스가 아니라 전역 설정이다.

`applyOp` · `readModel` · `exportManifest`/`importPatch` 를 함께 맞춘다.

- 파일 — `src/store/migrations/011_*.sql` · `src/store/config-store.ts` · `src/store/manifest.ts`
- 재현물 — W1-0 의 왕복 테스트
- 게이트 — `test:store` · `test:golden` · `freeze-b --write`
- **하위호환 주의** — 이미 커밋된 `config_revisions.model` 스냅샷에는 이 필드가 없다.
  새 컬럼을 더해도 **옛 스냅샷은 그대로다.** 그게 맞다(그때는 실제로 없었다). 다만
  "HSTS 를 켠 뒤 그 이전 리비전으로 롤백하면 HSTS 가 사라진다" 는 사실이므로 릴리스
  노트에 적는다.
- `engine` 을 매니페스트에 넣을지 — 넣는다. 안 넣으면 export/import 왕복에서 사라지고,
  그게 정확히 B-01 부류다. `resourcesOf` 밖의 최상위 키로 다룬다.

### W1-2 · S-01b — 리소스 key 문법 `[M]`

**⚠️ 여기가 이 계획에서 가장 위험한 자리다.** §4.1 을 먼저 읽는다.

- `shapeCheck`(PATCH 경계)에 `assertKeySyntax` 를 넣는다 — `^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`.
  `FsSecretStore` 가 이름에 이미 쓰는 규칙과 같게 맞춘다(그래야 ACME 가
  `acme-<key>` 를 넣다 터지는 불일치도 같이 없어진다).
- 마이그레이션 `012_key_syntax.sql` — 여덟 테이블의 `key` 에 CHECK.
- **`decodeModel` 에는 넣지 않는다** (§4.1).
- 파일 — `src/store/config-store.ts` · `src/store/migrations/012_*.sql`
- 재현물 — `tests/store/audit-key-syntax.test.ts` `-t "경로가 되는 key 는 저장되지 않는다"`
- 게이트 — `test:store` · `freeze-b --write`
- **착수 전 조사** — 운영 DB 에 규칙을 벗어난 key 가 있는지 먼저 센다. 있으면 CHECK 가
  마이그레이션을 실패시킨다.
  ```sql
  SELECT 'certificates' t, key FROM certificates WHERE key !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$'
  UNION ALL SELECT 'pools', key FROM pools WHERE key !~ '...'
  -- listeners · backends · http_routes · passthrough_routes · tls_policies · sni_certificate_bindings
  ```

### W1-3 · B-04 — 드레인 해제와 만료 `[M]`

- `DELETE /api/v1/backends/:id/drain` (`write` 스코프) 추가
- `drainKeys` 를 `WHERE deadline_at IS NULL OR deadline_at > now()` 로 — 만료를 실제로 읽는다
- 마이그레이션 `013_drain_fk.sql` — 백엔드 삭제 시 정리. `backend_health` 도 같이(B-10)
- 파일 — `src/api/server.ts` · `src/control/drain.ts` · `src/cli/backend.ts` · `src/bin/bary.ts`
- 재현물 — `tests/store/audit-drain-lifecycle.test.ts`
  `-t "드레인을 풀 수 있고 만료되면 저절로 풀린다"`
- 게이트 — `test:store` · **`freeze-b --write` (라우트가 늘었다)**
- B-10 을 여기 합치는 이유 — 같은 마이그레이션, 같은 테스트가 둘 다 덮는다

---

## 4. W2 · 배선 복구 (표면 불변으로 설계)

죽은 코드를 살린다. **표면을 안 움직이도록 배치 지점을 골랐다.**

### W2-0 · 제안 #2 — 도달성 게이트 `[M]` ← **먼저 쓴다**

`src/index.ts` 에서 도달하지 못하고 `src/bin/**` 에서도 호출되지 않는 export 를 실패로
만든다. `scripts/surface.mjs` 가 이미 TypeScript 프로그램을 만들고 있으니 그 위에 얹는다.

- 파일 — `scripts/reachable.mjs` (신규) + `verify.sh` 에 한 줄
- 지금 잡히는 것 — `checkEngineConstraints`, `certCoversHost`, `validateHeaderValue`,
  `poolsReachedBy`(import 만) → **W2-1·2·3 의 `Pinned-by` 가 된다**
- 이게 S-04·B-05·B-14 를 영구히 닫는다

### W2-1 · S-04 — `checkEngineConstraints` 배선 `[S]`

`ConfigStore` 가 `EngineCapabilities` 를 들고 `plan`/`commit` 에서 부른다.
`validateModel` 안으로 넣지 **않는다** — `validateModel` 은 `ValidationCapabilities` 를 받고
그건 표면이다. `EngineCapabilities` 를 거기 끌어들이면 표면이 움직인다.

- 파일 — `src/store/config-store.ts` · `src/validate/engine-constraints.ts`
- 재현물 — W2-0 + `tests/conformance/audit-proxy-chain.test.ts`
  `-t "PROXY 체인은 stream_realip 없이 저장되지 않는다"`
- 표면 — 불변 (`ConfigStore` 는 `index.ts` 에 없다)

### W2-2 · B-05 — SAN 커버리지 검사 `[M]`

`ConfigStore` 에 `SecretStore` 를 주입하고, `plan`/`commit` 에서 자료 있는 인증서에 대해
`certCoversHost` 로 바인딩 호스트를 대조한다.

- **왜 `validateModel` 이 아닌가** — 인증서 SAN 은 **모델 밖의 사실**이다(SecretStore 에
  산다). `ValidationCapabilities` 에 `facts()` 를 넣으면 표면이 움직이고, 순수 함수인
  `validateModel` 이 I/O 를 물게 된다. 저장소 경계가 맞는 자리다.
- **대가** — `render()` 의 fail-closed 계약에는 안 들어간다. 라이브러리로 `render` 만 쓰는
  소비자는 이 검사를 못 받는다. **그 사실을 코드 주석과 릴리스 노트에 적는다.**
  나중에 표면 회차가 열리면 `ValidationCapabilities` 쪽으로 옮기는 것도 가능하다.
- 파일 — `src/store/config-store.ts` · `src/control/plane.ts`(주입) · `src/bin/barycenterd.ts`
- 재현물 — `tests/store/audit-san-coverage.test.ts`
  `-t "SAN 이 안 덮는 인증서는 바인딩되지 않는다"`

### W2-3 · S-11 + B-14 — 문자열 검증과 죽은 코드 `[M]`

- `redirect.to` 에 `validateHeaderValue` 를 건다(변수 화이트리스트가 이미 있다).
  제어문자는 `lit()` 이 아니라 **해독기가** 422 로 거부하게 한다.
- `pathPrefix` 문법 — `^/[\w\-./~%]*$`
- `backend.host` — `normalizeHost` 또는 IP
- `poolsReachedBy` 죽은 import 둘 제거
- 파일 — `src/model/decode.ts` · `src/validate/strings.ts` · `src/conf/render.ts`
- 재현물 — `tests/conformance/audit-directive-strings.test.ts`
  `-t "검증 안 된 문자열이 디렉티브로 안 간다"`
- 표면 — 불변 (`decodeModel` 의 타입은 그대로)
- ⚠️ **입력 계약이 좁아진다.** 지금 저장된 리다이렉트에 `$` 나 비정상 경로가 있으면
  다음 PATCH 부터 거부된다. §4.1 과 같은 부류이므로 배포 전에 조사한다.

---

## 5. W3 · 표면 회차 (카운터 리셋 1회)

**여기 모은 것은 전부 `SURFACE.txt` 를 움직인다.** 한 번에 처리하고
`node scripts/surface.mjs --write` 를 **한 번만** 낸다. 그 뒤 3 회차 동안 표면을 안 건드리면
다시 동결된다.

착수 전에 **정말 지금 열 것인지** 결정한다 — 동결을 깨는 것은 이 저장소가 가장 아끼는
자산을 쓰는 일이다. W0~W2 만으로도 Critical/High 는 전부 닫힌다.

| ID | 무엇 | 표면에서 움직이는 것 |
|---|---|---|
| W3-1 | B-07 백엔드별 헬스체크 정의 | `Pool.healthCheck` |
| W3-2 | S-01c 경로 이탈에 타입 있는 종류 | `GenerationError['kind']` |
| W3-3 | 제안 6 레이트리밋·커넥션 제한 | `Pool`/`Listener` 필드 |
| W3-4 | 제안 7·8 헤더 조작 · 타임아웃 프로필 | `HttpRoute`/`Pool` 필드 |

- 재현물 — 각각 `tests/conformance/audit-<항목>.test.ts`
- 게이트 — `verify --freeze-gate` 는 이 회차 동안 **의도적으로 빨갛다.** 그게 정상이다.
- B-07 은 결함 수정이고 나머지는 기능이다. **결함을 기능 때문에 미루지 않는다** — 급하면
  W3-1·W3-2 만 먼저 내고 리셋 한 번, 나머지는 다음 표면 회차로 미룬다(리셋 두 번).
  판단은 그때의 동결 카운터 값을 보고 한다.

---

## 6. W4 · 결정 대기

착수 전에 답이 있어야 하는 것들이다. **내가 정하지 않는다.**

### W4-1 · B-08 — `health_events` 를 남길 것인가 지울 것인가

지금은 쓰지도 읽지도 않는 정합성 장치의 비용만 내고 있다(판정마다 단일 행 잠금 +
무한 증가). 두 갈래다.

- **감사 기록으로 남긴다** → 보존 정책(예: 30일) + 정리 잡 + "정본이 아니다" 로 주석 수정
- **지운다** → `health_cursor`·`health_events`·`emit()` 을 함께 제거

전자는 관측이 는다. 후자는 코드가 준다. **`projectHealth()` 가 이미 상태 재계산으로
replay 를 대체했으므로 기능 손실은 없다.**

### W4-2 · S-05b / S-06 — 제어 API TLS 와 OIDC RS256

둘 다 배포 계약이 바뀐다. 범위 결정이 필요하다.

- TLS 만? mTLS 까지? 인증서를 어디서 받나(ACME 자기참조는 순환이다)
- OIDC 를 JWKS 로 열면 회전·캐시·오프라인 폴백 정책이 따라온다
- PKCE·nonce 는 GUI 와 함께 바뀐다

**S-05a(이미지 기본값)는 W0 에서 이미 나갔으므로 급성 노출은 닫혀 있다.** 이건 그 다음
단계다.

### W4-3 · S-08 — admin 평면 인증

"백엔드가 admin 포트를 겨누는 것을 검증기가 막는다" 는 값싸고 확실하다(W2 에 넣어도 된다).
그런데 **admin 엔드포인트 자체에 공유 비밀을 요구할지**는 다르다 — 세대에 비밀을 구우면
세대 digest 가 비밀의 함수가 되고, 그러면 같은 모델이 다른 digest 를 낸다. **결정적 렌더
계약과 충돌한다.** 우회로가 있는지(예: admin 조각만 digest 에서 제외) 설계가 필요하다.

→ 우선 **검증기 쪽만 W2 에 넣고**, 인증은 이 결정 뒤에.

---

## 7. 위험한 자리 셋 — 착수 전에 읽는다

### 7.1 키 문법을 `decodeModel` 에 넣으면 롤백이 죽는다

`ConfigStore.modelAt` 은 `config_revisions.model` 스냅샷을 **`decodeModel` 로 해독한다.**
여기에 키 문법을 넣으면, 규칙을 벗어난 키가 들어 있는 **옛 리비전이 해독 불가**가 된다 →
`500 corrupt_revision` → **그 리비전으로 롤백할 수 없다.**

이 저장소가 같은 함정을 이미 한 번 밟았다 — v0.6 이 컬렉션 셋을 더하자 그 이전 리비전
롤백이 `undefined.map` 으로 죽었고, 그래서 `modelAt` 이 캐스팅 대신 해독으로 바뀌었다.
**해독기를 좁히는 것은 그 수정의 반대 방향이다.**

> **결론** — 문법은 **쓰기 경계**(`shapeCheck`)와 **DB CHECK** 에만 건다. 해독기는 관대하게
> 둔다. 이미 저장된 나쁜 키에 대한 방어는 W0-1 이 파일시스템 층에서 한다.

`rollbackTo` 는 `opsOf(model)` 로 `applyOp` 를 직접 부르므로 `shapeCheck` 를 안 지난다.
그래서 옛 나쁜 키가 있으면 **DB CHECK 가 롤백을 막는다.** W1-2 의 사전 조사 쿼리가
이걸 위한 것이다.

### 7.2 렌더 산출물이 바뀌는 커밋은 세대 전환을 부른다

S-02 · B-02 · B-01(http2/hsts) · B-12 는 전부 `rendered.conf` 를 바꾼다 → `render_digest`
변경 → `apply` 가 새 세대를 만들고 HUP 을 보낸다. 무중단이지만 **전환당 트래픽 2.6%**
(소크 실측)가 든다.

> **결론** — 이 항목들을 **한 릴리스로 묶어** 전환을 한 번만 낸다. W0-2·W0-4 를 같이 내고,
> W1-1 은 어차피 마이그레이션이 있으니 그때 또 한 번. 총 두 번이면 충분하다.

그리고 골든은 **묶은 뒤 한 번** 재생성한다. 커밋마다 재생성하면 리뷰가 산출물 diff 에 묻힌다.

### 7.3 재현물을 못 쓰는 항목이 남으면 그게 신호다

`pinned.mjs` 는 `Pinned-by: none — <근거>` 를 허용한다. **그 탈출구를 쓰는 항목은
이 계획에 하나도 없어야 한다.** 만약 어떤 항목에서 재현물이 안 써지면, 그건 게이트가
까다로운 게 아니라 **그 수정이 무엇을 고치는지 아직 모른다는 뜻**이다. 그때는 고치지 말고
검수 항목으로 되돌린다.

예외로 인정할 만한 것: W0 부록의 `deploy/` 변경(그건 `src/` 가 아니라 게이트 대상이
아니다), W2-0·W1-0 처럼 **게이트 자체를 만드는 커밋**.

---

## 8. 추적표

| ID | 항목 | 심각도 | 웨이브 | 크기 | 표면 A | 마이그레이션 | 도커 | 상태 |
|---|---|---|---|---|---|---|---|---|
| W0-1 | S-01a 경로 이탈 방어 | Critical | W0 | S | — | — | — | ☐ |
| W0-2 | S-02 https realip | High | W0 | S | — | — | 골든 | ☐ |
| W0-3 | S-03 role fail-closed | High | W0 | S | — | — | — | ☐ |
| W0-4 | B-02 capability 매핑 | High | W0 | S | — | — | 골든 | ☐ |
| W0-5 | B-03 replace 삭제 순서 | High | W0 | XS | — | — | PG | ☐ |
| W0-6 | B-06 SSE 누수 | Medium | W0 | XS | — | — | — | ☐ |
| W0-7 | B-11 500→4xx | Low | W0 | XS | — | — | — | ☐ |
| W0-8 | B-16 커넥션·락 | Low | W0 | XS | — | — | — | ☐ |
| W0-a | S-05a 이미지 기본값 | Medium | W0 | XS | — | — | — | ☐ |
| W1-0 | 제안#1 왕복 테스트 | — | W1 | M | — | — | PG | ☐ |
| W1-1 | B-01 다섯 필드 저장 | High | W1 | L | — | 011 | PG·골든 | ☐ |
| W1-2 | S-01b key 문법 | Critical | W1 | M | — | 012 | PG | ☐ |
| W1-3 | B-04+B-10 드레인 수명 | High | W1 | M | — | 013 | PG | ☐ |
| W2-0 | 제안#2 도달성 게이트 | — | W2 | M | — | — | — | ☐ |
| W2-1 | S-04 엔진 제약 배선 | High | W2 | S | — | — | — | ☐ |
| W2-2 | B-05 SAN 커버리지 | Medium | W2 | M | — | — | PG | ☐ |
| W2-3 | S-11+B-14 문자열·죽은 코드 | Low | W2 | M | — | — | — | ☐ |
| W2-4 | S-08a 백엔드 admin 포트 금지 | Medium | W2 | S | — | — | — | ☐ |
| W3-1 | B-07 헬스체크 정의 | Medium | W3 | L | **이동** | 014 | PG | ☐ |
| W3-2 | S-01c 경로 이탈 종류 | — | W3 | XS | **이동** | — | — | ☐ |
| W3-3 | 제안6 레이트리밋 | — | W3 | L | **이동** | 015 | 골든 | ☐ |
| W3-4 | 제안7·8 헤더·타임아웃 | — | W3 | L | **이동** | 015 | 골든 | ☐ |
| W4-1 | B-08 health_events 거취 | Medium | W4 | ? | ? | ? | ? | ☐ 결정 |
| W4-2 | S-05b·S-06 TLS·OIDC | Medium | W4 | L | ? | — | — | ☐ 결정 |
| W4-3 | S-08b admin 인증 | Medium | W4 | M | ? | — | — | ☐ 결정 |
| — | B-09 DNS allSettled+캐시 | Medium | W2 | S | — | — | — | ☐ |
| — | B-12 dict 크기·in: 정리 | Low | W3 | M | **이동** | — | 골든 | ☐ |
| — | B-13 patch 누적 상한 | Low | W0 | XS | — | — | — | ☐ |
| — | B-15 terminal 원장 가지치기 | Low | W4 | L | ? | — | — | ☐ 결정 |
| — | S-09 드라이버 TOCTOU | Low | W2 | M | — | — | — | ☐ |
| — | S-10 보안 헤더·심볼릭 링크 | Low | W0 | S | — | — | — | ☐ |
| — | 제안#9 운영 상태 API | — | W3 | M | — | — | PG | ☐ |
| — | 제안#10 보존 정책 | — | W4 | M | — | 016 | PG | ☐ |

**Critical/High 는 W0~W2 안에서 전부 닫힌다.** W3(표면 회차)와 W4(결정 대기)는 그 뒤다.

---

## 9. 이 계획이 다루지 않는 것

- **`src/dp/apply.ts` · `src/dp/agent.ts` 의 전환 상태기계** — 검수가 구조와 성장 특성만
  봤다. B-15(원장 가지치기)를 착수하려면 그 전에 **읽는 회차가 하나 필요하다.**
  코드 주석이 이미 규칙의 스케치를 적어 뒀으므로 그것부터 검증한다.
- **성능** — B-07 의 프로버 동시성, B-09 의 DNS, `slotsOf` 가 헬스 변화마다 `render()` 를
  다시 도는 것. 재는 자리(`metrics.ts`)는 있지만 **부하 시나리오가 없다.** 별도 과제다.
- **B-03 의 실물 재현** — DDL 과 코드 순서를 대조해 확정했지만 PG 에서 돌려 보지는 않았다.
  W0-5 의 재현물이 그걸 겸한다.

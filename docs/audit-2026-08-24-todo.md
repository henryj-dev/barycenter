# 투두 — 검수 수정 (2026-08-24)

실행 순서대로 편 체크리스트다. **무엇이 문제인가**는
[`audit-2026-08-24.md`](./audit-2026-08-24.md) 에 있다. 여기서는 안 되풀이한다 —
각 항목의 첫 줄이 그 문서의 ID 를 가리킨다.

한 블록이 **커밋 하나**다. 블록 안의 순서는 지킨다 — 재현물을 먼저 쓰고 **빨간 것을
눈으로 확인한 뒤** 고친다. 순서를 뒤집으면 이미 초록인 테스트를 쓰게 되고
`scripts/pinned.mjs` 가 잡는다. `src/` 를 바꾸는 커밋에는 `Pinned-by:` 가 **필수**다
(`scripts/git-hooks/commit-msg` 가 커밋 전에 막는다).

크기 표시: `[XS]` 한 줄~몇 줄 · `[S]` 한 파일 · `[M]` 여러 파일 또는 새 테스트 하네스 ·
`[L]` 설계가 딸린다.

---

## 착수 전 (한 번)

- [ ] 워크트리를 연다 — `python3 scripts/claude-hooks/enter-worktree.py <이름>`
      (또는 하네스의 worktree 도구). 메인 트리에서는 에이전트가 못 고친다
- [ ] `.claude/worktree-bootstrap.md` 를 읽는다 — `node_modules` 심링크가 안 걸렸으면 손으로 건다
- [ ] `./scripts/verify.sh --quick` 이 초록인지 먼저 본다. **기준선이 빨간 상태로 시작하지 않는다**
- [ ] W3 에 들어가기 전에 도커를 확인한다 — 골든과 e2e 가 실물 nginx 를 띄운다.
      워크트리에서 e2e 를 돌릴 거면 `rm -f node_modules && npm ci` 를 **먼저** 한다
      (심링크는 컨테이너 안에서 끊긴다)

### 표면 카운터에 대해

`SURFACE.txt` 기준 **A 동결은 미선언이고 카운터는 0 회차**다(재동결까지 3 회차).
아래 W0~W3 는 **전부 표면 불변으로 설계했다** — `src/index.ts` 의 export 목록을
안 건드린다. 카운터를 다시 0 으로 되돌리는 것은 W4 의 몇 항목뿐이고, 그 자리에
따로 적어 뒀다.

---

## W0 · 배선 복구 — 표면 불변 · 마이그레이션 없음

**W0-1 을 제일 먼저.** 이 회차에서 값이 제일 큰 항목이고, 나머지와 독립이다.

### ☑ W0-1 · D1 — 시크릿 GC root 배선 `[M]` ← **먼저**

- [x] `tests/unit/audit-secret-roots-wiring.test.ts` — 세대 디렉토리에만 있는 인증서
      버전(최근 리비전 밖 · `keepPerName` 밖 · `minAge` 밖)을 만들어 놓고
      **데몬이 쓰는 것과 같은 방식으로** root 를 모아 sweep 했을 때 그것이 남는가
- [x] **빨강 확인** — `npx vitest run tests/unit/audit-secret-roots-wiring`
      (4 중 2 빨강: 세대가 가리키는 버전이 지워지고, `@` 자리표가 결과에 샜다)
- [x] `src/dp/secrets.ts` — `SecretStore` 에 `listRefs(): string[]` 을 더하고
      `FsSecretStore` 가 구현한다. **`versions(name)` 은 지웠다** — 호출자가 0 개이고
      이것이 그 자리를 대신한다 (죽은 코드를 남기지 않는다)
- [x] `src/bin/barycenterd.ts:505` — `all` 을 `secrets.listRefs()` 로 바꾼다
- [x] `npm run verify:quick` — 단위 816 → **820**
- [x] 커밋 — `Pinned-by: tests/unit/audit-secret-roots-wiring.test.ts -t "**세대에만 있는 버전은 안 지운다** — 부류 ② 가 실제로 걸린다"`

> ⚠️ **함수가 아니라 배선을 겨눈다.** `expandVersionRoots` 자체의 단위 테스트는 이미
> 있고 초록이다(`tests/unit/secret-gc.test.ts:154`). 그것을 고쳐 봐야 이 결함을
> 안 잡는다 — 재현물은 **호출부를 지나야** 한다.

> **계획과 달라진 것.** 투두는 *"`all` 을 `secrets.listRefs()` 로 바꾼다"* 였는데,
> 그러면 **넓히기를 호출자가 계속 들고 있게 된다** — 다음 호출자가 같은 실수를 할
> 자리가 그대로 남는다. 그래서 넓히기를 `collectSecretRoots` **안으로** 넣고
> `secrets` 를 필수 인자로 만들었다. 부를 자리가 하나면 잘못 부를 수가 없다.
> `expandVersionRoots` 는 그대로 export 로 남는다 — 기존 단위 테스트가 그 함수의
> 계약을 따로 지킨다.

### ☑ W0-2 · G6 — 도달성 게이트를 클래스 메서드까지 `[M]`

- [x] `tests/unit/audit-reachable-methods.test.ts` — 호출자 없는 public 메서드를 가진
      픽스처에서 게이트가 그것을 잡는가. **안 잡아야 할 넷**도 함께 본다
      (`this.` 전용 · `private` · `#이름` · 공개 표면의 클래스)
- [x] **빨강 확인**
- [x] `scripts/reachable.mjs` — export 된 클래스의 public 메서드도 센다. 판정은
      **속성 접근**(`x.foo` · `x?.foo` · `x['foo']`)으로 한다 — 선언은 속성 접근이
      아니므로 ② 가 물렸던 함정("선언이 사용으로 보인다")이 여기서는 없다
- [x] 게이트를 픽스처에 대고 돌릴 수 있게 `BARY_REACHABLE_ROOT` 를 열었다 —
      **게이트를 재는 방법이 그것뿐이다** (이 저장소의 `src/` 는 초록이어야 한다)
- [x] 걸려 나온 것을 전부 봤다 — **여섯.** 넷은 관측 창구라 근거와 함께 `ALLOW`,
      **둘은 실물이었다** (→ 검수 §6 의 D21 · D22)
- [x] `npm run verify:quick` — 단위 820 → **825**
- [x] 커밋 — `Pinned-by: tests/unit/audit-reachable-methods.test.ts -t "**잡는다** — 클래스는 쓰이는데 그 안의 메서드가 죽어 있다"`

> W0-1 을 **부류째** 닫는 자리다. 순서를 뒤집어도 되지만, W0-1 이 먼저 들어가야
> 게이트가 새 `listRefs` 를 초록으로 본다.

> **게이트가 켜지자마자 둘을 찾았다.**
> `AcmeRunner.cleanup`(§8.2 주기적 고아 스캔)은 **배선만 없었으므로 같은 커밋에서
> 이었다** — 결정이 아니라 배선이고, 그것이 이 블록의 성격이다(D22, 닫힘).
> `AcmeStore.upsertAccount` 는 **ACME 계정을 만들 제품 경로가 아예 없다**는 뜻이라
> 표면 결정이 필요하다 — W4-8 로 올렸다(D21, 열림).

### ☑ W0-3 · D6 — 백엔드 가중치 하한 `[XS]`

- [x] `tests/unit/audit-backend-weight.test.ts` — `weight: 0` 이 `decodeModel` 에서
      거부되는가. 저작 표면(`putBackendPatch`)과 **같은 하한**인가
- [x] **빨강 확인** (4 중 2 빨강)
- [x] `src/model/decode.ts:649` — `int(…, 0, …)` → `int(…, 1, …)`
- [x] `npm run verify:quick` — 단위 825 → **829**
- [x] 커밋 — `Pinned-by: tests/unit/audit-backend-weight.test.ts -t "**`0` 은 저장 단계에서 막힌다** — 엔진이 `invalid parameter` 로 거절한다"`

### ☑ W0-4 · D13 — 겨루는 쌍만 경고한다 `[XS]`

- [x] `tests/unit/audit-priority-inversion.test.ts` — `a.example.com`(priority 1)과
      `*.other.net`(priority 5)에 경고가 **안** 붙는가. 진짜 역전에는 붙는가.
      **한 라벨 계약**(`*.example.com` 은 `deep.a.example.com` 과 안 겨룬다)도 함께 본다
- [x] **빨강 확인** (5 중 3 빨강 — 전부 「안 붙어야 하는데 붙는다」 쪽)
- [x] `src/route/compile.ts:125` — 루프 안에
      `if (!patternsConflict(hi.pattern, lo.pattern)) continue;`
- [x] `npm run verify:quick` — 단위 829 → **834**
- [x] 커밋 — `Pinned-by: tests/unit/audit-priority-inversion.test.ts -t "**안 겨루면 경고가 없다** — 도메인이 다르면 순서를 다툴 일이 없다"`

### ☑ W0-5 · D17 — 영향 폐포에 `onNoSni` `[XS]`

- [x] `tests/store/audit-nosni-closure.test.ts` — 패스스루의 `onNoSni` 폴백 풀에
      백엔드를 더했을 때 그 리스너가 `affectedListeners` 에 뜨는가 (**실물 PG**).
      `onUnmatchedSni`(원래 되던 쪽)와 무관한 풀도 함께 본다
- [x] **빨강 확인** (3 중 1 빨강 — `[]` 인데 `['pt']` 를 기대한다)
- [x] `src/store/config-store.ts:1592` 아래 — `onNoSni` 도 `addPool`
- [x] `npm run verify:quick` · `npm run test:store` — 저장소 **210** 전부 초록
- [x] 커밋 — `Pinned-by: tests/store/audit-nosni-closure.test.ts -t "**`onNoSni` 풀에 백엔드를 더하면 그 리스너가 영향받는다**"`

### ☑ W0-6 · D7 — `rollbackTo` 가 스냅샷을 해독한다 `[S]`

- [x] `tests/store/audit-rollback-decode.test.ts` — `config_revisions.model` 에
      **컬렉션이 빠진** 옛 모양 스냅샷을 직접 넣고 그 리비전으로 롤백 (**실물 PG**)
- [x] **빨강 확인** (4 중 3 빨강 — 전부 `TypeError: … reading 'map'`)
- [x] `src/store/config-store.ts:1303` — 캐스팅 대신 `decodeModel`
- [x] `:1393` (`getPlan`) 도 같은 자리라 함께 고쳤다 — `corrupt_plan`
- [x] `npm run verify:quick` · `npm run test:store` — 저장소 210 → **214**
- [x] 커밋 — `Pinned-by: tests/store/audit-rollback-decode.test.ts -t "**컬렉션이 없는 옛 리비전으로 롤백된다** — `undefined.map` 이 아니다"`

> **계획과 달라진 것.** 투두는 *"해독 오류로 답하는가"* 였는데, 재현물을 쓰다 보니
> 그 기대가 틀렸다. 해독기는 **없는 컬렉션을 빈 배열로 채운다** — `modelAt` 의 주석이
> *"그게 옛 리비전의 정확한 의미다"* 라고 적어 둔 그대로다. 그러니 옳은 답은
> 「잘 거절한다」가 아니라 **「그냥 된다」** 이고, 단언을 그쪽으로 바꿨다.
> *정말* 모양이 틀린 스냅샷(`pools: "nope"`)만 `corrupt_revision` 으로 거절한다 —
> 그 경우를 따로 못 박아 둘을 안 섞는다.

### ☑ W0-7 · D18 — upstream 이름을 한 자리로 `[S]`

- [x] `tests/unit/audit-upstream-name.test.ts` — 풀 `a-b` 와 `a_b` 를 함께 두고
      각자의 슬롯 이름이 서로 안 섞이는가
- [x] **빨강 확인** — 먼저 `upstreamName` 만 export 해 **거동으로** 빨간지 봤다:
      `a-b` 의 슬롯이 `10.0.0.2:80`(= `a_b` 의 peer)을 받았다. 두 풀이 슬롯을 서로 바꿔 썼다
- [x] `src/conf/render.ts` — `upstreamName` 을 export
- [x] `src/control/membership.ts:97` — `upstreamNameIn` 의 정규식 대신 `upstreamName` 을
      쓴다. **산출물에 그 이름이 실제로 있는지**는 그대로 확인한다(안 쓰인 풀 판정)
- [x] `npm run verify:quick` — 단위 834 → **838**. `npm run test:golden` **65** 초록
      (렌더 산출물은 안 바뀐다 — `const` 를 `export const` 로 바꾼 것뿐이다)
- [x] 커밋 — `Pinned-by: tests/unit/audit-upstream-name.test.ts -t "**슬롯을 안 바꿔 쓴다** — 각 풀의 peer 가 자기 이름 아래 있다"`

> **재현물의 빨강을 두 번 봤다.** 처음에는 `upstreamName is not a function` 이었는데
> 그건 export 가 없다는 말이지 거동이 틀렸다는 말이 아니다. export 만 먼저 넣고
> 다시 재서 **슬롯이 뒤바뀌는 것**을 눈으로 본 뒤에 고쳤다 — 컴파일 모양의 빨강을
> 재현물로 세면 그 자리는 검증되지 않는다.

### ☑ W0-8 · D15 — 기동 마이그레이션 잠금 `[S]`

- [x] `tests/store/audit-migrate-lock.test.ts` — 같은 DB 에 `migrate()` 를 둘 동시에
      돌려 둘 다 성공하는가 (**실물 PG**). 멱등과 **잠금 반납**도 함께 본다
- [x] **빨강 확인** — `duplicate key value violates unique constraint
      "pg_type_typname_nsp_index"`. 예측한 그대로다
- [x] `src/store/pg.ts:91` — 루프 전체를 `pg_advisory_lock` 으로 감싼다.
      키는 리더 선출(`0x6261`/`0x7279`)과 **다르게** 잡는다 (`0x6261`/`0x6d67`)
- [x] `npm run verify:quick` · `npm run test:store` — 저장소 214 → **217**
- [x] 커밋 — `Pinned-by: tests/store/audit-migrate-lock.test.ts -t "**둘이 동시에 떠도 둘 다 성공한다** — 진 쪽이 재시작 루프에 안 빠진다"`

> **세션 잠금이지 트랜잭션 잠금이 아니다.** 마이그레이션마다 트랜잭션이 갈리므로
> `xact` 로 두면 그 사이가 열린다. 그리고 커넥션이 풀로 **돌아가므로** `finally` 에서
> 명시적으로 놓는다 — 세션을 닫아도 풀리지만 이 커넥션은 안 닫힌다.
> 잠금을 놓는지도 재현물이 잰다(`pg_locks` 에 granted advisory 가 0).

### ☑ W0-9 · N1 — 새 실행 파일에 실행 권한 `[XS]` (`src/` 밖)

- [x] `scripts/build.sh:17` — `chmod +x dist/bin/*.js`. **목록을 없앤다** —
      이름을 손으로 들고 있는 것이 빠뜨린 원인이었다
- [x] `./scripts/build.sh` 를 돌려 셋 다 `-rwxr-xr-x` 인지 봤다
      (`bary-dp-agent.js` 포함)
- [x] `src/bin/bary-dp-agent.ts` — 다른 두 진입점과 같은 argv 가드를 단다
- [x] 커밋 — `Pinned-by: none — 아래 근거`

> **왜 재현물이 없나.** 둘 다 게이트가 안 재는 자리다.
> ㉠ 빌드 산출물의 퍼미션 — 어느 스위트도 `dist/` 를 안 본다.
> ㉡ argv 가드 — 재현물은 이 진입점을 import 해 「서버가 안 뜬다」를 보는 것인데,
> **고치기 전 트리에서는 그 import 가 `process.exit(1)` 로 러너를 죽인다**(환경변수가
> 없으면 `main` 이 던지고 `.catch` 가 프로세스를 내린다). 러너가 죽는 것을 「빨갛다」로
> 세는 것은 `pinned.mjs` 가 이미 한 번 물린 함정이다(`tests/unit/pinned-gate.test.ts`
> 의 ② — *"아무 테스트도 안 돌았는데 통과한다"*). 그 모양을 재현물로 쓰지 않는다.
>
> ㉠ 을 잴 자리는 있다 — `package.json` 의 `bin` 을 읽어 빌드 뒤 퍼미션을 대조하는
> 게이트. 빌드를 돌려야 해서 `verify:quick` 밖이고, **G7 로 남긴다.**

### ☐ W0 마무리

- [ ] `./scripts/verify.sh` **전체** (도커 포함)
- [ ] 골든이 흔들렸으면 재생성한다 — W0 은 렌더 산출물을 안 바꾸므로 **안 흔들려야 한다.**
      흔들렸으면 그 자체가 신호다
- [ ] `SURFACE.txt` 가 안 움직였는지 확인 — `node scripts/surface.mjs --check`

---

## W1 · 경계 해독기 — 새 표면이 규칙 밖에 있다

이 저장소의 규칙은 *"타입은 런타임 입력을 막지 못한다"* 이고 `decodeModel` ·
`parseTokenSpecs` 가 그것을 실행한다. **직전 회차가 들여온 표면 셋이 그 규칙 밖에 있다.**

### ☑ W1-1 · N3 — `upstreamTls.sni` 를 검증기에 태운다 `[S]`

- [x] `tests/store/audit-upstream-sni.test.ts` — `sni: "$http_host"` 와 호스트가 아닌
      문자열이 PATCH 에서 **400** 으로 막히는가 (**실물 PG**) — 5 케이스
- [x] **빨강 확인** — 셋 다 `expected undefined to be an instance of StoreError`.
      *통과해 버리는* 빨강이라 행동상의 재현물이다 (컴파일 모양이 아니다)
- [x] `src/store/config-store.ts` — `assertDirectiveStrings` 에 `op.kind === 'pool'`
      분기를 더하고 `upstreamTls.sni` 를 `normalizeHost` 에 태운다
- [x] `./scripts/verify.sh --quick` — 9/9 초록
- [x] 커밋 — `Pinned-by: tests/store/audit-upstream-sni.test.ts -t "변수 참조를 막는다"`

> **왜 S-11 이 놓친 게 아닌가.** `upstream_tls` 는 `assertDirectiveStrings` 가 생긴
> **뒤에** 열렸고 그때 이 목록이 안 따라왔다 — N1(`build.sh` 의 `chmod` 진입점 목록)과
> 같은 모양이다. 함수 머리말에 그 사실을 적었지만, 그건 장치가 아니라 산문이다.
> 목록을 게이트가 대조하게 만드는 것은 아래 W1-2 와 묶어 남는다.

> **목록이 자라는 것을 게이트가 세게 한다.** `assertDirectiveStrings` 가 보는 필드는
> 이제 넷이다. 디렉티브로 나가는 필드가 늘 때마다 이 자리를 빠뜨리므로,
> W1-2 와 묶어 「디렉티브에 닿는 필드 목록」을 한 곳에 적고 적합성이 그것을 대조하게 한다.

### ☐ W1-2 · N2 — 원격 창구에 해독기 `[M]`

- [ ] `tests/unit/audit-remote-decode.test.ts` — 세 가지를 본다:
      ㉠ `targetGeneration` 이 세대 이름 문법 밖이면 **거절**
      ㉡ `planes` 에 모르는 키가 있으면 거절
      ㉢ 거절은 **409(`DpRejection`)** 이지 500 이 아니다
- [ ] **빨강 확인**
- [ ] `src/dp/agent-server.ts` — `invoke` 의 `as never` 를 지우고
      `decodeApplyOperation(a['op'])` 을 지난다. **`src/index.ts` 에 안 내보낸다**
      (표면이 안 움직인다)
- [ ] 세대 이름 문법은 `KEY_SYNTAX` 와 **같은 규칙**을 쓴다 —
      `^[A-Za-z0-9][A-Za-z0-9._-]{0,62}$`. 두 벌로 두지 않는다
- [ ] `src/dp/remote.ts:143` — 응답도 같은 대접. 최소한 `phase` 가 `ALL_APPLY_PHASES`
      안인지 본다
- [ ] `npm run verify:quick`
- [ ] 커밋 — `Pinned-by: tests/unit/audit-remote-decode.test.ts -t "세대 이름이 경로 조각이 되기 전에 막힌다"`

> ⚠️ 지금 `verifyGeneration` 이 앞에 서서 fail-closed 다. **그것이 이 항목을 미룰
> 이유가 아니다** — 방어가 검사 순서 하나에 매달려 있고, 그 검사의 일은 manifest
> 무결성이지 셸 안전이 아니다(`BARY_CONFIGTEST_CMD` 가 `{generation}` 을 `sh -c` 에 넣는다).

### ☐ W1-3 · D19 — CA 가 준 이름을 대조한다 `[S]`

- [ ] `tests/unit/audit-dns01-identifier.test.ts` — 주문 도메인에 없는
      `identifier.value`(`../` 포함)로 `place` 가 거부되는가
- [ ] **빨강 확인**
- [ ] `src/control/acme-runner.ts` — `#startOrder` 에서 `authz.identifier.value` 가
      `order.domains` 에 있는지 보고 아니면 던진다. `FileDns01` 이 아니라 **부르는 쪽**이다
      (http-01 도 같은 값을 쓴다)
- [ ] `npm run verify:quick`
- [ ] 커밋 — `Pinned-by: tests/unit/audit-dns01-identifier.test.ts -t "주문에 없는 도메인은 챌린지를 안 놓는다"`

### ☐ W1-4 · G3 — 환경변수 해독기 `[S]`

- [ ] `tests/unit/audit-env-numbers.test.ts` — `BARY_PROBE_INTERVAL_MS=abc` 가
      `NaN` 이 아니라 **기동 실패**가 되는가
- [ ] **빨강 확인**
- [ ] `src/bin/barycenterd.ts` — `envInt(name, fallback, {min, max})` 하나를 만들고
      `Number(env(...))` 를 전부 그것으로 바꾼다. 범위 밖·정수 아님은 던진다
- [ ] `npm run verify:quick`
- [ ] 커밋 — `Pinned-by: tests/unit/audit-env-numbers.test.ts -t "숫자 환경변수는 강제 변환하지 않는다"`

### ☐ W1 마무리

- [ ] `./scripts/verify.sh --quick`
- [ ] `node scripts/surface.mjs --check` — 안 움직여야 한다

---

## W2 · 자원 상한과 수명 — 오래 돌면 자란다

### ☐ W2-1 · D10 — 헬스 프로브 본문 상한 `[S]`

- [ ] `tests/unit/audit-probe-body-cap.test.ts` — 큰 본문을 주는 백엔드에
      `expectBody` 없이 프로브했을 때 본문을 **안 모으는가**
      (`res.destroy()` 가 불리는가)
- [ ] **빨강 확인**
- [ ] `src/control/health.ts:120` — `expectBody` 가 없으면 헤더만 보고 끊는다.
      있으면 기대 길이 + 여유(64 KiB)에서 자르고 초과분은 즉시 불일치
- [ ] `npm run verify:quick`
- [ ] 커밋 — `Pinned-by: tests/unit/audit-probe-body-cap.test.ts -t "판정에 안 쓰는 본문을 안 모은다"`

### ☐ W2-2 · D11 · D16 — ACME 타임아웃 · 재진입 가드 · 계정 재사용 `[S]`

세 항목이 같은 두 파일이라 한 커밋이다.

- [ ] `tests/unit/audit-acme-timeout.test.ts` — ㉠ 안 답하는 CA 에 `post` 가
      유한 시간에 끝나는가 ㉡ 틱이 겹쳐 돌지 않는가 ㉢ `accountUrl` 이 있으면
      `newAccount` 를 **다시 안 부르는가**
- [ ] **빨강 확인**
- [ ] `src/acme/client.ts` — `AcmeOptions.timeoutMs`(기본 30초)를 더하고
      `directory()` · `#takeNonce()` · `post()` 의 모든 `fetch` 에
      `AbortSignal.timeout` 을 건다
- [ ] `src/acme/client.ts` — `resumeAccount(url)` 을 더한다 (`#kid` 를 놓는다)
- [ ] `src/control/acme-runner.ts:176` — else 분기를 `client.resumeAccount(acct.accountUrl)`
      로 바꾼다. **주석이 말하던 것을 코드가 하게 된다**
- [ ] `src/control/acme-runner.ts:342` — `#running` 가드
      (`HealthProber` 의 것을 그대로 가져온다)
- [ ] `npm run verify:quick`
- [ ] 커밋 — `Pinned-by: tests/unit/audit-acme-timeout.test.ts -t "안 답하는 CA 가 러너를 못 매단다"`

### ☐ W2-3 · G4 — SSE 와 원격 응답의 상한 `[S]`

- [ ] `tests/unit/audit-stream-caps.test.ts` — ㉠ 안 읽는 SSE 소비자에 버퍼가
      임계를 넘으면 끊는가 ㉡ 원격 드라이버가 큰 응답을 상한에서 자르는가
- [ ] **빨강 확인**
- [ ] `src/api/events.ts` — `writable()` 이 `res.writableLength` 도 본다.
      넘으면 `finish()`
- [ ] `src/dp/remote.ts:112` — 누적에 상한.
      에이전트 쪽 `readJson` 의 4 MiB 와 **같은 값**을 쓴다
- [ ] `npm run verify:quick`
- [ ] 커밋 — `Pinned-by: tests/unit/audit-stream-caps.test.ts -t "안 읽는 소비자가 버퍼를 무한히 못 키운다"`

### ☐ W2-4 · D8 — SecretStore `put` 원자화 `[M]`

- [ ] `tests/unit/audit-secret-put-atomic.test.ts` — mkdir 과 첫 write 사이에서
      죽인 뒤 **같은 바이트를 다시 올리면** 자료가 온전한가
- [ ] **빨강 확인**
- [ ] `src/dp/secrets.ts:128` — `.tmp-<nonce>/` 에 셋을 쓰고 fsync 한 뒤 rename.
      `materializeGeneration` 과 같은 모양이다. `putKey` 도 같은 자리
- [ ] `npm run verify:quick`
- [ ] 커밋 — `Pinned-by: tests/unit/audit-secret-put-atomic.test.ts -t "반쪽으로 죽은 자료는 재업로드가 고친다"`

### ☐ W2-5 · D9 — 종료 경로 `[S]`

- [ ] `tests/unit/audit-shutdown-sse.test.ts` — SSE 를 하나 붙여 둔 채 SIGTERM 을
      보냈을 때 **유한 시간에** 락이 반납되는가
- [ ] **빨강 확인**
- [ ] `src/bin/barycenterd.ts:676` — `server.close()` 뒤에
      `server.closeAllConnections()`. 정리 전체에 마감을 씌우고 `process.exit`.
      `bary-dp-agent.ts:84` 가 이미 그 모양이다 — **같은 모양으로 맞춘다**
- [ ] 열린 SSE 는 `res.end()` 로 먼저 닫는다 (화면이 「끊겼다」를 안다)
- [ ] `npm run verify:quick`
- [ ] 커밋 — `Pinned-by: tests/unit/audit-shutdown-sse.test.ts -t "화면이 붙어 있어도 종료가 끝난다"`

### ☐ W2 마무리

- [ ] `./scripts/verify.sh` 전체
- [ ] 소크를 한 번 돌려 본다 — `npm run soak`. W2 가 겨눈 것이 「오래 돌면」이므로
      짧은 스위트로는 안 보인다

---

## W3 · 멤버십 평면 — 골든이 필요하다 (도커)

**여기부터는 코드 경로 판단이 아니라 실물 측정이다.** 검수 문서 §4 가 적어 뒀듯
D3·D4 는 아직 골든으로 못 박히지 않았다 — 그것을 먼저 만든다.

### ☐ W3-0 · 무대부터 — 재시도 골든 하네스 `[M]` ← **먼저**

- [ ] `tests/golden/next-upstream.test.ts` — 백엔드 둘 중 **첫째를 죽여 두고**
      요청 하나를 보낸 뒤 `/membership/inflight` 를 양쪽 다 읽는다.
      지금은 죽은 쪽이 `1` 로 남아야 한다 (**그것이 D3 의 재현물이다**)
- [ ] **빨강 확인** — 이 시점에 이 테스트는 「1 이 남는다」를 **기대하지 않는다.**
      0 을 기대하고 빨개야 한다
- [ ] 커밋 — 테스트만. `Pinned-by: none — 재현물 커밋. 수정은 W3-1 이다`

### ☐ W3-1 · D3 — `in:` 누수를 막는다 `[M]`

- [ ] W3-0 의 테스트가 빨간 것을 다시 확인한다
- [ ] `src/conf/render.ts:350` — `ngx.ctx.bary_peer = peer` 대신
      **고른 것 전부**를 쌓는다 (`ngx.ctx.bary_peers`)
- [ ] `src/conf/render.ts:1403` · `1513` — log 단계가 그 목록을 전부 내린다.
      **양 평면 다** 고친다 — 한쪽만 고치면 stream 쪽이 그대로 샌다
- [ ] `npm run test:golden`
- [ ] `./scripts/verify.sh` 전체 — 렌더 산출물이 바뀌므로 골든이 흔들린다.
      **의도한 변경인지 diff 로 눈으로 본다**
- [ ] 커밋 — `Pinned-by: tests/golden/next-upstream.test.ts -t "재시도가 inflight 를 안 남긴다"`

### ☐ W3-2 · D5 — 활성화 음성 신호를 수준으로 좁힌다 `[S]`

- [ ] `tests/e2e/audit-error-log-noise.test.ts` — apply 창 동안 **무관한 upstream
      오류**가 error log 에 찍히게 해 놓고 apply 가 `activated` 로 끝나는가
- [ ] **빨강 확인**
- [ ] `src/dp/effects-fs.ts:257` — 줄 수가 아니라 `[emerg]`·`[alert]`·`[crit]` 만 센다.
      `errorLogGrowth` 의 뜻이 바뀌므로 `src/dp/operation.ts:98` 의 주석도 함께 고친다
- [ ] S7 이 잡은 것(포트 점유 = `[emerg]`)이 **여전히 잡히는지** 확인한다 —
      그것이 이 신호의 존재 이유다
- [ ] `npm run test:e2e`
- [ ] 커밋 — `Pinned-by: tests/e2e/audit-error-log-noise.test.ts -t "트래픽 오류가 apply 를 안 죽인다"`

### ☐ W3-3 · D4 — 퇴역 epoch 의 슬롯을 회수한다 `[L]`

- [ ] `tests/golden/slot-reclaim.test.ts` — 세대를 여러 번 넘긴 뒤
      `/membership/read` 로 **옛 epoch 의 키가 안 남아 있는가**
- [ ] **빨강 확인**
- [ ] `src/control/membership.ts:222` — `/membership` 에 `remove` 인자를 더한다.
      ACME 의 `arg_remove` 와 **같은 모양**이다 (새 계약이 아니다)
- [ ] `src/control/plane.ts` — `sweep()` 이 세대를 지울 때 그 epoch 의 슬롯도 함께
      지운다. **판정을 다시 짓지 않는다** — `workerLingerMs` 가 이미 「아무도 안 든다」를 답한다
- [ ] stream 평면(`streamAdminConf`)에도 같은 동사를 낸다
- [ ] 관측 창구를 하나 낸다 — `bary_membership_slot_keys` 게이지.
      **자라는 것이 보여야** 다음에 이 자리를 안 다시 만든다
- [ ] `npm run test:golden` · `./scripts/verify.sh` 전체
- [ ] 커밋 — `Pinned-by: tests/golden/slot-reclaim.test.ts -t "퇴역한 epoch 의 슬롯이 안 남는다"`

### ☐ W3 마무리

- [ ] `./scripts/verify.sh` 전체 (도커 포함)
- [ ] 골든 재생성 — W3-1 과 W3-3 이 렌더를 바꾼다. **한 번에 모아서** 한다
- [ ] `STATUS.md` 의 스위트 수치를 **실측으로** 맞춘다 (옮겨 적은 값은 늘 낡는다)

---

## W4 · 결정이 먼저다 — 손대기 전에 답을 정한다

아래는 **고치는 방법이 여럿이고 그 선택이 계약을 바꾼다.** 코드부터 쓰면
되돌리는 비용이 크다. 각 항목은 「무엇을 정해야 하는가」로 적었다.

### ☐ W4-1 · D2 — 멤버십 평면의 가중치 `[L]` ← **이 블록에서 제일 크다**

**정할 것:** 세 안 중 하나.

| 안 | 무엇이 바뀌나 | 대가 |
|---|---|---|
| ㉠ 슬롯에 가중치를 싣는다 (`host:port\|w`) | admin 와이어 문법 · Lua 선택 로직 | 계약이 넓어진다. dict 값이 길어진다 |
| ㉡ 슬롯 목록을 가중치만큼 반복 | `slotsOf` 한 곳 | 가장 싸다. **dict 크기를 먹는다** — D4 의 절벽과 같은 자원 |
| ㉢ 안 고치고 plan 이 말한다 | `capabilityWarnings` 한 줄 | 거짓말은 아니게 된다. **가중치는 여전히 안 걸린다** |

- [ ] 셋 중 하나를 고르고 **근거를 `DESIGN.md` §7.3 에 적는다.**
      ㉢ 을 고른다면 그것이 축소 결정이므로 §12.0 이나 §15 에 근거가 있어야 한다
      (STATUS 가 "결정이었다면 근거가 있어야 한다" 고 적어 둔 그 규칙)
- [ ] 고른 뒤에 재현물 → 수정 → 커밋

### ☐ W4-2 · D12 — 엔진 생사를 나타내는 창구 `[M]`

**정할 것:** `/healthz` 를 바꿀 것인가, `/readyz` 를 새로 낼 것인가.

- 바꾸면 지금 `/healthz` 를 쓰는 오케스트레이터의 뜻이 조용히 달라진다
- 새로 내면 **API 표면이 하나 는다** (B 동결 드리프트 게이트가 잰다)

- [ ] 결정 후: `probeAccepting` 이 이미 admin 소켓을 두드리므로 재료는 있다
- [ ] `deploy/Dockerfile` 에 `HEALTHCHECK`, `deploy/docker-compose.yml` 에
      `restart: unless-stopped`
- [ ] e2e 로 잰다 — nginx 를 죽이고 그 창구가 빨개지는가

### ☐ W4-3 · D14 — 인증서 선택 규칙 `[S]`

**정할 것:** 정확일치 우선으로 할 것인가, 겹치는 바인딩 자체를 막을 것인가.

- 앞: nginx 의 `server_name` 규칙과 같아 설명할 것이 없다. 기존 설정이 안 깨진다
- 뒤: 표현 불가능하게 만든다(이 저장소의 기본 취향). **기존 설정이 저장 불가가 될 수 있다**

- [ ] 결정 후 `src/conf/render.ts:946` 또는 `src/validate/model.ts`

### ☐ W4-4 · G2 — CSP `script-src` `[S]`

**정할 것:** GUI 빌드가 인라인 스크립트·스타일을 내는가. 그것이 정책의 모양을 정한다.

- [ ] `gui/build` 산출물을 실제로 열어 확인한다 (`headers.ts` 가 미룬 이유가 그것이다)
- [ ] `script-src 'self'` · `connect-src 'self'` 로 시작하고, 화면이 깨지면
      **깨진 자리를 근거로** 좁힌다. 지어내지 않는다
- [ ] `tests/unit/audit-csp.test.ts` — 응답 헤더에 `script-src` 가 있는가

### ☐ W4-5 · G1 — SSE 재연결 `[M]`

**정할 것:** 재개를 `Last-Event-ID` 로 할 것인가, 스냅샷 재요청으로 할 것인가.

- `EventHub` 가 이미 `id` 를 붙이므로 서버 쪽 절반은 있다. 그런데 **허브가 과거
  이벤트를 안 들고 있다** — 재개하려면 버퍼가 필요하고 그건 새 상태다
- 스냅샷 재요청은 상태가 없다. 대신 재연결마다 DB 를 친다

- [ ] 결정 후 `gui/src/lib/desk.svelte.ts:222` — 지수 백오프
- [ ] `tests/unit/gui-*.test.ts` 계열에 재연결 테스트

### ☐ W4-6 · G5 — 테스트용 가짜를 `dist` 에서 뺀다 `[M]`

⚠️ **표면이 움직인다.** `FakeEffects` 등은 `reachable.mjs` 의 `ALLOW` 에 있고,
옮기면 그 목록도 바뀐다. 카운터가 0 으로 돌아가므로 **W4 의 다른 표면 변경과
같은 회차에 모은다.**

- [ ] `src/testing/` 로 옮기고 `tsconfig.build.json` 의 `include` 에서 뺀다
- [ ] `reachable.mjs` 의 `ALLOW` 에서 그 항목들을 지운다 (더 이상 예외가 아니다)
- [ ] `node scripts/surface.mjs --check` 로 A 표면이 안 움직였는지 확인
      (`src/index.ts` 는 이것들을 안 내보내므로 안 움직여야 한다)

### ☐ W4-8 · D21 — ACME 계정을 만드는 경로 `[M]` ← **W4 에서 제일 크다**

**정할 것:** 계정 등록을 어느 표면에 낼 것인가.

지금은 `acme_accounts` 에 넣는 코드가 `upsertAccount` 하나이고 **호출자가 테스트뿐이다.**
계정이 없으면 러너가 경고 한 줄 찍고 건너뛰므로, 새 배포에서 **ACME 가 통째로 도달
불가**다. G6 의 게이트가 켜지자마자 짚었다.

| 안 | 대가 |
|---|---|
| `POST /api/v1/acme/accounts` | **B 동결 드리프트다** — 라우트 표가 움직인다. 그 대신 GUI·CLI 가 같은 길을 쓴다 |
| `bary acme account create` | 표면이 CLI 에만 산다. GUI 에서는 못 만든다 — 제품 명제가 GUI 인데(§2) |
| 기동 환경변수 | 표면이 안 움직인다. 계정이 **설정이 아니라 배포**가 되고, 그러면 리비전·감사·롤백 밖에 산다 |

- [ ] 셋 중 하나를 고르고 근거를 `DESIGN.md` §8.2 나 ADR-ACME 에 적는다
- [ ] 고른 뒤에 재현물 → 수정 → `scripts/reachable.mjs` 의 `ALLOW` 에서 부채 항목을 **지운다**
      (그 줄이 남아 있으면 고친 것이 아니다)

### ☐ W4-7 · G7 — 작은 것 넷 `[S]`

한 커밋으로 묶어도 된다. 각각 독립이다.

- [ ] `readManifest` 가 `JSON.parse` 를 감싸고 `files` 를 검증한다 →
      깨진 manifest 가 `GenerationError('manifest_missing')` 으로 온다
- [ ] `BARY_LISTEN` 파싱을 `URL` 로 바꿔 IPv6 를 표현할 수 있게 한다
- [ ] `build.sh` 가 `gui/package-lock.json` 의 변화를 본다
      (해시를 `gui/node_modules/.bary-lock` 에 적고 대조)
- [ ] `bary-dp-agent` 배포 조리법 — `deploy/` 에 원격 모드 예시를 넣거나,
      **안 넣기로 하고 그 근거를 적는다**
- [ ] **진입점 퍼미션 게이트** (W0-9 가 남겼다) — `package.json` 의 `bin` 을 읽어
      빌드 뒤 퍼미션을 대조한다. 빌드를 돌려야 해서 `verify:quick` 밖이다

---

## 진행 요약

검수 문서의 ID 가 전부 어느 블록에 들어갔는지. **빠진 것이 없어야 한다.**

| ID | 심각도 | 블록 | 크기 |
|---|---|---|---|
| D1 | High | W0-1 | M |
| D2 | High | W4-1 | L |
| D3 | Medium | W3-0 · W3-1 | M |
| D4 | Medium | W3-3 | L |
| D5 | Medium | W3-2 | S |
| D6 | Medium | W0-3 | XS |
| D7 | Medium | W0-6 | S |
| D8 | Medium | W2-4 | M |
| D9 | Medium | W2-5 | S |
| D10 | Medium | W2-1 | S |
| D11 | Medium | W2-2 | S |
| D12 | Medium | W4-2 | M |
| D13 | Medium | W0-4 | XS |
| D14 | Low | W4-3 | S |
| D15 | Low | W0-8 | S |
| D16 | Low | W2-2 | S |
| D17 | Low | W0-5 | XS |
| D18 | Low | W0-7 | S |
| D19 | Low | W1-3 | S |
| N1 | Low | W0-9 | XS |
| N2 | Medium | W1-2 | M |
| N3 | Medium | W1-1 | S |
| G1 | 제안 | W4-5 | M |
| G2 | 제안 | W4-4 | S |
| G3 | 제안 | W1-4 | S |
| G4 | 제안 | W2-3 | S |
| G5 | 제안 | W4-6 | M |
| G6 | 제안 | W0-2 | M |
| G7 | 제안 | W4-7 | S |
| D21 | High | W4-8 | M |
| D22 | Medium | W0-2 (닫힘) | — |

**29 개 전부 배정됐다.** D21 · D22 는 **수정 중에 G6 의 게이트가 찾은 것**이라 검수
문서 §6 에 따로 적었다 — 손으로 훑은 목록에는 없던 것들이다. D20 은 검수 문서 §4 에 적힌 대로 직전 회차(`b8c7eb2`)가
`pruneTerminal` 로 닫았으므로 여기 없다.

### 블록별 무게

| 블록 | 항목 | 무엇을 닫나 | 도커 |
|---|---|---|---|
| W0 | 9 | 배선 결손. **High 하나가 여기 있다** | 마무리에만 |
| W1 | 4 | 경계 해독기 — 새 표면이 규칙 밖 | 실물 PG 둘 |
| W2 | 6 | 자원 상한과 수명 | 소크 |
| W3 | 3 | 멤버십 평면 — **코드 판단을 측정으로 바꾼다** | 전부 |
| W4 | 7 | 결정이 먼저인 것 | 항목마다 |

### 어디서 멈춰도 되는가

- **W0 까지**면 개인키를 지울 수 있는 결함이 닫힌다. 이것만 해도 값이 있다
- **W1 까지**면 새 표면이 이 저장소의 규칙 안으로 들어온다
- **W3 까지**면 검수 문서 §4 가 적어 둔 *"코드 경로로만 세운 판단"* 이
  측정으로 바뀐다 — D3·D4 가 골든에 박힌다
- **W4 는 결정이 먼저다.** 답을 안 정하고 코드부터 쓰면 되돌리는 비용이 크다

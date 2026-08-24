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
- [ ] W3 에 들어가기 전에 도커를 확인한다 — 골든과 e2e 가 실물 nginx 를 띄운다
- [x] ~~워크트리에서 e2e 를 돌릴 거면 `rm -f node_modules && npm ci` 를 **먼저** 한다
      (심링크는 컨테이너 안에서 끊긴다)~~ — **W1-2b 가 없앴다.** `appMount()` 가
      실체 경로를 따로 싣는다

> ⚠️ **이 줄이 이 회차의 교훈 하나다.** 심링크가 끊긴다는 사실은 투두를 쓸 때 이미
> 알고 있었고, 그래서 「손으로 이렇게 하라」를 적어 뒀다. 그리고 **아무도(나 포함)
> 그걸 안 했다.** 산문으로 적힌 선결 조건은 지켜지지 않는다 — 이 저장소가
> `pinned.mjs` 를 만들며 배운 것과 같은 것이다(*"규칙이 산문이라 안 지켜졌으므로
> 게이트로 옮겼다"*). 손으로 할 일을 적는 대신 그 일이 필요 없게 만드는 것이 답이었다.

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

### ☑ W0 마무리

- [x] `./scripts/verify.sh` **전체** (도커 포함) — **여기서 e2e 가 빨갰다.**
      원인은 W0 의 어느 수정도 아니라 게이트 자신이었다 → W1-2b (N4)
- [x] 골든이 안 흔들렸다 — 65 초록. W0 은 렌더 산출물을 안 바꾸므로 맞는 결과다
- [x] `node scripts/surface.mjs --check` — 표면 그대로 (117 심볼)

> **이 블록의 진짜 값은 여기 있었다.** W0 아홉은 전부 `--quick` 으로 닫혔고, 전체를
> 돌린 것은 마무리 한 번뿐이었다. 그리고 그 한 번이 **아홉 개를 합친 것과 다른 종류의
> 결함**을 찾았다 — 게이트가 워크트리에서 항상 빨갛다는 것. 회차마다 `--quick` 만
> 돌리면 도커 스위트는 마무리에서만 재지고, 그때 나온 빨강은 **어느 수정이 깼는지
> 구분할 수 없다.** W1 부터는 블록 마무리에서 전체를 돌린다.

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

### ☑ W1-2 · N2 — 원격 창구에 해독기 `[M]`

- [x] `tests/unit/audit-remote-decode.test.ts` — 13 케이스. 타입 드라이버가 절대 안
      만드는 요청을 **원시 mTLS 로 직접** 던진다 (드라이버를 지나면 "타입이 타입을
      지킨다" 를 재게 된다)
- [x] **빨강 확인** — 10 개가 `expected 200 to be 409`. *통과해 버리는* 빨강이다
- [x] `src/dp/wire.ts` (새 파일) — `invoke` 의 `as never` 다섯을 전부 해독기로 바꿨다.
      **`src/index.ts` 에 안 내보낸다**
- [x] `src/validate/syntax.ts` (새 파일) — `PATH_SEGMENT_SYNTAX` 한 벌.
      `config-store` 의 `KEY_SYNTAX` 가 이제 이걸 가리킨다
- [x] `src/dp/remote.ts` — `applyConfig` · `recoverConfig` 응답의 `phase` 가
      `ALL_APPLY_PHASES` 안인지 본다
- [x] `./scripts/verify.sh --quick` — 9/9 초록 (unit 838 → 851)
- [x] 커밋 — `Pinned-by: tests/unit/audit-remote-decode.test.ts -t "세대 이름이 경로 조각이 되기 전에 막힌다"`

> ⚠️ 지금 `verifyGeneration` 이 앞에 서서 fail-closed 다. **그것이 이 항목을 미룰
> 이유가 아니다** — 방어가 검사 순서 하나에 매달려 있고, 그 검사의 일은 manifest
> 무결성이지 셸 안전이 아니다(`BARY_CONFIGTEST_CMD` 가 `{generation}` 을 `sh -c` 에 넣는다).

**계획과 달라진 것 둘.**

1. **`RejectionKind` 에 `'malformed_request'` 를 더했다 — A 표면이 움직였다.**
   투두는 "표면이 안 움직인다" 를 `decodeApplyOperation` 을 안 내보내는 것으로만
   적었는데, ㉢(거절은 409 `DpRejection`)을 지키려면 `kind` 가 있어야 한다. 있는 것을
   빌려 쓰는 길(`envelope_mismatch` 등)은 진짜 진단을 흐린다. 동결 카운터가 0 이라
   쌓아 놓은 것을 잃지는 않았다 — `surface.mjs --write` 로 기준을 옮겼다.
   표면 diff 는 그 한 줄뿐이다.
2. **정규식을 `validate/strings.ts` 에 안 넣고 `validate/syntax.ts` 를 새로 만들었다.**
   `strings.ts` 는 `./ip.js` 와 `../model/provisional.js` 를 끌어오는데 **`src/dp/` 는
   모델 층을 안 본다** (§3.1 — DP 에이전트는 별도 배포다). 규칙 하나를 나눠 쓰려고 그
   경계를 무르는 것은 값이 안 맞아서, 아무것도 import 하지 않는 잎으로 갈랐다.

> **응답 쪽에서 `kind` 는 일부러 안 좁혔다.** 버전 스큐의 대가가 두 방향에서 다르다 —
> 모르는 `phase` 를 받아들이면 전환이 **조용히 멈추고**(어느 분기에도 안 걸린다),
> 모르는 `kind` 를 거절하면 **판정을 장애로 오해해서 재시도한다.** 앞엣것은 안 보이고
> 뒤엣것은 보인다. `remote.ts` 의 `checkedPhase` 주석에 그 근거를 적어 뒀다.

### ☑ W1-2b · N4 — 워크트리에서 e2e 가 돌게 한다 `[S]` — **회차 중에 끼어들었다**

> 이 항목은 계획에 없었다. **W0 마무리로 전체 `verify.sh` 를 처음 끝까지 돌렸더니
> e2e 가 빨갰다.** 원인은 어느 회차의 코드도 아니라 **게이트 자신**이었고, 이걸 안
> 고치면 W1~W4 의 어느 것도 e2e 로 검증할 수 없어서 먼저 닫았다.

- [x] 진단 — 컨테이너를 손으로 다시 띄워 `set -x` 를 걸었다.
      `ERR_MODULE_NOT_FOUND: Cannot find package 'pg'`. 워크트리의 `node_modules` 가
      **메인 체크아웃을 가리키는 심볼릭 링크**라 컨테이너 안에 그 절대경로가 없다
- [x] `tests/e2e/audit-worktree-mounts.test.ts` — 메커니즘을 **실물 도커**로 못 박는다
      (4 케이스, 8.5 초). 마지막 하나는 *지금 이 체크아웃*을 잰다
- [x] `tests/e2e/mounts.ts` — `appMount()` 한 벌. `node_modules` 실체를 두 번째 `-v`
      로 따로 싣는다. **조건부 분기를 안 둔다** — 링크가 아니면 결과가 같다
- [x] 여섯 마운트 자리를 전부 바꿨다 (v01 둘 · v02-capability · v02-l4 · v03 · v06)
- [x] `npm run test:e2e` — 여섯 스위트 전부 초록
- [x] 커밋 — `src/` 를 안 건드리므로 재현물 게이트는 건너뛴다

> **왜 워크트리 쪽을 안 고쳤나.** `scripts/pinned.mjs` 도 같은 짓을 한다 —
> `symlinkSync(process.cwd()/node_modules, tree/node_modules)`. 워크트리를 만드는
> 자리는 앞으로도 늘고 전부 같은 이유로 링크를 건다. 심볼릭 링크가 바인드 마운트를
> 못 건너는 것은 **도커의 성질이지 누구의 실수가 아니므로**, 고칠 자리는 마운트다.

> ⚠️ **「거짓 초록」이 아니라 「거짓 빨강」이었다.** 대가는 다르지만 끝은 같다 —
> 게이트가 말하는 것을 사람이 안 믿게 된다. 이 회차에 실제로 그랬다.

### ☑ W1-3 · D19 — CA 가 준 이름을 대조한다 `[S]`

- [x] `tests/store/audit-dns01-identifier.test.ts` — 5 케이스. **`tests/unit/` 이 아니라
      `tests/store/`** 다: 러너의 `#startOrder` 는 `AcmeStore`(실물 PG)를 지나야
      닿는다. 가짜 store 를 만들면 `as never` 캐스팅 더미가 되고, 그러면 이 검사가
      배선이 아니라 목(mock)을 재게 된다
- [x] **빨강 확인** — 셋. 그중 하나는 **경로 탈출 실물 재현**:
      `expected [ 'dns-challenges', 'keys', 'pwned' ] to not include 'pwned'` —
      CA 가 준 이름으로 시크릿 저장소 루트에 파일이 쓰였다
- [x] `src/control/acme-runner.ts` — `assertOrdered(order, authz.identifier.value)`.
      `FileDns01` 이 아니라 **부르는 쪽**이다 (http-01 도 같은 값을 쓴다)
- [x] `./scripts/verify.sh --quick`
- [x] 커밋 — `Pinned-by: tests/store/audit-dns01-identifier.test.ts -t "경로 조각이 든 이름은 파일시스템에 안 닿는다"`

> **처음 쓴 탈출 케이스는 아무것도 안 쟀다.** `challengeTypeWanted` 가 와일드카드가
> 아니면 http-01 을 고르므로 그 케이스가 `FileDns01` 을 안 지났고, 그래서 **수정 전에도
> 초록**이었다. `*.` 로 시작하게 바꿔 dns-01 로 강제하자 빨개졌다. 배치기를 안 지나는
> 검사는 배치기에 대해 아무 말도 안 한다.

> **`authz.wildcard` 플래그까지는 안 본다.** apex 를 받아야 하는 이유(RFC 8555 §7.1.3 —
> `*.b.test` 의 authz 는 `b.test` 다)는 코드 주석에 적었고, 「CA 가 apex 만 검증하는」
> 경우는 **프로토콜이 이미 닫는다**: finalize 에 나가는 CSR 이 `*.b.test` 라 apex authz
> 만으로는 그 인증서가 안 나온다. 플래그를 요구하면 그것을 빠뜨리는 CA 에서 와일드카드
> 발급이 막히는 대가만 남는다.

### ☑ W1-4 · G3 — 환경변수 해독기 `[S]`

- [x] `tests/unit/audit-env-numbers.test.ts` — 6 케이스. **`main()` 을 부른다** —
      `envInt` 를 직접 부르면 `envInt` 만 재게 된다. 도커 없이 돈다
- [x] **빨강 확인** — 넷이 `expected '환경변수 BARY_DSN 이 필요하다' to contain
      'BARY_PROBE_INTERVAL_MS'`. 숫자가 **DSN 보다 먼저** 안 걸린다는 뜻이다
- [x] `src/validate/env.ts` — `envInt(name, fallback, {min,max})` · `envIntOpt`
- [x] `src/bin/barycenterd.ts` — `readTimings()` 하나가 열넷을 한 번에 읽는다.
      `Number(env(...))` 17 곳과 보존 기간 `Number(raw)` 5 곳이 전부 사라졌다
- [x] `./scripts/verify.sh --quick` — 9/9 초록 (unit 851 → 857)
- [x] 커밋 — `Pinned-by: tests/unit/audit-env-numbers.test.ts -t "숫자 환경변수는 강제 변환하지 않는다"`

**계획보다 넓게 갔다 — 둘.**

1. **`envInt` 를 `barycenterd.ts` 안이 아니라 `src/validate/env.ts` 에 뒀다.**
   해독기는 `validate/` 에 산다는 것이 이 저장소의 배치이고(`strings`·`syntax`·
   `sockets`), 진입점 파일에 두면 두 번째 진입점이 생기는 날 사본이 는다.
2. **자리마다 부르지 않고 `readTimings()` 로 모았다.** 투두는 "전부 그것으로 바꾼다"
   였는데, 그대로 하면 **`BARY_PROBE_INTERVAL_MS` 를 두 번 읽는 것이 남는다** —
   프로버에 넘길 때 한 번, 로그에 찍을 때 또 한 번. `BARY_ACME_INTERVAL_MS`·
   `BARY_ACME_RENEW_DAYS`·`BARY_ACME_ORPHAN_INTERVAL_MS` 도 같았다. 기본값이 같아서
   지금은 안 갈리지만, 한쪽만 고치는 날 **로그가 거짓말을 시작한다.**

> **읽는 자리를 DB 접속 앞으로 옮겼다.** 설정이 틀린 채로 PG 에 붙어 마이그레이션까지
> 돌리고 죽는 것은 아무에게도 이롭지 않고, 그래야 이 판정을 도커 없이 잰다.
> 순서가 테스트의 편의가 아니라 **설계**라는 것을 주석에 적었다.

> **빈 문자열을 기본값으로 접는 것이 요점 하나다.** `Number('')` 은 `0` 이라,
> `FOO=` 로 지운 변수가 `setInterval(f, 0)` 이 된다. 오케스트레이터가 빈 값을 흔히 만든다.
> 보존 기간만은 빈 값이 **「무한 보존」**이라 `envIntOpt` 로 갈랐다 — 기본값으로 접으면
> 업그레이드가 곧 데이터 소실이다.

### ☑ W1 마무리

- [x] `./scripts/verify.sh` — **전체. 20/20 초록.** 워크트리에서 전체가 통과한 것은
      이번이 처음이다

      | 스위트 | 결과 |
      |---|---|
      | typecheck · 표면 · 도달성 · node 핀 · 재현물 핀 · 훅 둘 | 전부 초록 |
      | unit | 857 |
      | conformance | 479 |
      | 모델 | 13 |
      | build (dist·gui) | 초록 |
      | store (실물 PG) | 227 |
      | golden (nginx -t) | 65 |
      | **e2e (실제 nginx)** | **64** ← W1-2b 전에는 다섯 스위트가 죽었다 |
      | engine facts | PASS=76 FAIL=0 SKIP=1 |
      | spike S1/S5 · S7 · S8 · S9 · S11 · S12 · S13 · S15 · S16 · S17 · S18 · S19 | 전부 FAIL=0 |

- [x] `node scripts/surface.mjs --check` — 그대로. W1-2 에서 `RejectionKind` 한 줄이
      움직였고 기준을 그때 옮겼다. 표면 diff 는 그 한 줄뿐이다
- [x] 골든이 안 흔들렸다 — 65 초록. W1 도 렌더 산출물을 안 바꾼다

---

## W2 · 자원 상한과 수명 — 오래 돌면 자란다

### ☑ W2-1 · D10 — 헬스 프로브 본문 상한 `[S]`

- [x] `tests/unit/audit-probe-body-cap.test.ts` — 7 케이스. 무대는 **끝나지 않는
      응답**이다 (헤더와 첫 청크만 주고 `end()` 를 안 부르는 백엔드)
- [x] **빨강 확인** — 넷이 전부 `expected '1000ms 안에 응답이 없다' to …`
- [x] `src/control/health.ts` — 상태 코드를 **헤더에서** 보고, `expectBody` 가 없으면
      본문을 읽지도 않고 `res.destroy()`. 있으면 **기대 길이까지만** 읽는다
- [x] `./scripts/verify.sh --quick` — 9/9 초록 (unit 857 → 864)
- [x] 커밋 — `Pinned-by: tests/unit/audit-probe-body-cap.test.ts -t "판정에 안 쓰는 본문을 안 모은다"`

**메모리보다 먼저 드러나는 것이 있었다.** 투두는 이 항목을 「자원 상한」으로 적었는데,
재현물을 쓰다 보니 **판정이 먼저 틀리고 있었다**: 상태 코드 판정이 `'end'` 안에 있어서
**본문을 안 끝내는 백엔드**(SSE · 스트리밍 · 청크를 흘리다 멈춘 앱)가 헤더에 `200` 을
주고도 타임아웃으로 `unhealthy` 가 됐다. 기본 프로브 경로가 `/` 라 그런 응답은 드물지
않다. 재현물의 무대를 「큰 본문」이 아니라 「안 끝나는 본문」으로 잡은 이유가 그것이다 —
같은 수정이 둘 다 닫지만, 큰 본문만 재면 이쪽은 안 보인다.

> **계획과 달라진 것.** 투두는 *"기대 길이 + 여유(64 KiB)에서 자른다"* 였는데 여유를
> 안 뒀다. 판정이 **정확일치**(`body === expect`)라 한 바이트만 넘어도 답이 이미
> 「다르다」이고, 여유는 그만큼 더 모으는 것일 뿐 판정을 안 바꾼다.

> 프로브 시간이 케이스당 1019ms → **15ms** 로 줄었다. 그 1000ms 는 전부 타임아웃을
> 기다린 시간이었다 — 즉 실제 배포에서도 그런 백엔드 하나가 매 틱 프로브 예산을
> 통째로 먹고 있었다.

### ☑ W2-2 · D11 · D16 — ACME 타임아웃 · 재진입 가드 · 계정 재사용 `[S]`

세 항목이 같은 두 파일이라 한 커밋이다.

- [x] `tests/unit/audit-acme-timeout.test.ts` — 7 케이스. **실물 PG 를 안 쓴다** —
      묻는 것이 「원장이 무엇을 하는가」가 아니라 「러너가 CA 에 무엇을 묻는가」다
- [x] **빨강 확인** — 셋이 서로 다른 모양이었다:
      ㉠ `Test timed out in 20000ms` (매달린다) ·
      ㉡ `expected 19 to be 1` (틱이 열아홉 겹쳤다) ·
      ㉢ `expected [ 'register' ] to deeply equal [ 'resume:…' ]`
- [x] `src/acme/client.ts` — `AcmeOptions.timeoutMs`(기본 30 초). `#send` 하나를 두고
      **모든 요청이 거기를 지나게** 했다 — `#fetch` 직접 호출이 남으면 다음 요청이
      마감 없이 들어온다
- [x] `src/acme/client.ts` — `resumeAccount(url)` · `get timeoutMs`
- [x] `src/control/acme-runner.ts` — else 분기가 `client.resumeAccount(acct.accountUrl)`.
      **주석이 말하던 것을 코드가 하게 됐다**
- [x] `src/control/acme-runner.ts` — `#running` 가드 (`HealthProber` 의 것과 같다)
- [x] `./scripts/verify.sh --quick` — 9/9 초록 (unit 864 → 871).
      `test:store` 의 `acme-runner` 16 초록
- [x] 커밋 — `Pinned-by: tests/unit/audit-acme-timeout.test.ts -t "안 답하는 CA 가 러너를 못 매단다"`

> **㉢ 의 빨강을 두 번 봤다** (W0-7 과 같은 이유). 처음에는
> `c.resumeAccount is not a function` 이었는데 그건 메서드가 없다는 말이지 러너가
> 틀렸다는 말이 아니다. `resumeAccount` 만 먼저 넣고 다시 재서 **러너가 `register` 를
> 부르는 것**을 눈으로 본 뒤에 고쳤다.

**기존 가짜 CA 가 실물 계약보다 좁았다.** `tests/store/acme-runner.test.ts` 의
`fakeClient` 에 `resumeAccount` 가 없어서 다섯이 빨개졌다. 가짜에 한 줄을 더해 맞췄다 —
그리고 그것이 이 결함이 오래 안 보인 이유이기도 하다: **가짜가 실물보다 좁으면 그
차이만큼 검증이 비고, 비어 있다는 사실 자체가 안 보인다.**

### ☑ W2-3 · G4 — SSE 와 원격 응답의 상한 `[S]`

- [x] `tests/unit/audit-stream-caps.test.ts` — 4 케이스. **실물 소켓으로 안 읽는
      소비자를 만든다** (`sock.pause()`) — 가짜 `res` 로는 이 결함을 못 만든다
- [x] **빨강 확인** — 둘이 `안 끊겼다`. 64 MiB 를 밀어 넣어도 살아 있다고 봤다
- [x] `src/api/events.ts` — `writable()` 이 `res.writableLength` 도 본다.
      `MAX_SSE_BUFFER_BYTES` = 4 MiB
- [x] `src/api/events.ts` — `finish()` 가 **소켓도 놓는다.** 놓기로 했으면 물고 있는
      것도 놓아야 한다
- [x] `src/dp/remote.ts` — 누적에 상한. 에이전트 쪽 `readJson` 의 4 MiB 와 **같은 값**
- [x] `./scripts/verify.sh --quick` — 9/9 초록 (unit 871 → 875)
- [x] 커밋 — 핀 **둘**. 두 자리가 서로 독립이라 하나로는 반쪽만 증명된다

**또 가짜가 실물보다 좁았다** (W2-2 에 이어 두 번째). `audit-sse-early-close.test.ts`
의 `fakeRes` 에 `writableLength` 도 `destroy` 도 없어서 셋이 빨개졌다. 두 자리를 더해
맞췄다 — 그리고 `writableLength: 0` 이라고 적어 두었다: 그 가짜로는 이 결함을 **만들
수가 없다**는 것이 요점이라, 안 읽는 소비자는 실물 소켓 쪽에서만 잰다.

> **`finish()` 가 소켓을 안 놓고 있었다.** 투두는 「넘으면 `finish()`」만 적었는데,
> 그것만으로는 재현물이 안 초록이 됐다 — `finish` 는 구독만 놓고 소켓은 그대로 뒀다.
> 클라이언트가 끊어서 온 경우에는 맞지만(이미 파괴돼 있다), **우리가 먼저 그만두기로
> 한 경우**에는 쌓인 바이트가 그대로 남는다.

### ☑ W2-4 · D8 — SecretStore `put` 원자화 `[M]`

- [x] `tests/unit/audit-secret-put-atomic.test.ts` — 8 케이스. **죽는 순간을 흉내
      내지 않는다** — 죽었을 때 디스크에 남는 모양을 그대로 만들어 놓고 `put` 을
      부른다. 재려는 것은 죽는 순간이 아니라 **죽은 뒤에 복구가 되는가**다
- [x] **빨강 확인** — 넷. 세 단계(mkdir 직후 · fullchain 만 · key 까지) 전부와
      `putKey` 까지
- [x] `src/dp/secrets.ts` — `replaceDir()` 하나로 `put` 과 `putKey` 를 같이 덮는다.
      staging 에 전부 쓰고 **fsync 한 뒤** rename
- [x] `./scripts/verify.sh --quick` — 9/9 초록 (unit 875 → 883)
- [x] 커밋 — 핀 셋

**주석이 옳은 절반만 말하고 있었다.** `put` 의 주석은 *"중간에 죽으면 key 가 없는
디렉토리가 남고 `get` 이 던진다 — 반쪽짜리를 조용히 쓰는 것보다 낫다"* 였다. 조용히
쓰는 것보다 나은 건 맞다. **거기서 끝나지 않는 것이 문제였다:** 버전이 내용 주소라
같은 바이트를 다시 올리면 같은 `version` 이 나오고, `existsSync(dir)` 이 참이라 쓰기를
통째로 건너뛴다 — **재업로드로 못 고친다.** 그리고 재업로드가 운영자가 제일 먼저 할
일이다. 나가는 길은 손으로 지우는 것뿐인데 자료 디렉토리는 `0500` 이라 그것도 한 단계
더 있다.

**계획에 없던 것 하나 — 수정이 만든 위험을 같이 닫았다.** tmp+rename 으로 바꾸면
크래시가 `<version>.tmp-<nonce>` 를 남길 수 있고, 그것을 **버전으로 읽는 쪽이 둘**이다:
`listRefs`(GC 의 root 넓히기)와 `secret-gc` 의 `keepPerName`. 뒤엣것이 실제 위험이다 —
tmp 는 **mtime 이 제일 커서** 보호 자리를 차지하고, 그만큼 진짜 최신 버전이 보호 밖으로
밀려난다. `VERSION_DIR` 한 벌을 두고 양쪽이 대조하게 했다. 재현물도 붙였다
(`keepPerName: 1` 로 진짜 자료가 지워지는지 본다).

> ⚠️ **그 재현물 하나가 처음엔 가짜였고, `pinned.mjs` 가 잡았다.**
> `FAIL … -t "GC 도 그것을 버전으로 안 센다" — **수정 전에도 초록이다. 아무것도 안
> 지킨다.**` 두 디렉토리의 mtime 이 **같은 밀리초**라 정렬이 안 갈렸고, `readdirSync`
> 순서상 진짜 버전이 먼저 와서 보호 자리를 지켰다. `utimesSync` 로 시간을 벌려
> 고쳤다. 재현물이 초록인 것과 방어가 있는 것은 다르고, **그 차이를 사람이 보는
> 방법은 게이트뿐이다.**

### ☑ W2-5 · D9 — 종료 경로 `[S]`

- [x] `tests/unit/audit-shutdown-sse.test.ts` — 4 케이스. **데몬을 안 띄운다** (PG 가
      필요해지고 그러면 이 판정이 도커에 매달린다). 대신 **같은 기계 부품**을 쓴다:
      진짜 `http.Server` · 진짜 `openEventStream` · 진짜 SSE 클라이언트
- [x] **빨강 확인** — `expected false to be true`. `server.close()` 가 5 초 안에 안 끝난다
- [x] `src/api/events.ts` — `EventHub.onShutdown` · `closeAll()`.
      `finish(graceful)` 이 종료 때는 `res.end()`, 나머지는 `res.destroy()`
- [x] `src/bin/barycenterd.ts` — ① `events.closeAll()` ② `server.closeAllConnections()`
      ③ `SHUTDOWN_DEADLINE_MS`(10 초) 마감. `bary-dp-agent` 와 같은 모양이다
- [x] `./scripts/verify.sh --quick` — 9/9 초록 (unit 883 → 887)
- [x] 커밋 — `Pinned-by: tests/unit/audit-shutdown-sse.test.ts -t "화면이 붙어 있어도 종료가 끝난다"`

> **빨강을 두 번 봤다** (W0-7 · W2-2 에 이어 세 번째). 처음에는
> `hub.closeAll is not a function` 이었다 — 메서드가 없다는 말이지 종료가 안 끝난다는
> 말이 아니다. **빈 `closeAll()` 을 먼저 넣고** 다시 재서 `expected false to be true`
> 를 본 뒤에 구현했다.

> **종료 등록을 스냅샷보다 앞에 뒀다** — B-06 이 `req.on('close')` 를 앞으로 옮긴 것과
> 같은 이유다. 스냅샷은 DB 를 두 번 치므로 그 사이에 종료가 시작될 수 있고, 그때
> 등록이 아직 없으면 **그 스트림만 종료에서 빠진다.**

> **왜 `res.end()` 이고 `destroy()` 가 아닌가.** 소켓을 그냥 끊으면 브라우저가
> 재연결을 시도한다(SSE 의 기본 동작). 우리가 내려가는 중이면 그 재연결은 실패하고,
> 화면은 「끊겼다」가 아니라 **「멎었다」**로 보인다. 반대로 버퍼 상한·쓰기 실패(G4)는
> **우리가 그만두기로 한** 경우라 물고 있는 바이트도 놓아야 한다 — 그래서 두 길이 갈린다.

### ☑ W2-6 · N4-b — 같은 수정이 `scripts/soak.mjs` 를 빠뜨렸다 `[XS]`

> 계획에 없었다. **W2 마무리로 소크를 돌리려다 나왔다.**

- [x] `scripts/soak.mjs` 에도 `-v ${process.cwd()}:/app:ro` 가 있었다 — W1-2b 가
      `tests/e2e/` 여섯 자리만 바꿨다
- [x] `appMount()` 를 옮겨 붙였다. **사본이 둘인 것을 그 자리에 적었다** —
      저쪽은 `.ts`, 여기는 `.mjs` 라 한 벌로 두려면 빌드 설정을 건드려야 하고,
      그 값이 두 줄짜리 인자 배열보다 크지 않다
- [x] 전 저장소 `grep` 으로 남은 자리가 없는지 확인
- [x] 커밋 — `src/` 를 안 건드린다

> ⚠️ **N4 를 고친 커밋 메시지가 *"목록으로 관리하다 물린 자리가 이미 여럿이다"* 라고
> 적어 놓고 같은 회차에 같은 실수를 했다.** 목록이 `grep` 한 번으로 나오는 것이라도,
> 그 `grep` 을 돌린 범위가 `tests/` 였다는 것이 전부다.
>
> **그리고 게이트가 이것을 안 잡는다.** `verify.sh` 에 소크가 없다 — 여기가 깨지면
> 사람이 손으로 돌릴 때까지 아무도 모른다. 그래서 N4 회차에 e2e 는 초록이 됐는데
> 여기는 그대로였다.

### ☐ W2 마무리

- [ ] `./scripts/verify.sh` 전체
- [ ] 소크를 한 번 돌려 본다 — `npm run soak`. W2 가 겨눈 것이 「오래 돌면」이므로
      짧은 스위트로는 안 보인다

---

## W3 · 멤버십 평면 — 골든이 필요하다 (도커)

**여기부터는 코드 경로 판단이 아니라 실물 측정이다.** 검수 문서 §4 가 적어 뒀듯
D3·D4 는 아직 골든으로 못 박히지 않았다 — 그것을 먼저 만든다.

### ☑ W3-0 · 무대부터 — 재시도 골든 하네스 `[M]` ← **먼저**

- [x] `tests/golden/next-upstream.test.ts` — 백엔드 둘 중 첫째를 안 띄우고 요청 넷을
      보낸 뒤 응답 코드와 `/membership/inflight` 를 양쪽 다 읽는다
- [x] **빨강 확인** — `응답 코드 ["200","502","200","502"]`
- [x] 커밋 — 테스트만. `Pinned-by: none — 재현물 커밋. 수정은 W3-1 이다`

**무대가 서자 D3 의 전제가 틀린 것이 드러났다 → N5 (검수 §8).**

재시도가 **아예 안 난다.** `balancer_by_lua_block` 을 쓰면 nginx 는
`balancer.set_more_tries(n)` 을 부른 경우에만 밸런서를 다시 부르는데, 그 호출이
저장소에 **한 번도 안 나온다**(`grep -rn set_more_tries src/` → 0 건). 그래서 죽은
백엔드로 배정된 요청은 곧바로 **502** 다 — 백엔드 둘에 round_robin 이면 **트래픽의
절반**이 죽는다.

**소크가 독립적으로 확인했다** — 다른 하네스, 6 분, 백엔드를 5 초마다 토글:
`트래픽 5712건 · 실패 536건 (9.4%)`.

> **이것이 「무대부터」의 값이다.** 고치기부터 했으면 `ngx.ctx` 에 목록을 쌓는 다섯 줄을
> 넣고 「고쳤다」고 적었을 것이다 — 그리고 그 코드는 아무 일도 안 했을 것이다.

**무대를 세우며 물린 것 둘** (다음 사람을 위해):

1. **admin 소켓을 바인드 마운트에 두면 안 생긴다.** macOS 의 Docker 바인드 마운트에는
   유닉스 소켓을 못 만든다. 증상은 「admin 창구가 연결 거부」다. e2e 가 안 물린 이유는
   거기서는 소켓이 컨테이너 안 경로(`/prefix/run`)에 살기 때문이다
2. **nginx 의 상대 `include` 는 `-p`(prefix)가 아니라 설정 파일이 있는 디렉토리
   기준이다.** `admin/` 을 `conf/` 밖에 뒀더니 glob 이 아무것도 안 잡았고, 빈 glob 은
   오류가 아니라(E62) **조용히** admin 창구가 없는 채로 떴다

### ☐ W3-1 · **N5 + D3** — 페일오버를 세우고, 그것이 깨우는 누수를 함께 막는다 `[M]`

> **범위가 바뀌었다.** 원래는 D3 하나였는데, W3-0 이 N5 를 찾았고 **둘은 같은 커밋이어야
> 한다** — `set_more_tries` 를 부르는 순간 D3 이 잠복에서 깨어난다. 아래 항목의 원문은
> 그 뒤에 그대로 둔다.

- [x] `src/conf/render.ts` — `balancer_by_lua_block` 이 `balancer.set_more_tries(#all - 1)`
      를 **첫 호출에만** 부른다. 두 번 부르면 남은 횟수가 다시 설정돼 재시도가 안 끝난다
- [x] **이미 시도한 peer 를 뺀다.** 재시도가 같은 죽은 peer 로 다시 가면 그건 재시도가
      아니라 같은 실패를 반복하는 것이다 (`ngx.ctx.bary_tried`)
- [x] 같은 커밋에서 D3 — `ngx.ctx.bary_peers` 에 **고른 peer 전부**를 쌓고
      `log_by_lua` 가 그 목록을 전부 내린다
- [x] `tests/golden/next-upstream.test.ts` 의 검사 **셋이 다 초록**
- [x] stream 평면도 같이 고쳤다
- [x] 커밋 — `Pinned-by: tests/golden/next-upstream.test.ts -t "죽은 백엔드가 있어도 모든 요청이 성공한다"`

**계획에 없던 것 — 골든 스위트를 직렬로 돌린다.**

새 파일을 넣자 `ciphers.test.ts` 가 빨개졌다(`tls12=거절`). 단독으로 돌리면 초록이다 —
**부하가 늘어 타이밍 민감성이 드러난 것**이고, 내 변경이 원인이 아니라 그 자리가 원래
아슬아슬했다.

`test:e2e` 와 `test:store` 는 **이미** `--no-file-parallelism` 이다. 골든만 빠져 있었고,
e2e 쪽 주석이 그 이유를 이미 적어 뒀다:

> vitest 는 파일을 동시에 돌리므로 … 실제로 깨졌고, **단독으로 돌리면 초록이라 원인을
> 찾기 전에 "가끔 깨진다" 로 넘어가기 쉽다.**

같은 교훈이 골든에는 안 적용돼 있었다. 붙였다.

### ☐ W3-1(원문) · D3 — `in:` 누수를 막는다 `[M]`

- [ ] W3-0 의 테스트가 빨간 것을 다시 확인한다
- [ ] `src/conf/render.ts:350` — `ngx.ctx.bary_peer = peer` 대신
      **고른 것 전부**를 쌓는다 (`ngx.ctx.bary_peers`)
- [ ] `src/conf/render.ts:1403` · `1513` — log 단계가 그 목록을 전부 내린다.
      **양 평면 다** 고친다 — 한쪽만 고치면 stream 쪽이 그대로 샌다
- [ ] `npm run test:golden`
- [ ] `./scripts/verify.sh` 전체 — 렌더 산출물이 바뀌므로 골든이 흔들린다.
      **의도한 변경인지 diff 로 눈으로 본다**
- [ ] 커밋 — `Pinned-by: tests/golden/next-upstream.test.ts -t "재시도가 inflight 를 안 남긴다"`

### ☑ W3-2 · D5 — 활성화 음성 신호를 수준으로 좁힌다 `[S]`

- [x] `tests/unit/audit-error-log-noise.test.ts` — 6 케이스. **`tests/e2e/` 가 아니다**
      (아래 근거). 실물 파일에 실물 nginx 가 적는 것과 **같은 줄**을 적는다
- [x] **빨강 확인** — `expected 5 to be +0`. 트래픽 줄 다섯이 전부 음성 신호였다
- [x] `src/dp/effects-fs.ts` — `FATAL_LEVEL` 로 `[emerg]`·`[alert]`·`[crit]` 만 센다
- [x] **옵션 이름도 바꿨다** — `probeErrorLogLines` → `probeFatalLogLines`.
      표면이 그 한 줄 움직였고 기준을 옮겼다
- [x] `src/dp/operation.ts` — `errorLogGrowth` 의 뜻이 바뀌었으므로 주석을 고쳤다.
      **이름은 그대로다** (아래 근거)
- [x] **S7 이 잡은 것이 여전히 잡힌다** — 스파이크 S7 `PASS=9 FAIL=0`.
      재현물도 `bind() … Address already in use`(`[emerg]`)를 직접 판다
- [x] `./scripts/verify.sh` 전체 — 아래 「게이트가 잡은 것 둘」 참조
- [x] 커밋 — `Pinned-by: tests/unit/audit-error-log-noise.test.ts -t "트래픽 오류가 apply 를 안 죽인다"`

**왜 e2e 가 아니라 unit 인가.** e2e 로는 **원하는 순간에 원하는 줄을 만들 수가 없다** —
백엔드를 죽여 `[error]` 를 유도해도 그것이 HUP 창 안에 들어갈지는 타이밍이 정한다.
그러면 재현물이 「가끔 빨간」 것이 되고, 이 저장소가 그 부류로 이미 여러 번 데였다.
여기서 재는 것은 `FsEffects` 가 **그 줄을 어떻게 세는가**이고, 그건 파일 하나면 충분하다.

**이름을 바꾼 것과 안 바꾼 것.** `probeFatalLogLines` 는 **주입 이음매**라, 옛 이름을
보고 「줄 수를 세면 되는구나」 하고 구현하면 그 순간 D5 가 조용히 되살아난다 — 계약이
바뀌었으면 이름도 바뀌어야 잘못 구현하는 것이 어려워진다. typecheck 가 즉시 기존
테스트 두 곳을 잡아 줬고, 그게 이름을 바꾼 값이다.

반면 `errorLogGrowth` 는 `AgentState.lastEvidence` 로 **`agent.json` 에 영속된다.**
바꾸면 업그레이드 직후 옛 파일의 값이 안 읽히고 사라지는데, 「관측 못 함」과 「0」을
섞지 않는 것이 이 층의 규칙이고 **이름 바꾸기가 그 규칙을 깨는 셈이다.**

**게이트가 잡은 것 둘.**

1. **e2e `v03-membership` 이 빨개졌다 — 내 페일오버 수정(N5)의 결과다.**
   `expected 'healthy' to be 'unhealthy'`. 그 테스트는 「B12 만 보인다」를 기다렸는데,
   전에는 그것이 곧 「프로버가 내렸다」였다 — 죽은 peer 로 간 요청이 **502 였기
   때문**이다. 페일오버가 생기자 그 기다림이 **판정 전에도 참**이 되어 그냥 지나갔고,
   뒤의 판정 단언이 경합했다. **판정 자체를 기다리도록** 고쳤다. 11/11 초록.
   > 좋은 수정이 테스트의 숨은 전제를 깬 자리다. 테스트가 재던 것(「빠졌는가」)은
   > 그대로이고, **추론 경로**가 더 이상 성립하지 않게 됐을 뿐이다.
2. **스파이크 S18 이 빨갰다 — 확률적 flake 다** (→ W3-6). 단독 재실행 `PASS=8 FAIL=0`.

### ☑ W3-3 · D4 — 퇴역 epoch 의 슬롯을 회수한다 `[L]`

- [x] `tests/golden/slot-reclaim.test.ts` — 3 케이스. **양 평면 다** 실물로 몬다
- [x] **빨강 확인** — 셋 다. http `expected 'pool_app=…' to be ''`,
      stream `expected 'pool_edge=…' to be ''`
- [x] `src/control/membership.ts` — `/membership?remove=1` (http) · `<epoch> remove`
      (stream). ACME 의 `arg_remove` 와 **같은 모양**이다
- [x] `src/control/plane.ts` — `reclaimSlots(out.removed, by)`. **판정을 다시 짓지
      않는다** — 입력이 `sweepGenerations` 가 지운 **세대 이름 그대로**이고, epoch 은
      `r<리비전>-e<epoch>` 에서 읽는다
- [x] stream 평면(`streamAdminConf`)에도 같은 동사
- [x] `bary_membership_slot_keys` 게이지 — **평면별**. `/membership/count` 와
      stream `count` 동사가 재료다
- [x] `npm run test:golden` 3/3 · `./scripts/verify.sh --quick` 9/9
- [x] 커밋 — `Pinned-by: tests/golden/slot-reclaim.test.ts -t "퇴역한 epoch 의 슬롯이 안 남는다"`

**지우는 단위가 슬롯 하나가 아니라 epoch 하나다.** ACME 는 토큰 하나를 지우는데
(`?remove=<토큰>`) 여기는 그럴 수가 없다 — 그 epoch 에 슬롯이 몇 개인지는 **부르는
쪽이 모르고**(풀 수는 모델이 정한다) 알 필요도 없다. 그래서 `?remove=1` 은 값이 아니라
플래그이고, 창구가 그 epoch 의 `slot:` 키를 훑어 지운다.

> **접두사와 접미사를 함께 본다.** `slot:` 로만 걸면 다른 키를 지울 수 있고, epoch 으로만
> 걸면 `in:`·`rr:` 이 걸린다. 재현물의 둘째 케이스가 이웃 epoch 을 안 건드리는지 잰다.

**게이지가 왜 여전히 필요한가.** 회수를 붙였다고 안 자란다는 보장은 없다 — 세대 GC 가
꺼진 배포(`keepGenerations <= 0`), 회수가 실패한 회차, 아직 모르는 자리가 남는다.
「고쳤다」와 「안 자란다」는 다르고, **자라는 것이 보여야** 다음 사람이 이 자리를 다시
만들지 않는다.

> **못 물으면 계열에서 빠진다.** admin 소켓이 아직 없거나 엔진이 Lua 없이 떴으면
> 답이 없는데, 그때 **0 을 내지 않는다** — 0 은 「안 자란다」로 읽히고 그건 우리가 모르는
> 것에 대한 주장이다. `certificateExpiry` 가 만료를 모를 때 0 을 안 내는 것과 같은 규칙이고,
> `renderMetrics` 가 표본 없는 계열을 통째로 빼 준다.

**무대를 세우며 또 물린 것:** 템플릿 리터럴 안의 **백틱을 escape 안 했다.** conf 전체가
템플릿 리터럴이라 주석에 적은 `` `slot:` `` 이 리터럴을 끝냈고, typecheck 가 TS1005 로
잡았다. 기존 주석들이 전부 `\`in:\`` 로 적혀 있던 이유가 그것이다.

### ☑ W3-4 · N4 후속 — 「데몬이 안 떴다」가 이유를 말하게 한다 `[S]`

> W1-2b 가 남긴 것. 진단을 막은 것은 `apk add` 의 `>/dev/null` 이 아니라 **실패 경로에
> 아무 출력이 없는 것**이었다 — `docker logs --tail 40` 이 빈 문자열이라 원인이
> 어디에도 안 드러났고, 컨테이너를 손으로 다시 띄워 `set -x` 를 걸고서야 나왔다.

- [x] `tests/e2e/daemon-up.ts` — 다섯 자리를 `waitForDaemon` 하나로 모았다
      (`mounts.ts`·`pg-ready.ts` 와 같은 이유)
- [x] 로그가 비었을 때 **상태·종료 코드·OOM·에러**를 함께 싣는다. 그리고
      **「비어 있다」를 명시한다** — 빈 문자열을 이어 붙이면 읽는 사람은 로그를 못 받은
      것인지 로그가 없는 것인지 모른다. N4 를 진단할 때 정확히 그 자리에서 막혔다
- [x] `tests/e2e/audit-daemon-diagnosis.test.ts` — 5 케이스, **실물 도커**.
      일부러 못 뜨는 컨테이너 넷(조용히 죽음 · 로그 있고 매달림 · 정상 종료 ·
      컨테이너 없음)과 「뜨면 아무 말 안 함」
- [x] `v02-capability` 의 죽은 `waitFor`·`sleep` 을 지웠다 — 쓰는 데 없는 헬퍼를
      남기면 다음 사람이 그것으로 새 기다림을 만들고, 그러면 진단이 다시 갈린다
- [x] `npm run test:e2e`
- [x] 커밋 — `src/` 를 안 건드리므로 재현물 게이트는 건너뛴다

**상태가 서로 다른 이야기를 한다** — 그게 이 진단의 값이다:

| 상태 | 뜻 |
|---|---|
| `running` + 로그 없음 | 아직 `apk add` 중이거나 **어딘가 매달렸다** |
| `exited 1` + 로그 없음 | `set -e` 가 조용히 죽은 명령에서 끊었다 — **N4 가 그랬다** |
| `exited 0` | 스크립트가 끝나 버렸다. `exec` 가 빠졌다는 뜻이다 |
| 컨테이너 없음 | `docker run` 자체가 실패했다 |

> `docker inspect`·`logs` 가 실패해도 **진단이 예외로 바뀌지 않는다.** 진단을 만들다
> 던지면 원래 실패가 사라진다 — 재현물의 넷째 케이스가 그것을 잰다.

### ☑ W3-5 · 소크 관측 — `agent.json` 의 성장 `[M]` — **결함이 아니었다**

> W2 마무리의 소크가 낸 숫자다. 6 분 · 설정 변경 37 회에 `agentStateKb` 가
> **6 → 147** 로 자랐고, 같은 실행에서 `generations`·`generationKb`·`rssMb` 는 전부
> 평탄해졌다. 그래서 **「상한이 없다」로 읽었다.**

- [x] 재 봤다. **평탄해진다:**

      | n | total | completed | #completed |
      |---|---|---|---|
      | 50 | 56,593 | 48,891 | 150 |
      | 175 | 76,667 | 66,817 | **192** ← 여기서 멈춘다 |
      | 400 | 76,668 | 66,817 | 192 |

- [x] `COMPLETED_RETENTION`(64 전환 × 단계 3 = 192 항목)에서 상한이 걸린다.
      **소크는 37 회뿐이어서 그 창에 못 닿았고, 내가 램프업을 무한 성장으로 읽었다**
- [x] `tests/unit/audit-agent-state-growth.test.ts` — 「자라나」가 아니라
      **「어디서 멈추나」**를 못 박는다. 200 회와 400 회의 **항목 수가 같아야** 한다
- [x] 검수 문서 §8 의 틀린 단정을 고쳤다
- [x] 커밋

**틀린 판단을 남기지 않는 것이 이 항목의 산출물이다.** 그리고 재현물은 여전히 값이
있다 — 이 저장소가 **이 축을 이미 한 번 열었기 때문**이다. `prune` 의 주석:

> 48차 이전에는 키에 토큰이 없어 재발급이 **같은 키를 덮어썼으므로** 이 축이 없었다.
> 내가 키를 바꾸면서 그 축을 열었다. **"자리를 다 안 센다" 의 재연이다.**

그때 실측이 「재발급 80 회에 240 항목, 160 회에 480 — 정확히 선형」이었다. 새 축이
열리면 이 파일이 그것을 잡는다.

> **바이트가 아니라 항목 수로 잰다.** 바이트는 epoch 자릿수가 늘면 움직이지만
> (`gen-200` → `gen-400`), 항목 수는 보존 창이 서는지에만 반응한다. 절대 상한은
> 128 KB 로 따로 둔다 — 지금 평탄값이 ~77 KB 이고, 축이 하나 열리면 실측처럼
> 선형이 되어 금방 넘는다.

### ☑ W3-6 · 스파이크 S18 이 ~2% 확률로 빨갛다 `[S]`

> W3-2 의 전체 게이트에서 나왔다. 단독 재실행은 `PASS=8 FAIL=0`.

```
FAIL  fail  예외: ACME 400 …:badNonce: JWS has an invalid anti-replay nonce
```

- [x] Pebble 은 nonce 를 **20% 거부**하도록 세워져 있고 `nonceRetries` 는 5 다.
      한 요청이 여섯 번 연속 거절될 확률은 `0.2^6 = 6.4e-5` 인데, 한 회차에 요청이
      **수백 개**다(`nonce.control` 이 상한 300 까지 주문한다) — 합치면 **~2%**
- [x] **㉡ 을 골랐다.** ㉠(거부율을 낮춘다)은 ② 가 재는 것을 바꾼다 — 그 거부율이
      곧 ② 의 무대다
- [x] `tracked()` 의 기본값을 `SPIKE_NONCE_RETRIES = 30` 으로. `0.2^31 ≈ 4e-22` 이고
      흔한 경우의 비용은 없다(기대 재시도가 요청당 0.25 회, Pebble 은 같은 호스트)
- [x] **②·③ 은 그 기본값을 안 쓴다.** 그 둘이 재는 것이 바로 재시도 예산이라 각자
      값을 명시한다 — ② 는 `nonceRetries: 5`(제품 기본값), ③ 은 `0`
- [x] ② 에 **남는 거짓 빨강(~1e-3)을 메시지에 적었다.** 더 낮추려면 재시도를 늘려야
      하는데 그러면 재는 대상이 사라진다 — 숨기지 말고 드러낸다 (③ 이 하는 것과 같다)
- [x] 4 연속 `PASS=8 FAIL=0`
- [x] 커밋 — `src/` 를 안 건드린다

> ⚠️ **이건 우리 코드의 결함이 아니다.** 그래도 ~2% 로 빨간 게이트는 *"가끔 깨진다"* 를
> 가르치고, 이 저장소는 그것을 이미 여러 번 대가로 치렀다.

**③ 이 이미 같은 교훈을 적어 뒀다.** `nonce_norety` 의 주석:

> 재시도를 끈 클라이언트로 그냥 `register()` 를 부르면 20% 확률로 거기서 죽고,
> 그러면 **시나리오가 무작위로 빨개진다** — 간헐적으로 깨지는 게이트는 없느니만 못하다.

**그 판단이 `tracked()` 의 기본값에는 안 적용돼 있었다.** 한 시나리오에서 배운 것을
하네스로 옮기지 않으면 다음 시나리오가 같은 자리에서 다시 물린다.

### ☐ W3 마무리

- [ ] `./scripts/verify.sh` 전체 (도커 포함)
- [ ] 골든 재생성 — W3-1 과 W3-3 이 렌더를 바꾼다. **한 번에 모아서** 한다
- [ ] `STATUS.md` 의 스위트 수치를 **실측으로** 맞춘다 (옮겨 적은 값은 늘 낡는다)

---

## W4 · 결정이 먼저다 — 손대기 전에 답을 정한다

아래는 **고치는 방법이 여럿이고 그 선택이 계약을 바꾼다.** 코드부터 쓰면
되돌리는 비용이 크다. 각 항목은 「무엇을 정해야 하는가」로 적었다.

### ☑ W4-1 · D2 — 멤버십 평면의 가중치 `[L]` ← **이 블록에서 제일 크다**

**정할 것:** 세 안 중 하나.

| 안 | 무엇이 바뀌나 | 대가 |
|---|---|---|
| ㉠ 슬롯에 가중치를 싣는다 (`host:port\|w`) | admin 와이어 문법 · Lua 선택 로직 | 계약이 넓어진다. dict 값이 길어진다 |
| ㉡ 슬롯 목록을 가중치만큼 반복 | `slotsOf` 한 곳 | 가장 싸다. **dict 크기를 먹는다** — D4 의 절벽과 같은 자원 |
| ㉢ 안 고치고 plan 이 말한다 | `capabilityWarnings` 한 줄 | 거짓말은 아니게 된다. **가중치는 여전히 안 걸린다** |

- [x] **㉡ 을 골랐다.** 근거를 `DESIGN.md` **§7.3.1** 에 적었다
- [x] 재현물 `tests/unit/audit-backend-weight-slots.test.ts` — 7 케이스.
      **빨강 확인** 넷 (`expected {…:1} to deeply equal {…:3}` 등)
- [x] `src/control/membership.ts` — `weightedSlots()`
- [x] 단위·conformance 1381 · 멤버십 골든 8/8 초록
- [x] 커밋

**㉠ 을 안 고른 이유가 결정적이다.** peer 문자열은 슬롯에만 사는 게 아니라
`in:<peer>` 카운터와 `/membership/inflight` 의 **질의 키**이기도 하다. 거기에
`|w` 접미사가 생기면 **벗기는 자리가 넷**이 되고, 그건 *"자리가 둘이면 언젠가 갈린다"*
를 새로 만드는 것이다. ㉡ 은 와이어를 안 건드린다.

**㉡ 의 대가(dict 크기)는 이 회차에 관리 가능해졌다** — D4 가 회수를 붙였고
`bary_membership_slot_keys` 가 자라는 것을 보여 준다.

셋을 지킨다:

1. **GCD 로 나눈다** — `2:4` 와 `1:2` 는 같은 뜻이고, 안 나누면 dict 를 두 배 먹는다
2. **상한(`SLOT_EXPANSION_CAP = 256`)** — 해독기가 `weight` 를 1..1,000,000 으로 받고
   **그 범위를 안 좁힌다**(`modelAt` 이 옛 리비전을 같은 해독기로 읽으므로 좁히면
   롤백이 막힌다, D7). 막을 자리는 확장 쪽이다
3. **사본을 고르게 섞는다** — 뭉쳐 두면 `round_robin` 의 순차 순회가 무거운 peer 에게
   **연속으로** 몰아준다. 비율은 맞고 버스트가 생긴다

> **가중치가 전부 1 이면 산출물이 글자 그대로 같다.** GCD 가 1 이고 사본이 하나씩이라
> 정렬된 목록이 그대로 나온다 — 안 쓰는 배포의 거동이 안 바뀐다는 뜻이고, 그게 이
> 수정이 안전한 이유다. 재현물이 그것을 따로 못 박는다.

> **상한 산술을 한 번 틀렸다.** `max(1, round(c * CAP / total))` 로 뒀더니
> `1:1000000` 에서 합이 **257** 이 됐다 — 무거운 쪽이 256 으로 반올림되고 가벼운 쪽이
> 하한 1 을 받아 서로 밀었다. 예산에서 **한 칸씩 먼저 떼고 남은 것만 비례 배분**하도록
> 고쳤다. peer 수가 상한보다 많으면 상한을 포기하고 한 칸씩 준다 — **백엔드를 빼는 것은
> 장애이고 dict 를 더 쓰는 것은 비용이다.**

### ☑ W4-2 · D12 — 엔진 생사를 나타내는 창구 `[M]`

- [x] **`/readyz` 를 새로 냈다.** `/healthz` 는 안 바꿨다
- [x] `ControlPlane.readiness()` — `dataplane`(드라이버가 답하는가) ·
      `engine`(admin 소켓이 답하는가)
- [x] `tests/unit/audit-readyz.test.ts` — 6 케이스 (계약: 상태 코드·본문·무인증)
- [x] `tests/e2e/v02-capability.test.ts` — **실물 nginx 를 죽이고** 잰다.
      `/readyz` 503 · `/healthz` 200
- [x] `deploy/Dockerfile` 에 `HEALTHCHECK`(`/readyz`),
      `deploy/docker-compose.yml` 에 `restart: unless-stopped`
- [x] `./scripts/verify.sh --quick` 9/9 (unit 895 → 908)
- [x] 커밋

**`/healthz` 를 안 바꾼 이유.** 그건 **순수 liveness** 이고 오케스트레이터는 그걸 보고
**프로세스를 죽인다.** 엔진 상태를 넣으면 의존성 장애가 곧 재시작이 되고, 재시작해도
엔진은 그대로라 **재시작 루프**가 된다. 뜻이 다른 두 질문이라 창구도 둘이다.

**예상한 대가가 안 생겼다.** 투두는 「API 표면이 하나 는다」를 적었는데
`node scripts/freeze-b.mjs --check` 가 `ok B freeze 44 routes` 그대로다 — 프로브는
스코프 표 **밖**에 사는 것이 맞는 자리이고(`/healthz` 가 그렇다), B 게이트는
`route()` 표를 읽는다. 숨긴 것이 아니라 안 생긴 것이다.

> ⚠️ **「못 물었다」와 「죽었다」를 가르는 것이 이 창구의 전부다.** 원격 드라이버
> 배포에는 옆에 엔진이 없어서 admin 소켓에 못 붙는 것이 **정상**이고, 로컬에서 못 붙는
> 것은 **엔진이 죽은 것**이다. 둘을 접으면 창구가 아무 말도 안 한다. 가르는 신호는
> **드라이버의 종류**다 — 소켓 파일의 유무로는 못 가른다(nginx 는 정상 종료에 소켓을
> 지우고 `SIGKILL` 에는 남긴다).

> **세대 대조는 여기서 안 한다.** 엔진이 답하는 세대와 우리가 게시한 것이 다를 수
> 있지만, 전환 중이면 정상이고 아니면 `reconcile` 이 판정한다 — **이미 있는 판정을
> 다시 짓지 않는다**(D4 에서 내린 것과 같은 판단).

> **`HEALTHCHECK` 에 liveness 가 아니라 readiness 를 건다.** 도커의 `HEALTHCHECK` 는
> 컨테이너를 안 죽이고 `unhealthy` 로 표시만 하므로, 거기 맞는 것은 readiness 다.
> compose 의 `depends_on: service_healthy` 와 로드밸런서가 그것을 읽는다.

### ☑ W4-3 · D14 — 인증서 선택 규칙 `[S]`

- [x] **정확일치 우선(㉠)** 을 골랐다
- [x] `tests/unit/audit-cert-specificity.test.ts` — 6 케이스.
      **빨강 확인** 둘 (`expected 'wild' to be 'exact'`)
- [x] `src/conf/render.ts` — `coverScore()` 로 **제일 잘 덮는 것**을 고른다
- [x] `./scripts/verify.sh --quick` 9/9 (unit 908 → 914) · TLS 골든 13/13

**㉡(겹치는 바인딩을 막는다)은 못 쓴다.** 그쪽이 이 저장소의 기본 취향(표현 불가능하게
만든다)이지만, 막는 자리가 `validateModel` 인데 **`render()` 가 그것을 부르고 롤백은
렌더를 지난다** — 겹치는 바인딩이 든 옛 리비전이 렌더 불가가 되어 **롤백이 막힌다.**
`assertDirectiveStrings` 의 머리말이 같은 함정을 이미 적어 뒀고, D7 이 그 대가를
실측했다.

**㉠ 의 값은 「설명할 것이 없다」이다.** nginx 의 `server_name` 우선순위 그대로라
(정확일치 → 긴 와일드카드 → 짧은 와일드카드), `server_name` 이 고르는 server 와
`ssl_certificate` 가 고르는 인증서가 **같은 근거로** 갈린다.

> **동점 tie-break 을 안 만들었다.** 같은 특정성이려면 같은 호스트 문자열이어야 하고,
> 그건 `sni_binding_conflict` 가 이미 막는다 — 여기서 규칙을 발명하면 *"도달 불가한
> 방어는 방어가 아니라 죽은 코드"* 를 하나 더 만드는 셈이다. 대신 **그 사실을 재현물이
> 못 박는다**: 나중에 검증기가 느슨해지면 그 검사가 먼저 빨개진다.

### ☑ W4-4 · G2 — CSP `script-src` `[S]`

- [x] **산출물을 실제로 열었다.** 9 개 페이지가 전부 같다:
      인라인 `<script>` **하나**(SvelteKit 부트스트랩, `nonce` 없음) ·
      인라인 `style="display:contents"` **속성 하나**(`<style>` 블록은 없음) ·
      나머지 JS·CSS 는 외부 파일 · **구글 폰트 두 출처를 참조**
- [x] `tests/unit/audit-csp.test.ts` — 7 케이스. **빨강 확인** 넷
- [x] `src/web/serve-gui.ts` — HTML 을 서빙할 때 **그 바이트에서 해시를 유도**한다
- [x] `./scripts/verify.sh --quick` 9/9 (unit 914 → 921)

**해시를 베껴 적지 않는다.** 인라인을 허용하는 길 셋 중 `'unsafe-inline'` 은 정책의
뜻을 없애고, nonce 는 서빙 때 HTML 을 다시 써야 해서 정적 서빙을 버리는 것이다. 남는
해시는 **빌드마다 바뀐다** — 모듈 파일 이름이 내용 해시이고 SvelteKit 의 전역
이름(`__sveltekit_abh1v7`)도 빌드마다 다르다. `headers.ts` 에 박아 두면 **다음 빌드에
화면이 죽는다.** 파일 경로+mtime+크기로 캐시하되, 빌드가 바뀌면 자동으로 다시 뽑는다 —
**사람이 갱신할 것이 없어야 한다.**

**「깨진 자리를 근거로」를 실제로 적용했다.** `'self'` 만 두려다 산출물이
`https://fonts.googleapis.com` 스타일시트와 `https://fonts.gstatic.com` 폰트를
참조하는 것을 발견했다 — 그것만 열었다. 지어낸 것이 아니라 **참조하니까 연 것**이고,
그 사실이 바뀌면 재현물이 먼저 빨개진다(폰트를 자기 자산으로 들이면 정책도 좁아져야
한다는 검사를 넣었다).

> ⚠️ **외부 폰트는 결정이지 사실이 아니다.** 출처가 하나라도 열려 있으면 그만큼 이
> 화면이 남의 가용성에 매달린다. 지금 상태를 정확히 적어 두는 것이 다음 사람이 그
> 결정을 할 재료다 — 코드 주석에도 같은 말을 남겼다.

> **`style-src` 만 `'unsafe-inline'` 이다.** `style="display:contents"` 는 **속성**이라
> 해시로 못 잡고(CSP3 의 `'unsafe-hashes'` 는 지원이 고르지 않다), 스타일 속성으로 할
> 수 있는 것은 스크립트와 급이 다르다. 스크립트는 해시로 잠근다.

### ☑ W4-5 · G1 — SSE 재연결 `[M]`

- [x] **스냅샷 재요청**을 골랐다. `Last-Event-ID` 를 안 쓴다
- [x] `src/web/reconnect.ts` — `backoffMs(attempt)`. 지수 · 상한 30 초 · **양쪽 지터**
- [x] `gui/src/lib/desk.svelte.ts` — `connect()` 가 재연결 루프를 돈다
- [x] `tests/unit/audit-sse-reconnect.test.ts` — 6 케이스
- [x] `npx vite build` · `./scripts/verify.sh --quick` 9/9 (unit 921 → 932)

**전에는 재연결이 아예 없었다.** 스트림이 끝나면 `live = false` 만 하고 끝났다 —
망이 잠깐 끊기거나 데몬이 재기동하면 **화면이 그 자리에서 멈추고 다시는 안 살아난다.**
운영자는 그것이 「아무 일도 안 일어나는 중」인지 「연결이 죽은 것」인지 알 수 없고,
**이 화면은 트래픽을 바꾸는 데 쓰인다.**

**`Last-Event-ID` 를 안 쓴 이유.** 버퍼는 새 상태이고, 버퍼는 반드시 유한하므로
**간격이 크면 스냅샷으로 돌아가야 한다** — 즉 그 길은 **두 경로를 다 구현**하는 것이다.
스트림은 열릴 때 언제나 전체 스냅샷을 주므로 재연결 = 새 스냅샷 = 일관된 상태이고,
이건 **구성상 옳다**(빠뜨릴 이벤트라는 개념이 없다). 덜 구현하면서 절대 안 틀리는
쪽을 고른다 — 버퍼는 「자라는 것에 상한이 없다」와 「조용히 빠뜨린다」를 동시에
들여오는데, 이 저장소는 그 둘로 이미 여러 번 물렸다.

> **루프에 결함이 하나 있었고 쓰면서 잡았다.** 처음엔 `live` 로 「붙었었는가」를
> 가르려 했는데, `finally` 가 그것을 내리므로 돌아온 시점에는 **언제나 `false`** 다.
> `streamOnce` 가 `served`·`refused`·`stop` 셋을 돌려주게 바꿨다.

> **붙었다 끊긴 것과 못 붙은 것을 가른다.** 붙었었다면 다음 재시도는 처음부터다 —
> 안 그러면 잠깐씩 자주 끊기는 망에서 대기가 끝없이 길어진다. 401 은 다시 붙어 봐야
> 같으므로 **안 붙는다**(사람이 고칠 것이다).

> **지터를 양쪽으로 준다.** 화면이 여럿이면 전부 같은 순간에 다시 붙고, 그게 재기동
> 직후의 데몬에 제일 나쁜 순간이다. 한쪽으로만 주면 평균이 밀린다.

### ☑ W4-6 · G5 — 테스트용 가짜를 `dist` 에서 뺀다 `[M]`

- [x] `src/testing/apply-fakes.ts` 로 옮겼다 — `CrashInjected` · `CrashClock` ·
      `classifyWrite` · `FaultStore` · `FakeEffects`
- [x] `tsconfig.build.json` 에 `"exclude": ["src/testing"]`
- [x] `reachable.mjs` — ALLOW 의 심볼 항목을 지우고 **구조로** 갈랐다
- [x] `node scripts/surface.mjs --check` — **표면 그대로** (117 심볼)
- [x] 테스트 23 파일의 import 를 옮겼다
- [x] `./scripts/verify.sh --quick` 9/9 · **스파이크 S12 `PASS=5 FAIL=0`**

**투두가 예상 못 한 제약이 하나 있었다: `spike/s12/runner.mjs` 가 `dist/dp/apply.js`
에서 `CrashClock`·`FaultStore` 를 가져온다.** 컨테이너 안에서 도는 **빌드 산출물**을
쓰기 때문이고(소스를 직접 못 돌린다), 그러니 이 파일들도 어딘가로는 빌드돼야 한다.

`tsconfig.testing.json` 을 새로 두고 `dist-testing/` 으로 낸다. **배포 이미지는
`dist/` 만 복사하므로**(`deploy/Dockerfile`) 거기 안 실린다 — 목적은 그대로 달성된다.

> **예외를 심볼이 아니라 구조로 바꿨다.** 전에는 `FakeEffects` 하나가 ALLOW 에 있었는데,
> 옮기고 나니 `FaultStore`·`CrashClock`·`publishedGeneration` 이 함께 걸렸다 —
> **예외를 심볼로 적으면 형제가 생길 때마다 예외가 는다.** `src/testing/` 을 통째로
> 뺀다. `tsconfig.build.json` 도 같은 경계를 쓰므로 **한 사실을 두 곳이 같은 말로
> 말한다.** 도달성 예외가 22 → 21 로 줄었다.

**게이트가 둘을 잡았다.**

1. **도달성**이 옮기고 남은 죽은 import 셋(`AgentState`·`DurableStore`·`StoredState`)을
   잡았다. 옮기면 원본에서 안 쓰이게 되는데, 그건 눈으로는 안 보인다
2. **`census-identity`** 가 신원 비교 자리 20 → 19 를 잡았다. 줄어든 이유가 「자리가
   사라졌다」가 아니라 **「프로덕션이 아니게 됐다」**다 — 그 근거를 코드에 적고 숫자를
   내렸다. 그 계측기의 머리말이 요구하는 그대로다

### ☑ W4-8 · D21 — ACME 계정을 만드는 경로 `[M]` ← **W4 에서 제일 크다**

**정할 것:** 계정 등록을 어느 표면에 낼 것인가.

지금은 `acme_accounts` 에 넣는 코드가 `upsertAccount` 하나이고 **호출자가 테스트뿐이다.**
계정이 없으면 러너가 경고 한 줄 찍고 건너뛰므로, 새 배포에서 **ACME 가 통째로 도달
불가**다. G6 의 게이트가 켜지자마자 짚었다.

| 안 | 대가 |
|---|---|
| `POST /api/v1/acme/accounts` | **B 동결 드리프트다** — 라우트 표가 움직인다. 그 대신 GUI·CLI 가 같은 길을 쓴다 |
| `bary acme account create` | 표면이 CLI 에만 산다. GUI 에서는 못 만든다 — 제품 명제가 GUI 인데(§2) |
| 기동 환경변수 | 표면이 안 움직인다. 계정이 **설정이 아니라 배포**가 되고, 그러면 리비전·감사·롤백 밖에 산다 |

- [x] **REST 를 골랐다.** 근거를 `DESIGN.md` **§8.2.1** 에 적었다
- [x] `tests/store/audit-acme-account-path.test.ts` — 7 케이스, **실물 PG**.
      **빨강 확인** 다섯 (`no_route`)
- [x] `POST /api/v1/acme/accounts` · `GET /api/v1/acme/accounts`
- [x] `AcmeStore.accounts()` — 개인키 참조를 안 낸다
- [x] `scripts/reachable.mjs` 의 **부채 항목을 지웠다** (예외 21 → 20)
- [x] `node scripts/freeze-b.mjs --write` — 44 → **46 라우트**. diff 가 그 둘뿐이다
- [x] `./scripts/verify.sh --quick` 9/9

**CLI 만 두는 것은 제품 명제와 어긋난다.** §2 가 이 제품을 GUI 로 세웠는데, 인증서
자동 갱신을 켜려면 셸에 들어가야 한다면 그 명제가 그 자리에서 깨진다. REST 를 내면
CLI·GUI 가 **같은 길**을 쓴다.

**환경변수는 계정을 리비전·감사·롤백 밖으로 내보낸다.** 계정은 개인키를 들고 CA 와의
신원을 정한다. 배포 아티팩트가 되면 「누가 언제 만들었나」가 어디에도 안 남고, 바꾸려면
재기동해야 한다.

**B 표면이 움직이는 것은 대가이지 반대 근거가 아니다.** 그 게이트는 표면이 느는 것을
**보이게** 하려고 있지 막으려고 있는 것이 아니다.

> **재현물이 「창구가 생겼는가」를 안 잰다.** 그것만 재면 「필드는 있는데 아무도 안
> 읽는다」를 새로 만들 뿐이고 — **이 결함 자체가 그 부류였다.** 만든 계정으로
> **러너가 실제로 주문을 여는지**를 잰다.

> **CA 등록은 창구가 안 한다.** 원장에 적고 키를 만들 뿐이고 `newAccount` 는 러너가 첫
> 주문 때 부른다. 창구가 CA 를 기다리면 CA 가 느린 날 계정을 못 만들고, 그건 **관측
> 못 한 것을 실패로 접는 것**이다. 대신 목록이 `registered` 를 낸다 — 그 차이가
> 보여야 「왜 아직 안 됐나」를 물을 수 있다.

> **또 가짜가 실물보다 좁았다** (이 회차에 네 번째). 테스트 하네스가 `store` 를 빈
> 객체로 줬는데 창구가 감사에 남기므로 `api.store.audit is not a function` 이 났다.
> 실물 `ConfigStore` 로 바꿨다 — 가짜가 좁으면 **감사에 남는가**를 못 잰다.

### ☑ W4-7 · G7 — 작은 것 넷 `[S]`

- [x] `tests/unit/audit-small-four.test.ts` — 16 케이스. **빨강 확인** 다섯
- [x] **① `readManifest`** 가 `JSON.parse` 를 감싸고 `files`·`digest` 를 검증한다
- [x] **② `parseListen`** — `URL` 로 바꿔 IPv6 를 표현한다. **데몬이 그것을 쓴다**
- [x] **③ `build.sh`** 가 `gui/package-lock.json` 의 해시를
      `gui/node_modules/.bary-lock` 에 적고 대조한다
- [x] **④ `bary-dp-agent` 배포 조리법** — **안 넣기로 하고 근거를 적었다**
- [x] **⑤ 진입점 퍼미션 게이트** — `verify.sh` 에 넣었다 (빌드 뒤라 `--quick` 밖)
- [x] `./scripts/verify.sh --quick` 9/9 (unit 932 → 948)

**① 은 「빈 목록을 대조해 초록」이 진짜 위험이었다.** 스키마 번호만 보면 `{"schema":1}`
이 통과하고, 그러면 `verifyGeneration` 이 **아무 파일도 안 보고 「맞다」**고 답한다 —
없는 검사보다 나쁘다. 그리고 raw `SyntaxError` 는 호출자의 `GenerationError` 분기에
안 걸려 **apply 가 「알 수 없는 오류」로 끝난다.**

**② 는 실패가 조용한 쪽이다.** `[::1]:8088` 을 콜론으로 쪼개면 port 가 `''` 이고
`Number('')` 은 `0` — **무작위 포트가 열린다.** `127.0.0.1:abc` 는 `NaN` 이고 그것도
무작위 포트다. 둘 다 **기동이 성공한 것처럼 보이고** 그 뒤로 아무도 못 붙는다.
`URL` 을 쓰는 이유는 대괄호 문법을 그것이 이미 알기 때문이다 — 직접 파싱하면 규칙이
두 벌이 되고, 이 저장소가 `upstreamName`(D18)에서 그것으로 물렸다.

**④ 는 안 넣기로 했다.** 이 compose 는 **한 대짜리 데모**다(`demo-backend` 주석이
*"제품의 일부가 아니다"* 라고 적어 뒀다). 원격 모드는 CP 와 DP 를 **다른 호스트**에
두는 것인데, 한 compose 에 넣으면 둘이 같은 도커 네트워크에 있게 되고 **그 구성이 재는
것은 원격이 아니다** — *"흉내로 재면 흉내를 재게 된다"*. 그리고 원격 모드에 정말
필요한 것은 compose 가 아니라 **인증서 셋**인데, 키 배포는 배포 환경이 정할 일이다.
**계약은 코드에 있다**: `bary-dp-agent.ts` 머리말의 환경변수 일곱과, 그 구성을
**실물로 세워 돌리는** `tests/e2e/agent-in-container.test.ts`. 문서가 아니라 도는 것이
답한다.

> **⑤ 는 「함수만 있고 아무도 안 쓴다」를 안 만드는 것이 핵심이었다.** `parseListen`
> 을 만들고 데몬이 계속 `split(':')` 을 쓰면 이 검수가 반복해서 잡는 부류를 **새로
> 만드는 것**이다. 배선까지 하고, 퍼미션 게이트는 `verify.sh` 에 넣어 도는 것으로 만들었다.

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
| N4 | High | W1-2b (닫힘) · 후속 W3-4 | S |
| N4-b | Medium | W2-6 (닫힘) | XS |
| **N5** | **High** | **W3-1** (무대는 W3-0 에서 닫힘) | M |
| 소크 관측 | Medium | W3-5 | M |

**34 개 전부 배정됐다.** D21 · D22 는 **수정 중에 G6 의 게이트가 찾은 것**이라 검수
문서 §6 에 따로 적었다 — 손으로 훑은 목록에는 없던 것들이다. D20 은 검수 문서 §4 에 적힌 대로 직전 회차(`b8c7eb2`)가
`pruneTerminal` 로 닫았으므로 여기 없다.

**N4 는 W0 마무리가 찾았다** — 전체 `verify.sh` 를 처음 끝까지 돌린 회차다. 검수
문서 §7 에 적었다. 목록에 없던 것을 게이트가 찾은 것이 이 회차에 세 번째다
(D21 · D22 · N4), 그리고 **셋 다 손으로 훑을 때는 안 보이는 부류**였다.

### 블록별 무게

| 블록 | 항목 | 무엇을 닫나 | 도커 |
|---|---|---|---|
| W0 | 9 | 배선 결손. **High 하나가 여기 있다** | 마무리에만 |
| W1 | 4 (+N4) | 경계 해독기 — 새 표면이 규칙 밖 | 실물 PG 둘 · 도커 |
| W2 | 5 | 자원 상한과 수명 | 소크 |
| W3 | 4 | 멤버십 평면 — **코드 판단을 측정으로 바꾼다** | 전부 |
| W4 | 7 | 결정이 먼저인 것 | 항목마다 |

### 어디서 멈춰도 되는가

- **W0 까지**면 개인키를 지울 수 있는 결함이 닫힌다. 이것만 해도 값이 있다
- **W1 까지**면 새 표면이 이 저장소의 규칙 안으로 들어온다
- **W3 까지**면 검수 문서 §4 가 적어 둔 *"코드 경로로만 세운 판단"* 이
  측정으로 바뀐다 — D3·D4 가 골든에 박힌다
- **W4 는 결정이 먼저다.** 답을 안 정하고 코드부터 쓰면 되돌리는 비용이 크다

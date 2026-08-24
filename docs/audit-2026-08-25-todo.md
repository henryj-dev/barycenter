# 투두 — 전수 점검 수정 (2026-08-25)

**무엇이 문제인가**는 [`../CODE_AUDIT_REPORT.md`](../CODE_AUDIT_REPORT.md) 에 있다.
여기서는 안 되풀이한다 — 각 항목의 첫 줄이 그 문서의 절 이름을 가리킨다.

대상 커밋은 보고서와 같다 — `39fe68b`. 그 이후 `origin/main` 에 얹힌 세 커밋
(`9a5c58f` · `a418146` · `da5ab08`)은 훅·워크트리 스크립트뿐이라 `src/` 는 바이트가 같다.

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
- [ ] `.claude/worktree-bootstrap.md` 를 읽는다
- [ ] `git fetch origin && git log --oneline -1 origin/main` — 기준선을 적어 둔다
- [ ] `npm run verify:quick` 이 **초록**인지 먼저 본다. 기준선이 빨간 상태로 시작하지 않는다
      (보고서 「검증 결과」가 unit 955 / conformance 479 를 적어 뒀다 — 그 숫자에서 출발한다)
- [ ] V2·V3 에 들어가기 전에 `docker info` 를 확인한다 — e2e 다섯 파일과 소크가
      실물 컨테이너를 띄우고, 두 블록 다 그것을 건드린다

---

## 하지 말 것 — 이미 반증된 넷

보고서 「반증된 지적」 절이 1차 보고서의 네 건을 **철회**했다. 다시 손대지 않는다.
누가 또 지적하면 아래 테스트를 돌려 보이는 것이 답이다.

| 하지 말 것 | 왜 | 초록인 재현물 |
|---|---|---|
| `events.ts` 를 `res.write()` 반환값 + `drain` 추적으로 바꾸기 | `writableLength` 가 소켓 버퍼를 **포함**한다 — 현재 코드가 그 불리언보다 상위 정보다 | `tests/unit/audit-stream-caps.test.ts` (4) |
| SSE 종료 훅 추가 | `events.ts:159` 가 스냅샷 조회 **앞에** 이미 등록한다 | `tests/unit/audit-shutdown-sse.test.ts` (4) |
| 헬스 프로브 조기 종료 정리 | 이미 고친 코드다 — 헤더 시점 판정 + `res.destroy()` (`health.ts:141~142`) | `tests/unit/audit-probe-body-cap.test.ts` (7) |
| 원격 DP 응답에 `settled` 플래그 | `reject` 중복은 프로미스에서 no-op, `r.destroy()` 가 Agent 풀에서 소켓을 뺀다 | `tests/unit/audit-remote-decode.test.ts` |

> 이 표를 지우지 말 것. 1차 보고서가 이 넷을 [높음]·[중간~높음]·[중간]으로 올렸고,
> 근거로 든 *"테스트 타임아웃"* 은 대상 커밋에서 **사실이 아니었다.**
> 같은 값을 두 번 치르지 않는다.

---

## D · 결정이 먼저다 — 코드 앞에 `DESIGN.md` 를 고친다

`CONTRIBUTING.md` 가 못 박은 것: *"A behaviour change starts in `DESIGN.md`, not in `src/`."*
아래 둘은 **동작을 바꾸는 것**이라 설계에 자리가 먼저 있어야 한다. 결정이 안 서면
V2·V3 에 손대지 않는다 — 되돌리는 비용이 코드보다 크다.

### ☐ D-1 · 평문 노출을 어떻게 다룰 것인가 `[L]` (문서만)

보고서: 「[높음] 외부 바인딩에서 평문 제어 API를 허용함」

정해야 할 것:

- [ ] **기본을 거부로 뒤집는가.** 지금은 `log.warn('listen.exposed')` 로 끝난다
      (`src/bin/barycenterd.ts:772`). 코드가 이미 가진 반론이 있다 — 컨테이너에서
      `0.0.0.0` 은 **필요한** 값이다(포트 퍼블리시가 루프백 바인드에 닿지 못한다).
      단순 금지는 배포를 깨뜨린다
- [ ] **플래그 이름과 의미.** 보고서 제안은 `BARY_ALLOW_PLAINTEXT_EXPOSED=1`.
      「평문인 것을 안다」는 선언이지 「TLS 를 끈다」가 아니다 — 이름이 그렇게 읽혀야 한다
- [ ] **어디까지가 평문인가.** 앞단(sidecar·ingress)이 TLS 를 종단하는 배포에서는
      데몬이 평문으로 듣는 것이 **정상**이다. 데몬은 앞단을 볼 수 없다 →
      그래서 플래그가 필요하고, 그 사실이 플래그 설명에 적혀야 한다
- [ ] **상태 창구에 드러내는가.** 보고서 제안은 `/readyz` 또는 상태 응답.
      `/readyz` 는 지금 `{ ok, dataplane, engine? }` 뿐이고 **인증이 없다**
      (`src/api/server.ts:947`, `src/control/plane.ts:198`). 여기에 「평문 노출 중」을
      실으면 **인증 없이 배포 자세를 말하게 된다** — `/metrics` 에 토큰을 요구한
      이유(`server.ts:943` 주석)와 정면으로 부딪힌다. 대안 셋 중 하나를 고른다:

      ① `/readyz` 에 싣는다 (노출 정보다)
      ② `/metrics` 게이지로 낸다 (`read` 스코프 뒤다)
      ③ 기동 로그 `listening` 줄에만 남긴다 (지금 `tls:` 필드 옆)

      → **권장은 ②.** `/metrics` 는 이미 인증 뒤에 있고, 보고서가 말한
      「운영자가 나중에 발견할 수 있게」에는 스크레이프가 로그보다 낫다
- [ ] `DESIGN.md` §11.1 또는 §11.3 에 위 결정을 적는다. 표면(`src/index.ts`)은 안 건드린다

### ☐ D-2 · `configTest` 실행 실패를 무엇으로 볼 것인가 `[L]` (문서만)

보고서: 「[높음] 설정 검사가 실행에 실패하면 통과로 접힌다 (fail-open)」

지금 코드 (`src/dp/effects-fs.ts:194-197`):

```ts
} catch (e) {
  // 검사를 못 한 것은 실패가 아니다. 판정은 관측이 한다 (§6.3).
  return { ok: true, reason: `config test 를 돌리지 못했다: ${(e as Error).message}` };
}
```

정해야 할 것:

- [ ] **미설정과 실행 실패를 가르는가.** 지금은 둘 다 「검사 없음」으로 접힌다.
      미설정(`this.opts.configTest === undefined`, `:188`)은 운영자가 아는 상태지만,
      실행 실패는 **검사를 켰다고 믿는 배포가 검사 없이 도는** 상태다
- [ ] **실행 실패를 preflight 실패로 승격하는가.** 권장은 **예 — 조건 없이.**
      `configTest` 가 주입됐다는 것 자체가 「이 배포는 검사한다」는 선언이고,
      미설정과의 구분은 이미 코드가 갖고 있다(`undefined` 대 `throw`).
      보고서는 *"운영 모드에서는 승격"* 을 제안했지만, 새 모드 스위치는
      **끄는 자리를 하나 더 만드는 것**이다 — 그러면 같은 결함이 이름만 바꿔 돌아온다
- [ ] 승격이 §6.3 원칙(*"관측하지 못한 것은 반증이 아니다"*)과 충돌하는가 → **안 한다.**
      그 원칙은 **활성화 판정**(`provesActivation`, `src/dp/operation.ts:131`)의 것이고
      여기는 **게시 전 게이트**다. 두 자리는 다르다 — 그 사실을 §6.2 에 한 줄로 적는다.
      적어 두지 않으면 다음 사람이 지금 주석을 근거로 되돌린다
- [ ] `PreflightResult` 에 무엇을 더할지 정한다. 보고서 제안은 `configTestSkipped` /
      `configTestErrored`. **표면이 바뀐다** — `PreflightResult` 는 `src/index.ts:150` 에서
      export 된다. `SURFACE.txt` 카운터가 이 회차에 0 으로 돌아간다는 뜻이다.
      필드 **추가**만 하고 기존 셋은 안 건드린다 (`ok` · `reason` · `configTestPassed`)
- [ ] `DESIGN.md` §6.2 (ApplyOperation 상태기계) 의 preflight 항목에 적는다

---

## V1 · 작은 것부터 — manifest 중복 `[S]`

**여기서 시작한다.** 이 회차에서 제일 작고 나머지와 완전히 독립이다. 한 블록으로
재현물 → 빨강 → 수정 → 게이트 → 커밋 흐름을 한 번 돌려 보고 V2 로 간다.
표면 불변 · 마이그레이션 없음 · 도커 불필요.

### ☐ V1-1 · Manifest 중복 `(kind, key)` 를 거부한다 `[S]`

보고서: 「[낮음] Manifest에서 중복 리소스 식별자를 허용함」

- [ ] `tests/unit/audit-manifest-duplicate.test.ts` — 케이스 셋:

      ① 같은 `kind` + 같은 `key` 가 두 번 → `parseManifest()` 가 던진다
      ② 같은 `key` 인데 `kind` 가 다르면 → **통과한다** (다른 자원이다)
      ③ 던지는 메시지가 **몇 번째 인덱스**인지 말한다 — 옆 검증이 전부
         `resources[${i}]` 형식이다 (`src/store/manifest.ts:121~144`), 여기만 달라지지 않게
- [ ] **빨강 확인** — `npx vitest run tests/unit/audit-manifest-duplicate`
      (①③ 이 빨강, ② 는 처음부터 초록이어야 한다 — 초록인 쪽은 회귀 방지용이다)
- [ ] `src/store/manifest.ts` — `raw.map` **안에서** 즉시 거부한다.
      `map` 밖에서 사후 검사하지 않는다: 인덱스를 잃고 메시지가 옆과 달라진다.
      `importPatch` 가 이미 쓰는 `${kind}\0${key}` 키 모양을 그대로 쓴다
      (`src/store/manifest.ts:154` · `:159`)
- [ ] `importPatch` 는 **안 건드린다.** 거절은 파서의 일이다 — 뒤에서 또 세면
      같은 규칙이 두 자리에 산다
- [ ] `npx vitest run tests/unit` — 955 → 958. 숫자를 커밋 메시지에 적는다
- [ ] `npm run verify:quick`
- [ ] 커밋 — `fix(store): manifest 의 중복 (kind, key) 를 거절한다`

      `Pinned-by: tests/unit/audit-manifest-duplicate.test.ts -t "같은 kind 와 key 가 두 번 나오면 거절한다"`

> **왜 [낮음]인데 하는가.** 결과는 결정적 last-wins 이고 비경합이다 — 보고서가
> [중간]에서 내린 이유가 그것이다. 그래도 고치는 이유는 **일관성**이다: 모르는 필드,
> 빈 `key`, `spec` 타입, `spec.key` 혼입까지 거절하는 파서가 이것만 통과시킨다.
> 그리고 값이 싸다.

---

## V2 · fail-open 을 닫는다 `[M]` — **D-2 가 선행이다 · 도커 필요**

보고서: 「[높음] 설정 검사가 실행에 실패하면 통과로 접힌다」

이 블록은 **표면을 건드린다** (`PreflightResult`). `SURFACE.txt` 카운터가 0 으로
돌아가는 것을 각오하고 들어간다.

### ☐ V2-1 · 실행 실패와 검사 거부를 가른다 `[M]`

- [ ] `tests/unit/audit-configtest-fail-open.test.ts` — `FsEffects` 에 `configTest` 를
      **던지게** 주입하고 `preflight()` 를 부른다. 케이스 넷:

      ① `configTest` 가 던지면 `ok === false` 다 (지금은 `true`)
      ② 그때 `configTestErrored === true` 이고 `reason` 이 원래 메시지를 담는다
      ③ `configTest` 가 `false` 를 주면(엔진이 거부) 그건 **다른 것**이다 —
         `configTestPassed === false` · `configTestErrored` 는 없다
      ④ **미설정**이면 여전히 `ok === true` 이고 두 필드 다 `undefined` 다

      → ③④ 가 이 블록의 핵심이다. 「깨진 검사」와 「없는 검사」와 「거부한 검사」가
        결과에서 서로 구별돼야 한다. 셋을 한 값으로 뭉개는 것이 지금 결함이다
- [ ] `tests/conformance/check-effect-gap.test.ts` 옆에 계약을 하나 더 둘지 본다 —
      상태기계가 preflight 실패에서 게시로 안 넘어가는 것은 이미 계약이다.
      **없으면 새로 만들지 말고** unit 으로 충분한지 판단해 근거를 적는다
- [ ] **빨강 확인** — `npx vitest run tests/unit/audit-configtest-fail-open`
- [ ] `src/dp/apply.ts:42` — `PreflightResult` 에 `configTestErrored?: boolean` 추가.
      기존 필드 셋은 안 건드린다. **JSDoc 에 「왜 `configTestPassed` 로 안 되는가」를 적는다**:
      `false` 는 "엔진이 거부했다", `undefined` 는 "안 봤다" — 실행 실패는 그 둘 중
      어느 것도 아니다
- [ ] `src/dp/effects-fs.ts:194-197` — `catch` 가
      `{ ok: false, configTestErrored: true, reason }` 을 돌린다.
      **주석을 지우지 말고 고쳐 쓴다** — 지금 주석이 §6.3 을 근거로 들고 있고,
      D-2 가 그 근거의 적용 범위를 좁혔다. 새 주석이 그 구분을 적는다
- [ ] `src/dp/apply.ts:567` 근처 — `failAll` 의 사유가 실행 실패임을 말하게 한다.
      지금 `check.reason ?? '게시 전 검사 실패'` 로 뭉개진다
- [ ] **감사·저널에 남는지 확인한다.** 실패 사유가 apply 저널에 안 남으면
      「검사를 켰는데 안 돌았다」를 **여전히 아무도 모른다** — 그게 보고서가 지적한
      본체다. 안 남으면 남긴다
- [ ] `src/testing/apply-fakes.ts:167` — 가짜 `preflight` 가 새 필드를 알아야 하는지 본다
- [ ] `SURFACE.txt` / `SURFACE-API.json` 재생성이 필요한지 확인 — 필요하면 같은 커밋에
- [ ] `npm run verify:quick`
- [ ] `npm run test:e2e` (**도커 필요**) — 아래 경고를 본다
- [ ] 커밋 — `fix(dp): config test 실행 실패를 통과로 접지 않는다`

      `Pinned-by: tests/unit/audit-configtest-fail-open.test.ts -t "configTest 가 던지면 게시 전 검사가 실패한다"`

> ⚠️ **배포를 깨뜨릴 수 있는 항목이다.** `BARY_CONFIGTEST_CMD` 를 설정해 두고 실제로는
> 안 돌던 배포가 있다면, 이 수정 뒤에 **apply 가 막힌다** — 그게 의도다. 다만 그 전환이
> 조용하면 안 된다: 실패 메시지가 「검사를 못 돌렸다」와 원인 문장을 그대로 들어야
> 운영자가 5 분 안에 고친다. e2e 네 파일과 소크가 `BARY_CONFIGTEST_CMD` 를 쓰므로
> (`tests/e2e/v01-curl.test.ts` · `v02-l4` · `v03-membership` · `v06-tls` ·
> `scripts/soak.mjs`) **e2e 를 반드시 돌린다.**

---

## V3 · 노출 기본값을 뒤집는다 `[M]` — **D-1 이 선행이다 · 도커 필요**

보고서: 「[높음] 외부 바인딩에서 평문 제어 API를 허용함」

**이 블록이 이 회차에서 제일 잘 깨진다.** 기본을 거부로 뒤집으면 `0.0.0.0` 을 쓰는
자리가 **여덟 곳** 있고, 하나라도 빠뜨리면 그 스위트가 통째로 빨개진다.
아래에 전부 적어 뒀다 — 손으로 다시 찾지 말 것.

### ☐ V3-0 · 먼저 `envBool` 을 만든다 `[S]`

- [ ] `src/validate/env.ts` 에 불리언 해독기가 **없다** (`envInt` · `envIntOpt` 뿐).
      W1-4(2026-08-24 회차)가 세운 규칙 — 환경변수는 해독기를 지난다 — 을 이 플래그도 지킨다
- [ ] `tests/unit/audit-env-numbers.test.ts` 옆에 붙이거나 같은 파일에 확장한다:
      `'1'` · `'true'` 는 참, `'0'` · `''` · 미설정은 거짓,
      **`'yes'` · `'참'` · `'TRUE '` 같은 것은 던진다.**
      조용히 거짓으로 접히면 「켠 줄 알았는데 안 켜진」 상태가 생기고,
      이 플래그에서는 그게 곧 **기동 실패**로 나타난다
- [ ] **빨강 확인** → `envBool` 구현 → `npx vitest run tests/unit/audit-env-numbers`
- [ ] 커밋 — `feat(validate): 환경변수 불리언 해독기`

      `Pinned-by: tests/unit/audit-env-numbers.test.ts -t "모르는 값은 거짓으로 접지 않고 던진다"`

### ☐ V3-1 · 평문 + 외부 바인드를 기본 거부로 `[M]`

- [ ] `tests/unit/audit-plaintext-exposed.test.ts` — 새 파일.
      기존 `tests/unit/audit-listen-exposure.test.ts` 는 **안 지운다** (S-05a 의 근거가
      거기 있다). 케이스 넷:

      ① TLS 없음 + `0.0.0.0` + 플래그 없음 → **기동이 던진다**
      ② 같은 조합 + `BARY_ALLOW_PLAINTEXT_EXPOSED=1` → 뜬다, 그리고 그 사실이 드러난다
      ③ TLS 있음 + `0.0.0.0` + 플래그 없음 → 뜬다 (플래그는 평문일 때만 필요하다)
      ④ TLS 없음 + `127.0.0.1` + 플래그 없음 → 뜬다 (지금 기본값이 안 깨진다)
- [ ] **빨강 확인** — ① 이 빨강이어야 한다
- [ ] `src/bin/barycenterd.ts` — 판정을 **`server.listen` 앞으로 옮긴다.**
      지금 경고는 `:772`, 즉 **바인드가 끝난 뒤**다. 거부는 묶기 전에 해야 한다 —
      묶은 뒤에 던지면 그 짧은 창 동안 평문 포트가 실제로 열린다
- [ ] 오류 메시지에 **빠져나가는 법**을 적는다. 그냥 던지면 컨테이너가 재시작 루프에
      빠지고 운영자는 이유를 모른다. 셋을 다 적는다:
      TLS 를 켜라(`BARY_TLS_CERT_FILE`/`BARY_TLS_KEY_FILE`) ·
      루프백에만 묶어라(`BARY_LISTEN=127.0.0.1:8088`) ·
      앞단이 TLS 를 종단한다면 `BARY_ALLOW_PLAINTEXT_EXPOSED=1`
- [ ] 플래그가 켜졌을 때도 `log.warn('listen.exposed')` 는 **남긴다.**
      플래그는 「허용」이지 「괜찮음」이 아니다
- [ ] **여덟 자리를 전부 고친다** — 하나라도 빠지면 그 스위트가 빨개진다:
      - [ ] `deploy/Dockerfile:102` — `BARY_LISTEN=0.0.0.0:8088` 옆에 플래그를 `ENV` 로.
            `:85` 의 ⚠️ 주석을 **고쳐 쓴다** (왜 `0.0.0.0` 인지 + 왜 플래그가 함께 있는지)
      - [ ] `deploy/docker-compose.yml:69` — 퍼블리시는 이미 `127.0.0.1:8088:8088` 이다.
            **그래도 컨테이너 안의 바인드는 `0.0.0.0`** 이므로 플래그가 필요하다.
            그 사실을 파일 주석에 적는다 (다음 사람이 "루프백인데 왜?" 에서 멈춘다)
      - [ ] `deploy/entrypoint.sh` — 플래그를 지우거나 덮어쓰는 자리가 없는지 확인
      - [ ] `tests/e2e/v01-curl.test.ts:181` · `:438`
      - [ ] `tests/e2e/v02-l4.test.ts:228`
      - [ ] `tests/e2e/v02-capability.test.ts:99`
      - [ ] `tests/e2e/v03-membership.test.ts:141`
      - [ ] `tests/e2e/v06-tls.test.ts:141`
      - [ ] `scripts/soak.mjs:105`
- [ ] `tests/unit/audit-listen-exposure.test.ts:52` 의 Dockerfile 검사를 **확장한다** —
      `BARY_LISTEN=0.0.0.0:8088` 과 플래그가 **함께** 있는지 본다.
      한쪽만 남으면 이미지가 안 뜨거나 보호가 사라진다
- [ ] `npm run verify:quick` → `npm run test:e2e` (**도커**) → `node scripts/soak.mjs` 한 번
- [ ] 커밋 — `fix(bin): 평문 제어 API 를 외부 주소에 묶는 것을 기본 거부로 바꾼다`

      `Pinned-by: tests/unit/audit-plaintext-exposed.test.ts -t "TLS 가 없고 루프백 밖이면 플래그 없이는 안 뜬다"`

### ☐ V3-2 · 켜진 상태를 밖에서 볼 수 있게 `[S]` — D-1 에서 고른 창구

- [ ] D-1 에서 고른 창구에 낸다. **권장 ②** — `src/obs/metrics.ts` 의 `count()` 가
      이미 있으므로 게이지/카운터 하나를 더하는 것으로 끝난다.
      `/metrics` 는 `read` 스코프 뒤다 (`src/api/server.ts:709`)
- [ ] `/readyz` 를 골랐다면(①) — **인증이 없는 창구**라는 것을 다시 확인한다.
      `src/api/server.ts:943` 주석이 *"여기서 나가는 것은 불리언 둘이다 — 배포 구조를
      말하지 않는다"* 라고 적었고 이 항목은 그 문장을 깨뜨린다. 깨뜨릴 거면 주석도 고친다
- [ ] 재현물 → 빨강 → 수정 → 커밋

      `Pinned-by: tests/unit/audit-plaintext-exposed.test.ts -t "허용 플래그가 켜진 것이 밖에서 보인다"`

---

## V4 · 제어 API 레이트리밋 `[M]`

보고서: 「[중간] 제어 API에 레이트리밋·시도 제한이 없다」

**V3 뒤에 온다.** 보고서가 적은 대로 이 항목의 실질 심각도는 V3 가 얼마나 닫히느냐에
달려 있다 — *"망에서 닿을 수 있고, 무제한으로 시도할 수 있다"* 는 조합이 문제였다.

> 공정하게: 인증 로직 자체는 견고하다. `sha256:<hex>` 저장 · `timingSafeEqual` 비교
> (`src/api/auth.ts:307~`) · JWT 알고리즘을 **토큰 헤더가 아니라 키 종류**가 정한다.
> 이건 결함이 아니라 **경계의 부재**다. **인증 코드를 뜯지 말 것.**

### ☐ V4-1 · 인증 실패를 센다 `[XS]` ← **먼저**

- [ ] `src/obs/metrics.ts` 의 `count()` 를 쓴다 — **새 기구를 만들지 않는다**
- [ ] `src/api/server.ts:1046~1051` (`who === undefined` 가지) 에서 센다
- [ ] `tests/unit/audit-auth-ratelimit.test.ts` — 401 이 나가면 카운터가 오른다.
      `resetCounters()` 로 격리한다
- [ ] **빨강 확인** → 수정 → 커밋

      `Pinned-by: tests/unit/audit-auth-ratelimit.test.ts -t "인증 실패가 세어진다"`

> **왜 세는 것이 먼저인가.** 지금 실패를 세는 곳이 하나도 없다. 상한을 걸기 전에
> **정상 배포에서 초당 몇 번 실패하는지** 모르면 임계값을 지어낼 수밖에 없고,
> 지어낸 임계값은 운영자를 잠근다. 세는 것만으로도 값이 있다 — 보고서의 권장 조치
> 둘 중 하나가 이것이다.

### ☐ V4-2 · 실패에 백오프를 건다 `[M]`

정해야 할 것부터:

- [ ] **무엇을 키로 잡는가.** 소스 IP 는 프록시 뒤에서 하나로 뭉친다 —
      `tests/conformance/proxy-trust.test.ts` 에 신뢰 경계 판단이 이미 있다.
      **그 판단을 다시 짓지 말고 재사용한다**
- [ ] **상태를 어디에 두는가.** 인스턴스 메모리면 재시작에 사라지고 여러 인스턴스가
      각자 센다. 제어 평면은 대수가 적으므로 그것으로 충분한지 정한다.
      **DB 에 두는 것은 과하다** — 인증 실패마다 쓰기가 생긴다
- [ ] **무한히 자라지 않게.** 키별 상태 맵은 상한과 만료가 있어야 한다.
      직전 회차 W2 가 같은 부류(`agent.json` 성장)를 다뤘다 — 그 결론을 본다
- [ ] `429` 응답 모양 — `DESIGN.md` §5.1 의 상태 코드 4분할 표에 **429 가 없다.**
      표에 줄을 더한다. `Retry-After` 를 함께 낸다
- [ ] **루프백은 제외할 것인가.** GUI 개발과 `bary` CLI 가 같은 창구를 쓴다.
      잠그면 로컬 작업이 막힌다 — 정하고 적는다

그다음:

- [ ] `tests/unit/audit-auth-ratelimit.test.ts` 확장 — 케이스 넷:

      ① N 회 실패하면 `429` 다
      ② `Retry-After` 가 있다
      ③ **성공한 인증은 안 막힌다** (같은 키로 옳은 토큰을 들고 오면 통과)
      ④ 시간이 지나면 풀린다
- [ ] **빨강 확인** → 구현 → `npm run verify:quick`
- [ ] 커밋 — `feat(api): 인증 실패에 백오프와 429 를 건다`

      `Pinned-by: tests/unit/audit-auth-ratelimit.test.ts -t "정해진 횟수를 넘으면 429 다"`

---

## 회차 마무리

- [ ] `npm run verify` **전체** (도커 · 수십 분). `--quick` 만 돌고 끝내지 않는다 —
      직전 회차에서 목록에 없던 결함 셋을 찾은 것이 전체 게이트였다
- [ ] `STATUS.md` — 위 수정이 §2「열린 것」의 무언가를 참이 아니게 만들었으면 같은 PR 에서
      고친다 (`CONTRIBUTING.md` 의 규칙이다)
- [ ] `TESTS.md` — 새 재현물이 어느 부류인지 적는다
- [ ] `CODE_AUDIT_REPORT.md` — 닫힌 항목에 처리 결과를 적는다. **철회한 넷은 그대로 둔다**
- [ ] `git fetch origin && git rebase origin/main && git push origin HEAD:<branch>`
      — `CLAUDE.md`: *"이 push 까지 끝나 있어야 한다."* 워크트리에 커밋만 남기면
      그 사이클은 아직 메인에 반영된 것이 아니다

---

## 이 회차 밖 — 로드맵

아래 넷은 **코드 결함이 아니다.** 보고서가 「미구현·기능 공백」으로 분류했고, 코드가
스스로 범위를 선언한 자리다. 투두에 남기되 이 회차에서 손대지 않는다 — 넷 다 설계
결정이 먼저다.

### ☐ R-1 · KMS/Vault SecretStore 드라이버 `[L]`

`src/dp/secrets.ts:13` — `FsSecretStore` 는 DP 호스트 파일시스템에 **평문으로** 쓴다.
보호는 파일 권한(0400)과 「메인 DB 가 아니다」뿐이고, 파일 헤더가 *"암호화가 아니다"* 라고
스스로 적었다. §4.8 요구(개인키가 PG 에 안 들어감 · 참조 버전 고정 · digest 동반)는 지켜진다.

- [ ] 남는 위험은 그대로다 — 호스트 침해 시 즉시 노출, 백업·스냅샷·디스크 복제본 잔존
- [ ] 그때까지 할 수 있는 것: **기동 시 저장 방식과 파일 권한을 검사해 로그에 드러낸다.**
      드라이버보다 훨씬 싸고, 「암호화된 줄 알았다」를 막는다

### ☐ R-2 · GUI 인증을 HttpOnly 세션으로 `[L]`

`gui/src/lib/desk.svelte.ts:39` · `:293` · `gui/src/routes/login/+page.svelte:35-52` —
토큰과 OIDC 검증값(state·code_verifier·nonce)을 `sessionStorage` 에 둔다.
CSP · state · PKCE · nonce 검증은 있고 검증값은 사용 후 `removeItem` 한다.
그래도 XSS 가 나면 토큰이 읽힌다.

- [ ] BFF + HttpOnly/Secure/SameSite 쿠키. **아키텍처가 바뀐다** — GUI 를 데몬이
      정적으로 서빙하는 지금 구조(`api.guiRoot`)와 어떻게 맞출지가 먼저다

### ☐ R-3 · SecretStore 미설정 시 인증서 자료 업로드 불가 `[S]`

`src/api/server.ts:737` — SecretStore 가 없으면 `POST /api/v1/certificates/material` 이
`501 no_secret_store` 다. 선택형 의존성 설계인 것은 확인됐다.

- [ ] 배포 구성에서 「인증서 업로드는 항상 된다」고 기대하면 공백이 된다 →
      **문서로 충분한지** 판단한다. 코드 수정이 아닐 가능성이 높다

### ☐ R-4 · DNS-01 provider 범위 `[M]`

`src/control/dns01.ts` (전체 40 줄) — `FileDns01` 뿐이다. 헤더가 *"벤더 API 를 제품
계약으로 얼리지 않는다. 파일이 정본이다"* 라고 적었으므로 **의도된 범위**다.

- [ ] 외부 DNS 자동화가 필요한 환경에서는 배포가 훅을 제공해야 한다 →
      그 훅의 계약을 문서에 적을지, 범용 provider 인터페이스를 열지 정한다

---

## 어디서 멈춰도 되는가

- **V1 까지** — 파서 일관성이 닫힌다. 값은 작지만 흐름을 한 번 돌려 본 것이 남는다
- **V2 까지** — *"검사를 켠 배포가 검사 없이 도는"* 상태가 사라진다.
  **보고서의 [높음] 둘 중 하나가 여기서 닫힌다**
- **V3 까지** — 「경고를 읽었기를 바라는」 상태를 벗어난다. 보고서 우선순위 1·2 가 닫힌다
- **V4 는 V3 없이는 값이 절반이다** — 망에서 안 닿으면 무제한 시도의 대상이 아니다.
  다만 **V4-1(세는 것)은 언제 해도 값이 있다** `[XS]`

### 블록별 무게

| 블록 | 항목 | 무엇을 닫나 | 도커 | 표면 |
|---|---|---|---|---|
| D | 2 | 결정 — 코드 앞에 온다 | — | 불변 |
| V1 | 1 | 파서 일관성 `[낮음]` | — | 불변 |
| V2 | 1 | **fail-open `[높음]`** | e2e | **`PreflightResult` 바뀜** |
| V3 | 3 | **평문 노출 `[높음]`** | e2e · 소크 | 불변 |
| V4 | 2 | 레이트리밋 `[중간]` | — | 불변 |
| R | 4 | 로드맵 — 이 회차 밖 | — | — |

**보고서 우선순위와의 대응** — 1 → V3 · 2 → V2 · 3 → V4 · 4 → V1 · 5 → R-1 · 6 → R-2.
순서를 바꾼 이유는 하나다: **V1 이 제일 싸고, 그것으로 흐름을 한 번 돌려 본 뒤에
표면과 배포를 건드리는 블록으로 들어간다.**

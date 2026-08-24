# barycenter 코드 전수 점검 보고서

작성일: 2026-08-25
정정일: 2026-08-25 (1차 보고서의 재현 근거를 재검증하고 발견 4건을 반증, 2건 추가)

## 점검 방법

**대상 커밋: `39fe68b`** (`build(deploy): 베이스 이미지를 digest 로 고정한다`)

문서 파일은 분석 대상에서 제외하고 `src/`, `gui/src/`, `scripts/`, 테스트 코드를 기준으로
점검했다. 코드 수정은 수행하지 않았다.

실행한 검증 커맨드와 결과는 「검증 결과」 절에 그대로 적었다. **1차 보고서에는 커밋과
커맨드가 없었고, 그것이 발견 4건을 잘못된 근거 위에 세운 직접 원인이다.** 이 보고서의
모든 재현 근거는 위 커밋에서 실제로 돌린 출력이다.

검사 항목은 다음과 같다.

- 기능 오류와 예외·동시성 처리
- 인증·인가·암호화·입력 검증
- 파일·소켓·프로세스 경계
- 미구현·옵션 처리·더미 구현
- 테스트 공백과 재현 가능한 실패

## 요약

**전체 테스트는 통과한다** — unit 103 파일 / 955 테스트, conformance 50 파일 / 479 테스트,
모두 통과하며 종료 코드는 0이다. 1차 보고서가 최우선으로 지목한 SSE backpressure·SSE
종료 문제는 재현되지 않으며, 기술 전제 자체도 성립하지 않는다 (「반증된 지적」 참조).

실제로 남는 문제는 세 가지 성격으로 나뉜다.

1. **의도적 opt-in이 안전하지 않은 기본값으로 남아 있는 것** — 외부 주소에 평문 제어 API를
   묶는 것을 경고만 하고 허용한다.
2. **검사가 조용히 건너뛰어지는 것** — nginx 설정 검사는 미설정일 때뿐 아니라 **설정했는데
   실행이 실패해도** 통과로 접힌다.
3. **입력·인증 경계의 좁은 구멍** — manifest의 중복 리소스 식별자, 제어 API의 레이트리밋 부재.

## 발견 사항

### [높음] 외부 바인딩에서 평문 제어 API를 허용함

파일: `src/bin/barycenterd.ts:743`, `src/bin/barycenterd.ts:772`

TLS가 꺼진 상태에서 루프백 외 주소에 API를 바인딩할 수 있으며, 현재는 `log.warn('listen.exposed')`
경고만 남긴다. 이 API에는 Bearer 토큰, 설정 변경·적용 권한, 인증서 개인키 업로드가 존재한다.

정확히 적을 것: **TLS 지원 자체는 있다.** `BARY_TLS_CERT_FILE`/`BARY_TLS_KEY_FILE`로 켤 수 있고,
반만 켜지지는 않는다(`apiTlsOptions`가 던진다). `BARY_TLS_CLIENT_CA_FILE`로 클라이언트 CA도
붙는다. 문제는 "TLS가 없다"가 아니라 **안전하지 않은 조합이 기본이고 경고로 끝난다**는 것이다.

코드가 이미 가진 반론: 컨테이너에서는 `0.0.0.0`이 **필요한** 값이다(포트 퍼블리시가 루프백
바인드에 닿지 못한다). 따라서 단순 금지는 배포를 깨뜨린다.

영향:

- Bearer 토큰 탈취
- 인증서 개인키 평문 노출
- 네트워크에 접근 가능한 공격자의 설정 변경 및 트래픽 적용

권장 조치:

- 외부 주소 + TLS 없음 조합을 **기본 거부**로 뒤집고, 명시적 플래그(`BARY_ALLOW_PLAINTEXT_EXPOSED=1`
  같은)를 받은 경우에만 허용
- 컨테이너 사용성은 그 플래그가 흡수한다 — 지금처럼 "경고를 읽었기를 바라는" 상태를 벗어난다
- 그 플래그가 켜진 상태를 `/readyz` 또는 상태 응답에도 드러내 운영자가 나중에 발견할 수 있게 함

### [높음] 설정 검사가 실행에 실패하면 통과로 접힌다 (fail-open)

파일: `src/dp/effects-fs.ts:188`, `src/dp/effects-fs.ts:194-197`, `src/dp/operation.ts:131`

두 갈래가 있고, **1차 보고서는 첫 번째만 봤다.**

1. `BARY_CONFIGTEST_CMD`가 없으면 manifest·digest 대조만 하고 넘어간다 (`:188`).
2. **설정했는데 `configTest`가 던지면 `{ ok: true }`를 돌려준다** (`:194-197`).

```ts
} catch (e) {
  // 검사를 못 한 것은 실패가 아니다. 판정은 관측이 한다 (§6.3).
  return { ok: true, reason: `config test 를 돌리지 못했다: ${(e as Error).message}` };
}
```

두 번째가 더 나쁘다. 미설정은 운영자가 아는 상태지만, 이쪽은 **검사를 켰다고 믿는 배포가
실제로는 검사 없이 도는** 상태다. nginx 바이너리 경로가 바뀌거나, 컨테이너에서 exec가 깨지거나,
`{generation}` 치환 경로가 안 맞으면 조용히 여기로 떨어진다.

그리고 이때 `configTestPassed`는 `false`가 아니라 **`undefined`** 로 남는다. 그래서 활성화
판정(`operation.ts:131`)의 `if (evidence.configTestPassed === false) return false` 차단에도
안 걸린다. 설계 원칙(*"관측하지 못한 것은 반증이 아니다"*)과는 일관되지만, 그 원칙이 여기서는
**깨진 검사와 없는 검사를 구분 불가능하게** 만든다.

영향:

- 잘못된 설정이 게시된 뒤 reload 단계에서야 실패
- 검사를 켠 배포가 검사 없이 도는 것을 아무도 모름
- 적용 실패가 늦게 드러나고, 새 세대와 현재 포인터 상태가 운영자 관점에서 혼란스러워짐

권장 조치:

- **실행 실패(`catch`)와 검사 거부(`passed === false`)를 구분하되, 실행 실패도 결과에 드러낸다** —
  지금 `reason`은 채워지지만 `ok: true`에 묻혀 호출부가 보지 않는다
- 운영 모드에서는 실행 실패를 preflight 실패로 승격 (미설정과 달리 "켰는데 안 돈다"는 구성 오류다)
- 적용 결과에 `configTestSkipped` / `configTestErrored`를 명시해 감사 로그에 남긴다

### [중간] 제어 API에 레이트리밋·시도 제한이 없다

파일: `src/api/auth.ts:307`, `src/api/server.ts`

`src/api/` 전체와 `barycenterd.ts`에 `rateLimit` / `throttle` / `429` / lockout에 해당하는
코드가 하나도 없다. Bearer 토큰과 OIDC ID Token 검증 모두 **시도 횟수 제한 없이** 반복 가능하다.

공정하게 적을 것: 인증 자체는 견고하다. 토큰은 `sha256:<hex>`로 저장되고 비교는
`timingSafeEqual`이며(`auth.ts:307~`), JWT는 알고리즘을 토큰 헤더가 아니라 **키 종류**가
정한다. 따라서 이건 인증 로직의 결함이 아니라 **경계의 부재**다.

다만 위 [높음] 항목(외부 평문 바인딩)과 결합하면 그 항목의 실질 심각도를 올린다 — 망에서
닿을 수 있고, 무제한으로 시도할 수 있다.

영향:

- 토큰 무차별 대입 시도에 비용이 들지 않음
- 인증 실패 폭주가 로그와 CPU를 소모 (제어 평면은 대수가 적다)
- 침해 시도가 관측 가능한 흔적 없이 반복됨

권장 조치:

- 인증 실패에 대해 소스 기준 지수 백오프 또는 토큰 버킷, 초과 시 `429`
- 인증 실패율을 메트릭으로 노출 (지금은 실패를 세는 곳이 없다)

### [낮음] Manifest에서 중복 리소스 식별자를 허용함

파일: `src/store/manifest.ts:121-144`

`parseManifest()`는 알 수 없는 필드, `kind` 종류, 빈 `key`, `spec` 타입, `spec.key` 혼입까지
거절하지만 **동일한 `kind + key`가 여러 번 나오는 것은 거절하지 않는다.** 중복 검사에 쓸
자료구조도 없다 — 파일 안의 `Set`/`has` 사용처는 `importPatch`의 `want` 하나뿐이다.

서로 다른 `spec`이면 `importPatch`가 같은 `(kind, key)`에 대해 `put` 연산을 두 번 만들고
마지막 값이 결과를 결정한다.

심각도를 [중간]에서 [낮음]으로 내린다: 결과는 **결정적 last-wins**이고(비결정적 경합이 아니다),
manifest는 관리자가 넣는 입력이며, 다른 검증은 촘촘하다. 그래도 거절이 맞다 — 여기까지
꼼꼼한 파서가 이것만 통과시키는 것은 일관성 문제다.

영향:

- 입력자의 의도와 실제 최종 설정이 달라질 수 있음
- 감사 로그에 중복 변경이 남음
- 백업·복구 결과가 배열 순서에 의존

권장 조치:

- `parseManifest()`의 `raw.map` 안에서 `(kind, key)` 중복을 즉시 거부
- 중복 입력에 대한 단위 테스트 추가

## 반증된 지적 (1차 보고서에서 철회)

기록을 위해 남긴다. 아래 4건은 1차 보고서가 [높음]·[중간~높음]·[중간]으로 올린 것이며,
**모두 재현되지 않았다.** 인용된 재현 근거("테스트 타임아웃")는 대상 커밋에서 사실이 아니다.

### 철회: SSE 버퍼 상한이 backpressure를 제어하지 못함

1차 주장: `src/api/events.ts`가 `res.writableLength`만 보고 `res.write()` 반환값과 `drain`을
처리하지 않아 안 읽는 소비자가 메모리를 무한히 키운다.

**전제가 틀렸다.** Node의 `OutgoingMessage.writableLength`는 `outputSize + socket.writableLength`로
정의되어 **소켓 버퍼를 포함한다.** 실측(안 읽는 소비자에게 64 KiB씩 write):

```
n=20   write()=false  writableLength=786636    socket.writableLength=786636
n=200  write()=false  writableLength=12586176  socket.writableLength=12586176
```

`write()`가 `false`를 주는 조건이 곧 `writableLength > highWaterMark`이므로,
`events.ts:189`의 `res.writableLength <= MAX_SSE_BUFFER_BYTES`(4 MiB)는 그 불리언보다
**상위 정보이며 임계값을 직접 고를 수 있다.** `write()` 반환값 추적으로 바꾸는 것은 개선이
아니다. `drain` 처리는 "느린 소비자를 살려 계속 쓴다"는 **다른 정책**이지, 현재 정책(상한을
넘으면 놓고 `Last-Event-ID` 재연결에 맡긴다)의 결함이 아니다.

재현 근거 재검증 — `tests/unit/audit-stream-caps.test.ts` **4 tests 전부 통과** (2204ms).
통과한 테스트가 1차 보고서가 깨졌다고 한 바로 그 동작이다:

- `안 읽는 소비자가 버퍼를 무한히 못 키운다`
- `구독도 함께 놓는다 — 죽은 구독이 허브에 안 쌓인다`
- `읽는 소비자는 안 끊긴다 — 상한은 안 읽는 쪽에만 걸린다`

### 철회: SSE 연결이 정상 종료되지 않음

1차 주장: `EventHub.closeAll()` 이후 `streamDone`과 `server.close()`가 완료되지 않는다.

`events.ts:159`가 스냅샷 조회 **이전에** `hub.onShutdown(() => finish(true))`를 등록하며,
그 위 주석이 정확히 이 실패 모드(등록이 늦으면 그 스트림만 종료에서 빠진다)를 이유로 적고 있다.

재현 근거 재검증 — `tests/unit/audit-shutdown-sse.test.ts` **4 tests 전부 통과** (248ms).

### 철회: HTTP 헬스 프로브의 조기 종료에서 연결 정리가 불완전함

1차 주장: 조기 판정 후 정리가 안 되어 소켓이 쌓이고 false unhealthy가 난다.

**이미 고쳐진 것을 결함으로 적었다.** `src/control/health.ts:141` 주변 주석이 명시한다 —
예전에는 `'end'`에서 판정해 **본문을 끝내지 않는 백엔드**(SSE·스트리밍)가 헤더에 `200`을 주고도
타임아웃으로 `unhealthy`가 됐고, 지금은 헤더 시점에 판정해 `done()`이 `res.destroy()` 한다
(`:142`). 1차 보고서가 "영향"으로 적은 *"실제 백엔드 상태와 무관한 false unhealthy/timeout 신호"* 는
이 코드가 **제거한** 증상이다.

재현 근거 재검증 — `tests/unit/audit-probe-body-cap.test.ts` **7 tests 전부 통과** (28ms).

### 철회: 원격 DP 응답 상한 초과 시 연결 정리가 불완전

1차 주장: `settled` 플래그가 없어 중복 이벤트 처리가 발생하고, keep-alive 에이전트에 연결이 남는다.

두 근거 모두 성립하지 않는다.

- **`reject()` 중복 호출은 JS 프로미스에서 no-op이다.** 이미 settled된 프로미스는 두 번째
  `reject`를 무시한다 — 별도 플래그가 방지할 대상이 없다.
- `#agent`는 `keepAlive: true`지만(`src/dp/remote.ts:101`), `r.destroy()`(`:138`)가 소켓을
  파괴하면 Agent가 `'close'`에서 풀에서 제거한다. "연결이 남을 가능성"의 근거가 없다.

재현 근거 재검증 — 해당 테스트(`원격 응답이 상한을 넘으면 못 물었다가 된다`) **통과** (1702ms).

## 미구현·기능 공백

### SecretStore가 개인키를 평문으로 저장함

파일: `src/dp/secrets.ts:13`

**결함이 아니라 선언된 미구현이다.** 1차 보고서는 이것을 [중간] 발견으로 올렸으나, 파일 헤더가
스스로 못 박고 있다: *"`FsSecretStore`는 DP 호스트의 파일시스템에 **평문으로** 쓴다. 보호는
파일 권한(0400)과 '메인 DB가 아니다' 뿐이다. **암호화가 아니다** — KMS·Vault 드라이버는 이
인터페이스 뒤에 별도로 붙는다. 지금 없는 것을 있다고 적지 않는다."*

지켜지는 §4.8 요구: 개인키가 PG에 안 들어가고, 참조가 버전 고정이며, 자료의 digest를 함께 든다.

남는 위험은 그대로다 — 호스트 침해 시 즉시 노출, 백업·스냅샷·디스크 복제본 잔존.
따라서 **로드맵 항목**이지 코드 결함이 아니다.

권장: KMS/Vault 드라이버 구현. 그때까지 기동 시 저장 방식과 파일 권한을 검사해 로그에 드러낸다.

### SecretStore 미설정 시 인증서 자료 업로드 불가

파일: `src/api/server.ts:737`

SecretStore가 주입되지 않으면 `POST /api/v1/certificates/material`이 `501 no_secret_store`를
반환한다. 선택형 의존성으로 설계된 것은 확인되지만, 배포 구성에서 인증서 업로드가 항상
동작한다고 기대하면 기능 공백이 된다.

### DNS-01 provider 범위 제한

파일: `src/control/dns01.ts` (전체 40줄)

`FileDns01`(파일에 TXT 값을 쓰고 지운다)만 있다. 클라우드 DNS provider도, 범용 provider
인터페이스도 없다. 이것도 의도적이다 — 헤더가 *"벤더 API를 제품 계약으로 얼리지 않는다.
파일이 정본이다. 운영자가 그 파일을 nsupdate/외부 훅으로 밀어 올리는 것은 이 모듈 밖이다."*
라고 적었다. 외부 DNS 자동화가 필요한 환경에서는 그 훅을 배포가 제공해야 한다.

### GUI 인증 토큰 저장 방식

파일: `gui/src/lib/desk.svelte.ts:39`, `gui/src/lib/desk.svelte.ts:293`,
`gui/src/routes/login/+page.svelte:35-52`

토큰과 OIDC 검증값(state·code_verifier·nonce)을 `sessionStorage`에 저장한다. CSP와
state·PKCE·nonce 검증은 존재하며 검증값은 사용 후 `removeItem`으로 지운다. 그래도 브라우저
XSS가 발생하면 토큰이 읽힌다. 장기 운영 환경에서는 BFF와 HttpOnly/Secure/SameSite 쿠키가
더 안전하다.

## 정상 확인 항목

- TypeScript 타입체크 통과
- 프로덕션 빌드 통과
- unit 테스트 955개 통과 (103 파일)
- Conformance 테스트 479개 통과 (50 파일)
- 도달성 검사 통과
- JWT 알고리즘·issuer·audience·expiry 검증 존재 — 알고리즘을 **토큰 헤더가 아니라 키 종류**가 정한다
- Bearer 토큰이 `sha256:<hex>`로 저장되고 비교가 `timingSafeEqual` (`src/api/auth.ts:307`)
- OIDC state·PKCE·nonce 검증 존재, `kid` 지정 시 고정 키 폴백 없음
- mTLS 인증서 CN 매핑 존재 — 인증서는 신원만 답하고 역할표는 한 자리
- 경로 탈출 방지 로직 존재
- 개인키를 DB 모델과 인증서 조회 응답에 넣지 않는 구조 (해당 자원에 GET 자체가 없다)
- nginx directive로 전달되는 문자열 검증 로직 존재
- SSE 스트림이 스냅샷 조회 **이전에** 종료 훅을 등록 (`src/api/events.ts:159`)
- 헬스 프로브가 헤더 시점에 판정하고 본문을 안 볼 때는 읽지도 않음
- 원격 DP 응답에 4 MiB 상한 존재 (`src/dp/remote.ts:70`)

## 검증 결과

대상 커밋 `39fe68b`에서 실행:

```
$ npx vitest run tests/unit
  Test Files  103 passed (103)
       Tests  955 passed (955)
  [exited with code 0]

$ npx vitest run tests/conformance
  Test Files  50 passed (50)
       Tests  479 passed (479)

$ npx vitest run tests/unit/audit-stream-caps.test.ts \
                tests/unit/audit-shutdown-sse.test.ts \
                tests/unit/audit-probe-body-cap.test.ts --no-file-parallelism
  ✓ audit-stream-caps.test.ts    (4 tests) 2204ms
  ✓ audit-probe-body-cap.test.ts (7 tests)   28ms
  ✓ audit-shutdown-sse.test.ts   (4 tests)  248ms
  Test Files  3 passed (3) / Tests  15 passed (15)
```

세 파일에 `.skip` / `.only` / `.todo`는 없다 — 통과가 회피가 아니다.

**타임아웃도 실패도 없다.** 1차 보고서의 *"위 unit 테스트 실패로 전체 검증을 완전 통과로
볼 수 없다"* 는 결론은 철회한다. 이 커밋에서 전체 검증은 통과다.

## 우선순위 제안

1. 외부 바인딩 + TLS 없음 조합을 기본 거부로 전환 (명시적 플래그로만 허용)
2. configTest 실행 실패를 통과로 접지 않기 — 실행 실패와 미설정을 구분해 결과에 드러내기
3. 제어 API 인증 실패에 레이트리밋·백오프 추가
4. Manifest 중복 `(kind, key)` 거부
5. KMS/Vault SecretStore 드라이버 추가
6. GUI 인증을 HttpOnly 세션 방식으로 전환

## 정정 이력

1차 보고서(`145b984 docs: add code audit report`) 대비 변경:

| 1차 항목 | 처리 |
|---|---|
| [높음] SSE 버퍼 상한이 backpressure를 제어 못함 | **철회** — 전제 오류, 테스트 4건 통과 |
| [높음] SSE 연결이 정상 종료되지 않음 | **철회** — 테스트 4건 통과 |
| [높음] 외부 바인딩 평문 제어 API | **유지** — TLS opt-in이 존재한다는 사실 보강 |
| [중간~높음] 원격 DP 응답 정리 불완전 | **철회** — `reject` 중복은 no-op, 소켓은 회수됨 |
| [중간] HTTP 헬스 프로브 정리 불완전 | **철회** — 이미 수정된 코드, 테스트 7건 통과 |
| [중간] nginx 설정 검사가 선택 사항 | **[높음]으로 승격 + 확장** — 실행 실패 fail-open 경로 추가 |
| [중간] SecretStore 평문 저장 | **「미구현」으로 이동** — 코드가 명시적으로 선언한 범위 |
| [중간] Manifest 중복 리소스 | **[낮음]으로 하향** — 결정적 last-wins, 비경합 |
| — | **신규 [중간]** 제어 API 레이트리밋 부재 |
| 라인 번호 | `events.ts:189`, `desk.svelte.ts:39`, `server.ts:737` 등 정정 |
| 대상 커밋 | **신규 명시** (`39fe68b`) |

`145b984` 이후 `origin/main`이 `9a5c58f`·`a418146`·`da5ab08`을 더 얹었으나 셋 다 훅·워크트리
스크립트라 `src/`·`gui/src/`·`tests/`는 `39fe68b`와 바이트가 같다 — 위 판정은 현재 main에도 그대로 선다.

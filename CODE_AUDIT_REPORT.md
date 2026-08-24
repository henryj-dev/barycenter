# barycenter 코드 전수 점검 보고서

작성일: 2026-08-25

## 점검 범위

문서 파일은 분석 대상에서 제외하고 `src/`, `gui/src/`, `scripts/`, 테스트 코드를 기준으로 점검했다. 코드 수정은 수행하지 않았다.

검사 항목은 다음과 같다.

- 기능 오류와 예외·동시성 처리
- 인증·인가·암호화·입력 검증
- 파일·소켓·프로세스 경계
- 미구현·옵션 처리·더미 구현
- 테스트 공백과 재현 가능한 실패

## 요약

현재 가장 우선순위가 높은 문제는 SSE 연결 관리와 스트림 backpressure 처리다. 읽지 않는 SSE 소비자가 서버 메모리를 계속 사용하며, SSE 종료 및 데몬 종료 관련 테스트도 타임아웃된다.

또한 외부 주소에 평문 HTTP API를 열 수 있고, nginx 설정 검사가 환경변수에 따라 생략되며, SecretStore가 개인키를 평문 파일로 저장한다.

## 발견 사항

### [높음] SSE 버퍼 상한이 실제 backpressure를 제어하지 못함

파일: `src/api/events.ts:189`

`res.writableLength`만 확인하고 `res.write()`의 반환값과 `drain` 이벤트를 처리하지 않는다. 읽지 않는 클라이언트에 이벤트를 계속 발행하면 서버의 쓰기 버퍼와 힙 사용량이 증가할 수 있다.

재현 근거:

- `tests/unit/audit-stream-caps.test.ts`
- 안 읽는 SSE 소비자 테스트 3건 타임아웃

영향:

- 느리거나 멈춘 GUI 탭 하나가 제어 평면 메모리를 소모할 수 있음
- apply·헬스 이벤트가 계속 발생하는 동안 메모리 사용량 증가
- 서비스 거부(DoS) 가능성

권장 조치:

- `res.write()` 반환값을 추적하고 backpressure 상태를 별도로 관리
- 연결별 누적 바이트·마지막 drain 시각을 관리
- 상한 초과 시 `res`와 underlying socket을 확실히 종료
- 종료 경로를 단일 settled 상태로 보호

### [높음] SSE 연결이 정상 종료되지 않음

파일: `src/api/events.ts:159`, `src/bin/barycenterd.ts:799`

`EventHub.closeAll()`로 스트림을 닫도록 되어 있으나, 실제 테스트에서는 `streamDone`과 `server.close()`가 완료되지 않는다.

재현 근거:

- `tests/unit/audit-shutdown-sse.test.ts`
- 종료 관련 테스트 4건 전부 타임아웃

영향:

- SIGTERM/SIGINT 이후 데몬 종료 지연
- 리더 락과 durable store 락 해제가 늦어짐
- 오케스트레이터의 강제 종료에 의존하게 됨
- 다음 기동이 이전 프로세스의 락 정리 상태에 영향을 받을 수 있음

권장 조치:

- 스트림 종료 시 `ServerResponse`, 요청 소켓, 연결 객체를 함께 종료
- `closeAll()` 호출 후 실제 종료 완료를 기다리는 통합 테스트 추가
- `server.close()` 전에 새 요청 수락 중지와 active connection 목록 정리

### [높음] 외부 바인딩에서 평문 제어 API를 허용함

파일: `src/bin/barycenterd.ts:740`, `src/bin/barycenterd.ts:772`

TLS가 꺼진 상태에서 루프백 외 주소에 API를 바인딩할 수 있으며, 현재는 경고 로그만 남긴다. API에는 Bearer 토큰, 설정 변경·적용 권한, 인증서 개인키 업로드가 존재한다.

영향:

- Bearer 토큰 탈취
- 인증서 개인키 평문 노출
- 네트워크에 접근 가능한 공격자의 설정 변경 및 트래픽 적용

권장 조치:

- 외부 주소 바인딩 시 TLS를 필수화
- 예외적으로 평문을 허용할 경우 명시적인 개발 모드 플래그 필요
- 기동 로그 경고만으로 끝내지 말고 안전하지 않은 조합을 기본 거부

### [중간~높음] 원격 DP 응답 상한 초과 시 연결 정리가 불완전할 가능성

파일: `src/dp/remote.ts:135`

응답이 상한을 넘으면 응답 스트림을 `destroy()`하고 Promise를 reject하지만 요청 객체·소켓·중복 이벤트를 하나의 종료 상태로 관리하지 않는다.

재현 근거:

- `tests/unit/audit-stream-caps.test.ts`
- 큰 원격 응답 테스트 타임아웃

영향:

- 악성 또는 오작동 DP가 CP의 연결과 메모리를 소모
- keep-alive 에이전트에 연결이 남을 가능성
- 종료·정리 단계에서 서버가 끝나지 않을 가능성

권장 조치:

- 응답 상한 초과 시 `IncomingMessage`, `ClientRequest`, 소켓을 함께 종료
- `settled` 플래그로 `data`, `end`, `error`, `close` 중복 처리를 방지
- 상한 초과를 별도 메트릭과 로그로 기록

### [중간] HTTP 헬스 프로브의 조기 종료에서 연결 정리가 불완전함

파일: `src/control/health.ts:141`

상태 코드나 기대 본문 길이로 판정한 뒤 응답 객체를 `destroy()`한다. 끝나지 않는 HTTP 응답을 반복해서 프로브하는 환경에서 클라이언트·서버 양쪽 연결 정리가 완료되지 않는 테스트 실패가 확인됐다.

재현 근거:

- `tests/unit/audit-probe-body-cap.test.ts`
- 7개 테스트 전부 타임아웃

영향:

- 헬스 프로브 주기가 짧거나 백엔드 수가 많을 때 소켓 누적
- 프로브 스레드와 자원 고갈
- 실제 백엔드 상태와 무관한 false unhealthy/timeout 신호

권장 조치:

- 조기 판정 시 요청과 응답 소켓을 모두 종료
- `close`·`error`·`timeout`을 하나의 완료 함수로 통합
- 종료 완료를 확인하는 테스트 추가

### [중간] nginx 설정 검사가 선택 사항임

파일: `src/dp/effects-fs.ts:188`, `src/dp/effects-boot.ts:106`

`BARY_CONFIGTEST_CMD`가 없으면 manifest와 digest만 검사하고 적용한다. 파일 무결성은 확인하지만 nginx 문법·모듈·directive 호환성은 확인하지 않는다.

영향:

- 잘못된 설정이 게시된 뒤 reload 단계에서 실패
- 적용 실패가 늦게 드러남
- 새 세대와 현재 포인터 상태가 운영자 관점에서 혼란스러워짐

권장 조치:

- 운영 모드에서는 설정 검사를 필수화
- 검사 미설정 시 명시적인 unsafe 모드로만 허용
- 적용 결과에 `configTestSkipped`를 명시

### [중간] SecretStore가 개인키를 평문으로 저장함

파일: `src/dp/secrets.ts:13`, `src/dp/secrets.ts:229`

파일 권한은 제한하지만 인증서 개인키를 암호화하지 않는다. 코드 자체도 이 저장 방식이 암호화가 아님을 전제로 한다.

영향:

- 호스트 침해 시 개인키 즉시 노출
- 백업·스냅샷·디스크 복제본에 개인키가 남음
- 파일 권한 오류나 운영자 실수 시 피해 확대

권장 조치:

- KMS/Vault 기반 SecretStore 구현
- 평문 파일 저장은 개발 환경으로 제한
- 기동 시 저장 방식과 파일 권한을 검사하고 안전하지 않으면 경고 또는 실패

### [중간] Manifest에서 중복 리소스 식별자를 허용함

파일: `src/store/manifest.ts:121`, `src/store/manifest.ts:158`

동일한 `kind + key`를 가진 리소스를 여러 번 넣은 manifest를 거부하지 않는다. 서로 다른 spec이면 여러 `put` 작업이 생성되고 마지막 값이 결과를 결정한다.

영향:

- 입력자의 의도와 실제 최종 설정이 달라질 수 있음
- 감사 로그에 중복 변경이 남음
- 백업·복구 결과가 입력 순서에 의존

권장 조치:

- `parseManifest()`에서 `(kind, key)` 중복을 즉시 거부
- 중복 입력에 대한 단위 테스트 추가

## 미구현·기능 공백

### SecretStore 미설정 시 인증서 자료 업로드 불가

파일: `src/api/server.ts:734`

SecretStore가 주입되지 않으면 인증서 자료 업로드가 `501`을 반환한다. 선택형 의존성으로 설계된 것은 확인되지만, 배포 구성에서 인증서 업로드 기능이 항상 동작한다고 기대하면 기능 공백이 된다.

### DNS-01 provider 범위 제한

현재 코드에는 파일 기반 DNS-01 구현이 있으며, 클라우드 DNS provider 또는 범용 provider 인터페이스 구현은 확인되지 않는다. 외부 DNS 자동화가 필요한 환경에서는 추가 구현이 필요하다.

### GUI 인증 토큰 저장 방식

파일: `gui/src/lib/desk.svelte.ts:36`, `gui/src/routes/login/+page.svelte:8`

토큰과 OIDC 검증값을 `sessionStorage`에 저장한다. 현재 CSP와 state·PKCE·nonce 검증은 존재하지만, 브라우저 XSS가 발생하면 토큰이 읽힐 수 있다. 장기 운영 환경에서는 BFF와 HttpOnly/Secure/SameSite 쿠키 방식이 더 안전하다.

## 정상 확인 항목

- TypeScript 타입체크 통과
- 프로덕션 빌드 통과
- Conformance 테스트 479개 통과
- 도달성 검사 통과
- JWT 알고리즘·issuer·audience·expiry 검증 존재
- OIDC state·PKCE·nonce 검증 존재
- mTLS 인증서 CN 매핑 존재
- 경로 탈출 방지 로직 존재
- 개인키를 DB 모델과 인증서 조회 응답에 넣지 않는 구조
- nginx directive로 전달되는 문자열 검증 로직 존재

## 검증 결과

전체 unit 테스트는 다음 영역에서 실패 또는 타임아웃이 발생했다.

- SSE backpressure 상한
- SSE 종료 처리
- HTTP 헬스 프로브 조기 종료
- 원격 DP 응답 상한

Conformance 테스트는 479개가 통과했지만, 위 unit 테스트 실패로 전체 검증을 완전 통과로 볼 수 없다.

## 우선순위 제안

1. SSE backpressure 및 종료 처리 수정
2. HTTP 프로브와 원격 DP 응답의 연결 정리 통합
3. 외부 바인딩 시 TLS 강제
4. 운영 모드 nginx config test 강제
5. KMS/Vault SecretStore 추가
6. Manifest 중복 리소스 거부
7. GUI 인증을 HttpOnly 세션 방식으로 전환

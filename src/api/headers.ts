/**
 * 모든 응답에 붙는 보안 헤더 (검수 S-10)
 *
 * 하나도 없었다. 그런데 **GUI 는 인증 없이 나간다** — 토큰은 페이지가 fetch 에 붙이므로
 * 문서 자체는 누구나 받는다. 그러면 남의 페이지가 이 화면을 투명하게 겹쳐 두고
 * 운영자에게 apply 를 누르게 할 수 있다. 인증이 있는 API 가 아니라 **인증이 없는 문서**
 * 가 clickjacking 의 표면이다.
 *
 * 여기 있는 것은 **한 줄로 얻는 것들**뿐이다. 전체 CSP(스크립트 출처 제한)는 GUI 빌드가
 * 무엇을 내는지에 달려 있어 함께 정해야 하고, 지금 그것을 지어내면 화면이 조용히 깨진다.
 * `frame-ancestors` 만 먼저 건다 — 이건 빌드 산출물과 무관하게 참이다.
 */
export const SECURITY_HEADERS: Record<string, string> = {
  // 응답이 선언한 타입으로만 읽힌다. JSON 을 HTML 로 읽어 스크립트를 실행하는 경로를 막는다.
  'x-content-type-options': 'nosniff',
  // clickjacking. `X-Frame-Options` 의 후계이고 현대 브라우저는 이쪽을 본다.
  'content-security-policy': "frame-ancestors 'none'",
  // 관리 표면의 URL 이 밖으로 새지 않게 — 리비전·plan id 가 경로에 있다.
  'referrer-policy': 'no-referrer',
};

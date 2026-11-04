/**
 * 대상 URL 칸의 확인 (#126 3단계, 시안 `urlCheck`). 화면의 말은 해요체다.
 *
 * patch 빌더(`proxyFromUrlPatch`)도 같은 것을 거절하지만 그 말은 CLI 용 해라체다. 칸 아래에는 이 말을 먼저 보인다.
 * 규칙은 빌더와 같다 — http · https 만, 사용자 정보 · `?` · `#` 없음, 포트는 1–65535.
 */
export const urlCheck = (text: string): string | undefined => {
  const t = text.trim();
  if (t === '') return 'https://로 시작하는 URL을 입력해요.';
  if (!/^https?:\/\//i.test(t)) return 'URL은 http:// 또는 https://로 시작해요.';
  if (/^https?:\/\/[^/?#]*@/i.test(t)) return 'URL에 사용자 정보(user:pass@)를 넣지 않아요. 인증 정보는 요청 헤더로 보내요.';
  if (t.includes('?')) return 'URL에 ?를 넣지 않아요. 요청의 질의 문자열은 그대로 전달돼요.';
  if (t.includes('#')) return 'URL에 #를 넣지 않아요. 조각은 서버로 전달되지 않아요.';
  try {
    const u = new URL(t);
    if (u.hostname === '') throw new Error('no host');
  } catch {
    return 'URL 형식이 아니에요. 예: https://api.example.com/v1/';
  }
  return undefined;
};

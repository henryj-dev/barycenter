/**
 * 리소스 이름(키) 규칙 — 화면 쪽 한 벌.
 *
 * 판정은 서버와 **같은 정규식**이다(`src/validate/syntax.ts`). 이 파일은 별칭(`@web`)을 안 쓴다 —
 * 단위 테스트가 루트 `tsc` 로 `route-edit.ts` 를 끌어오고, 그 길에는 GUI 별칭이 없다.
 */
import { RESOURCE_KEY_SYNTAX } from '../../../../src/validate/syntax.js';

/** 이름 규칙 한 줄. 도움말과 오류가 같은 말을 한다. */
const KEY_RULE = '콜론(:)으로 구간을 나눌 수 있어요. 각 구간은 영문·숫자로 시작하고 영문, 숫자, 점(.), 밑줄(_), 하이픈(-)만 쓸 수 있어요. 127자까지예요.';

export const KEY_HELP = `${KEY_RULE} 예: web-01.dc1:shop:api:01. 만든 뒤에는 바꿀 수 없어요.`;

/** 이름 칸의 오류. 만들기 폼 · 라우트 · SNI · TLS 정책 · ACME 계정이 모두 이것을 쓴다. */
export const KEY_ERROR = `이름 규칙에 안 맞아요. ${KEY_RULE}`;

/** 이름(키). 맞으면 undefined. 빈 칸은 오류가 아니다 — 「만들기」 버튼만 잠근다. */
export const keyError = (v: string): string | undefined => {
  const t = v.trim();
  if (t === '' || RESOURCE_KEY_SYNTAX.test(t)) return undefined;
  return KEY_ERROR;
};

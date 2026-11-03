/**
 * 경로 바꾸기 미리보기 (#126 3단계, 시안 `rewritePath` · `slashMismatch`). 「예시 요청이 어디로 가나」 를 저장 전에 보인다.
 *
 * 규칙은 렌더와 같다 — 맞은 경로 접두사를 바꾸기 값으로 갈고, 나머지 경로와 질의 문자열은 그대로 붙인다. 경로가 여럿이면
 * 경로마다 자기 접두사를 간다(location 마다). nginx 는 최장 접두사를 고르므로 여기서도 가장 긴 것을 고른다.
 * 끝의 `/` 가 다르면 붙거나 겹친다(`/api/` → `/v1` 이면 `/v1users`) — 해독기와 patch 빌더가 막는 것을 먼저 말한다.
 */

/** 끝의 `/` 가 서로 다른가. */
export const slashMismatch = (a: string, b: string): boolean => a.endsWith('/') !== b.endsWith('/');

/** 요청과 맞는 가장 긴 접두사. 없으면 `undefined`. 질의 문자열은 보지 않는다. */
export const matchPrefix = (paths: readonly string[], req: string): string | undefined => {
  const q = req.indexOf('?');
  const path = q < 0 ? req : req.slice(0, q);
  return paths.filter((p) => path.startsWith(p)).sort((a, b) => b.length - a.length)[0];
};

/** 접두사를 바꾼 경로. 맞지 않으면 `undefined`. 바꾸기 값이 비면 그대로다. */
export const rewritePath = (prefix: string, rewrite: string, req: string): string | undefined => {
  const q = req.indexOf('?');
  const path = q < 0 ? req : req.slice(0, q);
  const qs = q < 0 ? '' : req.slice(q);
  if (!path.startsWith(prefix)) return undefined;
  return rewrite === '' ? req : rewrite + path.slice(prefix.length) + qs;
};

/** 예시 요청의 기본값 — 첫 경로 아래의 흔한 요청. */
export const exampleRequest = (paths: readonly string[]): string => {
  const p = paths[0] ?? '/';
  return `${p.endsWith('/') ? p : `${p}/`}users?id=1`;
};

/** 경로 바꾸기 값의 모양. 맞으면 `undefined`. */
export const rewriteError = (rewrite: string, paths: readonly string[]): string | undefined => {
  if (rewrite === '') return undefined;
  if (!rewrite.startsWith('/')) return '경로는 /로 시작해야 해요.';
  // 해독기와 같은 글자만 받는다 — `$` 가 들어가면 nginx 가 변수로 푼다.
  if (!/^\/[A-Za-z0-9\-._~/%]*$/.test(rewrite)) return '경로에는 영문, 숫자, - . _ ~ / % 만 써요.';
  if (paths.some((p) => slashMismatch(p, rewrite))) return '끝의 /가 접두사와 같아야 해요. 다르면 경로가 붙거나 겹쳐요.';
  return undefined;
};

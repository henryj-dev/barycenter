/**
 * **라우트가 덮는 경로들** (2026-11-02).
 *
 * 라우트는 경로를 하나(`pathPrefix`) 또는 여럿(`pathPrefixes`) 가진다. 둘 다 없으면 `/` 하나다. 같은 동작 ·
 * 헤더를 경로마다 라우트로 따로 적지 않게 하려는 것이다(`/api/` · `/v2/` · `/graphql`).
 *
 * `pathPrefix` 를 없애지 않은 이유: 옛 리비전 스냅샷이 그 필드로 적혀 있다. 해독기가 그것을 계속 읽어야 롤백이 된다.
 * 둘을 함께 적는 것은 해독기가 막는다 — 어느 쪽이 맞는지 고를 근거가 없다.
 *
 * 경로를 쓰는 자리(검증기 · 컴파일러 · 렌더러 · plan 영향 · 화면)는 모두 이 함수로 읽는다. 자리마다 따로 읽으면
 * 한 자리가 `pathPrefixes` 를 모르고 첫 경로만 본다.
 */
export function routePaths(r: { readonly pathPrefix?: string; readonly pathPrefixes?: readonly string[] }): string[] {
  if (r.pathPrefixes !== undefined && r.pathPrefixes.length > 0) return [...r.pathPrefixes];
  return [r.pathPrefix ?? '/'];
}

/**
 * 한 라우트의 경로 하나를 가리키는 컴파일 열쇠. 경로가 하나면 라우트 키 그대로다 — 옛 plan 의 순서 비교와 같게 둔다.
 * 여럿이면 `키 경로` 다(공백은 키 문법에 없으므로 겹치지 않는다).
 */
export function routePathKey(key: string, path: string, many: boolean): string {
  return many ? `${key} ${path}` : key;
}

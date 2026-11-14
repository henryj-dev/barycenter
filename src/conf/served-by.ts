/**
 * **응답한 노드의 이름** — `X-Served-By` 헤더와 오류 페이지 (DESIGN.md §4.10, 2026-11-14).
 *
 * 요청이 어느 노드에서 처리되었는지 응답만 보고 알게 한다. 기본은 **끈다** — 노드 이름은 내부 구조를 드러낸다.
 * 운영자가 노드마다 `BARY_SERVED_BY` 로 짧은 별칭(예: `icn-a1`)을 정한다. `@hostname` 이면 호스트 이름을 쓴다.
 *
 * ── 왜 렌더 결과가 아니라 세대 조각인가 ─────────────────────────────────────────────────
 *
 * 값은 **노드마다 다르다.** 렌더 결과(`nginx.conf`)에 넣으면 같은 모델이 노드마다 다른 digest 가 된다 — plan 이 렌더러
 * 드리프트를 잡는 근거가 사라진다(`adminInclude` 주석과 같은 이유). 그래서 렌더러는 자리만 낸다:
 *
 *   map $status $bary_served_by { include admin/served-by.map*; }
 *
 * 값은 각 노드가 세대를 만들 때 `admin/served-by.map` 에 `default "<별칭>";` 한 줄로 쓴다. **파일이 없으면 map 이 비어
 * 값이 빈 문자열이다** — `nginx -t` 를 통과하고(빈 glob · 빈 map, 실측), 헤더는 나가지 않는다(`more_set_headers` 의 값이
 * 비면 헤더를 내지 않는다, 실측). 부트스트랩 · 시험 렌더처럼 조각을 안 쓰는 자리도 그대로 유효하다.
 *
 * 헤더는 `headers-more` 가 있을 때만 낸다. core 의 `add_header` 는 http 블록에 두면 자기 `add_header` 가 있는 server ·
 * location 에서 사라진다(render.ts `hstsNode` 의 함정) — 반쪽짜리 헤더는 없는 것보다 헷갈린다. 오류 페이지의 표시는
 * 엔진과 상관없이 나간다.
 */
import { block, directive, entry, lit, variable, type ConfNode } from './ast.js';

export const SERVED_BY_VAR = 'bary_served_by';
/** 세대 디렉터리 안의 조각 경로. 렌더러의 `include` 와 같은 이름이어야 한다. */
export const SERVED_BY_FILE = 'admin/served-by.map';

/**
 * 별칭 모양. conf 리터럴 · 헤더 값 · HTML 에 그대로 들어가므로 **따옴표 · 공백 · `$` · `<` 가 없어야 한다.**
 * 호스트 이름 문자(영숫자 · `.` · `-` · `_`)만, 64 자까지.
 */
const ALIAS = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * `BARY_SERVED_BY` → 별칭. 비면 끈다(`undefined`). 모양이 틀리면 던진다 — 기동이 멈춰야 운영자가 안다.
 * `@hostname` 은 받은 호스트 이름을 쓴다(그 이름도 같은 모양 검사를 받는다).
 */
export function servedByFromEnv(raw: string | undefined, hostname: () => string): string | undefined {
  const v = (raw ?? '').trim();
  if (v === '') return undefined;
  const alias = v === '@hostname' ? hostname() : v;
  if (!ALIAS.test(alias)) {
    throw new Error(`BARY_SERVED_BY 가 틀렸다: 영숫자 · '.' · '-' · '_' 만, 64 자까지 (받은 값 ${JSON.stringify(alias)})`);
  }
  return alias;
}

/** 세대 조각의 내용. `servedByFromEnv` 를 지난 값만 받는다. */
export function servedByFragment(alias: string): string {
  if (!ALIAS.test(alias)) throw new Error(`served-by 별칭이 틀렸다: ${JSON.stringify(alias)}`);
  return `# 이 노드의 이름 (BARY_SERVED_BY). 노드마다 다르다 — 렌더 결과가 아니라 세대 조각이다.\ndefault "${alias}";\n`;
}

/** **http 블록**에 한 번 — 변수와 (모듈이 있으면) 헤더. 오류 페이지의 map 보다 앞에 둔다. */
export function servedByHttpNodes(headersMore: boolean): ConfNode[] {
  return [
    block('map', [variable('status'), variable(SERVED_BY_VAR)], [
      directive('include', [lit(`${SERVED_BY_FILE}*`)]),
    ]),
    ...(headersMore ? [directive('more_set_headers', [lit(`X-Served-By: $${SERVED_BY_VAR}`)])] : []),
  ];
}

/** 값이 있을 때만 다른 값이 되는 map — 오류 페이지가 빈 자리를 안 남기게. `""` 는 빈 값과 맞는다. */
export function servedByWhenSet(target: string, whenSet: string): ConfNode {
  return block('map', [variable(SERVED_BY_VAR), variable(target)], [
    entry(lit(''), lit('')),
    entry(lit('default'), lit(whenSet)),
  ]);
}


/**
 * **엔진이 스스로 만드는 오류 응답의 본문** (DESIGN.md §4.10 「응답 이름과 오류 페이지」, 2026-11-08).
 *
 * nginx 가 직접 내는 오류(라우트 없음 404 · 출발지 거부 403 · SNI 불일치 421 · 본문 초과 413 · 백엔드 없음 502 ·
 * 시간 초과 504 …)는 기본 본문에 엔진 이름을 싣는다 — `<hr><center>openresty</center>`. 이것을 차분한 자체 페이지로
 * 바꾼다. 그 페이지를 보는 사람은 운영자가 아니라 **barycenter 뒤에 있는 임의 사이트의 방문자**다.
 *
 * ── 어떻게 내는가 — 파일이 아니라 conf 안에서 ──────────────────────────────────────────────
 *
 *   · `error_page <코드들> $bary_err_loc;` — 값이 `@bary_err_html` 또는 `@bary_err_json` 인 변수다(`Accept` 로 고른다).
 *     `=` 를 안 붙이므로 **원래 상태 코드가 그대로 나간다** — named location 의 `return 200` 은 nginx 가 오류 상태로
 *     덮는다(`ngx_http_send_header` 의 `err_status`). 실측: tests/golden/error-pages.test.ts.
 *   · **named location 이어야 한다.** URI(`/__x.html`)로 넘기면 내부 리다이렉트가 server rewrite 단계부터 다시 돌아
 *     server 레벨 `if` 가드(421 · 출발지 444)가 또 걸리고, 두 번째 오류는 nginx 기본 페이지로 떨어진다.
 *     named location 은 location rewrite 단계로 바로 간다.
 *   · 본문은 http 블록의 `map` 값이다 — 변수(`$status` · `$request_id`)를 넣을 수 있고, server 마다 되풀이하지 않는다.
 *     **값 하나는 4 KB 보다 작아야 한다**(nginx 설정 파서의 토큰 버퍼). 그래서 머리 · 본문 · 꼬리 셋으로 나눈다.
 *
 * 정적 파일을 안 쓰는 이유: 설치 · 빌드 · 엔진 이미지 · 세대 디렉터리마다 파일이 제자리에 있어야 하고, 없으면 오류
 * 페이지를 내려다 404 가 된다. conf 안에 있으면 렌더 결과 하나가 전부다 — digest 도 그 본문을 덮는다.
 *
 * ── 지키는 것 ───────────────────────────────────────────────────────────────────────────
 *
 *   · **업스트림이 보낸 오류는 그대로다.** `proxy_intercept_errors` 를 켜지 않는다 — `error_page` 는 nginx 가 만든
 *     응답에만 걸린다.
 *   · **응답 헤더가 그대로다.** named location 에 `add_header` 를 두지 않는다 — 하나라도 두면 server 의 HSTS ·
 *     사용자 응답 헤더가 전부 사라진다(render.ts `hstsNode` 주석). `Cache-Control` 을 못 붙이는 이유가 그것이다.
 *   · `error_page` 는 상속이 아니라 **대체**다 — 자기 `error_page` 가 있는 location(라우트 출발지 규칙의 570 번대)은
 *     server 의 것을 잃는다. 그 자리에는 `locationErrorPageNodes()` 로 한 벌을 다시 낸다.
 *   · 444 는 응답이 없으므로 대상이 아니다.
 */
import { block, directive, entry, lit, num, regex, variable, type ConfNode } from './ast.js';

/**
 * 바꾸는 코드. 렌더러가 실제로 내는 자리와 nginx 가 스스로 내는 자리다.
 *
 * | 코드 | 어디서 |
 * |---|---|
 * | 400 · 494 · 495 · 496 · 497 | 잘못된 요청 · 헤더 초과 · 클라이언트 인증서 · HTTPS 포트에 평문 (494–497 은 400 으로 나간다) |
 * | 403 · 404 | 라우트 `reject` · 맞는 라우트가 없음 |
 * | 405 · 501 | 엔진이 받지 않는 메서드 · 전송 방식 |
 * | 413 · 414 | `client_max_body_size` 초과 · 너무 긴 요청 줄 |
 * | 421 | SNI↔Host 불일치 (`reject_421`) |
 * | 429 | 속도 제한 · 연결 제한 초과 (`limit_req_status` · `limit_conn_status 429`, render.ts `rateLimitNodes`) |
 * | 500 · 502 · 503 · 504 | 엔진 내부 · 백엔드 연결 실패 · 백엔드 없음 · 백엔드 시간 초과 |
 */
export const ERROR_PAGE_CODES = [
  400, 403, 404, 405, 413, 414, 421, 429, 494, 495, 496, 497, 500, 501, 502, 503, 504,
] as const;

type Copy = { title: string; text: string; ko: string; action: 'home' | 'retry' };

/**
 * 문구. **영어가 먼저, 한국어가 한 줄** — 방문자가 누구인지 모른다. 영어 한 언어만 두면 이 저장소의 사용자(한국어)가
 * 운영하는 사이트의 방문자에게 낯설고, 한국어만 두면 그 밖의 방문자가 못 읽는다. 짧게: 무엇이 일어났고 무엇을 할 수 있는지.
 *
 * 494–497 은 nginx 가 400 으로 내보내므로(`$status` 가 400) 문구가 따로 없다.
 */
const COPY: Readonly<Record<number, Copy>> = {
  400: { title: 'Bad request', text: 'The server could not understand this request.',
    ko: '요청을 이해하지 못했습니다. 주소를 확인해 주세요.', action: 'home' },
  403: { title: 'Access denied', text: 'You don’t have permission to view this page.',
    ko: '이 페이지를 볼 권한이 없습니다.', action: 'home' },
  404: { title: 'Page not found', text: 'The page you’re looking for doesn’t exist or may have moved.',
    ko: '찾는 페이지가 없거나 다른 곳으로 옮겨졌습니다.', action: 'home' },
  405: { title: 'Method not allowed', text: 'This page doesn’t accept that kind of request.',
    ko: '이 페이지는 그런 방식의 요청을 받지 않습니다.', action: 'home' },
  413: { title: 'Request too large', text: 'What you sent is larger than this site accepts.',
    ko: '보낸 내용이 이 사이트가 받는 크기보다 큽니다.', action: 'home' },
  414: { title: 'Address too long', text: 'The web address is longer than this site accepts.',
    ko: '주소가 너무 깁니다.', action: 'home' },
  421: { title: 'Misdirected request', text: 'This request reached a server that can’t answer for this address.',
    ko: '이 주소에 답할 수 없는 서버로 요청이 왔습니다. 주소를 다시 열어 주세요.', action: 'retry' },
  429: { title: 'Too many requests', text: 'You sent too many requests in a short time. Wait a moment, then try again.',
    ko: '짧은 시간에 요청이 너무 많았습니다. 잠시 뒤 다시 시도해 주세요.', action: 'retry' },
  500: { title: 'Internal server error', text: 'Something went wrong on our side. Please try again later.',
    ko: '서버에 문제가 생겼습니다. 잠시 뒤 다시 시도해 주세요.', action: 'retry' },
  501: { title: 'Not implemented', text: 'The server doesn’t support what this request asks for.',
    ko: '서버가 이 요청을 지원하지 않습니다.', action: 'home' },
  502: { title: 'Bad gateway', text: 'The site isn’t responding right now. Please try again in a few minutes.',
    ko: '사이트가 지금 응답하지 않습니다. 몇 분 뒤 다시 시도해 주세요.', action: 'retry' },
  503: { title: 'Service unavailable', text: 'The site is temporarily unavailable. Please try again shortly.',
    ko: '사이트를 잠시 쓸 수 없습니다. 조금 뒤 다시 시도해 주세요.', action: 'retry' },
  504: { title: 'Gateway timeout', text: 'The site took too long to respond. Please try again in a few minutes.',
    ko: '사이트의 응답이 너무 늦습니다. 몇 분 뒤 다시 시도해 주세요.', action: 'retry' },
};

const FALLBACK: Copy = { title: 'Something went wrong', text: 'The request could not be completed.',
  ko: '요청을 처리하지 못했습니다.', action: 'retry' };

/** 변수 이름. 렌더러의 다른 변수와 겹치지 않게 `bary_err_` 로 시작한다. */
const V = {
  loc: 'bary_err_loc', title: 'bary_err_title', head: 'bary_err_head', main: 'bary_err_main',
  foot: 'bary_err_foot', json: 'bary_err_jbody',
} as const;
const LOC_HTML = '@bary_err_html';
const LOC_JSON = '@bary_err_json';

/**
 * 모양 — 운영 GUI 토큰(`gui/src/lib/ui/tokens.css`)의 색 · 글자 크기 · 간격에서 왔다. 다만 GUI 는 다크가 기본이고
 * 이 페이지는 **방문자 기기의 테마를 따른다**(라이트가 기본, `prefers-color-scheme: dark` 면 다크).
 * 외부 글꼴 · 이미지 · 스크립트 0 — 시스템 글꼴과 인라인 SVG 뿐이다. `$` 를 쓰지 않는다(nginx 변수 문자다).
 */
const CSS = [
  ':root{--bg:#f3f4f6;--pn:#fff;--bd:#d9dde3;--tx:#14181f;--t2:#4a5463;--t3:#6b7584;--ac:#3d4fd6;color-scheme:light dark}',
  '@media (prefers-color-scheme:dark){:root{--bg:#0e1115;--pn:#161a20;--bd:#2a313b;--tx:#e8ebef;--t2:#a4aebb;--t3:#74808f;--ac:#8a9bff}}',
  '*{box-sizing:border-box}',
  'html,body{margin:0}',
  "body{min-height:100vh;display:flex;align-items:center;justify-content:center;padding:32px 16px;background:var(--bg);color:var(--tx);font:400 15px/1.6 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Apple SD Gothic Neo','Noto Sans KR',sans-serif;-webkit-font-smoothing:antialiased}",
  'main{width:100%;max-width:440px}',
  '.code{margin:0;font-size:64px;line-height:1;font-weight:700;letter-spacing:-.03em;color:var(--ac);font-variant-numeric:tabular-nums}',
  'h1{margin:20px 0 8px;font-size:22px;line-height:30px;font-weight:700}',
  'p{margin:0 0 6px;color:var(--t2)}',
  '.ko{font-size:14px;color:var(--t3);word-break:keep-all}',
  '.act{display:inline-block;margin-top:20px;padding:8px 14px;border:1px solid var(--bd);border-radius:6px;background:var(--pn);color:var(--tx);font-size:14px;text-decoration:none}',
  '.act:hover{border-color:var(--ac)}',
  '.act:focus-visible{outline:2px solid var(--ac);outline-offset:2px}',
  'footer{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px 16px;margin-top:40px;padding-top:16px;border-top:1px solid var(--bd);font-size:12px;line-height:16px;color:var(--t3)}',
  '.brand{display:inline-flex;align-items:center;gap:6px}',
  '.brand svg{color:var(--ac)}',
  'code{font:12px/16px ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;word-break:break-all}',
].join('');

/** 무게중심(barycenter) — 두 몸이 도는 가운데. 14px, 색은 `currentColor`. */
const MARK = '<svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true">'
  + '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity=".45"/>'
  + '<circle cx="8" cy="8" r="1.6" fill="currentColor"/><circle cx="14" cy="8" r="1.6" fill="currentColor"/>'
  + '<circle cx="2" cy="8" r="1" fill="currentColor"/></svg>';

const HEAD = '<!doctype html><html lang="en"><head><meta charset="utf-8">'
  + '<meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark">'
  + '<meta name="robots" content="noindex"><title>$status · $bary_err_title</title>'
  + `<style>${CSS}</style></head><body><main><p class="code">$status</p>`;

/**
 * 요청 id 는 방문자가 운영자에게 알려 줄 수 있는 유일한 손잡이다 — 접근 기록과 맞춰 볼 수 있다. 작게 둔다.
 */
const FOOT = `<footer><span class="brand">${MARK}barycenter</span>`
  + '<span>Request ID <code>$request_id</code></span></footer></main></body></html>';

/** `href=""` 는 지금 주소를 다시 연다(GET). 스크립트 없이 「다시 시도」 가 된다. */
const ACTION: Record<Copy['action'], string> = {
  home: '<a class="act" href="/">Go to home page · 홈으로</a>',
  retry: '<a class="act" href="">Try again · 다시 시도</a>',
};

const mainOf = (c: Copy): string =>
  `<h1>${c.title}</h1><p>${c.text}</p><p class="ko" lang="ko">${c.ko}</p>${ACTION[c.action]}`;

const JSON_BODY = '{"status":$status,"error":"$bary_err_title","request_id":"$request_id"}';

const statusEntries = (f: (c: Copy) => string): ConfNode[] => [
  ...Object.entries(COPY).map(([code, c]) => entry(num(Number(code)), lit(f(c)))),
  entry(lit('default'), lit(f(FALLBACK))),
];

/** **http 블록**에 한 번 — 변수들. 쓰는 server 가 없어도 낸다(부트스트랩 포함, 렌더가 모델 모양에 덜 기댄다). */
export function errorPageHttpNodes(): ConfNode[] {
  return [
    // `Accept` 에 json 이 있으면 JSON 이다. 브라우저의 `Accept` 에는 없다.
    block('map', [variable('http_accept'), variable(V.loc)], [
      entry(lit('default'), lit(LOC_HTML)),
      entry(regex('~*json'), lit(LOC_JSON)),
    ]),
    block('map', [variable('status'), variable(V.title)], statusEntries((c) => c.title)),
    block('map', [variable('status'), variable(V.main)], statusEntries(mainOf)),
    block('map', [variable('status'), variable(V.head)], [entry(lit('default'), lit(HEAD))]),
    block('map', [variable('status'), variable(V.foot)], [entry(lit('default'), lit(FOOT))]),
    block('map', [variable('status'), variable(V.json)], [entry(lit('default'), lit(JSON_BODY))]),
  ];
}

const errorPageDirective = (): ConfNode =>
  directive('error_page', [...ERROR_PAGE_CODES.map((c) => num(c)), variable(V.loc)]);

/**
 * **server 마다** 한 벌 — `error_page` 와 두 named location. named location 은 server 에 속하므로 http 에 둘 수 없다.
 *
 * `types {}` 를 비우는 이유: 응답 형식을 URI 확장자로 고르지 않게 한다. 없으면 `/x.png` 의 404 가 `image/png` 로 나간다.
 */
export function errorPageServerNodes(): ConfNode[] {
  return [
    errorPageDirective(),
    block('location', [lit(LOC_HTML)], [
      block('types', [], []),
      directive('default_type', [lit('text/html; charset=utf-8')]),
      directive('return', [num(200), lit(`$${V.head}$${V.main}$${V.foot}`)]),
    ]),
    block('location', [lit(LOC_JSON)], [
      block('types', [], []),
      directive('default_type', [lit('application/json')]),
      directive('return', [num(200), variable(V.json)]),
    ]),
  ];
}

/**
 * 자기 `error_page` 를 가진 location 에 다시 낼 것 (라우트 출발지 규칙의 프록시, 570 번대).
 *
 * `recursive_error_pages on` 이 있어야 한다 — 570 → named location 으로 한 번 넘어간 요청은 nginx 가 「이미 오류
 * 페이지를 처리 중」 으로 표시해, 거기서 난 502 가 다시 `error_page` 를 못 탄다(기본 페이지로 떨어진다, 실측).
 * 되돌이는 없다: 오류 페이지의 named location 은 `return 200` 뿐이라 다시 오류를 내지 않는다.
 */
export function locationErrorPageNodes(): ConfNode[] {
  return [errorPageDirective(), directive('recursive_error_pages', [lit('on')])];
}

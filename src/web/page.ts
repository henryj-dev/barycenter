/**
 * GUI 자리. Kit 경로가 정본이다. pageOf 는 그 이름을 읽는다.
 *
 * 경로는 사이드바 메뉴 그룹을 따른다(디자인 시안 §4): 변경 · 트래픽 · TLS · 운영 · 관리.
 * 리소스 이름은 단수다 — `/traffic/listener`, 그 아래 `/<key>` 가 상세, `/<key>/edit` 가 수정.
 * 상세 주소에는 **key** 를 쓴다(UUID 아님). API·CLI 가 같은 key 를 쓰고, 복구 뒤에도 안 바뀐다.
 */
export type Place =
  | 'dashboard' | 'impact' | 'listeners' | 'pools' | 'routes' | 'certificates' | 'status' | 'rendered' | 'audit'
  | 'login' | 'invite' | 'account' | 'users' | 'reset' | 'email' | 'regions';

/** SvelteKit 이 프리렌더하는 자리. 한 index.html 폴백이 아니다. */
export const KIT_ROUTES: readonly { place: Place; path: string }[] = [
  { place: 'dashboard', path: '/' },
  { place: 'impact', path: '/change/pending' },
  { place: 'listeners', path: '/traffic/listener' },
  { place: 'pools', path: '/traffic/pool' },
  { place: 'routes', path: '/traffic/route' },
  { place: 'certificates', path: '/tls/certificate' },
  { place: 'status', path: '/ops/status' },
  { place: 'rendered', path: '/ops/rendered' },
  { place: 'audit', path: '/ops/audit' },
  { place: 'users', path: '/admin/user' },
  { place: 'login', path: '/login' },
  { place: 'invite', path: '/invite' },
  { place: 'account', path: '/account' },
  { place: 'reset', path: '/reset' },
  { place: 'email', path: '/email' },
  { place: 'regions', path: '/regions' },
];

/**
 * **미리 못 만드는 자리** — 주소에 key 가 들어간다. 빌드는 이 자리들을 위해 셸 HTML 하나
 * (`GUI_SHELL`)를 내고, 서버는 **이 패턴에만** 그 셸을 내보낸다. 모르는 경로는 지금처럼 거절한다 —
 * 아무 경로나 받는 SPA 폴백이 아니다.
 */
export const GUI_SHELL = '_shell.html';

export const GUI_DYNAMIC: readonly { place: Place; pattern: RegExp; route: string }[] = [
  { place: 'listeners', pattern: /^\/traffic\/listener\/[^/]+$/, route: '/traffic/listener/[key]' },
  { place: 'listeners', pattern: /^\/traffic\/listener\/[^/]+\/edit$/, route: '/traffic/listener/[key]/edit' },
];

/** 이 경로가 셸로 서빙되는 동적 자리인가. 끝의 `/` 하나는 봐준다. */
export function isDynamicGuiPath(pathname: string): boolean {
  const p = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  return GUI_DYNAMIC.some((d) => d.pattern.test(p));
}

/**
 * **옮긴 자리** (2026-10-30). 옛 주소로 들어오면 서버가 308 로 새 주소를 알려 준다 —
 * 북마크와 문서의 옛 링크가 404 가 되지 않게. `/` 는 옮기지 않았다(대시보드가 됐다).
 */
export const GUI_MOVED: Readonly<Record<string, string>> = {
  '/listeners': '/traffic/listener',
  '/pools': '/traffic/pool',
  '/routes': '/traffic/route',
  '/certificates': '/tls/certificate',
  '/status': '/ops/status',
  '/rendered': '/ops/rendered',
  '/audit': '/ops/audit',
  '/users': '/admin/user',
};

/** 옛 주소면 새 주소. 아니면 undefined. 끝의 `/` 하나는 봐준다. */
export function movedGuiPath(pathname: string): string | undefined {
  const p = pathname.length > 1 ? pathname.replace(/\/$/, '') : pathname;
  return GUI_MOVED[p];
}

const under = (pathname: string, base: string): boolean =>
  pathname === base || pathname.startsWith(`${base}/`);

export function pageOf(pathname: string): Place {
  if (under(pathname, '/change/pending')) return 'impact';
  if (under(pathname, '/traffic/listener')) return 'listeners';
  if (under(pathname, '/traffic/pool')) return 'pools';
  if (under(pathname, '/traffic/route')) return 'routes';
  if (under(pathname, '/tls/certificate')) return 'certificates';
  if (under(pathname, '/ops/status')) return 'status';
  if (under(pathname, '/ops/rendered')) return 'rendered';
  if (under(pathname, '/ops/audit')) return 'audit';
  if (under(pathname, '/admin/user')) return 'users';
  if (under(pathname, '/login')) return 'login';
  if (under(pathname, '/invite')) return 'invite';
  if (under(pathname, '/account')) return 'account';
  if (under(pathname, '/reset')) return 'reset';
  if (under(pathname, '/email')) return 'email';
  if (under(pathname, '/regions')) return 'regions';
  return 'dashboard';
}

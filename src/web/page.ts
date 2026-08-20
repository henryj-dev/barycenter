/**
 * GUI 자리. Kit 여덟 경로가 정본이다. pageOf 는 그 이름을 읽는다.
 */
export type Place =
  | 'impact' | 'listeners' | 'pools' | 'routes' | 'certificates' | 'status' | 'rendered' | 'audit';

/** SvelteKit 이 프리렌더하는 여덟 자리. 한 index.html 폴백이 아니다. */
export const KIT_ROUTES: readonly { place: Place; path: string }[] = [
  { place: 'impact', path: '/' },
  { place: 'listeners', path: '/listeners' },
  { place: 'pools', path: '/pools' },
  { place: 'routes', path: '/routes' },
  { place: 'certificates', path: '/certificates' },
  { place: 'status', path: '/status' },
  { place: 'rendered', path: '/rendered' },
  { place: 'audit', path: '/audit' },
];

export function pageOf(pathname: string): Place {
  if (pathname === '/listeners' || pathname.startsWith('/listeners/')) return 'listeners';
  if (pathname === '/pools' || pathname.startsWith('/pools/')) return 'pools';
  if (pathname === '/routes' || pathname.startsWith('/routes/')) return 'routes';
  if (pathname === '/certificates' || pathname.startsWith('/certificates/')) return 'certificates';
  if (pathname === '/status' || pathname.startsWith('/status/')) return 'status';
  if (pathname === '/rendered' || pathname.startsWith('/rendered/')) return 'rendered';
  if (pathname === '/audit' || pathname.startsWith('/audit/')) return 'audit';
  return 'impact';
}

/**
 * GUI 자리. 경로가 늘어도 Kit 은 아직 없다 — serveGui 의 확장자 없는 폴백이
 * 같은 index.html 을 낸다. 라우터 이주는 화면과 한 커밋에 갈지 않는다.
 */
export type Place = 'impact' | 'listeners' | 'pools' | 'routes';

export function pageOf(pathname: string): Place {
  if (pathname === '/listeners' || pathname.startsWith('/listeners/')) return 'listeners';
  if (pathname === '/pools' || pathname.startsWith('/pools/')) return 'pools';
  if (pathname === '/routes' || pathname.startsWith('/routes/')) return 'routes';
  return 'impact';
}

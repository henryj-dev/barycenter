/**
 * 라우트의 **평가 순서**와 **가려짐** — 목록의 「평가 순서」 열과 트래픽 경로 그림의 「라우트 #n」 이 같은 값을 쓴다.
 *
 * 순서는 엔진이 실제로 보는 순서(`RoutesView.order` — 매치 클래스 → 우선순위 → 경로 길이)에서 라우트가 처음 나오는 자리다.
 * 호스트 · 경로가 여럿인 라우트는 엔진이 여러 번 보므로 가장 먼저 보는 자리를 쓴다. 가려짐은 더 높은 클래스의 라우트가
 * 먼저 잡는 쪽(`priority_inversion` 경고의 둘째)이고, 값은 그 경고 문구다.
 */
import type { RoutesView } from '@web/routes-view';

/** 컴파일 열쇠(`키` 또는 `키 경로`) → 라우트 키. 공백은 키 문법에 없다(`routePathKey`). */
const routeOf = (ck: string): string => ck.split(' ')[0] ?? ck;

export function routeOrder(view: Pick<RoutesView, 'order' | 'warnings'>): { ord: Map<string, number>; shadow: Map<string, string> } {
  const ord = new Map<string, number>();
  view.order.forEach((r, i) => { if (!ord.has(r.key)) ord.set(r.key, i + 1); });
  const shadow = new Map<string, string>();
  for (const w of view.warnings) {
    const lo = w.routes[1];
    if (w.kind === 'priority_inversion' && lo !== undefined && !shadow.has(routeOf(lo))) shadow.set(routeOf(lo), w.message);
  }
  return { ord, shadow };
}

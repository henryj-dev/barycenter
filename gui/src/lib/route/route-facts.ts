/**
 * 상세 화면(개요 · 연결된 리소스 · 머리 배지)이 라우트 한 줄의 사실을 읽는 자리 — 목록과 같은 함수(`route-cells.ts`)를 쓴다.
 * 평가 순서는 그 desk(지역)의 엔진 순서다.
 */
import { itemOf, type ModelLike } from '@web/resources';
import type { RoutesView } from '@web/routes-view';
import { routeOrder } from '#lib/lists/route-order';
import { httpRouteFacts, passRouteFacts, type RouteFacts } from '#lib/lists/route-cells';

export function routeFactsOf(
  desk: { model: ModelLike; routes: RoutesView }, kind: 'httpRoute' | 'passthroughRoute', key: string,
): RouteFacts | undefined {
  const item = itemOf(desk.model, kind, key);
  if (item === undefined) return undefined;
  if (kind === 'httpRoute') return httpRouteFacts(item, routeOrder(desk.routes));
  const i = desk.routes.passthrough.findIndex((p) => p.key === key);
  return passRouteFacts(item, i < 0 ? undefined : i + 1);
}

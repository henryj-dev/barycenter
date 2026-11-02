/**
 * **라우트의 동작들** (2026-11-02). 기본 동작 하나와 출발지 규칙의 동작들이다.
 *
 * 풀 참조 · 웹소켓 · 연결 그래프처럼 「라우트가 무엇을 쓰나」 를 묻는 자리는 모두 이 함수로 읽는다. `r.action` 만
 * 읽으면 규칙이 가리키는 풀이 upstream 에서 빠지고(렌더), 지워도 된다고 보이고(검증), 그래프에 안 보인다(화면).
 */
import type { HttpAction, HttpRoute } from './provisional.js';

export function routeActions(r: Pick<HttpRoute, 'action' | 'sourceRules'>): HttpAction[] {
  return [r.action, ...(r.sourceRules ?? []).map((x) => x.action)];
}

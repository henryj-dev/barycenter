/**
 * §7.5 라우트 컴파일러 — 축소 계약
 *
 * 엔진 근거 (tests/engine 실측):
 *   E20.1 — map/server_name 은 정확일치가 와일드카드보다 **항상** 먼저다. 등장 순서 무관.
 *   E20.3 — 정규식끼리는 등장 순서를 따른다.
 *   E22.2 — nginx 와일드카드는 다중 라벨을 매치한다 (X.509 와 다르다).
 *
 * 따라서 사용자 `priority` 는 **같은 매치 클래스 안에서만** 의미가 있다.
 * 클래스를 가로지르는 우선순위 역전은 저장은 되되 plan 이 경고해야 한다.
 */
import { describe, expect, it } from 'vitest';
import { compileHostRoutes, type RouteInput } from '../../src/route/compile.js';

const r = (key: string, host: string, priority: number, pathPrefix?: string): RouteInput =>
  pathPrefix === undefined ? { key, host, priority } : { key, host, priority, pathPrefix };

const order = (routes: RouteInput[]) => compileHostRoutes(routes).order.map((x) => x.key);

describe('매치 클래스 우선순위 — E20.1', () => {
  it('정확일치가 와일드카드보다 먼저다. 사용자 priority 가 낮아도 그렇다', () => {
    const out = compileHostRoutes([
      r('wild', '*.example.com', 20),
      r('exact', 'api.example.com', 10),
    ]);
    expect(out.order.map((x) => x.key)).toEqual(['exact', 'wild']);
  });

  it('클래스를 가로지르는 우선순위 역전을 경고한다 — 조용히 다르게 동작하지 않는다', () => {
    const out = compileHostRoutes([
      r('wild', '*.example.com', 20),
      r('exact', 'api.example.com', 10),
    ]);
    const w = out.warnings.find((x) => x.kind === 'priority_inversion');
    expect(w).toBeDefined();
    expect(w!.routes).toEqual(['exact', 'wild']);
  });

  it('역전이 없으면 경고하지 않는다', () => {
    const out = compileHostRoutes([
      r('exact', 'api.example.com', 20),
      r('wild', '*.example.com', 10),
    ]);
    expect(out.warnings.filter((x) => x.kind === 'priority_inversion')).toEqual([]);
  });

  it('매치 클래스를 노출한다 — API 가 실제 순서를 숨기지 않는다', () => {
    const out = compileHostRoutes([
      r('exact', 'api.example.com', 1),
      r('wild', '*.example.com', 1),
    ]);
    expect(out.order.map((x) => x.matchClass)).toEqual(['exact_host', 'wildcard_host']);
  });
});

describe('클래스 내부 정렬', () => {
  it('같은 클래스에서는 priority 내림차순', () => {
    expect(order([r('lo', 'a.example.com', 1), r('hi', 'b.example.com', 9)])).toEqual(['hi', 'lo']);
  });

  it('priority 동점이면 path_prefix 가 긴 쪽이 먼저 (더 구체적)', () => {
    expect(
      order([r('short', 'a.example.com', 5, '/'), r('long', 'a.example.com', 5, '/api/v1')]),
    ).toEqual(['long', 'short']);
  });

  it('전부 동점이면 key 오름차순 — 결정적이어야 한다', () => {
    expect(order([r('zzz', 'a.example.com', 5), r('aaa', 'b.example.com', 5)])).toEqual([
      'aaa',
      'zzz',
    ]);
  });

  it('입력 순서를 바꿔도 결과가 같다', () => {
    const routes = [
      r('a', 'x.example.com', 5),
      r('b', '*.example.com', 5),
      r('c', 'y.example.com', 7),
    ];
    expect(order(routes)).toEqual(order([...routes].reverse()));
  });
});

describe('중복과 path 우선순위 — E31 이 정정한 것', () => {
  it('같은 host + 같은 path_prefix 는 **오류**다 — nginx 가 duplicate location 으로 거부한다', () => {
    const out = compileHostRoutes([
      r('first', 'api.example.com', 10, '/'),
      r('second', 'api.example.com', 5, '/'),
    ]);
    expect(out.errors.map((e) => e.kind)).toEqual(['duplicate_match']);
    expect(out.order).toEqual([]);
  });

  it('대소문자만 다른 중복도 오류다', () => {
    const out = compileHostRoutes([
      r('upper', 'API.Example.com.', 5),
      r('lower', 'api.example.com', 5),
    ]);
    expect(out.errors.map((e) => e.kind)).toEqual(['duplicate_match']);
  });

  it('path_prefix 가 다르면 정상이다', () => {
    const out = compileHostRoutes([
      r('root', 'api.example.com', 10, '/'),
      r('api', 'api.example.com', 5, '/api'),
    ]);
    expect(out.errors).toEqual([]);
  });

  // E31: location 은 선언 순서도 사용자 priority 도 아닌 **longest-prefix** 로 고른다.
  it('같은 host 안에서는 priority 와 무관하게 긴 path 가 먼저다', () => {
    expect(
      order([r('broad', 'api.example.com', 99, '/'), r('narrow', 'api.example.com', 1, '/api')]),
    ).toEqual(['narrow', 'broad']);
  });

  it('사용자 priority 가 path 순서와 어긋나면 경고한다 — 조용히 다르게 동작하지 않는다', () => {
    const out = compileHostRoutes([
      r('broad', 'api.example.com', 99, '/'),
      r('narrow', 'api.example.com', 1, '/api'),
    ]);
    const w = out.warnings.find((x) => x.kind === 'path_priority_ignored');
    expect(w).toBeDefined();
    expect(w!.routes).toEqual(['broad', 'narrow']);
  });

  it('priority 가 path 길이와 같은 방향이면 경고하지 않는다', () => {
    const out = compileHostRoutes([
      r('broad', 'api.example.com', 1, '/'),
      r('narrow', 'api.example.com', 99, '/api'),
    ]);
    expect(out.warnings.filter((x) => x.kind === 'path_priority_ignored')).toEqual([]);
  });

  it('와일드카드는 정확일치를 가리지 않는다 — 엔진이 정확일치를 먼저 본다', () => {
    const out = compileHostRoutes([
      r('wild', '*.example.com', 99),
      r('exact', 'api.example.com', 1),
    ]);
    expect(out.errors).toEqual([]);
  });
});

describe('입력 검증', () => {
  it('잘못된 host 패턴은 컴파일 오류다', () => {
    const out = compileHostRoutes([r('bad', '*.a.*.b.com', 1)]);
    expect(out.errors.map((e) => e.route)).toEqual(['bad']);
    expect(out.errors.map((e) => e.kind)).toEqual(['invalid_host']);
    expect(out.order).toEqual([]);
  });
});

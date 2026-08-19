/**
 * Routes 화면이 읽는 값 — DESIGN.md §7.5 · §10
 *
 * GUI 는 사용자 priority 가 아니라 **컴파일된 최종 순서**를 보여 준다.
 * 컴파일러가 이미 있는 경고를 다시 만들지 않는다. 패스스루는 호스트 매치
 * 클래스가 아니므로 컴파일하지 않고 사실만 나열한다.
 */
import { compileHostRoutes } from '../route/compile.js';
import type { HostPattern } from '../validate/strings.js';

export type HttpRouteFact = {
  key: string;
  listener: string;
  hosts: string[];
  priority: number;
  pathPrefix?: string;
  action: { kind: string };
};

export type PassthroughFact = {
  key: string;
  listener: string;
  snis: string[];
  priority: number;
  action: { kind: string };
};

export type RouteRow = {
  key: string;
  listener: string;
  host: string;
  pathPrefix: string;
  matchClass: string;
  priority: number;
  action: string;
};

export type Shadow = {
  kind: string;
  routes: string[];
  message: string;
};

export type RoutesView = {
  order: RouteRow[];
  warnings: Shadow[];
  errors: Shadow[];
  passthrough: {
    key: string;
    listener: string;
    snis: string[];
    priority: number;
    action: string;
  }[];
};

const hostOf = (p: HostPattern): string =>
  (p.kind === 'exact' ? p.host : `*.${p.suffix}`);

export function viewOfRoutes(
  http: readonly HttpRouteFact[],
  passthrough: readonly PassthroughFact[],
): RoutesView {
  const inputs = http.flatMap((r) => r.hosts.map((host) => ({
    key: r.key,
    host,
    priority: r.priority,
    ...(r.pathPrefix === undefined ? {} : { pathPrefix: r.pathPrefix }),
  })));
  const compiled = compileHostRoutes(inputs);
  const byKey = new Map(http.map((r) => [r.key, r]));
  return {
    order: compiled.order.map((c) => {
      const r = byKey.get(c.key);
      return {
        key: c.key,
        listener: r?.listener ?? '',
        host: hostOf(c.pattern),
        pathPrefix: c.pathPrefix,
        matchClass: c.matchClass,
        priority: c.priority,
        action: r?.action.kind ?? '',
      };
    }),
    warnings: compiled.warnings.map((w) => ({
      kind: w.kind, routes: w.routes, message: w.message,
    })),
    errors: compiled.errors.map((e) => ({
      kind: e.kind, routes: [e.route], message: e.message,
    })),
    passthrough: [...passthrough]
      .sort((a, b) => b.priority - a.priority || a.key.localeCompare(b.key))
      .map((p) => ({
        key: p.key,
        listener: p.listener,
        snis: [...p.snis],
        priority: p.priority,
        action: p.action.kind,
      })),
  };
}

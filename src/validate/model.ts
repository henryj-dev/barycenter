/**
 * 모델 검증 — 렌더러는 검증된 모델만 받는다.
 *
 * 4차 검수 Critical: v3 까지 `render()` 는 잘못된 입력을 **의미를 바꿔서** 흡수했다.
 *
 *   `bind: '127.0.0.1x'` → `normalizeBind` 실패 → `listen 8080;`
 *
 * 오타 하나가 루프백 의도를 전 인터페이스 노출로 바꿨다. 참조가 깨진 라우트·풀도 산출물에서
 * 조용히 사라져, "저장은 됐는데 동작하지 않는" 상태를 만들었다.
 *
 * 여기서는 오류를 **모아서** 반환한다 (`plan` 이 한 번에 보여줘야 하므로). 렌더러는 하나라도
 * 있으면 던진다 — fail closed.
 */
import { findSocketConflicts, normalizeBind, type SocketReservation } from './sockets.js';
import { compileHostRoutes, type RouteInput } from '../route/compile.js';
import { parseHashKey } from './strings.js';
import type { Model } from '../model/provisional.js';

export type ModelIssueCode =
  | 'invalid_bind_address'
  | 'unknown_pool'
  | 'unknown_listener'
  | 'pool_has_no_backend'
  | 'socket_conflict'
  | 'route_compile_error'
  | 'invalid_hash_key';

export type ModelIssue = {
  code: ModelIssueCode;
  /** 관련 리소스 key */
  subjects: string[];
  message: string;
};

export class ModelValidationError extends Error {
  constructor(readonly issues: ModelIssue[]) {
    super(
      `모델이 유효하지 않다 (${issues.length}건):\n` +
        issues.map((i) => `  · [${i.code}] ${i.message}`).join('\n'),
    );
    this.name = 'ModelValidationError';
  }
}

export function validateModel(model: Model): ModelIssue[] {
  const issues: ModelIssue[] = [];
  const poolKeys = new Set(model.pools.map((p) => p.key));
  const listenerKeys = new Set(model.listeners.map((l) => l.key));
  const poolsWithBackends = new Set(model.backends.map((b) => b.pool));

  const needPool = (subject: string, poolKey: string): void => {
    if (!poolKeys.has(poolKey)) {
      issues.push({
        code: 'unknown_pool',
        subjects: [subject],
        message: `'${subject}' 가 존재하지 않는 풀 '${poolKey}' 를 참조한다`,
      });
      return;
    }
    if (!poolsWithBackends.has(poolKey)) {
      issues.push({
        code: 'pool_has_no_backend',
        subjects: [subject, poolKey],
        message:
          `풀 '${poolKey}' 에 백엔드가 없다. 렌더에서 조용히 사라지는 대신 저장을 막는다`,
      });
    }
  };

  // ── 풀 ──
  for (const pool of model.pools) {
    if (pool.algorithm !== 'hash') continue;
    const parsed = parseHashKey(pool.protocolClass, pool.hashKey ?? 'remote_addr');
    if (!parsed.ok) {
      issues.push({ code: 'invalid_hash_key', subjects: [pool.key], message: parsed.message });
    }
  }

  // ── 리스너 ──
  const reservations: SocketReservation[] = [];
  for (const l of model.listeners) {
    const bind = normalizeBind(l.bind);
    if (!bind.ok) {
      issues.push({
        code: 'invalid_bind_address',
        subjects: [l.key],
        message: `리스너 '${l.key}' 의 bind 가 IP 주소가 아니다: ${JSON.stringify(l.bind)}`,
      });
    } else if (l.enabled) {
      reservations.push({ key: l.key, protocol: l.protocol, bind: l.bind, port: l.port });
    }

    if (l.defaultPool !== undefined) needPool(l.key, l.defaultPool);
    if (l.protocol === 'tls_passthrough') {
      const o = l.onUnmatchedSni;
      if (o !== undefined && o !== 'reject') needPool(l.key, o.pool);
    }
    if (l.protocol === 'http' && l.http?.defaultAction !== undefined) {
      const a = l.http.defaultAction;
      if (a !== 'reject') needPool(l.key, a.pool);
    }
  }

  for (const c of findSocketConflicts(reservations)) {
    issues.push({ code: 'socket_conflict', subjects: [c.a, c.b], message: c.reason });
  }

  // ── 라우트 ──
  const byListener = new Map<string, RouteInput[]>();
  const addRoute = (listener: string, key: string, host: string, priority: number, path?: string) => {
    if (!listenerKeys.has(listener)) {
      issues.push({
        code: 'unknown_listener',
        subjects: [key],
        message: `라우트 '${key}' 가 존재하지 않는 리스너 '${listener}' 를 참조한다`,
      });
      return;
    }
    const list = byListener.get(listener) ?? [];
    list.push(path === undefined ? { key, host, priority } : { key, host, priority, pathPrefix: path });
    byListener.set(listener, list);
  };

  for (const r of model.httpRoutes) {
    if (r.action.kind === 'proxy') needPool(r.key, r.action.pool);
    r.hosts.forEach((h, i) => addRoute(r.listener, `${r.key}#${i}`, h, r.priority, r.pathPrefix));
  }
  for (const r of model.passthroughRoutes) {
    if (r.action.kind === 'proxy') needPool(r.key, r.action.pool);
    r.snis.forEach((h, i) => addRoute(r.listener, `${r.key}#${i}`, h, r.priority));
  }

  for (const [listener, inputs] of byListener) {
    for (const e of compileHostRoutes(inputs).errors) {
      issues.push({
        code: 'route_compile_error',
        subjects: [listener, e.route],
        message: `리스너 '${listener}': ${e.message}`,
      });
    }
  }

  return issues;
}

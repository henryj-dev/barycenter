/**
 * 인스턴스 메모리 — 지금까지의 `AuthFailureLimiter` 를 그대로 감싼다(뜻 불변, 기본).
 */
import { AuthFailureLimiter, type AuthFailureLimitOptions } from '../auth-rate-limit.js';
import type { LimitResult, RateLimitStore } from './store.js';

export function memoryRateLimit(opts: AuthFailureLimitOptions | AuthFailureLimiter = {}): RateLimitStore {
  const l = opts instanceof AuthFailureLimiter ? opts : new AuthFailureLimiter(opts);
  return {
    kind: 'memory',
    // 동기로 끝낸다 — 약속이 풀리기 전에 이미 기록돼 있다(지금과 같은 순서).
    record: (key) => {
      const retry = l.record(key);
      return Promise.resolve<LimitResult>(retry === undefined ? { ok: true } : { ok: true, retryAfterS: retry });
    },
    clear: (key) => {
      l.clear(key);
      return Promise.resolve({ ok: true as const });
    },
  };
}

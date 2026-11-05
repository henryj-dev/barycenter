/**
 * 인증 실패 제한 저장소 등록부 — `BARY_AUTH_LIMIT_STORE` 의 이름으로 고른다.
 *
 *   BARY_AUTH_LIMIT_STORE   `memory`(기본 — 지금과 같다) · `pg`(사람 계정 PG, `BARY_ACCOUNTS_DSN` 필요)
 *
 * 다른 저장소를 붙이려면: `RateLimitStore` 를 구현한 파일 하나 + 아래 표에 한 줄.
 */
import type { Queryable } from '../../store/pg.js';
import { memoryRateLimit } from './memory.js';
import { pgRateLimit } from './pg.js';
import type { RateLimitStore } from './store.js';

export type RateLimitConfig = {
  /** 사람 계정 PG. `pg` 가 쓴다. */
  accountsDb?: Queryable;
};

const KINDS: Readonly<Record<string, (c: RateLimitConfig) => RateLimitStore>> = {
  memory: () => memoryRateLimit(),
  pg: (c) => {
    if (c.accountsDb === undefined) {
      throw new Error('BARY_AUTH_LIMIT_STORE=pg 는 사람 계정 PG(BARY_ACCOUNTS_DSN)가 있어야 쓴다');
    }
    return pgRateLimit({ db: c.accountsDb });
  },
};

export function rateLimitKinds(): string[] {
  return Object.keys(KINDS);
}

/** 모르는 이름이면 던진다 — 기동이 거부된다(조용히 메모리로 떨어지지 않게). */
export function rateLimitStore(kind: string, c: RateLimitConfig = {}): RateLimitStore {
  const make = Object.hasOwn(KINDS, kind) ? KINDS[kind] : undefined;
  if (make === undefined) {
    throw new Error(`BARY_AUTH_LIMIT_STORE=${kind} 를 모른다 (쓸 수 있는 것: ${rateLimitKinds().join(', ')})`);
  }
  return make(c);
}

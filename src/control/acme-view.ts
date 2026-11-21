/**
 * ACME 주문·챌린지 **공개 읽기** (DESIGN.md §8.2).
 *
 * 원장 행을 그대로 내보내면 토큰·key authorization·시크릿 참조가 나간다.
 * GET 이 보여주는 것은 상태·도메인·놓았는가 뿐이다.
 */
import type { AcmeOrderRow, ChallengeRow } from './acme-store.js';

export type PublicOrder = {
  id: string;
  certificate: string;
  domains: string[];
  state: AcmeOrderRow['state'];
  attempts: number;
  lastError: string | undefined;
  /**
   * 러너가 이 주문을 다시 볼 시각(ISO) — **실패한 주문만** 싣는다 (2026-11-20). 화면의 「다음 시도」 다.
   * 다른 상태에서는 다음 틱이 바로 보거나(진행 중) 다시 안 본다(종단) — 시각이 뜻이 없다.
   */
  nextAttemptAt?: string;
};

export type PublicChallenge = {
  id: string;
  order: string;
  domain: string;
  type: ChallengeRow['type'];
  placed: boolean;
  cleaned: boolean;
  /** 놓은 · 치운 시각(ISO, 2026-11-21) — 화면의 주문 상세가 싣는다. 값(토큰 · keyAuthorization)은 싣지 않는다. */
  placedAt?: string;
  cleanedAt?: string;
};

/** 시각 열은 방언마다 모양이 다르다 — ISO 로 낸다. 못 읽으면 그대로. */
const iso = (v: string): string => {
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? v : d.toISOString();
};

const SECRET = /BEGIN |PRIVATE KEY|accountKey|account_key|issuedRef|certKeyRef/i;

export function publicOrder(row: AcmeOrderRow): PublicOrder {
  return {
    id: row.id,
    certificate: row.certificateKey,
    domains: [...row.domains],
    state: row.state,
    attempts: row.attempts,
    lastError: row.lastError,
    ...(row.state === 'failed' && row.nextAttemptAt !== undefined ? { nextAttemptAt: row.nextAttemptAt } : {}),
  };
}

export function publicChallenge(row: ChallengeRow): PublicChallenge {
  return {
    id: row.id,
    order: row.orderId,
    domain: row.domain,
    type: row.type,
    placed: row.placedAt !== undefined,
    cleaned: row.cleanedAt !== undefined,
    ...(row.placedAt === undefined ? {} : { placedAt: iso(row.placedAt) }),
    ...(row.cleanedAt === undefined ? {} : { cleanedAt: iso(row.cleanedAt) }),
  };
}

/** GET 본문에 시크릿이 실렸는지. 테스트와 서버가 같은 그물이다. */
export function leaksSecret(body: unknown): boolean {
  return SECRET.test(JSON.stringify(body));
}

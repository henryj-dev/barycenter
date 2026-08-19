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
};

export type PublicChallenge = {
  id: string;
  order: string;
  domain: string;
  type: ChallengeRow['type'];
  placed: boolean;
  cleaned: boolean;
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
  };
}

/** GET 본문에 시크릿이 실렸는지. 테스트와 서버가 같은 그물이다. */
export function leaksSecret(body: unknown): boolean {
  return SECRET.test(JSON.stringify(body));
}

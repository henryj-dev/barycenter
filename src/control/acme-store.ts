/**
 * ACME 주문 원장 (DESIGN.md §8.2 · ADR-ACME · S18)
 *
 * 프로토콜은 `src/acme/client.ts` 가 말한다. 여기는 **언제 무엇을 다시 시도할 것인가**를
 * 든다 — S18 이 실측한 대로 그건 CA 가 안 해 준다.
 *
 * ── 왜 `ConfigStore` 가 아닌가 ──────────────────────────────────────────
 *
 * 주문은 **설정이 아니라 운영 상태**다. `backend_health` 와 같은 부류이고, 리비전에
 * 들어가면 갱신 한 번마다 새 리비전이 생기며 롤백이 "그때 진행 중이던 주문" 을 되살린다.
 * 그건 되돌릴 대상이 아니다 (009 마이그레이션 주석).
 *
 * ── 실행권 ──────────────────────────────────────────────────────────────
 *
 * 리더가 둘일 수 있는 순간(§3.5 승계)에 같은 주문을 둘이 몰면 **nonce 가 서로를
 * 깨뜨리고**, 더 나쁘게는 챌린지를 두 번 수락한다. `operations` 가 apply 에 대해 하는
 * 일을 여기서 한다 — 다만 lease 는 **시간 기반**이다. 죽은 리더가 든 실행권을 영원히
 * 기다릴 수는 없기 때문이다.
 */
import { randomUUID } from 'node:crypto';

import type { Db, Queryable, Row } from '../store/pg.js';

export type OrderState = 'pending' | 'validating' | 'ready' | 'issued' | 'failed' | 'abandoned';

/** 진행 중인 상태들. 종단(`issued`·`abandoned`)이 아닌 것. */
export const LIVE_STATES: readonly OrderState[] = ['pending', 'validating', 'ready', 'failed'];

export type AcmeOrderRow = {
  id: string;
  accountKey: string;
  accountId: string;
  certificateKey: string;
  certificateId: string;
  domains: string[];
  state: OrderState;
  orderUrl: string | undefined;
  finalizeUrl: string | undefined;
  certificateUrl: string | undefined;
  issuedRef: string | undefined;
  certKeyRef: string | undefined;
  attempts: number;
  lastError: string | undefined;
};

export type ChallengeRow = {
  id: string;
  orderId: string;
  domain: string;
  type: 'http-01' | 'dns-01';
  token: string;
  value: string;
  authzUrl: string;
  challengeUrl: string;
  placedAt: string | undefined;
  cleanedAt: string | undefined;
};

const text = (r: Row, k: string): string => String(r[k]);
const maybe = (r: Row, k: string): string | undefined =>
  r[k] === null || r[k] === undefined ? undefined : String(r[k]);

/**
 * 지수 백오프. §8.2 *"CA 레이트 리밋 인지 + 지수 백오프"*.
 *
 * **상한을 둔다.** 무한히 늘리면 사람이 고친 뒤에도 몇 시간을 기다리게 되고, 그건
 * "포기" 와 구분되지 않는다. 포기는 `abandoned` 라는 이름이 따로 있다.
 */
export function backoffSeconds(attempts: number): number {
  return Math.min(60 * 2 ** Math.max(0, attempts - 1), 3600);
}

/** 이 회차 이후로는 사람이 봐야 한다. */
export const MAX_ATTEMPTS = 8;

export class AcmeStore {
  constructor(private readonly db: Db) {}

  /** 계정을 만들거나 있으면 그대로. 디렉토리당 하나다. */
  async upsertAccount(opts: {
    key: string; directoryUrl: string; accountKeyRef: string;
    contact?: readonly string[]; by: string;
  }): Promise<string> {
    const r = await this.db.query(
      `INSERT INTO acme_accounts (id,key,directory_url,contact,account_key_ref,created_by)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5)
       ON CONFLICT (directory_url) DO UPDATE SET
         contact=EXCLUDED.contact, updated_at=now()
       RETURNING id`,
      [opts.key, opts.directoryUrl, opts.contact ?? [], opts.accountKeyRef, opts.by],
    );
    return text(r.rows[0] ?? {}, 'id');
  }

  /** CA 가 준 계정 URL(kid)을 기억한다. 재시작 뒤 다시 등록하지 않기 위해서다. */
  async setAccountUrl(accountId: string, url: string): Promise<void> {
    await this.db.query(
      `UPDATE acme_accounts SET account_url=$2, tos_agreed_at=COALESCE(tos_agreed_at, now()),
              updated_at=now() WHERE id=$1`,
      [accountId, url],
    );
  }

  async account(directoryUrl: string): Promise<
    { id: string; key: string; accountKeyRef: string; accountUrl: string | undefined } | undefined
  > {
    const r = (await this.db.query(
      'SELECT id,key,account_key_ref,account_url FROM acme_accounts WHERE directory_url=$1',
      [directoryUrl],
    )).rows[0];
    if (r === undefined) return undefined;
    return {
      id: text(r, 'id'), key: text(r, 'key'),
      accountKeyRef: text(r, 'account_key_ref'), accountUrl: maybe(r, 'account_url'),
    };
  }

  /**
   * 주문을 연다. **이미 살아 있는 주문이 있으면 그것을 돌려준다.**
   *
   * 갱신 스케줄러는 주기적으로 돌고, 주문 하나가 여러 틱에 걸쳐 진행된다. 매 틱마다 새
   * 주문을 내면 CA 의 레이트리밋에 그대로 걸리고 챌린지가 서로를 덮는다. DB 의 부분
   * 유일 인덱스가 그걸 **구조적으로** 막고, 여기서는 그 충돌을 조회로 바꾼다.
   */
  async openOrder(opts: {
    accountId: string; certificateId: string; domains: readonly string[];
  }): Promise<{ id: string; created: boolean }> {
    const existing = (await this.db.query(
      `SELECT id FROM acme_orders WHERE certificate_id=$1 AND state = ANY($2::acme_order_state[])`,
      [opts.certificateId, LIVE_STATES],
    )).rows[0];
    if (existing !== undefined) return { id: text(existing, 'id'), created: false };

    const id = randomUUID();
    await this.db.query(
      `INSERT INTO acme_orders (id,account_id,certificate_id,domains) VALUES ($1,$2,$3,$4)`,
      [id, opts.accountId, opts.certificateId, [...opts.domains]],
    );
    return { id, created: true };
  }

  /**
   * 지금 처리할 주문 하나를 **집는다.**
   *
   * `FOR UPDATE SKIP LOCKED` 로 고른다 — 둘이 동시에 오면 서로 다른 주문을 집거나 하나는
   * 빈손으로 돌아간다. 기다리게 하면 스케줄러 틱이 서로를 막는다.
   *
   * lease 가 **시간 기반**인 이유: 실행권을 든 채 죽은 프로세스를 영원히 기다릴 수 없다.
   * 대가는 "죽은 줄 알았는데 살아 있는" 창이고, 그건 CA 쪽 멱등성(같은 주문 URL 재조회)이
   * 흡수한다 — 챌린지 수락은 여러 번 해도 되고, finalize 는 이미 valid 면 그대로다.
   */
  async claimDue(holder: string, leaseSeconds = 120): Promise<AcmeOrderRow | undefined> {
    return this.db.tx(async (c: Queryable) => {
      const picked = (await c.query(
        `SELECT id FROM acme_orders
          WHERE state = ANY($1::acme_order_state[])
            AND next_attempt_at <= now()
            AND (claimed_until IS NULL OR claimed_until < now())
          ORDER BY next_attempt_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1`,
        [LIVE_STATES],
      )).rows[0];
      if (picked === undefined) return undefined;

      await c.query(
        `UPDATE acme_orders SET claimed_by=$2, claimed_until=now() + ($3 || ' seconds')::interval,
                updated_at=now() WHERE id=$1`,
        [text(picked, 'id'), holder, String(leaseSeconds)],
      );
      return this.#read(c, text(picked, 'id'));
    });
  }

  async release(orderId: string): Promise<void> {
    await this.db.query(
      'UPDATE acme_orders SET claimed_by=NULL, claimed_until=NULL, updated_at=now() WHERE id=$1',
      [orderId],
    );
  }

  async get(orderId: string): Promise<AcmeOrderRow | undefined> {
    return this.#read(this.db, orderId);
  }

  async #read(c: Queryable, orderId: string): Promise<AcmeOrderRow | undefined> {
    const r = (await c.query(
      `SELECT o.*, a.key AS account_key, ce.key AS certificate_key
         FROM acme_orders o
         JOIN acme_accounts a ON a.id = o.account_id
         JOIN certificates ce ON ce.id = o.certificate_id
        WHERE o.id=$1`,
      [orderId],
    )).rows[0];
    if (r === undefined) return undefined;
    return {
      id: text(r, 'id'),
      accountId: text(r, 'account_id'),
      accountKey: text(r, 'account_key'),
      certificateId: text(r, 'certificate_id'),
      certificateKey: text(r, 'certificate_key'),
      domains: (r['domains'] as string[] | null) ?? [],
      state: text(r, 'state') as OrderState,
      orderUrl: maybe(r, 'order_url'),
      finalizeUrl: maybe(r, 'finalize_url'),
      certificateUrl: maybe(r, 'certificate_url'),
      issuedRef: maybe(r, 'issued_ref'),
      certKeyRef: maybe(r, 'cert_key_ref'),
      attempts: Number(r['attempts']),
      lastError: maybe(r, 'last_error'),
    };
  }

  /** CA 쪽 좌표를 붙인다. 재시작 뒤 이어서 몰려면 이게 있어야 한다. */
  async recordOrderUrls(orderId: string, urls: {
    orderUrl: string; finalizeUrl: string; expiresAt?: string;
  }): Promise<void> {
    await this.db.query(
      `UPDATE acme_orders SET order_url=$2, finalize_url=$3,
              expires_at=COALESCE($4::timestamptz, expires_at), updated_at=now()
        WHERE id=$1`,
      [orderId, urls.orderUrl, urls.finalizeUrl, urls.expiresAt ?? null],
    );
  }

  async advance(orderId: string, state: OrderState): Promise<void> {
    await this.db.query(
      'UPDATE acme_orders SET state=$2, updated_at=now() WHERE id=$1', [orderId, state]);
  }

  /**
   * 발급 성공. **실행권을 함께 놓는다** — 종단 상태는 실행권을 들 수 없다(DB CHECK).
   */
  async markIssued(orderId: string, issuedRef: string, certKeyRef: string): Promise<void> {
    await this.db.query(
      `UPDATE acme_orders
          SET state='issued', issued_ref=$2, cert_key_ref=$3,
              claimed_by=NULL, claimed_until=NULL, last_error=NULL, updated_at=now()
        WHERE id=$1`,
      [orderId, issuedRef, certKeyRef],
    );
  }

  async setCertKeyRef(orderId: string, ref: string): Promise<void> {
    await this.db.query(
      'UPDATE acme_orders SET cert_key_ref=$2, updated_at=now() WHERE id=$1', [orderId, ref]);
  }

  /**
   * 이번 시도 실패. 백오프를 걸고, 상한을 넘으면 포기한다.
   *
   * **포기를 조용히 하지 않는다** — `abandoned` 는 "그만 시도한다" 는 뜻이고 사람이 봐야
   * 한다. 계속 재시도하면서 아무 말도 안 하는 것이 더 나쁘다.
   */
  async fail(orderId: string, error: string): Promise<OrderState> {
    const r = await this.db.query(
      `UPDATE acme_orders
          SET attempts = attempts + 1,
              state = CASE WHEN attempts + 1 >= $3 THEN 'abandoned'::acme_order_state
                           ELSE 'failed'::acme_order_state END,
              next_attempt_at = now() + (LEAST(60 * POWER(2, attempts), 3600) || ' seconds')::interval,
              last_error = $2,
              claimed_by = NULL, claimed_until = NULL,
              updated_at = now()
        WHERE id=$1
      RETURNING state`,
      [orderId, error.slice(0, 2000), MAX_ATTEMPTS],
    );
    return text(r.rows[0] ?? {}, 'state') as OrderState;
  }

  // ── 챌린지 ──────────────────────────────────────────────────────────────

  async putChallenge(ch: Omit<ChallengeRow, 'id' | 'placedAt' | 'cleanedAt'>): Promise<string> {
    const r = await this.db.query(
      `INSERT INTO acme_challenges (id,order_id,domain,type,token,value,authz_url,challenge_url)
       VALUES (gen_random_uuid(),$1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (order_id, domain, type) DO UPDATE SET
         token=EXCLUDED.token, value=EXCLUDED.value,
         authz_url=EXCLUDED.authz_url, challenge_url=EXCLUDED.challenge_url
       RETURNING id`,
      [ch.orderId, ch.domain, ch.type, ch.token, ch.value, ch.authzUrl, ch.challengeUrl],
    );
    return text(r.rows[0] ?? {}, 'id');
  }

  /** 자료를 실제로 놓았다. **"놓을 예정" 과 구분해야 치울 대상을 안다.** */
  async markPlaced(challengeId: string): Promise<void> {
    await this.db.query(
      'UPDATE acme_challenges SET placed_at=now() WHERE id=$1 AND placed_at IS NULL',
      [challengeId]);
  }

  async markCleaned(challengeId: string): Promise<void> {
    await this.db.query(
      'UPDATE acme_challenges SET cleaned_at=now() WHERE id=$1 AND placed_at IS NOT NULL',
      [challengeId]);
  }

  async challenges(orderId: string): Promise<ChallengeRow[]> {
    return (await this.db.query(
      'SELECT * FROM acme_challenges WHERE order_id=$1 ORDER BY domain', [orderId],
    )).rows.map((r): ChallengeRow => ({
      id: text(r, 'id'), orderId: text(r, 'order_id'), domain: text(r, 'domain'),
      type: text(r, 'type') as 'http-01', token: text(r, 'token'), value: text(r, 'value'),
      authzUrl: text(r, 'authz_url'), challengeUrl: text(r, 'challenge_url'),
      placedAt: maybe(r, 'placed_at'), cleanedAt: maybe(r, 'cleaned_at'),
    }));
  }

  /**
   * 고아 — **놓았는데 안 치운** 챌린지 (§8.2 *"주기적 고아 스캔"*).
   *
   * S18 이 실측했다: 버려진 주문을 CA 는 `pending` 으로 남긴다. 그러니 "주문이 끝났나" 로
   * 물으면 영영 안 걸린다. **자료를 놓았는가**로 묻는다 — 그게 우리가 아는 사실이다.
   */
  async orphans(olderThanSeconds: number): Promise<ChallengeRow[]> {
    return (await this.db.query(
      `SELECT c.* FROM acme_challenges c
         JOIN acme_orders o ON o.id = c.order_id
        WHERE c.placed_at IS NOT NULL AND c.cleaned_at IS NULL
          AND (o.state IN ('issued','abandoned')
               OR c.placed_at < now() - ($1 || ' seconds')::interval)
        ORDER BY c.placed_at`,
      [String(olderThanSeconds)],
    )).rows.map((r): ChallengeRow => ({
      id: text(r, 'id'), orderId: text(r, 'order_id'), domain: text(r, 'domain'),
      type: text(r, 'type') as 'http-01', token: text(r, 'token'), value: text(r, 'value'),
      authzUrl: text(r, 'authz_url'), challengeUrl: text(r, 'challenge_url'),
      placedAt: maybe(r, 'placed_at'), cleanedAt: maybe(r, 'cleaned_at'),
    }));
  }
}

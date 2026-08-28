/**
 * ACME 갱신 러너 (DESIGN.md §8.2 · ADR-ACME · S18)
 *
 * 원장(`AcmeStore`)은 **무엇을 언제** 를 알고, 프로토콜(`AcmeClient`)은 **어떻게** 를 안다.
 * 이 파일은 그 둘을 잇고 **한 틱에 한 걸음씩** 옮긴다.
 *
 * ── 왜 한 걸음씩인가 ────────────────────────────────────────────────────
 *
 * 발급 한 바퀴는 CA 의 검증을 기다리는 구간을 포함한다. 그걸 한 호출 안에서 끝까지 몰면
 * **실행권을 든 채 몇 분을 붙잡고**, 그동안 죽으면 어디까지 갔는지 아무도 모른다.
 * 상태를 DB 에 적고 틱마다 이어서 몰면, 죽어도 다음 틱이 같은 자리에서 재개한다 —
 * `ApplyRunner` 가 저널로 하는 일과 같다.
 *
 * ── 리더만 돈다 ────────────────────────────────────────────────────────
 *
 * 스탠바이가 함께 주문하면 nonce 가 서로를 깨뜨리고 챌린지를 두 번 수락한다. 실행권이
 * 그걸 막지만, **애초에 두 명이 시도하지 않는 것**이 낫다 — 실행권은 승계 순간의 겹침을
 * 위한 것이지 상시 경합을 위한 것이 아니다.
 */
import { createPrivateKey, type KeyObject } from 'node:crypto';

import { AcmeClient, dns01Value, keyAuthorization, type Authorization } from '../acme/client.js';
import { newEcKey } from '../acme/der.js';
import { AcmeStore, type AcmeOrderRow, type ChallengeRow } from './acme-store.js';
import { challengeTypeWanted } from './dns01.js';
import { inspectMaterial } from '../dp/certinfo.js';
import type { SecretStore } from '../dp/secrets.js';
import { log } from '../obs/log.js';
import { count } from '../obs/metrics.js';

/**
 * 챌린지 자료를 실제로 놓고 치우는 쪽.
 *
 * http-01 은 데이터 플레인의 shared dict 이고(ADR-ACME ①), dns-01 은 DNS 프로바이더다.
 * 프로바이더가 없으면 와일드카드 주문을 있는 척하지 않는다.
 */
export interface ChallengePlacer {
  readonly type: 'http-01' | 'dns-01';
  place(domain: string, token: string, value: string): Promise<void>;
  remove(domain: string, token: string): Promise<void>;
}

export type AcmeRunnerOptions = {
  store: AcmeStore;
  secrets: SecretStore;
  placer: ChallengePlacer;
  /** 없으면 와일드카드·dns-01 주문은 실패한다. */
  dnsPlacer?: ChallengePlacer;
  /** 계정 키·인증서 키를 만든다. 테스트가 결정적으로 만들려고 갈아 끼운다. */
  newKey?: () => KeyObject;
  /** ACME 클라이언트를 만든다. 스파이크·테스트가 CA 를 바꿔 끼운다. */
  clientFor?: (directoryUrl: string, accountKey: KeyObject) => AcmeClient;
  /** 만료 며칠 전에 갱신할 것인가 (§8.2 는 30 일). */
  renewBeforeDays?: number;
  now?: () => Date;
};

/** 한 틱이 한 일. 관측과 테스트가 이걸 본다. */
export type TickResult = {
  /** 이번 틱에 옮긴 주문 (없으면 undefined). */
  order?: string;
  from?: string;
  to?: string;
  error?: string;
};

export class AcmeRunner {
  readonly #o: AcmeRunnerOptions;
  readonly #newKey: () => KeyObject;
  #timer: NodeJS.Timeout | undefined;
  /** 틱이 겹치지 않게 (검수 D11). `HealthProber` 의 것과 같은 가드다. */
  #running = false;

  constructor(opts: AcmeRunnerOptions) {
    this.#o = opts;
    this.#newKey = opts.newKey ?? newEcKey;
  }

  #now(): Date {
    return this.#o.now?.() ?? new Date();
  }

  #placer(type: 'http-01' | 'dns-01'): ChallengePlacer {
    if (type === 'dns-01') {
      if (this.#o.dnsPlacer === undefined) throw new Error('dns-01 프로바이더가 없다');
      return this.#o.dnsPlacer;
    }
    return this.#o.placer;
  }

  #client(directoryUrl: string, accountKey: KeyObject): AcmeClient {
    return this.#o.clientFor?.(directoryUrl, accountKey)
      ?? new AcmeClient({ directoryUrl, accountKey });
  }

  /**
   * 갱신이 필요한 인증서에 주문을 연다.
   *
   * **`openOrder` 가 멱등이므로 매 틱 불러도 된다** — 살아 있는 주문이 있으면 그것을
   * 돌려준다. 여기서 판단하는 것은 "언제부터 필요한가" 뿐이다.
   */
  async scan(certs: readonly {
    key: string; id: string; materialRef?: string; acme?: { account: string; domains: string[] };
  }[]): Promise<string[]> {
    const days = this.#o.renewBeforeDays ?? 30;
    const opened: string[] = [];
    for (const cert of certs) {
      const acme = cert.acme;
      if (acme === undefined) continue;
      // **키로 찾는다.** 설정이 가리키는 것은 계정 이름이지 디렉토리 URL 이 아니다.
      const account = await this.#o.store.accountByKey(acme.account);
      if (account === undefined) {
        log.warn('acme.no_account', { certificate: cert.key, account: acme.account });
        continue;
      }
      if (!this.#due(cert.materialRef, days)) continue;
      const r = await this.#o.store.openOrder({
        accountId: account.id, certificateId: cert.id, domains: acme.domains,
      });
      if (r.created) {
        opened.push(r.id);
        count('bary_acme_orders_total{event="opened"}');
        log.info('acme.order.opened', { certificate: cert.key, domains: acme.domains });
      }
    }
    return opened;
  }

  /**
   * 지금 주문해야 하는가.
   *
   * 자료가 없으면 **무조건 필요하다** — 첫 발급이다. 있으면 만료까지 남은 날로 판단한다.
   * 사실을 SecretStore 에서 읽으므로 **개인키를 안 읽는다**(§7.2 회차에 세운 규칙).
   */
  #due(materialRef: string | undefined, days: number): boolean {
    if (materialRef === undefined) return true;
    const facts = this.#o.secrets.facts(materialRef);
    // 사실을 모르면 판단할 수 없다. **모르는 것을 "갱신 필요" 로 읽지 않는다** — 그러면
    // v0.6 1단계에 올라간 자료가 매 틱 새 주문을 낸다.
    if (facts === undefined) return false;
    const left = new Date(facts.notAfter).getTime() - this.#now().getTime();
    return left <= days * 86_400_000;
  }

  /**
   * 주문 하나를 **한 걸음** 옮긴다. 할 일이 없으면 `undefined`.
   *
   * 실행권은 여기서 잡고 여기서 놓는다. 실패는 `fail()` 이 백오프와 함께 기록하고,
   * **성공적으로 한 걸음 갔으면 실행권만 놓는다** — 다음 걸음은 다음 틱이다.
   */
  async step(): Promise<TickResult | undefined> {
    const order = await this.#o.store.claimDue(`acme-runner-${process.pid}`);
    if (order === undefined) return undefined;
    const from = order.state;
    try {
      const to = await this.#drive(order);
      if (to !== order.state) {
        count(`bary_acme_orders_total{event="${to}"}`);
        log.info('acme.order.advanced', { order: order.id, from, to });
      }
      // 종단이면 `markIssued` 가 이미 놓았다 (DB CHECK 가 그걸 강제한다).
      if (to !== 'issued' && to !== 'abandoned') await this.#o.store.release(order.id);
      return { order: order.id, from, to };
    } catch (e) {
      const message = (e as Error).message;
      const state = await this.#o.store.fail(order.id, message);
      count(`bary_acme_orders_total{event="${state}"}`);
      log.warn('acme.order.failed', { order: order.id, from, state, error: message });
      await this.cleanupOrder(order.id);
      return { order: order.id, from, to: state, error: message };
    }
  }

  async #drive(order: AcmeOrderRow): Promise<AcmeOrderRow['state']> {
    // 계정은 주문에 매달려 있다. 디렉토리 URL 과 키 참조를 계정 행에서 읽는다.
    const acct = await this.#accountFor(order);
    const client = this.#client(acct.directoryUrl, acct.key);
    if (acct.accountUrl === undefined) {
      const url = await client.register();
      await this.#o.store.setAccountUrl(order.accountId, url);
    } else {
      // 이미 등록된 계정이면 `kid` 를 다시 쓴다 — `newAccount` 를 또 부르면 CA 가
      // 같은 계정을 돌려주긴 하지만 요청 하나가 낭비되고 레이트리밋에 계산된다.
      //
      // **이 줄은 오래 `await client.register()` 였다** (검수 D16). 위 주석이 계약을
      // 말하는데 코드가 안 지켰다 — `#kid` 를 놓을 방법이 클라이언트에 없었기 때문이다.
      // Let's Encrypt 의 `newAccount` 는 IP 당 시간당 10 회이고 러너는 **틱마다**
      // 이걸 불렀다: 기본 30 초 간격이면 한 시간에 120 회다.
      client.resumeAccount(acct.accountUrl);
    }

    switch (order.state) {
      case 'pending':
        return this.#startOrder(client, order);
      case 'validating':
        return this.#pollOrder(client, order);
      case 'ready':
        return this.#finalize(client, order);
      case 'failed':
        // 재시도는 처음부터가 아니라 **CA 가 아는 자리**에서 이어 간다.
        return order.orderUrl === undefined
          ? this.#startOrder(client, order)
          : this.#pollOrder(client, order);
      default:
        return order.state;
    }
  }

  async #accountFor(order: AcmeOrderRow): Promise<{
    directoryUrl: string; key: KeyObject; accountUrl: string | undefined;
  }> {
    const row = await this.#o.store.accountById(order.accountId);
    if (row === undefined) throw new Error(`주문 ${order.id} 의 계정이 없다`);
    // 계정 키는 인증서가 없는 키다 — `key://` 참조로 산다.
    return {
      directoryUrl: row.directoryUrl,
      key: createPrivateKey(await this.#o.secrets.getKey(row.accountKeyRef)),
      accountUrl: row.accountUrl,
    };
  }

  /** 주문을 내고 챌린지 자료를 놓는다. */
  async #startOrder(client: AcmeClient, order: AcmeOrderRow): Promise<AcmeOrderRow['state']> {
    const { url, order: created } = await client.newOrder(order.domains);
    await this.#o.store.recordOrderUrls(order.id, {
      orderUrl: url, finalizeUrl: created.finalize,
      ...(created.expires === undefined ? {} : { expiresAt: created.expires }),
    });

    const accountKey = (await this.#accountFor(order)).key;
    for (const authzUrl of created.authorizations) {
      const authz: Authorization = await client.fetchAuthorization(authzUrl);
      // **CA 가 준 이름을 대조한다** — 아래 전부가 이 값 위에 선다 (검수 D19).
      assertOrdered(order, authz.identifier.value);
      const wanted = challengeTypeWanted(
        { value: authz.identifier.value, ...(authz.wildcard === true ? { wildcard: true } : {}) },
        this.#o.placer.type === 'http-01',
      );
      const placer = this.#placer(wanted);
      const ch = authz.challenges.find((c) => c.type === wanted);
      if (ch === undefined) {
        // S18 실측: 와일드카드 authz 에는 http-01 이 **아예 없다.**
        throw new Error(
          `'${authz.identifier.value}' 에 ${wanted} 챌린지가 없다 ` +
          `(있는 것: ${authz.challenges.map((c) => c.type).join(',')})`);
      }
      const value = wanted === 'dns-01'
        ? dns01Value(ch.token, accountKey)
        : keyAuthorization(ch.token, accountKey);

      const id = await this.#o.store.putChallenge({
        orderId: order.id, domain: authz.identifier.value, type: wanted,
        token: ch.token, value, authzUrl, challengeUrl: ch.url,
      });
      // **놓고 나서 적는다.** 반대로 하면 "놓았다고 적혔는데 없는" 것이 생기고, 고아
      // 스캔이 없는 것을 치우려 든다. 이쪽으로 틀리면 "안 적힌 채 놓인" 것이 생기는데,
      // 그건 다음 `putChallenge` 가 같은 토큰을 덮으면서 회수된다.
      await placer.place(authz.identifier.value, ch.token, value);
      await this.#o.store.markPlaced(id);
      await client.acceptChallenge(ch.url);
    }
    await this.#o.store.advance(order.id, 'validating');
    return 'validating';
  }

  /** CA 의 판정을 본다. **`invalid` 는 기다리지 않고 실패로 확정한다** (S18). */
  async #pollOrder(client: AcmeClient, order: AcmeOrderRow): Promise<AcmeOrderRow['state']> {
    if (order.orderUrl === undefined) throw new Error('주문 URL 이 없다');
    const now = await client.fetchOrder(order.orderUrl);
    if (now.status === 'invalid') {
      throw new Error(`CA 가 주문을 거절했다: ${now.error?.detail ?? '(detail 없음)'}`);
    }
    if (now.status === 'ready' || now.status === 'valid') {
      await this.#o.store.advance(order.id, 'ready');
      return 'ready';
    }
    // 아직 검증 중이다. **실패가 아니다** — 상태를 그대로 두고 다음 틱에 다시 본다.
    return 'validating';
  }

  /** CSR 을 보내고 인증서를 받아 SecretStore 에 넣는다. */
  async #finalize(client: AcmeClient, order: AcmeOrderRow): Promise<AcmeOrderRow['state']> {
    if (order.orderUrl === undefined) throw new Error('주문 URL 이 없다');

    // **인증서 키는 주문에 매달린다.** CSR 에 서명한 키와 발급된 인증서가 짝이어야 하고,
    // 재시작을 넘어 살아 있어야 한다 — 매번 새로 만들면 finalize 재시도가 짝을 잃는다.
    let certKey: KeyObject;
    // **claim 시점의 스냅샷을 믿지 않는다.** 방금 이 함수가 저장한 키 참조는 `order` 에
    // 없다 — 그대로 쓰면 `markIssued` 가 빈 문자열을 쓰고 DB CHECK 에 걸린다.
    let certKeyRef = order.certKeyRef;
    if (order.certKeyRef === undefined) {
      certKey = this.#newKey();
      // **키를 먼저 durable 하게 둔다.** 여기서 죽으면 발급된 인증서가 짝을 잃고, 그러면
      // 새 주문을 내야 한다 — CA 의 레이트리밋이 그걸 센다. 인증서가 아직 없으므로
      // `key://` 참조로 둔다 (§7.2 의 "한 쌍" 계약을 안 깨면서).
      const ref = await this.#o.secrets.putKey(
        `acme-${order.certificateKey}`,
        certKey.export({ type: 'pkcs8', format: 'pem' }).toString());
      certKeyRef = ref.ref;
      await this.#o.store.setCertKeyRef(order.id, ref.ref);
    } else {
      certKey = createPrivateKey(await this.#o.secrets.getKey(order.certKeyRef));
    }

    const current = await client.fetchOrder(order.orderUrl);
    const done = await client.finalize(current, order.orderUrl, order.domains, certKey);
    if (done.status !== 'valid' || done.certificate === undefined) {
      throw new Error(`finalize 가 ${done.status} 로 끝났다`);
    }
    const pem = await client.downloadCertificate(done.certificate);
    const privkey = certKey.export({ type: 'pkcs8', format: 'pem' }).toString();

    // **받은 것을 검증한다.** 200 을 받은 것과 쓸 수 있는 인증서를 받은 것은 다르다
    // (S18 이 같은 이유로 발급 인증서와 CSR 키의 짝을 확인한다).
    inspectMaterial(pem, privkey, this.#now());
    const ref = await this.#o.secrets.put(`acme-${order.certificateKey}`, { fullchain: pem, privkey });

    // `issuedRef` 는 인증서 자료(체인+키), `certKeyRef` 는 주문이 쓴 키다. 둘을 같은
    // 값으로 두면 "어느 키로 CSR 을 만들었나" 를 잃는다.
    if (certKeyRef === undefined) throw new Error('인증서 키 참조가 없다');
    await this.#o.store.markIssued(order.id, ref.ref, certKeyRef);
    // 챌린지 자료를 치운다 — §8.2 는 "성공/실패와 무관하게" 라고 적었다.
    await this.cleanupOrder(order.id);
    return 'issued';
  }

  /** 이 주문의 놓인 챌린지를 치운다. 성공·실패 둘 다 부른다. */
  async cleanupOrder(orderId: string): Promise<number> {
    return cleanupPlacedChallenges(
      await this.#o.store.challenges(orderId),
      (row) => this.#placer(row.type).remove(row.domain, row.token),
      (id) => this.#o.store.markCleaned(id),
    );
  }

  /**
   * 고아 챌린지를 치운다 (§8.2 *"주기적 고아 스캔"*).
   *
   * S18 실측: **버려진 주문을 CA 는 안 치운다.** 주문 상태로 물으면 영영 안 걸리므로
   * 원장이 "놓았는가" 로 판단한다.
   */
  async cleanup(olderThanSeconds = 3600): Promise<number> {
    return cleanupPlacedChallenges(
      await this.#o.store.orphans(olderThanSeconds),
      (row) => this.#placer(row.type).remove(row.domain, row.token),
      (id) => this.#o.store.markCleaned(id),
    );
  }

  /**
   * 주기 실행. **틱이 겹치지 않는다** (검수 D11).
   *
   * `setInterval` 은 앞 틱이 끝났는지 안 본다. CA 가 느리면(또는 안 답하면) 틱이
   * 쌓이고, 각자 `claimDue` 로 실행권을 잡으려 든다 — 원장이 그 경합을 막아 주긴
   * 하지만 막는 것과 안 만드는 것은 다르다. 쌓인 틱은 전부 살아 있는 fetch 를 하나씩
   * 물고 있고, 그것이 이 프로세스의 소켓과 메모리다.
   *
   * `HealthProber.start` 가 같은 자리에 같은 가드를 갖고 있다. **한쪽만 갖고 있는
   * 것이 그 자체로 신호였다** — 두 틱은 같은 성질을 가졌다(느릴 수 있고, durable
   * 실행권을 잡는다).
   */
  start(intervalMs: number, isLeader: () => boolean, certs: () => Promise<Parameters<AcmeRunner['scan']>[0]>): void {
    this.#timer = setInterval(() => {
      void (async (): Promise<void> => {
        // **리더만 돈다.** 스탠바이가 함께 주문하면 nonce 가 서로를 깨뜨린다.
        if (!isLeader()) return;
        if (this.#running) return;
        this.#running = true;
        try {
          await this.scan(await certs());
          await this.step();
        } catch (e) {
          log.error('acme.tick.failed', { error: (e as Error).message });
        } finally {
          this.#running = false;
        }
      })();
    }, intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

/**
 * http-01 챌린지를 **데이터 플레인의 shared dict** 에 놓는다 (ADR-ACME ①).
 *
 * conf 를 안 바꾼다 — 그래서 갱신에 세대 전환이 없다. 멤버십 적재와 같은 admin 표면을
 * 쓰고, 같은 이유로 **되읽어 대조한다**: `nginx -t` 는 Lua 를 하나도 검증하지 않으므로
 * (E64) 이 경로가 실제로 도는지는 써 놓고 다시 읽는 것으로만 알 수 있다.
 */
/** 놓인 챌린지를 치운다. 하나 실패해도 다음을 계속한다. */
export async function cleanupPlacedChallenges(
  rows: readonly ChallengeRow[],
  remove: (row: ChallengeRow) => Promise<void>,
  markCleaned: (id: string) => Promise<void>,
): Promise<number> {
  let n = 0;
  for (const o of rows) {
    if (o.placedAt === undefined || o.cleanedAt !== undefined) continue;
    try {
      await remove(o);
      await markCleaned(o.id);
      n += 1;
    } catch (e) {
      log.warn('acme.cleanup.failed', { challenge: o.id, error: (e as Error).message });
    }
  }
  if (n > 0) count(`bary_acme_cleanup_total{outcome="removed"}`);
  return n;
}

/**
 * **CA 가 준 이름이 우리가 주문한 것인가** (검수 D19).
 *
 * `authz.identifier.value` 는 아래 전부의 입력이다:
 *
 *   placer.place(값, …)        dns-01 이면 `join(dir, '_acme-challenge.<값>')` 이 된다.
 *                              `join` 이 `..` 을 정규화하므로 **챌린지 디렉토리 밖에**
 *                              파일을 쓸 수 있다 — 실측했다(`tests/store/audit-dns01-…`).
 *   store.putChallenge({domain: 값})   원장에 남고 고아 스캔이 그걸로 치운다
 *   placer.remove(값, …)       치울 때 같은 경로를 다시 만든다
 *
 * ── "CA 를 못 믿나" 는 잘못된 질문이다
 *
 * 우리가 믿는 것은 **디렉토리 URL 을 적은 운영자**이지 그 URL 뒤에 있는 것이 아니다.
 * 디렉토리는 설정값이고(`acme_accounts.directory_url`) 사설 CA·프록시·오타가 전부 정상
 * 배포다. 그리고 주문한 것과 다른 이름이 돌아오는 것은 배신이기 전에 **버그**이고,
 * 버그가 조용히 파일을 쓰면 안 된다.
 *
 * ── 왜 배치기가 아니라 여기인가
 *
 * http-01 도 같은 값을 쓴다. 배치기마다 고치면 배치기가 늘 때마다 빠뜨릴 자리가
 * 하나 는다 — 이 저장소가 목록으로 관리하다 물린 자리가 이미 둘이다(N1 · N3).
 *
 * ── 와일드카드는 이름이 다르게 온다
 *
 * RFC 8555 §7.1.3 — `*.b.test` 를 주문하면 authz 의 identifier 는 `b.test` 다. 문자열로만
 * 대조하면 **정상 와일드카드 발급이 통째로 막힌다.** 그래서 apex 도 받는다.
 *
 * `authz.wildcard` 플래그까지 요구하지는 **않는다.** 그 플래그가 빠진 CA 에서 와일드카드
 * 발급이 막히는 대가가 있고, 막으려는 것(우리가 와일드카드를 주문했는데 CA 가 apex 만
 * 검증하는 것)은 **프로토콜이 이미 닫는다** — finalize 에 나가는 CSR 이 `*.b.test` 라
 * apex authz 만으로는 CA 가 그 인증서를 못 낸다.
 */
function assertOrdered(order: AcmeOrderRow, value: string): void {
  const ordered = order.domains.some(
    (d) => d === value || (d.startsWith('*.') && d.slice(2) === value),
  );
  if (!ordered) {
    throw new Error(
      `CA 가 주문에 없는 도메인의 authz 를 줬다: ${JSON.stringify(value)} `
      + `(주문한 것: ${order.domains.join(', ')})`,
    );
  }
}

export class HttpChallengePlacer implements ChallengePlacer {
  readonly type = 'http-01' as const;

  /**
   * **소켓에 붙는 `fetch` 를 받는다** (검수 S-08b). 전에는 포트 번호였다 —
   * admin 표면이 루프백 TCP 였을 때 이야기다.
   */
  constructor(private readonly fetchImpl: typeof fetch) {}

  async place(_domain: string, token: string, value: string): Promise<void> {
    const write = await this.fetchImpl('http://admin/acme', {
      method: 'POST', body: `${token}=${value}`, signal: AbortSignal.timeout(5000),
    });
    if (!write.ok) {
      throw new Error(`챌린지 적재 실패 (http ${write.status}): ${await write.text()}`);
    }
    const read = await this.fetchImpl('http://admin/acme/read',
      { signal: AbortSignal.timeout(5000) });
    const body = (await read.text()).trim();
    // **적재됐다고 믿지 않는다.** 200 을 받은 것과 dict 에 들어간 것은 다르다.
    if (!body.split('\n').includes(`${token}=${value}`)) {
      throw new Error(`챌린지가 적재되지 않았다: 토큰 ${token} 이 되읽기에 없다`);
    }
  }

  async remove(_domain: string, token: string): Promise<void> {
    // dict 항목은 TTL 로도 사라지지만(ADR-ACME ①), **명시적으로 지운다** — TTL 에만
    // 기대면 "치웠다" 를 언제 적을지 알 수 없고, 그러면 고아 목록이 안 줄어든다.
    const r = await this.fetchImpl(`http://admin/acme?remove=${encodeURIComponent(token)}`, {
      method: 'POST', body: '', signal: AbortSignal.timeout(5000),
    });
    if (!r.ok) throw new Error(`챌린지 제거 실패 (http ${r.status})`);
  }
}

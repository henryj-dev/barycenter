/**
 * 발급된 인증서를 **설정에 반영한다** (DESIGN.md §8.2 · ADR-ACME)
 *
 * ADR-ACME ⑥ 이 정했다: *"발급과 게시는 다른 사건이다 — 주문이 성공하면 그 참조를 바꾸는
 * changeset 을 만든다."* 러너는 인증서를 받아 SecretStore 에 넣고 `issued` 로 끝낸다.
 * **거기까지는 nginx 가 아무것도 모른다.**
 *
 * ── 왜 별도 사건인가 ────────────────────────────────────────────────────
 *
 * 주문 상태를 리비전에 넣지 않기로 했으므로(009), 발급 결과가 설정에 닿으려면 **정상
 * 경로**(changeset → plan → commit → apply)를 지나야 한다. 그래야:
 *
 *   · 인증서 교체가 다른 설정 변경과 **같은 방식으로** 검증·기록·롤백된다
 *   · 감사 기록에 "누가 언제 무엇을" 이 남는다 (여기서는 `acme` 가 그 "누가" 다)
 *   · plan 의 impact 가 인증서 교체를 **미리 말한다**
 *
 * ── 수렴으로 쓴다 ──────────────────────────────────────────────────────
 *
 * "게시했다" 는 상태를 따로 안 만든다. **비교가 곧 판정**이다 — 인증서의 현재
 * `materialRef` 가 주문의 `issuedRef` 와 다르면 아직 안 간 것이다. 상태를 하나 더 두면
 * 그 상태와 실제가 어긋나는 경우가 생기고, 이 저장소는 그걸 여러 번 겪었다.
 *
 * ── 대가를 적어 둔다 ───────────────────────────────────────────────────
 *
 * 인증서 경로에 버전이 들어가므로(§7.2) 교체는 **렌더 산출물을 바꾸고**, 따라서 세대
 * 전환과 reload 를 부른다. 소크가 잰 값으로 **전환당 트래픽 2.6% 손실**이다. 챌린지
 * 서빙은 reload 가 없지만(ADR-ACME ①) **교체 자체는 없앨 수 없다** — nginx 가 새 인증서
 * 파일을 읽으려면 reload 가 필요하다. 갱신 주기가 그 비용의 빈도를 정한다.
 */
import type { AcmeStore } from './acme-store.js';
import type { ControlPlane } from './plane.js';
import type { ConfigStore } from '../store/config-store.js';
import type { Db } from '../store/pg.js';
import type { SecretStore } from '../dp/secrets.js';
import { log } from '../obs/log.js';
import { count } from '../obs/metrics.js';

export type PublishResult = {
  certificate: string;
  order: string;
  revision?: string;
  operation?: string;
  error?: string;
};

export type PublisherOptions = {
  db: Db;
  store: ConfigStore;
  control: ControlPlane;
  acme: AcmeStore;
  secrets: SecretStore;
  /** 커밋만 하고 활성화는 사람이 한다. 기본은 자동이다 (§8.2 — 갱신은 자동). */
  applyAutomatically?: boolean;
  by?: string;
};

/**
 * 게시를 기다리는 것들 — **발급됐는데 설정이 모르는** 인증서.
 *
 * 주문 상태가 아니라 **두 참조의 차이**로 찾는다. 그래서 게시가 중간에 죽어도 다음 틱이
 * 같은 것을 다시 집는다.
 */
export async function pendingPublications(db: Db): Promise<{
  orderId: string; certificateKey: string; issuedRef: string;
}[]> {
  return (await db.query(
    `SELECT o.id AS order_id, c.key AS certificate_key, o.issued_ref
       FROM acme_orders o
       JOIN certificates c ON c.id = o.certificate_id
      WHERE o.state = 'issued'
        AND o.issued_ref IS NOT NULL
        AND c.material_ref IS DISTINCT FROM o.issued_ref
      ORDER BY o.updated_at`,
  )).rows.map((r) => ({
    orderId: String(r['order_id']),
    certificateKey: String(r['certificate_key']),
    issuedRef: String(r['issued_ref']),
  }));
}

/**
 * 한 번에 하나씩 게시한다.
 *
 * **여럿을 한 changeset 에 몰지 않는다.** 하나가 검증에 걸리면 나머지도 못 가고, 그러면
 * "왜 갱신이 안 되지" 의 원인이 다른 인증서에 있게 된다. 한 번에 하나면 실패가 자기
 * 자리에 남는다.
 */
export async function publishIssued(opts: PublisherOptions): Promise<PublishResult[]> {
  const by = opts.by ?? 'acme';
  const out: PublishResult[] = [];

  for (const p of await pendingPublications(opts.db)) {
    try {
      // 자료의 digest 는 **저장소에서 읽는다.** 주문이 기억한 값을 믿으면, 자료가 그
      // 사이에 바뀌었을 때 세대 결박이 거짓말이 된다 (§7.2).
      const ref = opts.secrets.describe(p.issuedRef);

      const head = await opts.store.head();
      const csId = await opts.store.createChangeset(head.revision, by);
      await opts.store.patchChangeset(csId, [{
        op: 'put', kind: 'certificate', key: p.certificateKey,
        body: {
          materialRef: ref.ref, chainDigest: ref.chainDigest, keyDigest: ref.keyDigest,
          // **ACME 의도를 지우지 않는다.** PUT 은 통째로 덮으므로, 안 실으면 다음 갱신이
          // 이 인증서를 자기 것으로 안 본다 — 한 번 갱신되고 영영 멈춘다.
          ...(await acmeIntentOf(opts.db, p.certificateKey)),
        },
      }], by);

      const plan = await opts.store.plan(csId, by);
      const committed = await opts.store.commit(csId, plan.id, by);

      const result: PublishResult = {
        certificate: p.certificateKey, order: p.orderId, revision: committed.revision,
      };
      if (opts.applyAutomatically !== false) {
        // **인증서 교체는 세대 전환이다** — nginx 가 새 파일을 읽으려면 reload 가 필요하고,
        // 전환당 트래픽 2.6% 가 실측값이다. 자동이라는 사실을 로그로 남긴다.
        const op = await opts.control.apply(plan.id, by);
        result.operation = op.id;
      }
      count('bary_acme_publish_total{outcome="committed"}');
      log.info('acme.published', result);
      out.push(result);
    } catch (e) {
      const error = (e as Error).message;
      count('bary_acme_publish_total{outcome="failed"}');
      // **다음 것을 계속한다.** 하나가 head 경합으로 밀리면 다음 틱이 다시 집는다 —
      // 여기서 멈추면 그 뒤 인증서들이 그 하나에 묶인다.
      log.warn('acme.publish.failed', { certificate: p.certificateKey, order: p.orderId, error });
      out.push({ certificate: p.certificateKey, order: p.orderId, error });
    }
  }
  return out;
}

/** 인증서에 붙어 있는 ACME 의도. PUT 이 통째로 덮으므로 함께 실어야 한다. */
async function acmeIntentOf(db: Db, key: string): Promise<{
  acme?: { account: string; domains: string[] };
}> {
  const r = (await db.query(
    'SELECT acme_account, acme_domains FROM certificates WHERE key=$1', [key])).rows[0];
  const account = r?.['acme_account'];
  if (account === null || account === undefined) return {};
  return { acme: { account: String(account), domains: (r?.['acme_domains'] as string[]) ?? [] } };
}

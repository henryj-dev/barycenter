/**
 * 컨트롤 플레인 — 커밋된 리비전을 실제 nginx 로 밀어 넣는다 (DESIGN.md §5.3, §6.2, §7.2)
 *
 * 정본 저장소(`ConfigStore`)와 데이터 플레인(`DataplaneDriver`) 사이의 유일한 연결이다.
 * 한 방향으로만 흐른다.
 *
 *   plan(committed) → render → materialize(세대) → ApplyOperation → driver.applyConfig
 *
 * **여기서 세대가 만들어진다.** 세대 이름에 `activation_epoch` 를 넣는 것이 중요하다 —
 * S19 가 실증한 대로 롤백은 *옛 내용*으로 *새 epoch* 를 굽는 것이고, 이름이 리비전만
 * 담으면 같은 내용의 롤백이 옛 세대 디렉토리를 재사용하게 된다.
 */
import { randomUUID } from 'node:crypto';

import { render, type RenderCapabilities } from '../conf/render.js';
import type { DataplaneDriver, DriverStatus } from '../dp/driver.js';
import { materializeGeneration } from '../dp/materialize.js';
import { DEFAULT_KEEP, sweepGenerations } from '../dp/retention.js';
import type { ApplyOperation, ApplyResult, Plane, PlaneTarget } from '../dp/operation.js';
import { ConfigStore, StoreError } from '../store/config-store.js';
import type { Db, Row } from '../store/pg.js';
import type { LeaderElection } from './leader.js';

export type ControlPlaneOptions = {
  /** `/etc/barycenter` 에 해당. `generations/` 와 `current` 가 여기 있다. */
  prefix: string;
  /**
   * 활성 세대 마커를 서빙할 포트 (§6.3-4).
   *
   * 루프백에만 바인딩한다. 이건 관리 표면이지 트래픽 표면이 아니다.
   */
  adminPort: number;
  renderCaps?: RenderCapabilities;
  /** 조회한 엔진 정보. `status()` 가 그대로 드러낸다. */
  engine?: unknown;
  /**
   * 남길 세대 수 (§9.1.1 — v0.1 은 GC 원장 대신 **수동 상한**이다).
   *
   * 활성·서빙 세대는 이 수와 무관하게 남는다. 0 이면 청소를 아예 안 한다 —
   * 디버깅용이고, **기본값으로 두면 디스크가 무한히 자란다.**
   */
  keepGenerations?: number;
};

export type OperationView = {
  id: string;
  planId: string;
  revision: string;
  activationEpoch: string;
  generation: string;
  phase: string;
  detail: unknown;
};

const PLANES: Plane[] = ['http', 'stream'];

/**
 * 세대에 결박된 admin 조각 (§7.2 `http/admin.conf`).
 *
 * **세대마다 다른 리터럴이어야 한다.** S7 의 A4.3 이 실측했다 — shared dict 마커는
 * "누가 응답했는가" 를 말하지 못한다. in-flight 요청을 옛 세대 워커가 처리하는 동안
 * 마커는 이미 새 값이었다. 렌더 리터럴이라야 옛 워커가 옛 값을 답한다.
 */
export const markerConf = (generation: string, port: number): string =>
  `# 이 파일은 세대에 결박된다. 세대마다 리터럴이 다르다 (§6.3-4).
server {
    listen 127.0.0.1:${port};
    default_type text/plain;
    location = /generation { return 200 "${generation}"; }
    location = /healthz    { return 200 "ok"; }
}
`;

export class ControlPlane {
  /**
   * 직전 apply 에서 읽은 DP 상태. **청소가 보호 대상을 고를 때만 쓴다.**
   *
   * 판정에는 절대 쓰지 않는다 — 캐시된 상태로 판정하면 그 사이 남이 옮긴 좌표를 못 본다.
   */
  private lastStatus: DriverStatus | undefined;

  constructor(
    private readonly db: Db,
    private readonly store: ConfigStore,
    private readonly driver: DataplaneDriver,
    /**
     * §3.5 — 토큰은 **선출에서 온다.** v0.1 까지는 환경변수였고, 그건 DP 가 그렇게
     * 정교하게 방어하는 값을 아무도 발급하지 않는다는 뜻이었다.
     */
    private readonly election: LeaderElection,
    private readonly opts: ControlPlaneOptions,
  ) {}

  /**
   * 커밋된 plan 을 활성화한다 (§5.2 `POST /apply`).
   *
   * **멱등하다.** 같은 `plan_id` 로 다시 부르면 새 오퍼레이션이 아니라 **같은 것**을
   * 돌려준다 (§5.3). 그 보장은 `operations.plan_id` 의 UNIQUE 제약이 진다 — 애플리케이션
   * 로직으로 지키면 동시 요청 둘이 각자 확인하고 각자 만든다.
   */
  async apply(planId: string, by: string): Promise<OperationView> {
    const existing = await this.findOperation(planId);
    if (existing !== undefined) return existing;

    const plan = await this.store.getPlan(planId);
    if (plan.state === 'planned') {
      throw new StoreError(409, 'not_committed', 'plan 을 먼저 커밋해야 한다 (§5.3)');
    }
    if (plan.targetRevision === undefined || plan.activationEpoch === undefined) {
      throw new StoreError(409, 'not_reserved', '이 plan 에는 예약된 좌표가 없다');
    }
    // **일반 apply 는 언제나 head 만 적용한다** (§5.3 superseded). 과거 리비전을 되돌리는
    // 것은 명시적 롤백의 몫이고, 그것도 *새 리비전*을 만들어서 한다.
    const head = await this.store.head();
    if (plan.targetRevision !== head.revision) {
      throw new StoreError(409, 'PLAN_STALE',
        `superseded: 이 plan 은 r${plan.targetRevision} 인데 head 는 r${head.revision} 이다`);
    }

    const rendered = render(plan.model, this.opts.renderCaps ?? { streamRealip: false });
    this.assertAdminPortFree(plan.model);

    // **이름에 epoch 를 넣는다.** 롤백은 옛 내용을 새 epoch 로 굽는다(§3.3, S19) —
    // 리비전만 담으면 같은 내용의 롤백이 옛 디렉토리를 재사용하고, 그러면 세대에 구워진
    // 마커 리터럴이 옛 세대와 같아져 활성화를 구분할 수 없다.
    const generation = `r${plan.targetRevision}-e${plan.activationEpoch}`;
    const manifest = materializeGeneration({
      prefix: this.opts.prefix,
      generation,
      planes: rendered.planes,
      files: {
        'nginx.conf': rendered.conf,
        'admin/marker.conf': markerConf(generation, this.opts.adminPort),
      },
    });

    const status = await this.driver.status();
    this.lastStatus = status;
    // **설정 전환은 언제나 두 평면을 옮긴다** (10차 반례 ②, `assertEnvelope`).
    //
    // 처음엔 `rendered.planes` 만 선언했다가 `envelope_mismatch` 로 막혔고, 그게 옳다.
    // 하나의 `nginx.conf` 가 http 와 stream 을 함께 지배하므로 **한쪽이 비게 되는 것도
    // 전환**이다. 목표에 있는 평면만 선언하면 `http+stream → http` 가 stream 을 없애면서
    // stream 좌표를 옛 값으로 남긴다 — 설정은 바뀌었는데 컨트롤 플레인은 모른다.
    //
    // manifest 의 `planes` 는 그대로 `rendered.planes` 다. 게시 전 검사는 선언이 manifest 를
    // **덮는지**만 보므로(부분집합) 어긋나지 않는다. 둘은 다른 것을 말한다 —
    // manifest 는 *이 세대가 무엇을 구성하는가*, 봉투는 *무엇이 움직이는가*.
    const planeTargets: Partial<Record<Plane, PlaneTarget>> = {};
    for (const plane of PLANES) {
      const cur = status.planes[plane];
      planeTargets[plane] = {
        expectedCurrent: {
          activationEpoch: cur.activationEpoch,
          membershipRevision: cur.membershipRevision,
        },
        target: {
          activationEpoch: plan.activationEpoch,
          // **v0.1 에는 멤버십 평면이 없다** (§9.1.1 — v0.3 으로 미뤘다). 0 으로 둔다.
          // 여기에 설정 리비전을 넣고 싶어지는데, 그건 거짓말이다 —
          // `membership_revision` 은 *그 epoch 안의* 헬스 리비전이지 설정 리비전이 아니다.
          membershipRevision: '0',
        },
        payloadDigest: rendered.digest,
      };
    }

    // **부작용 직전에 다시 묻는다.** 기동 때 리더였다는 기억으로는 부족하다 — 그 사이
    // 세션이 끊겼으면 락은 이미 풀렸고 신임이 fence 를 지났을 수 있다. 그래도 창은
    // 남고, 그 창은 여기서 못 닫는다. 닫는 것은 DP Agent 의 토큰 비교다 (§3.5).
    const leaderToken = this.election.assertLeader();

    const op: ApplyOperation = {
      leaderToken,
      operationId: randomUUID(),
      transitionId: `r${plan.targetRevision}`,
      affectedPlanes: [...PLANES],
      targetGeneration: generation,
      generationDigest: manifest.digest,
      planes: planeTargets,
    };

    // **먼저 행을 잡는다.** 부작용을 낸 뒤에 기록하면, 그 사이 크래시했을 때 세대는
    // 게시됐는데 어느 오퍼레이션이 냈는지 모르는 상태가 남는다. UNIQUE 가 지므로
    // 동시 요청 둘 중 하나는 여기서 진다.
    const claimed = await this.claim(op, planId, plan.targetRevision, plan.activationEpoch, by);
    if (claimed !== undefined) return claimed;   // 남이 먼저 잡았다 — 그쪽 것을 돌려준다

    let result: ApplyResult;
    try {
      result = await this.driver.applyConfig(op);
    } catch (e) {
      await this.recordPhase(op.operationId, 'failed', { error: String(e) });
      throw e;
    }
    await this.recordPhase(op.operationId, result.phase, result);
    await this.store.audit(by, 'apply', planId, undefined,
      { operationId: op.operationId, generation, phase: result.phase }, plan.targetRevision);

    if (result.phase === 'activated') {
      await this.db.query(`UPDATE plans SET state='applied' WHERE id=$1`, [planId]);
      // **활성화가 끝난 뒤에 치운다.** 앞에서 치우면 방금 만든 것을 지울 수 있고,
      // 실패했을 때 치우면 되돌아갈 자리를 지운다.
      this.sweep(generation, by);
    }
    return {
      id: op.operationId, planId, revision: plan.targetRevision,
      activationEpoch: plan.activationEpoch, generation,
      phase: result.phase, detail: result,
    };
  }

  /**
   * 전환을 포기한다 (§5.2 `/operations/{id}/cancel`).
   *
   * §5.3 — **조용한 중단은 없다.** 예약한 슬롯을 반납하고 종단 상태로 닫는다.
   * **이미 활성화된 것을 되돌리지는 않는다** — 되돌리는 것은 롤백이고, 롤백은 새 활성화
   * 사건이다 (§3.3). 그래서 활성화가 끝난 오퍼레이션은 취소 대상이 아니다.
   */
  async cancel(id: string, by: string): Promise<OperationView> {
    this.election.assertLeader();
    const r = (await this.db.query(
      `SELECT id, plan_id, revision, activation_epoch, generation, phase, detail, envelope
         FROM operations WHERE id=$1`, [id],
    )).rows[0];
    if (r === undefined) throw new StoreError(404, 'unknown_operation', `오퍼레이션 ${id} 이 없다`);
    const phase = String(r['phase']);
    if (phase === 'activated') {
      throw new StoreError(409, 'already_activated',
        '이미 활성화됐다 — 되돌리려면 롤백이다 (§3.3: 롤백은 새 활성화 사건이다)');
    }
    const envelope = r['envelope'] as ApplyOperation | null;
    if (envelope === null) {
      // 005 이전에 만들어진 행이다. **재구성하지 않는다** — 재구성한 튜플은 슬롯의
      // 주인으로 인정받지 못해 abort 가 아무것도 안 지운다.
      throw new StoreError(409, 'no_envelope',
        '이 오퍼레이션에는 보관된 봉투가 없다 (005 마이그레이션 이전). 재구성하면 정본 '
        + '튜플이 달라져 취소가 아무것도 못 지운다 — recover 로 이어받아 끝내야 한다');
    }
    await this.driver.abortConfig(envelope);
    await this.recordPhase(id, 'failed', { cancelled: true, by });
    await this.store.audit(by, 'operation.cancel', id, undefined, { generation: r['generation'] });
    return this.operation(id);
  }

  async operation(id: string): Promise<OperationView> {
    const r = (await this.db.query(
      `SELECT id, plan_id, revision, activation_epoch, generation, phase, detail
         FROM operations WHERE id=$1`, [id],
    )).rows[0];
    if (r === undefined) throw new StoreError(404, 'unknown_operation', `오퍼레이션 ${id} 이 없다`);
    return viewOf(r);
  }

  /** §5.2 `GET /status` — 4-way + 미완 전환. */
  async status(): Promise<{
    head: string;
    engine: unknown;
    leader: unknown;
    published: unknown;
    planes: unknown;
    lastEvidence: unknown;
    unfinished: unknown;
    pendingApply: { planId: string; revision: string }[];
  }> {
    const head = await this.store.head();
    const st = await this.driver.status();
    // **커밋됐지만 미적용은 숨기지 않는다** (§5.3).
    const pending = (await this.db.query(
      `SELECT p.id, p.target_revision FROM plans p
        WHERE p.state='committed'
          AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.plan_id = p.id)
        ORDER BY p.target_revision`,
    )).rows.map((r) => ({ planId: String(r['id']), revision: String(r['target_revision']) }));
    return {
      head: head.revision,
      // 엔진이 무엇을 할 수 있는지 드러낸다. 이게 안 보이면 "왜 이 조합이 막히는가" 에
      // 답할 수 없다 — capability 로 좁힌다면 그 capability 도 보여야 한다.
      engine: this.opts.engine ?? { probed: false },
      // **숨기지 않는다.** 스탠바이가 자기를 리더처럼 보이게 하면 운영자는 왜 apply 가
      // 503 인지 알 수 없다.
      leader: this.election.state,
      published: st.published,
      planes: st.planes,
      lastEvidence: st.lastEvidence,
      unfinished: st.unfinished,
      pendingApply: pending,
    };
  }

  /**
   * 끊긴 전환을 이어받는다 (§6.2 재진입).
   *
   * `status().unfinished` 에 값이 있으면 이걸 부르면 된다.
   */
  async recover(by: string): Promise<ApplyResult> {
    this.election.assertLeader();
    // **먼저 누구 것인지 묻는다.** `recoverConfig()` 는 `ApplyResult` 만 돌려주고 거기엔
    // `operationId` 가 없다 — 이어받은 뒤에는 저널이 닫혀 있을 수 있어서 나중에 물으면
    // 늦는다. `status().unfinished` 가 그 신원을 든다.
    const before = await this.driver.status();
    const out = await this.driver.recoverConfig();
    await this.store.audit(by, 'recover', before.unfinished?.operationId ?? 'dataplane',
      undefined, out);
    const id = before.unfinished?.operationId;
    if (id !== undefined) {
      await this.db.query(
        `UPDATE operations SET phase=$2, detail=$3, updated_at=now() WHERE id=$1`,
        [id, out.phase, JSON.stringify(out)],
      );
      if (out.phase === 'activated') {
        await this.db.query(
          `UPDATE plans SET state='applied' WHERE id=(SELECT plan_id FROM operations WHERE id=$1)`,
          [id]);
      }
    }
    return out;
  }

  // ── 내부 ───────────────────────────────────────────────────────────────

  /**
   * admin 포트가 모델과 부딪히지 않는지 본다.
   *
   * **소켓 검증기는 이 포트를 모른다** — 모델 밖에 있기 때문이다. 부딪히면 nginx 가
   * bind 에 실패하고 HUP 이 조용히 옛 설정을 유지한다(S7 이 실측한 바로 그 실패다).
   *
   * 보수적으로 본다: bind 주소와 무관하게 **포트가 같으면** 막는다. `0.0.0.0:PORT` 는
   * `127.0.0.1:PORT` 를 함께 차지하므로 주소별로 따지면 틀린다.
   */
  private assertAdminPortFree(model: { listeners: { key: string; port: number; protocol: string; enabled: boolean }[] }): void {
    for (const l of model.listeners) {
      if (!l.enabled || l.protocol === 'udp') continue;
      if (l.port === this.opts.adminPort) {
        throw new StoreError(409, 'admin_port_conflict',
          `리스너 '${l.key}' 가 admin 포트 ${this.opts.adminPort} 를 쓴다 — `
          + `활성 세대 마커를 서빙할 수 없어 활성화를 증명할 수 없다`);
      }
    }
  }

  private async findOperation(planId: string): Promise<OperationView | undefined> {
    const r = (await this.db.query(
      `SELECT id, plan_id, revision, activation_epoch, generation, phase, detail
         FROM operations WHERE plan_id=$1`, [planId],
    )).rows[0];
    return r === undefined ? undefined : viewOf(r);
  }

  /** 잡으면 `undefined`, 남이 이미 잡았으면 그쪽 것을 돌려준다. */
  private async claim(
    op: ApplyOperation, planId: string, revision: string, epoch: string, by: string,
  ): Promise<OperationView | undefined> {
    const r = await this.db.query(
      `INSERT INTO operations (id,plan_id,revision,activation_epoch,generation,phase,created_by,envelope)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7)
       ON CONFLICT (plan_id) DO NOTHING RETURNING id`,
      // **봉투를 그대로 보관한다.** 취소할 때 재구성하면 정본 튜플이 달라져 슬롯의
      // 주인으로 인정받지 못한다 (§9.2 `abortConfig`).
      [op.operationId, planId, revision, epoch, op.targetGeneration, by, JSON.stringify(op)],
    );
    if (r.rowCount === 1) {
      await this.db.query(
        `UPDATE plans SET state='operation_bound' WHERE id=$1 AND state='committed'`, [planId]);
      return undefined;
    }
    return this.findOperation(planId);
  }

  /**
   * 오래된 세대를 치운다 (§8.4 의 수동 상한판).
   *
   * **보호 대상을 호출자가 준다.** 지금 활성인 것, 방금 만든 것, 그리고 저널에 남은
   * 미완 전환의 세대다. 여기서 추측하면 추측이 틀렸을 때 활성 세대를 지운다 — S8 이
   * 실측했듯 트래픽은 계속 흐르고 **다음 reload 만 실패하므로 한동안 아무도 모른다.**
   *
   * 실패해도 apply 를 실패시키지 않는다. 치우기는 부수적인 일이고, 그것 때문에 성공한
   * 활성화를 실패로 보고하면 운영자가 잘못된 판단을 한다. 대신 **감사에 남긴다.**
   */
  private sweep(justMade: string, by: string): void {
    const keep = this.opts.keepGenerations ?? DEFAULT_KEEP;
    if (keep <= 0) return;
    try {
      const st = this.lastStatus;
      const protect = [
        justMade,
        ...(st?.published.kind === 'owned' ? [st.published.record.generation] : []),
        ...(st?.published.kind === 'inconsistent' && st.published.generation !== undefined
          ? [st.published.generation] : []),
        ...(st?.unfinished !== undefined ? [st.unfinished.generation] : []),
      ];
      const out = sweepGenerations({ prefix: this.opts.prefix, keep, protect });
      if (out.removed.length > 0 || out.failed.length > 0) {
        void this.store.audit(by, 'generations.sweep', 'dataplane', undefined, out);
      }
    } catch (e) {
      void this.store.audit(by, 'generations.sweep.failed', 'dataplane', undefined,
        { error: String(e) });
    }
  }

  private async recordPhase(id: string, phase: string, detail: unknown): Promise<void> {
    await this.db.query(
      `UPDATE operations SET phase=$2, detail=$3, updated_at=now() WHERE id=$1`,
      [id, phase, JSON.stringify(detail)],
    );
  }
}

const viewOf = (r: Row): OperationView => ({
  id: String(r['id']),
  planId: String(r['plan_id']),
  revision: String(r['revision']),
  activationEpoch: String(r['activation_epoch']),
  generation: String(r['generation']),
  phase: String(r['phase']),
  detail: r['detail'],
});

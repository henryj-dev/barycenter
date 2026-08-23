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
import { adminFetch, adminTalk } from './admin-client.js';
import { type DiscoveryIntake } from './discovery.js';
import { drainKeys, observationPeerOf, observePeerFromAdmin, observeStreamPeer } from './drain.js';
import { backendStatusRows, type BackendStatusRow } from './backend-status.js';
import { currentHealth, eligibleCountForPlane, healthRows, reduceMembership, shouldPushMembership } from './health.js';
import { assertAdminSocket, httpAdminConf, routedPools, slotsForEligible, streamAdminConf } from './membership.js';
import type { DataplaneDriver, DriverStatus } from '../dp/driver.js';
import { materializeGeneration } from '../dp/materialize.js';
import { DEFAULT_KEEP, sweepGenerations } from '../dp/retention.js';
import { certificateFiles, type SecretStore } from '../dp/secrets.js';
import type { ApplyOperation, ApplyResult, Plane, PlaneTarget } from '../dp/operation.js';
import { ConfigStore, StoreError } from '../store/config-store.js';
import type { Model } from '../model/provisional.js';
import {
  count, fileBytes, measureGenerations, type Gauges, type LabeledGauge,
} from '../obs/metrics.js';
import type { Db, Row } from '../store/pg.js';
import type { LeaderElection } from './leader.js';

export type ControlPlaneOptions = {
  /** `/etc/barycenter` 에 해당. `generations/` 와 `current` 가 여기 있다. */
  prefix: string;
  /**
   * 활성 세대 마커와 멤버십을 서빙할 **유닉스 소켓 경로** (§6.3-4 · 검수 S-08b).
   *
   * 전에는 루프백 TCP 포트였다. 그런데 이 표면에는 인증이 없고 `/membership` 은 백엔드
   * 슬롯을 다시 쓴다 — 루프백은 "밖에서 못 온다" 이지 "아무나 못 쓴다" 가 아니라서,
   * §11.3 이 권장하는 hostNetwork 배포에서는 같은 호스트의 아무 프로세스나 쓸 수 있었다.
   *
   * 소켓이면 접근 통제를 OS 가 진다. 비밀이 없으므로 conf 에는 경로 리터럴만 남고
   * `render_digest` 의 결정성도 그대로다.
   */
  adminSocket: string;
  renderCaps?: RenderCapabilities;
  /** 조회한 엔진 정보. `status()` 가 그대로 드러낸다. */
  engine?: unknown;
  /**
   * 기동에서 집어넣은 드라이버. 없으면 `{ loaded: false }`.
   * 설정 평면을 갈아 끼운 결과가 아니다 — capability 만 드러낸다.
   */
  driver?: unknown;
  /** stream 평면 admin 소켓. http 는 `adminSocket` 다. */
  streamAdminSocket?: string;
  /**
   * 남길 세대 수 (§9.1.1 — v0.1 은 GC 원장 대신 **수동 상한**이다).
   *
   * 활성·서빙 세대는 이 수와 무관하게 남는다. 0 이면 청소를 아예 안 한다 —
   * 디버깅용이고, **기본값으로 두면 디스크가 무한히 자란다.**
   */
  keepGenerations?: number;
  /**
   * 인증서 자료 저장소 (§4.8).
   *
   * **없으면 인증서를 참조하는 모델은 apply 되지 않는다.** 개인키가 없는 세대는
   * `nginx -t` 에서 죽으므로, 조용히 넘어가면 전환이 실패로만 보이고 원인은 안 보인다.
   */
  secrets?: SecretStore;
  /**
   * 드라이버가 발견한 엔드포인트. 광고했는데 비면 정적 peer 를 안 남긴다.
   * vendor 클라우드 API 는 여기 없다.
   */
  discovery?: DiscoveryIntake | (() => DiscoveryIntake | undefined);
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
/**
 * stream admin 소켓의 기본 경로.
 *
 * 전에는 `adminPort + 1` 이었다. 두 평면은 zone 이 갈려 서로를 못 보므로(E14 · E25 · §3.4)
 * 소켓도 둘이어야 한다. 이름을 파생시키는 것은 같은 이유다 — 배포가 하나만 정하면 된다.
 */
export const defaultStreamSocket = (adminSocket: string): string =>
  adminSocket.replace(/(\.sock)?$/, '-stream.sock');

export const markerConf = (generation: string, socket: string): string =>
  `# 이 파일은 세대에 결박된다. 세대마다 리터럴이 다르다 (§6.3-4).
server {
    listen unix:${assertAdminSocket(socket)};
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

  /**
   * 엔진이 준 peer 관측. 못 읽으면 undefined — 드레인이 0 을 짓지 않는다.
   *
   * **평면을 갈라야 한다** (S2, 2026-08-23). `in:` 카운터는 두 평면이 각자 자기 dict 에
   * 들고 있고 두 zone 은 서로 안 보인다(E14 · E25 · §3.4). 전에는 무조건 http admin 에
   * 물었으므로 TCP·UDP 백엔드는 **숫자가 세어지고 있는데도** 늘 "관측 없음" 이었고,
   * 그래서 `quiesced` 판정을 영영 못 받았다.
   *
   * 평면은 풀의 `protocolClass` 가 정한다 — 부르는 쪽이 이미 아는 값이다.
   */
  async observePeer(host: string, port: number, plane: Plane = 'http'): Promise<unknown> {
    const peer = await observationPeerOf(host, port);
    if (plane === 'stream') {
      const socket = this.opts.streamAdminSocket ?? defaultStreamSocket(this.opts.adminSocket);
      return observeStreamPeer(adminTalk(socket), peer);
    }
    return observePeerFromAdmin(adminFetch(this.opts.adminSocket), peer);
  }

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
   * 인증서 만료 계열 (§4.6 — *"`not_after` 를 상태 API 에 노출"*).
   *
   * **개인키를 안 읽는다.** `SecretStore.facts` 가 `put` 시점에 뽑아 둔 것을 읽는다.
   * 만료를 보려고 목록 조회마다 키를 읽어 들이면, 그 위험 때문에 결국 안 보게 된다.
   *
   * 사실이 없는 인증서(v0.6 1단계에 올라간 것)는 **계열에서 빠진다.** 0 으로 채우면
   * "모른다" 가 "이미 만료" 로 보이고, 없는 알람보다 거짓 알람이 나쁘다.
   */
  async certificateExpiry(): Promise<LabeledGauge[]> {
    const secrets = this.opts.secrets;
    if (secrets === undefined) return [];
    const head = await this.store.head();
    const model = await this.store.modelAt(head.revision);
    const now = Date.now();
    const samples: LabeledGauge['samples'] = [];
    for (const cert of model.certificates) {
      // 자료가 없으면 만료를 말할 수 없다. **0 으로 채우지 않는다** — "아직 발급 전" 이
      // "이미 만료" 로 보이면 없는 알람보다 나쁜 거짓 알람이 된다.
      if (cert.materialRef === undefined) continue;
      const f = secrets.facts(cert.materialRef);
      if (f === undefined) continue;
      samples.push({
        labels: { certificate: cert.key },
        value: Math.floor((new Date(f.notAfter).getTime() - now) / 1000),
      });
    }
    return [{
      name: 'bary_certificate_expiry_seconds',
      help: '인증서 만료까지 남은 초. 음수면 이미 만료다',
      samples,
    }];
  }

  /**
   * 이 모델이 세대에 넣어야 할 인증서 파일들.
   *
   * 인증서가 없으면 빈 맵이고, 그건 v0.1~v0.5 의 모든 모델이다 — TLS 를 안 쓰는 배포에
   * SecretStore 를 요구하지 않는다.
   */
  private certificateFiles(model: Model): { files: Record<string, string>; modes?: Record<string, number> } {
    // **자료가 있는 것만 세대에 넣는다.** ACME 발급 전 인증서는 넣을 바이트가 없고,
    // 바인딩도 안 돼 있으므로(검증기) 세대가 그걸 참조하지도 않는다.
    const withMaterial = model.certificates.filter(
      (c): c is typeof c & { materialRef: string; chainDigest: string; keyDigest: string } =>
        c.materialRef !== undefined && c.chainDigest !== undefined && c.keyDigest !== undefined);
    if (withMaterial.length === 0) return { files: {} };
    const store = this.opts.secrets;
    if (store === undefined) {
      // **fail closed.** 자료 없이 게시하면 세대가 `nginx -t` 에서 죽고, 실패 이유가
      // "설정이 이상하다" 로 보인다. 진짜 이유는 여기다.
      throw new Error(
        `모델이 자료 있는 인증서 ${withMaterial.length}개를 참조하는데 SecretStore 가 없다. ` +
        `개인키 없는 세대는 활성화할 수 없다 (§4.8)`,
      );
    }
    return certificateFiles(withMaterial, store);
  }

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
    // **admin 포트 충돌 검사가 여기 있었다** (S-08a). admin 이 유닉스 소켓으로 옮기면서
    // 구조적으로 불가능해졌다 — 겨눌 포트가 없다. 검사보다 없는 쪽이 낫다.

    // **이름에 epoch 를 넣는다.** 롤백은 옛 내용을 새 epoch 로 굽는다(§3.3, S19) —
    // 리비전만 담으면 같은 내용의 롤백이 옛 디렉토리를 재사용하고, 그러면 세대에 구워진
    // 마커 리터럴이 옛 세대와 같아져 활성화를 구분할 수 없다.
    const generation = `r${plan.targetRevision}-e${plan.activationEpoch}`;
    // **멤버십 평면이 켜졌으면 자료와 admin 조각을 세대에 싣는다** (§6.5 · §7.2).
    //
    // 자료가 세대에 있으므로 `ApplyOperation` 을 넓히지 않는다 — 봉투는 좌표를 나르고
    // 세대가 자료를 나른다. epoch 리터럴도 여기 있다(렌더러가 굽지 않는 이유는
    // `render_digest` 가 모델만의 함수여야 하기 때문이다).
    const caps = this.opts.renderCaps ?? { streamRealip: false };
    // **리듀서를 지난다** (§6.6). 커밋된 모델과 원시 헬스를 합성한 것이 실제 멤버십이다.
    // 프로버가 죽었다고 본 백엔드가 새 세대의 부트스트랩으로 되살아나면 안 된다 —
    // §6.4 가 경고한 바로 그 되살아남이다.
    const membership = caps.httpLua === true || caps.streamLua === true
      ? slotsForEligible(
        plan.model, await this.eligible(plan.model), caps, this.discoveryOf(),
      ) : undefined;
    const streamAdminSocket = this.opts.streamAdminSocket ?? defaultStreamSocket(this.opts.adminSocket);

    /**
     * **멤버십만 바뀌었는가** (§6.4 드리프트 분리 · §6.5).
     *
     * 멤버십 평면이 켜지면 백엔드는 conf 에 없다 — dict 에 산다. 그러니 백엔드만 바뀐
     * 변경은 **렌더 산출물이 바이트 단위로 같다.** 그게 판정이다: 지금 서빙 중인 세대의
     * conf digest 와 같으면 세대를 만들 이유가 없다.
     *
     * 다른 근거(예: "백엔드 테이블만 바뀌었나")로 판정하고 싶어지는데, 그러면 렌더에
     * 영향을 주는 필드가 하나 늘 때마다 이 판정이 조용히 틀려진다. **산출물을 비교하는
     * 것이 정의상 맞다.**
     */
    if (membership !== undefined) {
      const live = await this.activeRenderDigest();
      if (live !== undefined && live.digest === rendered.digest) {
        return this.applyMembershipOnly(plan, membership, live.epoch, planId, by);
      }
    }

    const certFiles = this.certificateFiles(plan.model);

    const manifest = materializeGeneration({
      prefix: this.opts.prefix,
      generation,
      planes: rendered.planes,
      ...(certFiles.modes === undefined ? {} : { modes: certFiles.modes }),
      files: {
        'nginx.conf': rendered.conf,
        // **인증서 바이트를 세대 안에 넣는다** (§7.2, S8·S19). 바깥 mutable 경로를
        // 가리키거나 symlink 로 걸면 롤백이 거짓말이 된다.
        ...certFiles.files,
        ...(membership === undefined
          ? { 'admin/marker.conf': markerConf(generation, this.opts.adminSocket) }
          : {
              'admin/marker.conf': httpAdminConf(generation, plan.activationEpoch,
                this.opts.adminSocket),
              ...(caps.streamLua === true
                ? {
                    'stream-admin/membership.conf':
                      streamAdminConf(plan.activationEpoch, streamAdminSocket),
                  }
                : {}),
              'lua/membership.json': JSON.stringify({
                epoch: plan.activationEpoch,
                http: membership.http,
                stream: membership.stream,
              }, null, 2),
            }),
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
    count(`bary_apply_total{phase="${result.phase}"}`);
    await this.store.audit(by, 'apply', planId, undefined,
      { operationId: op.operationId, generation, phase: result.phase }, plan.targetRevision);

    if (result.phase === 'activated') {
      await this.db.query(`UPDATE plans SET state='applied' WHERE id=$1`, [planId]);
      /**
       * **활성화 직후 헬스를 다시 투영한다** (§6.5-4 replay 의 자리).
       *
       * staging 은 스냅샷 시점(T0)의 헬스로 슬롯을 채운다. 그런데 T0 과 활성화 사이에
       * 백엔드가 죽으면 **새 epoch 은 T0 의 멤버십을 들고 서빙을 시작한다** — 프로버가
       * 다음으로 판정을 뒤집을 때까지 죽은 peer 가 트래픽을 받는다. §6.5 가 cut 과
       * replay 를 요구한 것이 이 창 때문이다.
       *
       * **이벤트를 재생하는 대신 다시 유도한다.** 이 저장소의 리듀서는 델타가 아니라
       * *상태*에서 계산하므로(커밋된 모델 ∩ 현재 헬스), 지금 상태로 한 번 더 계산하면
       * "HWM 이후 이벤트를 순서대로 적용" 과 결과가 같다. 순서를 지킬 것이 없으면
       * 커서도 필요 없다 — 이벤트 로그는 감사 기록으로 남는다.
       *
       * ⚠️ **이 창이 닫혔다는 것은 논증이지 측정이 아니다.** staging 과 활성화 사이에
       * 헬스를 바꾸는 것을 밖에서 결정적으로 만들 방법이 없어서, 재현물 없이 둔다.
       * 아래 테스트가 재는 것은 *"활성화 뒤 슬롯이 지금 헬스와 일치한다"* 는 불변식이다.
       */
      await this.projectHealth().catch((e: unknown) => {
        // 실패해도 apply 를 실패시키지 않는다 — 활성화는 이미 끝났고, 다음 헬스 변화가
        // 같은 일을 한다. 대신 조용히 넘기지 않는다.
        void this.store.audit(by, 'health.reproject.failed', planId, undefined,
          { error: String(e) });
        return undefined;
      });
      // **활성화가 끝난 뒤에 치운다.** 앞에서 치우면 방금 만든 것을 지울 수 있고,
      // 실패했을 때 치우면 되돌아갈 자리를 지운다.
      this.sweep(generation, by, plan.model);
    }
    return {
      id: op.operationId, planId, revision: plan.targetRevision,
      activationEpoch: plan.activationEpoch, generation,
      phase: result.phase, detail: result,
    };
  }

  /**
   * 기동 시 멤버십을 **다시 적재한다** (§6.4).
   *
   * `lua_shared_dict` 는 **프로세스 수명**이다. 엔진이 재시작하면 슬롯이 통째로 비고,
   * 밸런서는 §6.5-3 대로 연결을 끊는다 — 설정은 멀쩡한데 트래픽이 전부 죽는다.
   * 컨테이너를 재시작하고 500 을 받고서야 이 자리를 봤다.
   *
   * **정본은 세대 아티팩트가 아니라 head 리비전이다.**
   *
   * 처음엔 세대의 `lua/membership.json` 을 되밀었다. 그랬더니 재시작이 **커밋된 멤버십을
   * 되돌렸다** — 아티팩트는 그 세대가 만들어질 때의 스냅샷이고, 그 뒤의 멤버십 전용
   * 변경(세대를 안 만든다)이 통째로 사라진다. 실제로 백엔드를 :12 로 옮긴 뒤 재시작했더니
   * :11 이 되살아났다. §6.4 가 *"옛 부트스트랩만 쓰면 되살아난다"* 고 경고한 그 모양이다.
   *
   * 적격은 durable 헬스 ∩ 드레인이다. 죽은 백엔드가 세대 스냅샷으로 되살아나지 않는다 (S3).
   */
  async restageMembership(): Promise<{ epoch: string; planes: string[] } | undefined> {
    const caps = this.opts.renderCaps ?? { streamRealip: false };
    if (caps.httpLua !== true && caps.streamLua !== true) return undefined;
    const st = await this.driver.status();
    if (st.published.kind !== 'owned') return undefined;

    const head = await this.store.head();
    const headModel = await this.store.modelAt(head.revision);
    const eligible = await this.eligible(headModel);
    const slots = slotsForEligible(headModel, eligible, caps, this.discoveryOf());
    const planes: string[] = [];
    for (const plane of PLANES) {
      const epoch = st.planes[plane].activationEpoch;
      if (epoch === '0') continue;                       // 그 평면은 아직 활성화 안 됐다
      if (!shouldPushMembership(
        eligibleCountForPlane(eligible, plane), Object.keys(slots[plane]).length,
      )) continue;
      await this.driver.pushMembershipDirect(plane, epoch, slots[plane]);
      planes.push(plane);
    }
    if (planes.length === 0) return undefined;
    return { epoch: st.planes.http.activationEpoch, planes };
  }

  /**
   * 헬스가 바뀌었을 때 **서빙 중인 모든 epoch** 에 다시 투영한다 (§6.5-5).
   *
   * *"E-old 슬롯은 그 세대를 서빙하는 워커가 전부 사라질 때까지 유지한다. 유지하는
   * 동안에도 eligibility 는 계속 투영한다 — 옛 워커가 재시도할 때 이미 disabled 된 peer 를
   * 다시 고르면 안 된다."*
   *
   * 좌표를 안 옮긴다. 헬스 반영은 새 전환이 아니라 **같은 epoch 안의 갱신**이고,
   * §6.4 가 *"멤버십은 드리프트 판정 대상이 아니다 — 항상 움직인다"* 고 한 것이 이것이다.
   */
  async projectHealth(): Promise<{ epochs: string[]; planes: string[] } | undefined> {
    const caps = this.opts.renderCaps ?? { streamRealip: false };
    if (caps.httpLua !== true && caps.streamLua !== true) return undefined;
    const st = await this.driver.status();
    const head = await this.store.head();
    const headModel = await this.store.modelAt(head.revision);
    const model = await this.eligible(headModel);
    const slots = slotsForEligible(headModel, model, caps, this.discoveryOf());

    const epochs: string[] = [];
    const planes: string[] = [];
    for (const plane of PLANES) {
      const epoch = st.planes[plane].activationEpoch;
      if (epoch === '0') continue;
      if (!shouldPushMembership(
        eligibleCountForPlane(model, plane), Object.keys(slots[plane]).length,
      )) continue;
      // **의도적 zero-peer 는 그대로 쓴다** (§6.7). 모든 백엔드가 죽었으면 멤버십은
      // 실제로 비어 있고 요청은 실패해야 한다 — 옛 peer 를 남기면 죽은 백엔드가 계속
      // 트래픽을 받는다. 갱신 *실패* 의 fail-open 과는 다른 사건이다.
      await this.driver.pushMembershipDirect(plane, epoch, slots[plane]);
      count(`bary_membership_project_total{plane="${plane}"}`);
      epochs.push(epoch);
      planes.push(plane);
    }
    return planes.length > 0 ? { epochs, planes } : undefined;
  }

  /**
   * 지금 재 볼 수 있는 것 전부 (§6.4 리소스 알람).
   *
   * **자라는 것을 겨눈다.** 세대 디렉토리와 durable 상태 파일이 이 저장소가 오래 달고
   * 있는 성장 부채(`terminal`·`completed` 원장)의 관측 창구다 — 원장 내부를 안 들여다보고
   * 파일 크기로 재는 이유는 저장소 payload 를 불투명하게 다루기로 한 계약(9차 검수)을
   * 안 깨기 위해서다.
   */
  async gauges(): Promise<Gauges> {
    const st = await this.driver.status();
    const head = await this.store.head();
    const gen = measureGenerations(this.opts.prefix);
    const health = (await this.db.query(
      `SELECT state, count(*)::int AS n FROM backend_health GROUP BY state`,
    )).rows;
    const byState = Object.fromEntries(health.map((r) => [String(r['state']), Number(r['n'])]));
    const pending = (await this.db.query(
      `SELECT count(*)::int AS n FROM plans p WHERE p.state='committed'
         AND NOT EXISTS (SELECT 1 FROM operations o WHERE o.plan_id = p.id)`,
    )).rows[0];
    const mem = process.memoryUsage();
    return {
      generations: gen.count,
      generationBytes: gen.bytes,
      agentStateBytes: fileBytes(`${this.opts.prefix}/state/agent.json`),
      head: Number(head.revision),
      leader: this.election.state.isLeader ? 1 : 0,
      activationEpochHttp: Number(st.planes.http.activationEpoch),
      activationEpochStream: Number(st.planes.stream.activationEpoch),
      unfinished: st.unfinished === undefined ? 0 : 1,
      backendsHealthy: byState['healthy'] ?? 0,
      backendsUnhealthy: byState['unhealthy'] ?? 0,
      backendsUnknown: byState['unknown'] ?? 0,
      pendingApply: Number(pending?.['n'] ?? 0),
      uptimeSeconds: Math.round(process.uptime()),
      rssBytes: mem.rss,
    };
  }

  /** 지금 head 모델. 프로버가 무엇을 찔러야 하는지 안다. */
  async headModel(): Promise<Model> {
    return this.store.modelAt((await this.store.head()).revision);
  }

  /**
   * 지금 서빙 중인 세대의 렌더 digest 와 epoch.
   *
   * **적용된 리비전에서 다시 렌더한다.** 세대 디렉토리의 conf 를 읽어 해시하면 될 것
   * 같지만, 그건 `rendered.digest`(conf 문자열의 sha256)와 같은 값을 보장하지 않는다 —
   * manifest 의 digest 는 **파일 집합 + 평면**으로 계산되기 때문이다. 두 수를 비교하려면
   * 같은 방법으로 만들어야 한다.
   */
  private async activeRenderDigest(): Promise<{ digest: string; epoch: string } | undefined> {
    const r = (await this.db.query(
      `SELECT revision, activation_epoch::text AS epoch FROM operations
        WHERE phase = 'activated' ORDER BY activation_epoch DESC LIMIT 1`,
    )).rows[0];
    if (r === undefined) return undefined;
    const model = await this.store.modelAt(String(r['revision']));
    return {
      digest: render(model, this.opts.renderCaps ?? { streamRealip: false }).digest,
      epoch: String(r['epoch']),
    };
  }

  /**
   * **reload 없이** 멤버십만 옮긴다 (§6.5 · S1).
   *
   * 세대를 만들지 않고, 게시하지 않고, HUP 도 보내지 않는다. 활성 epoch 의 슬롯을 갈아
   * 끼우면 다음 연결부터 반영된다 — S1 이 HTTP·TCP·UDP 전부에서 reload 0 회, 마스터 PID
   * 불변으로 실증한 그 경로다.
   *
   * 좌표는 `membership_revision` 만 앞으로 간다. `activation_epoch` 는 그대로다 —
   * 세대가 안 바뀌었으므로 그게 맞다 (§3.3).
   */
  private async applyMembershipOnly(
    plan: { targetRevision: string | undefined; activationEpoch: string | undefined; model: Model },
    slots: Record<'http' | 'stream', Record<string, string[]>>,
    epoch: string, planId: string, by: string,
  ): Promise<OperationView> {
    const leaderToken = this.election.assertLeader();
    const status = await this.driver.status();
    const operationId = randomUUID();
    const revision = plan.targetRevision ?? '0';

    const planes: Partial<Record<Plane, PlaneTarget>> = {};
    const touched: Plane[] = [];
    for (const plane of PLANES) {
      const cur = status.planes[plane];
      // **활성 epoch 안에서만 움직인다.** 다른 epoch 에 있는 평면은 건드리지 않는다 —
      // 그 평면은 이 세대를 서빙하고 있지 않다.
      if (cur.activationEpoch !== epoch) continue;
      if (Object.keys(slots[plane]).length === 0) continue;
      planes[plane] = {
        expectedCurrent: {
          activationEpoch: cur.activationEpoch,
          membershipRevision: cur.membershipRevision,
        },
        target: {
          activationEpoch: epoch,
          // **엄격 단조.** Agent 가 그렇지 않으면 거부한다.
          membershipRevision: String(BigInt(cur.membershipRevision) + 1n),
        },
        payloadDigest: revision,
      };
      touched.push(plane);
    }
    if (touched.length === 0) {
      throw new StoreError(409, 'no_membership_target',
        `활성 epoch(${epoch}) 에 있는 평면이 없다 — 멤버십만 옮길 수 없다`);
    }

    const op: ApplyOperation = {
      leaderToken, operationId, transitionId: `m${revision}`,
      // **멤버십은 평면별이다.** 설정 전환이 언제나 두 평면을 옮기는 것과 다르다 —
      // 하나의 nginx.conf 가 둘을 지배하는 것이 이유였고, 여기서는 conf 를 안 건드린다.
      affectedPlanes: touched,
      targetGeneration: status.published.kind === 'owned'
        ? status.published.record.generation : '',
      generationDigest: status.published.kind === 'owned'
        ? status.published.record.generationDigest : '',
      planes,
    };

    await this.db.query(
      `INSERT INTO operations (id,plan_id,revision,activation_epoch,generation,phase,created_by,envelope)
       VALUES ($1,$2,$3,$4,$5,'pending',$6,$7) ON CONFLICT (plan_id) DO NOTHING`,
      [operationId, planId, revision, epoch, op.targetGeneration, by, JSON.stringify(op)],
    );
    for (const plane of touched) {
      await this.driver.applyMembership(op, plane, slots[plane]);
      count(`bary_membership_apply_total{plane="${plane}"}`);
    }
    await this.recordPhase(operationId, 'activated',
      { membershipOnly: true, planes: touched, reload: false });
    await this.db.query(`UPDATE plans SET state='applied' WHERE id=$1`, [planId]);
    await this.store.audit(by, 'apply.membership', planId, undefined,
      { operationId, epoch, planes: touched, reload: false }, revision);

    return {
      id: operationId, planId, revision, activationEpoch: epoch,
      generation: op.targetGeneration, phase: 'activated',
      detail: { membershipOnly: true, planes: touched, reload: false },
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
    driver: unknown;
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
      driver: this.opts.driver ?? { loaded: false },
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
   * **왜 이 백엔드가 트래픽을 안 받나** — 한 번에 답한다 (제안 #9).
   *
   * 헬스·드레인·슬롯 소속을 따로 물어 머리로 합치던 것을 한 자리로 모은다. 셋째(슬롯
   * 소속)는 지금까지 물을 창구조차 없었다 — 풀이 어디에도 안 걸리면 렌더에 upstream 이
   * 없고, 그러면 헬스가 초록이어도 트래픽이 0 이다.
   *
   * **리듀서의 입력을 그대로 쓴다.** 엔진에게 되묻지 않는 이유는 `backend-status.ts` 에
   * 적어 뒀다 — 되묻는 것은 우리가 방금 쓴 값을 다시 읽는 것이고, 갱신 실패는 §6.7 의
   * 다른 사건이다.
   */
  async backendStatus(): Promise<BackendStatusRow[]> {
    const caps = this.opts.renderCaps ?? { streamRealip: false };
    const head = await this.store.head();
    const model = await this.store.modelAt(head.revision);
    const rows = await healthRows(this.db);
    return backendStatusRows({
      model,
      health: new Map(rows.map((r) => [r.backendKey, r.state])),
      detail: new Map(rows.map((r) => [r.backendKey, {
        observedAt: r.observedAt,
        ...(r.detail === undefined ? {} : { detail: r.detail }),
      }])),
      draining: await drainKeys(this.db),
      routedPools: routedPools(model, caps),
    });
  }

  private async eligible(model: Model): Promise<Model> {
    return reduceMembership(model, await currentHealth(this.db), await drainKeys(this.db));
  }

  private discoveryOf(): DiscoveryIntake | undefined {
    const raw = this.opts.discovery;
    return typeof raw === 'function' ? raw() : raw;
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
  private sweep(justMade: string, by: string, model?: Model): void {
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
      /**
       * **시간 보호는 상한이 걸린 배포에서만 걸린다** (§4.10 · S13).
       *
       * `worker_shutdown_timeout` 이 없으면 옛 워커가 얼마나 오래 사는지 모르고, 그러면
       * "비활성이 된 지 오래됐다" 도 못 말한다. 그 경우 개수 상한만 남는다 — 없는 보호를
       * 있는 척하지 않는다.
       *
       * 여유를 두 배로 잡는다. 상한은 워커가 죽는 시각이지 **publish→HUP 사이 지연까지
       * 덮지 않는다.**
       */
      const linger = model?.engine?.workerShutdownTimeoutS;
      const out = sweepGenerations({
        prefix: this.opts.prefix, keep, protect,
        ...(linger === undefined ? {} : { workerLingerMs: linger * 2000 }),
      });
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

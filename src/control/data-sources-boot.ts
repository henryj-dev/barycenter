/**
 * 데이터 공급의 **기동 배선** (2026-11-05) — 풀의 백엔드 출처 러너 · 주소 집합 주기 갱신.
 *
 * `barycenterd` 는 이 모듈의 세 함수만 부른다(설정 읽기 → 러너 만들기 → 시작). 배선을 여기 모으는 것은
 * 기동 파일에 같은 판단을 흩어 두지 않기 위해서다.
 *
 * ── 누가 도나
 *
 *   · 디스커버리 러너는 **모든 노드**에서 돈다 — 상태 화면(`/discovery`)이 그 노드가 본 것을 말한다. 멤버십 투영은
 *     리더, 그리고 클러스터 모드의 팔로워(자기 nginx 를 맡는다)만 한다. 콜드 스탠바이가 함께 밀면 두 노드가 같은 슬롯을
 *     덮는다(헬스 프로버가 리더만 도는 것과 같은 이유)
 *   · 멤버십 평면(lua)이 없는 배포에서는 러너가 꺼진다 — 정적 `server` 줄은 세대 전환으로만 바뀌고, 출처가 바뀔
 *     때마다 세대를 만들지 않는다
 *   · 주소 집합 주기 갱신은 **리더만** — 커밋은 한 노드가 한다
 */
import type { EventHub } from '../api/events.js';
import { log } from '../obs/log.js';
import { count } from '../obs/metrics.js';
import type { ConfigStore } from '../store/config-store.js';
import type { Db } from '../store/pg.js';
import { addressSources, addressSourceScheduleFromEnv, type AddressSourceSchedule } from './address-sources/registry.js';
import { refreshAllAddressSets } from './address-sources/refresh.js';
import { configuredKinds, discoveryConfigFromEnv, discoverySources, type DiscoveryConfig } from './discovery/registry.js';
import { DiscoveryRunner } from './discovery/runner.js';
import type { ControlPlane } from './plane.js';

/** 주기 갱신을 하는 「누가」. 감사 · 리비전의 작성자로 남는다. */
export const ADDRESS_SOURCE_ACTOR = 'address-source';

export type DataSourcesConfig = { discovery: DiscoveryConfig; addressSets: AddressSourceSchedule };

/** env → 설정. **DB 보다 먼저** 부른다 — 틀린 설정으로 마이그레이션까지 돌리고 죽지 않게. 반만 설정되면 던진다. */
export function dataSourcesConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DataSourcesConfig {
  return { discovery: discoveryConfigFromEnv(env), addressSets: addressSourceScheduleFromEnv(env) };
}

export type DataSources = {
  runner: DiscoveryRunner | undefined;
  /** `ApiOptions.discovery` 에 넘긴다. */
  api: { enabled: boolean; reason?: string; intervalMs?: number; views: DiscoveryRunner['views']; view: DiscoveryRunner['view'] };
  /** `ControlPlaneOptions.discovery` 에 넘긴다. */
  intake: () => ReturnType<DiscoveryRunner['intake']>;
};

export function createDataSources(cfg: DataSourcesConfig, membershipPlane: boolean): DataSources {
  if (!membershipPlane) {
    const reason = '멤버십 평면(lua)이 없는 배포 — 출처의 목록을 반영할 곳이 없다. 정적 백엔드를 쓴다';
    return { runner: undefined, api: { enabled: false, reason, views: () => [], view: () => undefined }, intake: () => undefined };
  }
  const runner = new DiscoveryRunner({ sources: discoverySources(cfg.discovery), intervalMs: cfg.discovery.intervalMs });
  return {
    runner,
    api: { enabled: true, intervalMs: runner.intervalMs, views: () => runner.views(), view: (p) => runner.view(p) },
    intake: () => runner.intake(),
  };
}

export type StartOptions = {
  db: Db;
  store: ConfigStore;
  control: ControlPlane;
  events: EventHub;
  isLeader: () => boolean;
  /** 클러스터 팔로워도 자기 nginx 에 투영한다. */
  clusterOn: boolean;
};

/** 러너와 주기 갱신을 시작한다. 멈추는 함수를 돌려준다. */
export function startDataSources(cfg: DataSourcesConfig, ds: DataSources, o: StartOptions): () => void {
  const stops: (() => void)[] = [];

  if (ds.runner !== undefined) {
    const runner = ds.runner;
    runner.start(
      () => o.control.headModel(),
      async (r) => {
        for (const f of r.failed) {
          count(`bary_discovery_failure_total{reason="${f.error?.reason ?? 'unknown'}"}`);
          // **알림 어댑터가 받을 이름** — 같은 실패를 매 주기 다시 말하지 않는다(새로 실패한 때만).
          log.warn('discovery.source_failed', {
            pool: f.pool, source: f.source, query: f.query, reason: f.error?.reason, detail: f.error?.detail,
            keeping: f.advertised ? `마지막 목록 ${f.endpoints.length}개` : '정적 백엔드',
          });
          o.events.publish('discovery', { pool: f.pool, state: f.state, reason: f.error?.reason });
        }
        for (const pool of r.recovered) {
          log.info('discovery.source_recovered', { pool });
          o.events.publish('discovery', { pool, state: 'ok' });
        }
        if (r.changed.length === 0) return;
        for (const pool of r.changed) {
          const v = runner.view(pool);
          log.info('discovery.changed', { pool, advertised: v?.advertised ?? false, endpoints: v?.endpoints.length ?? 0 });
          o.events.publish('discovery', { pool, state: v?.state ?? 'removed', changed: true });
        }
        count('bary_discovery_change_total');
        if (!o.isLeader() && !o.clusterOn) return;
        // **기존 멤버십 투영 경로** — 헬스 · 드레인과 같은 자리다. 던지면 러너가 다음 바퀴에 같은 풀을 다시 넘긴다.
        const out = await o.control.projectHealth();
        if (out !== undefined) log.info('discovery.projected', { pools: r.changed, epochs: out.epochs, planes: out.planes });
      },
    );
    stops.push(() => runner.stop());
    log.info('discovery.started', { intervalMs: runner.intervalMs, sources: configuredKinds(cfg.discovery) });
  } else {
    log.info('discovery.disabled', { reason: ds.api.reason });
  }

  const every = cfg.addressSets.intervalMs;
  if (every !== undefined) {
    const sources = addressSources();
    const timer = setInterval(() => {
      void (async (): Promise<void> => {
        if (!o.isLeader()) return;
        try {
          const out = await refreshAllAddressSets({
            db: o.db, store: o.store, sources, by: ADDRESS_SOURCE_ACTOR,
            ...(cfg.addressSets.autoApply ? { control: o.control } : {}),
          });
          for (const r of out) {
            if (r.outcome === 'unchanged') continue;
            o.events.publish('address_set', { key: r.key, outcome: r.outcome });
            if (r.outcome === 'failed') {
              count(`bary_address_set_refresh_total{outcome="failed",reason="${r.reason}"}`);
              // **알림 어댑터가 받을 이름.** 집합은 그대로다 — 마지막으로 받은 목록이 계속 쓰인다.
              log.warn('address_set.refresh_failed', { key: r.key, reason: r.reason, detail: r.detail });
              continue;
            }
            count('bary_address_set_refresh_total{outcome="committed"}');
            o.events.publish('revision', { revision: r.revision, addressSet: r.key });
            if (r.held !== undefined) {
              log.warn('address_set.refresh_held', {
                key: r.key, revision: r.revision, held: r.held,
                why: '다른 변경이 적용 대기 중이다 — 함께 나가지 않게 커밋까지만 했다. 적용 대기에서 적용하라',
              });
            } else {
              log.info('address_set.refreshed', { key: r.key, revision: r.revision, count: r.count, operation: r.operation });
            }
          }
        } catch (e) {
          log.error('address_set.refresh_tick_failed', { error: e instanceof Error ? e.message : String(e) });
        }
      })();
    }, every);
    timer.unref?.();
    stops.push(() => clearInterval(timer));
    log.info('address_set.refresh_started', { intervalMs: every, autoApply: cfg.addressSets.autoApply });
  }

  return () => { for (const s of stops) s(); };
}

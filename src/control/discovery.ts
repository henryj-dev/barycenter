/**
 * BackendDiscovery 소비자 — DESIGN.md §9.1
 *
 * 드라이버가 엔드포인트 집합을 광고하면 멤버십·렌더가 **그 집합**을 쓴다.
 * 광고했는데 비면 정적 peer 를 남기지 않는다 — 발견이 안 된 것을 옛 목록으로
 * 위장하면 죽은 주소로 트래픽이 간다.
 *
 * 클라우드 vendor API 는 여기 없다. 받는 모양만 정한다.
 */
import type { Backend, Model } from '../model/provisional.js';
import { reduceMembership, type HealthState } from './health.js';

export type DiscoveredEndpoint = {
  pool: string;
  host: string;
  port: number;
};

export type DiscoveryIntake =
  | { advertised: false }
  | {
    advertised: true;
    endpoints: readonly DiscoveredEndpoint[];
    /**
     * **광고한 풀** (2026-11-05). 있으면 이 풀들의 정적 백엔드만 바꾸고 나머지 풀은 정적 그대로다 — 풀마다 출처를
     * 켜는 `Pool.discovery` 의 모양이다. 여기 있는 풀의 `endpoints` 가 비면 그 풀은 백엔드 0 이다(위의 규칙 그대로).
     * 없으면 옛 계약 — 정적 백엔드를 **통째로** 바꾼다.
     */
    pools?: readonly string[];
  };

/** 광고하지 않으면 정적 모델을 그대로 둔다. 광고하면 정적 백엔드를 바꾼다(`pools` 가 있으면 그 풀만). */
export function applyDiscoveredEndpoints(
  model: Model, intake: DiscoveryIntake | undefined,
): Model {
  if (intake === undefined || intake.advertised === false) return model;
  const discovered: Backend[] = intake.endpoints
    .filter((e) => intake.pools === undefined || intake.pools.includes(e.pool))
    .map((e) => ({
      key: `disc:${e.pool}:${e.host}:${e.port}`,
      pool: e.pool,
      host: e.host,
      port: e.port,
      weight: 1,
    }));
  if (intake.pools === undefined) return { ...model, backends: discovered };
  const replaced = new Set(intake.pools);
  return { ...model, backends: [...model.backends.filter((b) => !replaced.has(b.pool)), ...discovered] };
}

/**
 * 멤버십의 적격 — 발견한 엔드포인트를 **먼저** 얹고 헬스 · 드레인으로 줄인다. 컨트롤 플레인이 쓰는 한 자리다.
 * 순서를 뒤집으면(정적만 줄이고 발견을 나중에 얹으면) 발견한 peer 가 적격 집합에 없어 슬롯에서 빠진다.
 */
export function eligibleWithDiscovery(
  model: Model, health: Map<string, HealthState>, draining: ReadonlySet<string>, intake: DiscoveryIntake | undefined,
): Model {
  return reduceMembership(applyDiscoveredEndpoints(model, intake), health, draining);
}

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

export type DiscoveredEndpoint = {
  pool: string;
  host: string;
  port: number;
};

export type DiscoveryIntake =
  | { advertised: false }
  | { advertised: true; endpoints: readonly DiscoveredEndpoint[] };

/** 광고하지 않으면 정적 모델을 그대로 둔다. 광고하면 정적 백엔드를 통째로 바꾼다. */
export function applyDiscoveredEndpoints(
  model: Model, intake: DiscoveryIntake | undefined,
): Model {
  if (intake === undefined || intake.advertised === false) return model;
  const backends: Backend[] = intake.endpoints.map((e) => ({
    key: `disc:${e.pool}:${e.host}:${e.port}`,
    pool: e.pool,
    host: e.host,
    port: e.port,
    weight: 1,
  }));
  return { ...model, backends };
}

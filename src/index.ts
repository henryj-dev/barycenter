/**
 * v0.1 공개 표면 — **동결 대상** (DESIGN.md §9.1.1)
 *
 * "동결" 이 문서의 문장으로만 있으면 아무 뜻이 없다. 여기 있는 것이 동결 대상이고,
 * 여기 없는 것은 내부다. 목록이 바뀌면 `tests/conformance/v01-surface.test.ts` 가 깨진다.
 *
 * **왜 API·DB 가 여기 없는가.** 여섯 번의 검수가 같은 것을 가르쳤다 — 구현하지 않은
 * 계약을 고정하면 반드시 깨진다. §9.1 에서 멤버십 계약을 철회한 이유가 그것이었다.
 * REST 서버도 reconciler 도 없는 상태에서 OpenAPI 와 DDL 을 고정하면 같은 실수를 더 큰
 * 규모로 반복하게 된다. API·DB 는 v0.2 에서, 구현과 **함께** 고정한다.
 *
 * 그래서 v0.1 이 고정하는 것은 둘뿐이다.
 *
 *   1. **모델과 렌더러** — `unknown` 을 해독해 nginx 설정을 낸다.
 *   2. **DP 드라이버 ABI** — 세대를 만들고 활성화하고 복구한다.
 */

// ── 1. 모델과 렌더러 ────────────────────────────────────────────────────

export type {
  Backend,
  HttpAction,
  HttpListener,
  HttpProfile,
  HttpRoute,
  Listener,
  Model,
  PassthroughAction,
  PassthroughListener,
  PassthroughRoute,
  Pool,
  ProtocolClass,
  RawListener,
  RawModel,
  SniOutcome,
  TcpListener,
  UdpListener,
  UdpPreset,
} from './model/provisional.js';

/** 경계에서 `unknown` 을 해독한다. 저장 경로는 `parseModel` 을 쓴다. */
export { decodeModel, parseModel, type DecodeResult } from './model/decode.js';

export {
  ModelValidationError,
  validateModel,
  type ModelIssue,
  type ModelIssueCode,
  type ValidationCapabilities,
} from './validate/model.js';

export { render, type RenderCapabilities, type RenderedConfig } from './conf/render.js';

// ── 2. DP 드라이버 ABI ──────────────────────────────────────────────────

export type {
  ActivationEvidence,
  ApplyOperation,
  ApplyPhase,
  ApplyResult,
  Coordinate,
  MutationEnvelope,
  Plane,
  PlaneProgress,
  PlaneTarget,
} from './dp/operation.js';

export { ALL_APPLY_PHASES, isTerminalPhase, provesActivation } from './dp/operation.js';

export {
  LocalDataplaneDriver,
  type DataplaneDriver,
  type DriverStatus,
  type PlaneStatus,
} from './dp/driver.js';

/** 세대를 원자적으로 만들고 활성화 직전에 대조한다 (§7.2). */
export {
  GenerationError,
  digestOfFiles,
  materializeGeneration,
  readManifest,
  verifyGeneration,
  type GenerationManifest,
} from './dp/materialize.js';

/** 부작용과 durable 저장 — 배포 형태에 따라 구현이 달라진다. */
export { FsEffects, type FsEffectsOptions } from './dp/effects-fs.js';
export {
  FileStore,
  ReadOnlyFileStore,
  StoreCorrupted,
  StoreLockLost,
  StoreLocked,
} from './dp/store-fs.js';
export type { Effects, PreflightResult } from './dp/apply.js';

/**
 * DP Agent 자체는 **표면이 아니다.** 드라이버 뒤에 있다.
 *
 * `DpRejection` 과 `DurableStore` 만 내보낸다 — 호출자가 거부를 분류하고 저장소를
 * 갈아 끼울 수 있어야 하기 때문이다.
 */
export { DpRejection, type DurableStore, type RejectionKind } from './dp/agent.js';

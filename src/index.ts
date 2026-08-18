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
 * 그래서 v0.1 이 고정하는 것은 둘이다. v0.7 이 세 번째를 열었다.
 *
 *   1. **모델과 렌더러** — `unknown` 을 해독해 nginx 설정을 낸다.
 *   2. **DP 드라이버 ABI** — 세대를 만들고 활성화하고 복구한다.
 *   3. **드라이버 capability** — 잰 것만. 지금은 네이티브 DNS 실패 모드 표 (S14).
 */

// ── 1. 모델과 렌더러 ────────────────────────────────────────────────────

export type {
  Backend,
  HttpAction,
  HttpListener,
  HttpProfile,
  InboundProxyProtocol,
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

export {
  MEMBERSHIP_DICT,
  render,
  type RenderCapabilities,
  type RenderedConfig,
} from './conf/render.js';

// ── 2. DP 드라이버 ABI ──────────────────────────────────────────────────

export type {
  ActivationEvidence,
  ApplyLease,
  Checked,
  ApplyOperation,
  ApplyPhase,
  ApplyResult,
  Coordinate,
  MutationEnvelope,
  Plane,
  PlaneProgress,
  PlaneTarget,
  PublishedState,
  PublishRecord,
} from './dp/operation.js';

export {
  ALL_APPLY_PHASES,
  isTerminalPhase,
  provesActivation,
  publishedByMe,
} from './dp/operation.js';

export {
  LocalDataplaneDriver,
  type DataplaneDriver,
  type DriverStatus,
  type PlaneStatus,
  type ReconcileResult,
} from './dp/driver.js';

/**
 * 드라이버가 드러내는 능력. S14 가 첫 필드를 만들었다 — 네이티브 DNS 실패 모드는
 * 선택형이 아니다. 구현하지 않은 필드는 여기 없다 (§9.1).
 */
export {
  DriverContractError,
  NATIVE_DNS_FAILURE_MODES,
  capabilitiesFromDriver,
  dataplaneCapabilitiesOf,
  nativeDnsOf,
  type DataplaneCapabilities,
  type NativeDnsCapabilities,
  type NativeDnsFailureModes,
} from './engine/native-dns.js';

/**
 * 드라이버 로딩. 설정의 패키지명을 그대로 import 하지 않는다 (§9.3 · X5–X7).
 */
export {
  DRIVER_API_VERSION,
  DriverLoadError,
  assertDriverPins,
  driverIntegrityOf,
  loadDriver,
  parseDriverPins,
  type DriverLoadRefusal,
  type DriverModule,
  type DriverPin,
} from './dp/loader.js';

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
 * DP Agent 자체는 **표면이 아니다.** 드라이버 뒤에 있다 (`LocalDataplaneDriver.create`).
 *
 * 저장소를 갈아 끼우는 데 필요한 것만 내보낸다. 7차 검수는 "계약을 내보내 놓고 그 계약을
 * 구현할 타입을 안 줬다" 고 했고, 8차 검수는 반대로 "내부 상태기계 전체를 동결한다" 고
 * 했다. 답은 **불투명 payload + CAS** 다 — 저장소는 `version` 만 알면 되고 나머지는
 * 그대로 보관했다 그대로 돌려주면 된다. 그래야 내부 모양이 바뀌어도 계약이 안 깨진다.
 */
export {
  DpRejection,
  StoreConflict,
  type DurableStore,
  type PlaneAck,
  type RejectionKind,
  type StoredState,
} from './dp/agent.js';

/**
 * 원격 창구의 해독기 — 검수 2026-08-24 N2 (DESIGN.md §3.1 · §11.1)
 *
 * 이 저장소의 규칙은 **"타입은 런타임 입력을 막지 못한다"** 이고 `src/model/decode.ts`
 * 가 그것을 실행한다. REST 로 들어오는 모델은 한 글자도 안 믿는다.
 *
 * **mTLS 뒤의 창구는 그 규칙 밖에 있었다.** `agent-server` 의 `invoke` 가 이랬다:
 *
 *   driver.applyConfig(a['op'] as never)
 *
 * `as never` 는 타입 검사기에게 "그만 봐" 라고 말한 것이지 값이 그 모양이라는 증거가
 * 아니다. 인증서가 맞는 CP 라도 **버그가 있거나 낡은 CP** 일 수 있다 — mTLS 는 *누가*
 * 말하는지를 말하지 *무엇을* 말하는지는 말하지 않는다.
 *
 * ── 어디까지 갈 수 있었나
 *
 * `targetGeneration` 은 `effects-boot` 에서 이렇게 쓰인다:
 *
 *   run('/bin/sh', ['-c', BARY_CONFIGTEST_CMD.replace(/\{generation\}/g, generation)])
 *
 * 지금은 `verifyGeneration` 이 그 앞에 서서 fail-closed 다. **그것이 이 파일이 없어도
 * 되는 이유가 아니다** — 그 검사의 일은 manifest 무결성이지 셸 안전이 아니고, 방어가
 * 「검사 순서」 하나에 매달려 있으면 순서를 바꿀 이유가 생긴 날 조용히 사라진다.
 * 이 저장소의 표현으로 *"경계에 해독기가 없다"* 다.
 *
 * ── 왜 거절이 409(`DpRejection`)인가
 *
 * 창구의 계약은 셋뿐이다 (§`agent-server` 머리말): 200 · 409(판정) · 그 외(못 물었다).
 * 못 읽는 봉투를 500 으로 내면 CP 는 `RemoteDpUnreachable` 로 읽고 **고칠 수 없는 것을
 * 영원히 재시도한다.** 해독 실패는 에이전트가 내린 판정이므로 409 다 —
 * `invalid_coordinate` 가 이미 같은 자리에 있다.
 *
 * ── 이 모듈은 `src/index.ts` 에 안 나간다
 *
 * 공개 표면은 소비자가 보는 계약이고, 이건 창구의 **내부 방어**다. 표면에 얹으면
 * 다음 사람이 이 함수 모양을 계약으로 알고 쓰게 된다.
 */
import { DpRejection } from './agent.js';
import { PATH_SEGMENT_RULE, PATH_SEGMENT_SYNTAX } from '../validate/syntax.js';
import type { ApplyOperation, Coordinate, Plane, PlaneTarget } from './operation.js';

const PLANES: readonly Plane[] = ['http', 'stream'];

const reject = (what: string, why: string): never => {
  throw new DpRejection('malformed_request', `${what}: ${why}`);
};

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function str(v: unknown, what: string): string {
  if (typeof v !== 'string') return reject(what, `문자열이어야 한다 (받은 것: ${typeName(v)})`);
  return v;
}

function typeName(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * **모르는 키를 거절한다.**
 *
 * 조용히 무시하면 낡은 CP 가 보낸 필드가 여기서 사라지고, 그러면 CP 는 자기가 말한
 * 것이 반영됐다고 믿는다. `decodeModel` 의 `noExtraKeys` 와 같은 판단이다.
 */
function only(v: Record<string, unknown>, keys: readonly string[], what: string): void {
  const extra = Object.keys(v).filter((k) => !keys.includes(k));
  if (extra.length > 0) reject(what, `모르는 필드가 있다: ${extra.join(', ')}`);
}

/** 10진 정수 문자열. `normalizeNumeric` 이 뒤에서 다시 보지만, 여기서 먼저 막는다. */
function decimal(v: unknown, what: string): string {
  const s = str(v, what);
  if (!/^[0-9]+$/.test(s)) reject(what, `10진 정수 문자열이어야 한다: ${JSON.stringify(s)}`);
  return s;
}

/** 리더 토큰. `String(undefined)` 이 `"undefined"` 라는 사실이 이 함수의 이유다. */
export function decodeLeaderToken(v: unknown): string {
  return decimal(v, 'leaderToken');
}

/** 활성화 epoch. 좌표와 같은 규칙이다 — 10진 정수 문자열. */
export function decodeEpoch(v: unknown): string {
  return decimal(v, 'epoch');
}

export function decodePlane(v: unknown, what = 'plane'): Plane {
  const s = str(v, what);
  if (!PLANES.includes(s as Plane)) {
    reject(what, `'http' 이나 'stream' 이어야 한다: ${JSON.stringify(s)}`);
  }
  return s as Plane;
}

/**
 * 슬롯표. `Record<upstream, "host:port"[]>` 다.
 *
 * 값이 문자열 배열이 아니면 거절한다 — 이 값은 그대로 `lua_shared_dict` 로 밀려
 * `balancer_by_lua_block` 이 읽는다. 거기서 모양이 틀리면 **런타임 Lua 오류**가 되고,
 * 그건 요청을 받는 중에 드러난다.
 */
export function decodeSlots(v: unknown, what = 'slots'): Record<string, string[]> {
  if (!isObject(v)) return reject(what, `객체여야 한다 (받은 것: ${typeName(v)})`);
  const out: Record<string, string[]> = {};
  for (const [name, list] of Object.entries(v)) {
    if (!Array.isArray(list)) {
      reject(`${what}.${name}`, `배열이어야 한다 (받은 것: ${typeName(list)})`);
      continue;
    }
    out[name] = list.map((x, i) => str(x, `${what}.${name}[${i}]`));
  }
  return out;
}

function decodeCoordinate(v: unknown, what: string): Coordinate {
  if (!isObject(v)) return reject(what, `객체여야 한다 (받은 것: ${typeName(v)})`);
  only(v, ['activationEpoch', 'membershipRevision'], what);
  return {
    activationEpoch: decimal(v['activationEpoch'], `${what}.activationEpoch`),
    membershipRevision: decimal(v['membershipRevision'], `${what}.membershipRevision`),
  };
}

function decodePlaneTarget(v: unknown, what: string): PlaneTarget {
  if (!isObject(v)) return reject(what, `객체여야 한다 (받은 것: ${typeName(v)})`);
  only(v, ['expectedCurrent', 'target', 'payloadDigest'], what);
  return {
    expectedCurrent: decodeCoordinate(v['expectedCurrent'], `${what}.expectedCurrent`),
    target: decodeCoordinate(v['target'], `${what}.target`),
    payloadDigest: str(v['payloadDigest'], `${what}.payloadDigest`),
  };
}

/**
 * 세대 이름.
 *
 * 리소스 key 와 **같은 규칙**을 쓴다 (`PATH_SEGMENT_SYNTAX`). 둘 다 사용자가 정한
 * 문자열이 경로 조각이 되는 자리라 규칙이 갈릴 이유가 없고, 갈리면 어느 쪽이 정본인지
 * 아무도 모르게 된다.
 */
function decodeGenerationName(v: unknown, what: string): string {
  const s = str(v, what);
  if (!PATH_SEGMENT_SYNTAX.test(s)) {
    reject(what, `${PATH_SEGMENT_RULE}: ${JSON.stringify(s)} (세대 이름은 경로 조각이 된다)`);
  }
  return s;
}

/**
 * `ApplyOperation`.
 *
 * ⚠️ **여기서 의미를 판정하지 않는다.** `affectedPlanes` 가 비었는지(`empty_envelope`),
 * 실린 목표와 맞는지(`envelope_mismatch`), 좌표가 CAS 를 통과하는지는 전부 상태기계의
 * 일이고 그 판정들은 이미 있다. 이 함수의 일은 **그 판정들이 읽을 수 있는 모양인가**
 * 하나다. 둘을 섞으면 같은 판정이 두 자리에 생기고, 언젠가 갈린다.
 */
export function decodeApplyOperation(v: unknown, what = 'op'): ApplyOperation {
  if (!isObject(v)) return reject(what, `객체여야 한다 (받은 것: ${typeName(v)})`);
  only(v, ['leaderToken', 'operationId', 'transitionId', 'affectedPlanes',
    'planes', 'targetGeneration', 'generationDigest'], what);

  const rawPlanes = v['affectedPlanes'];
  if (!Array.isArray(rawPlanes)) {
    reject(`${what}.affectedPlanes`, `배열이어야 한다 (받은 것: ${typeName(rawPlanes)})`);
  }
  const affectedPlanes = (rawPlanes as unknown[])
    .map((p, i) => decodePlane(p, `${what}.affectedPlanes[${i}]`));

  const rawTargets = v['planes'];
  if (!isObject(rawTargets)) {
    return reject(`${what}.planes`, `객체여야 한다 (받은 것: ${typeName(rawTargets)})`);
  }
  // **모르는 평면 키를 거절한다.** `htp` 를 조용히 무시하면 CP 는 그 평면을 밀었다고
  // 믿고 우리는 안 민다 — 그 차이가 드러나는 곳은 트래픽이다.
  only(rawTargets, PLANES, `${what}.planes`);
  const planes: Partial<Record<Plane, PlaneTarget>> = {};
  for (const p of PLANES) {
    if (rawTargets[p] === undefined) continue;
    planes[p] = decodePlaneTarget(rawTargets[p], `${what}.planes.${p}`);
  }

  return {
    leaderToken: decimal(v['leaderToken'], `${what}.leaderToken`),
    operationId: str(v['operationId'], `${what}.operationId`),
    transitionId: str(v['transitionId'], `${what}.transitionId`),
    affectedPlanes,
    planes,
    targetGeneration: decodeGenerationName(v['targetGeneration'], `${what}.targetGeneration`),
    generationDigest: str(v['generationDigest'], `${what}.generationDigest`),
  };
}

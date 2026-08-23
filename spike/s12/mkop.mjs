/**
 * `ApplyOperation` 봉투를 만든다.
 *
 *   node mkop.mjs <prefix> <파일명> <id접미사> <세대> <from epoch> <to epoch>
 *
 * 처음엔 셸에서 `sed` 를 이어 붙여 두 번째 봉투를 만들었는데, 좌표 치환이 서로를 덮어써서
 * **조용히 망가진 JSON** 이 나왔다. 러너가 죽고 판정은 빈 문자열이 됐다 — 그건 "실패" 로
 * 보이지 "봉투가 잘못됐다" 로 안 보인다. 만드는 쪽을 스크립트로 옮긴다.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const [prefix, out, suffix, generation, fromArg, toArg] = process.argv.slice(2);
const manifest = JSON.parse(
  readFileSync(join(prefix, 'generations', generation, 'manifest.json'), 'utf8'));

/**
 * `auto` 면 **살아 있는 좌표**에서 읽는다.
 *
 * ── 왜 못 박으면 안 되나 (2026-08-24)
 *
 * 후속 봉투가 `expectedCurrent` 를 2 로 못 박고 있었다. 그건 **복구가 좌표를 옮겼다고
 * 가정하는 것**인데, 부하가 걸린 기계에서는 복구 러너가 활성화 증거를 예산 안에 못 보고
 * `failed` 로 확정하는 회차가 있다(이 파일의 러너 주석이 그 회차를 이미 적어 뒀다).
 * 그러면 `current` 심볼릭 링크와 nginx 는 gen-2 인데 **좌표만 뒤에 남고**, 못 박힌
 * 봉투는 `coordinate_mismatch` 로 영영 막힌다.
 *
 * **프로덕션은 그렇게 안 한다.** `ControlPlane.apply` 는 다음 오퍼레이션의 좌표를
 * 살아 있는 상태에서 만든다 — 앞 전환이 어디서 멈췄든 그 자리에서 이어 간다.
 * 봉투를 미리 구워 두고 재생하는 것은 이 스파이크만의 모양이었고, 그것이 없는 결함을
 * 만들어 냈다. 러너 주석의 그 문장 그대로다: **"계측기를 실제와 다르게 맞추면 없는
 * 결함을 만들어 낸다."**
 *
 * §12.0 이 묻는 것은 *"다음 오퍼레이션이 막히지 않는가"* 이고, 그 물음은 살아 있는
 * 좌표에서 출발할 때만 뜻이 있다.
 */
function liveEpoch() {
  // `FileStore` 의 봉투는 `{schema, checksum, state:{version, payload}}` 다.
  // 세 층을 다 열어 본다 — 옛 모양으로 저장된 파일도 읽히게.
  const raw = JSON.parse(readFileSync(join(prefix, 'state', 'agent.json'), 'utf8'));
  const planes = raw.state?.payload?.planes ?? raw.payload?.planes ?? raw.planes;
  const http = planes?.http?.activationEpoch;
  if (http === undefined) {
    throw new Error(`agent.json 에서 좌표를 못 읽었다: ${JSON.stringify(Object.keys(raw))}`);
  }
  return BigInt(http);
}

const from = fromArg === 'auto' ? String(liveEpoch()) : fromArg;
const to = toArg === 'auto' ? String(BigInt(from) + 1n) : toArg;

const coord = (digest) => ({
  expectedCurrent: { activationEpoch: from, membershipRevision: from },
  target: { activationEpoch: to, membershipRevision: to },
  payloadDigest: digest,
});

writeFileSync(join(prefix, out), JSON.stringify({
  leaderToken: '10',
  operationId: `op-s12${suffix}`,
  transitionId: `t-s12${suffix}`,
  // **두 평면을 다 선언한다** (10차 반례 ②) — 하나의 nginx.conf 가 둘을 함께 지배한다.
  affectedPlanes: ['http', 'stream'],
  targetGeneration: generation,
  // 이름은 내용을 말하지 못한다 (§7.2). manifest 에서 읽어 넣는다.
  generationDigest: manifest.digest,
  planes: { http: coord('sha256:h'), stream: coord('sha256:s') },
}, null, 2));

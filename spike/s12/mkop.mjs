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

const [prefix, out, suffix, generation, from, to] = process.argv.slice(2);
const manifest = JSON.parse(
  readFileSync(join(prefix, 'generations', generation, 'manifest.json'), 'utf8'));

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

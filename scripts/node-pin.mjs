#!/usr/bin/env node
/**
 * **node 버전이 두 군데서 갈라지지 않게 잰다.**
 *
 * 이 저장소는 node 의 메이저를 두 곳에 적는다.
 *
 *   · `.nvmrc`            — 워크플로 넷이 `setup-node` 로 읽는다
 *   · `deploy/Dockerfile` — 데이터 플레인 이미지가 `FROM node:<major>-alpine` 으로 박는다
 *
 * 한 군데로 못 줄인다. Dockerfile 의 `FROM` 은 파일을 읽지 못하고, 빌드 ARG 로 빼도
 * 기본값이 다시 사본이 된다. **그래서 사본이라는 사실을 인정하고, 대신 갈라지는 것을
 * 기계가 막는다** — 규칙이 산문이면 안 지켜진다는 것이 이 저장소가 반복해 배운 것이다.
 *
 * 이 검사가 없었으면 어떻게 됐는지는 실측이 있다: `.nvmrc` 를 만든 그날 dependabot 이
 * Dockerfile 만 24 → 26 으로 올리는 PR 을 열었다(#1). 게이트는 아무 말도 안 했을 것이다 —
 * CI 는 24 로, 배포 이미지는 26 으로 도는 상태가 조용히 초록이었을 것이다.
 *
 * `package.json` 의 `engines.node` 도 같이 본다. 그건 **바닥**이지 핀이 아니므로
 * (">=22" 는 "22 이상이면 돈다" 는 약속이다) 값이 같아야 하는 것이 아니라,
 * 핀이 그 바닥을 지켜야 한다.
 *
 *   node scripts/node-pin.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p) => readFileSync(join(root, p), 'utf8');

const fail = (msg) => {
  process.stderr.write(`${msg}\n`);
  process.exitCode = 1;
};

// ── .nvmrc ────────────────────────────────────────────────────────────
const nvmrc = read('.nvmrc').trim();
if (!/^\d+$/.test(nvmrc)) {
  fail(`.nvmrc 가 메이저 하나가 아니다: ${JSON.stringify(nvmrc)}\n`
    + '  `setup-node` 는 범위도 읽지만, 핀으로 쓰는 자리라 메이저 하나로 둔다.');
  process.exit(1);
}
const pin = Number(nvmrc);

// ── deploy/Dockerfile ─────────────────────────────────────────────────
//
// `FROM ... node:<major>[.<minor>...]-alpine` 만 본다. openresty 같은 다른 베이스는
// 이 검사의 대상이 아니다 — 여기서 재는 것은 *node 의 메이저가 한 벌인가* 다.
const dockerfile = read('deploy/Dockerfile');
const found = [...dockerfile.matchAll(/^FROM\s+\S*node:(\d+)(?:\.\S*)?-\S+/gm)]
  .map((m) => ({ major: Number(m[1]), line: m[0].trim() }));

if (found.length === 0) {
  fail('deploy/Dockerfile 에서 `FROM ... node:<major>-...` 를 못 찾았다.\n'
    + '  이미지가 node 를 안 쓰게 됐다면 이 검사도 같이 지워야 한다 — '
    + '검사만 남으면 아무것도 안 재면서 초록을 준다.');
} else {
  for (const f of found) {
    if (f.major !== pin) {
      fail(`node 핀이 갈라졌다 — .nvmrc 는 ${pin}, Dockerfile 은 ${f.major}\n`
        + `  ${f.line}\n`
        + '  둘은 같은 것을 말해야 한다. 올릴 거면 두 군데를 같이 올린다.');
    }
  }
}

// ── package.json engines ──────────────────────────────────────────────
const pkg = JSON.parse(read('package.json'));
const engines = pkg.engines?.node;
if (engines) {
  const floor = /^>=\s*(\d+)/.exec(engines);
  if (!floor) {
    fail(`engines.node 를 못 읽었다: ${JSON.stringify(engines)}\n`
      + '  이 검사는 ">=<메이저>" 형태만 안다. 형태를 바꿨으면 여기도 같이 고친다.');
  } else if (pin < Number(floor[1])) {
    fail(`핀이 engines 의 바닥보다 낮다 — .nvmrc ${pin} < engines "${engines}"\n`
      + '  선언한 최소 버전보다 낮은 것으로 검증하고 있다는 뜻이다.');
  }
}

if (process.exitCode) process.exit(1);

const where = found.map((f) => f.major).join(', ');
console.log(`node ${pin} — .nvmrc · deploy/Dockerfile(${where}) · engines "${engines ?? '없음'}"`);

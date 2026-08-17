/**
 * S12 러너 — **실제 프로세스를 크래시 지점에서 죽인다.**
 *
 *   node runner.mjs <prefix> <crashAt|none> <generation> [봉투파일=op.json]
 *
 * 종료 코드: 0 = 끝까지 갔다 · 없음(SIGABRT) = 주입한 지점에서 죽었다 · 3 = 못 죽었다
 *
 * ── 왜 in-process 스윕으로는 부족한가 ───────────────────────────────────
 *
 * `tests/conformance/review5-crash-points.test.ts` 가 지점 15 개 × 직전/직후를 전부
 * 훑고 수렴을 확인한다. 그건 **로직**을 재는 것이고, 거기서 죽는 방식은 예외다 —
 * 자바스크립트 힙만 버려지고 파일시스템은 정상 종료한 상태로 남는다.
 *
 * S12 가 묻는 것은 그게 아니다. **진짜로 죽으면** 남는 것들:
 *
 *   · 반쯤 쓰인 durable 파일, 이름이 바뀌다 만 임시 파일
 *   · 주인이 죽은 `FileStore` 락 — 회수할 수 있는가 (6차 반례 ⑤, 컨테이너에서 pid 1 은
 *     항상 살아 있어 보였다)
 *   · `current` 심볼릭 링크와 저널의 순서가 프로세스 경계를 넘어 지켜지는가
 *   · 그리고 v0.6 이 더한 **인증서 바이트** (§6.2 표 9행 — 크래시 지점 테스트가
 *     "TLS 는 v0.6" 이라며 범위 밖으로 미뤄 둔 행이다. v0.6 이 왔다)
 *
 * 그래서 여기서는 **실물 `FileStore` · 실물 `FsEffects` · 실물 nginx** 위에서 돌리고
 * `process.abort()` 로 죽인다. `kill -9` 와 같은 자리에 선다.
 *
 * ── 주입은 프로덕션 코드 밖에 있다 ──────────────────────────────────────
 *
 * `FaultStore` 는 아무 `DurableStore` 나 감싸므로 실물 `FileStore` 를 감쌀 수 있고,
 * `CrashClock.tick` 은 여기서 덮어써서 예외 대신 `abort()` 를 부른다. 이펙트 쪽은
 * 같은 수법으로 이 파일 안에서 감싼다 — **프로덕션 코드에 테스트용 인자가 새지 않는다**
 * (`classifyWrite` 주석이 세운 규칙이다).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const DIST = '/app/dist';
const { DpAgent } = await import(`${DIST}/dp/agent.js`);
const { ApplyRunner, CrashClock, FaultStore } = await import(`${DIST}/dp/apply.js`);
const { FileStore } = await import(`${DIST}/dp/store-fs.js`);
const { FsEffects } = await import(`${DIST}/dp/effects-fs.js`);

const [prefix, crashArg, generation, opFile = 'op.json'] = process.argv.slice(2);
const crashAt = crashArg === 'none' ? undefined : Number(crashArg);

const ENGINE = '/usr/local/openresty/bin/openresty';
const sh = (cmd) => execFileSync('/bin/sh', ['-c', cmd], { stdio: ['ignore', 'pipe', 'pipe'] })
  .toString().trim();

/** **진짜로 죽는 시계.** 예외를 던지는 대신 프로세스를 끝낸다. */
class AbortClock extends CrashClock {
  tick(label) {
    const at = this.steps;
    this.steps += 1;
    this.seen.push(label);
    // 지나온 지점을 밖에서 셀 수 있게 흘린다. 죽은 뒤에도 남아야 하므로 stdout 이다.
    process.stdout.write(`POINT ${at} ${label}\n`);
    if (this.crashAt === at) {
      process.stdout.write(`ABORT ${at} ${label}\n`);
      // **flush 를 기다린 뒤 죽는다.** 바로 abort 하면 마지막 줄이 안 나가서 어디서
      // 죽었는지 알 수 없다 — 판정이 아니라 계측을 잃는 것이다.
      try { execFileSync('/bin/sh', ['-c', 'true']); } catch { /* flush 유도 */ }
      process.abort();
    }
  }
}

/** 실물 이펙트를 감싸 같은 시계로 지점을 센다. */
function faultEffects(inner, clock) {
  const wrap = (name, fn) => async (...args) => {
    clock.tick(`${name}:before`);
    const out = await fn(...args);
    clock.tick(`${name}:after`);
    return out;
  };
  return {
    preflight: (op) => inner.preflight(op),
    publish: wrap('publish', (r, l) => inner.publish(r, l)),
    observePublished: () => inner.observePublished(),
    signalReload: wrap('reload', (l) => inner.signalReload(l)),
    observeActivation: () => inner.observeActivation(),
    ...(inner.stageMembership === undefined ? {} : {
      stageMembership: wrap('stage', (g, p, l) => inner.stageMembership(g, p, l)),
    }),
    ...(inner.pushMembership === undefined ? {} : {
      pushMembership: (p, e, s) => inner.pushMembership(p, e, s),
    }),
  };
}

const clock = new AbortClock();
clock.crashAt = crashAt;

const effects = faultEffects(new FsEffects({
  prefix,
  reload: async () => { sh(`kill -HUP $(cat ${prefix}/logs/nginx.pid)`); },
  probeAccepting: async () => {
    try {
      return sh(`curl -s --max-time 2 http://127.0.0.1:19990/generation`) || undefined;
    } catch { return undefined; }
  },
  configTest: async (gen) => {
    try {
      execFileSync(ENGINE, ['-p', prefix, '-c', `generations/${gen}/nginx.conf`, '-t'],
        { stdio: 'ignore' });
      return true;
    } catch { return false; }
  },
}), clock);

// **실물 FileStore 를 감싼다.** 락 회수까지 실제 동작이 걸린다.
const store = new FaultStore(FileStore.open(join(prefix, 'state', 'agent.json')), clock);

const op = JSON.parse(readFileSync(join(prefix, opFile), 'utf8'));
op.targetGeneration = generation;

// **폴 정책을 안 넘긴다** — 프로덕션과 같은 `DEFAULT_POLL`(25회 × 100ms)을 쓴다.
//
// 처음엔 `{attempts:3, intervalMs:50}` 으로 빠르게 돌렸는데, 그건 실제보다 17 배 빡빡한
// 예산이라 **활성화 증거를 기다리다 실패로 확정하는 회차가 생겼다.** 스윕이 회차마다
// 다른 지점을 실패로 지목했고(#2·#15·#24 → #10), 그 비결정성이 단서였다 — 고정된 로직
// 결함이면 같은 지점이 나온다.
//
// 계측기를 실제와 다르게 맞추면 없는 결함을 만들어 낸다. 이 세션에서 세 번째다.
const result = await new ApplyRunner(new DpAgent(store), effects).run(op);

process.stdout.write(`RESULT ${result.phase}\n`);
process.stdout.write(`CURRENT ${existsSync(join(prefix, 'current'))
  ? sh(`readlink ${prefix}/current`) : '(없음)'}\n`);
// 주입한 지점을 못 지났다는 뜻 — 스윕이 그 지점을 헛돈 것이므로 성공으로 세면 안 된다.
if (crashAt !== undefined) process.exit(3);

/**
 * S12 end-to-end — 저널이 **실제 nginx** 를 상대로 수렴하는가
 *
 * 지금까지 S11·S12 의 유일한 결격 사유가 "실물과 안 물려 있다" 였다. 4차 검수의 교훈이
 * "모의로만 검증한 것은 실물에서 깨진다" 였으므로 여기서 물린다.
 *
 *   게시     — **컨테이너 안에서** 심볼릭 링크 교체
 *   reload   — `docker kill --signal=HUP`
 *   관측     — 세대에 **구워진 리터럴**을 HTTP 로 읽는다 (§6.3-4)
 *
 * 게시를 컨테이너 안에서 하는 이유가 있다. 처음엔 호스트에서 링크를 바꿨는데 컨테이너가
 * 보는 링크가 **비어 있었다** — Docker Desktop 의 bind mount 가 심볼릭 링크 교체를
 * 전파하지 못한다 (`open() "/prefix/current/nginx.conf" failed (22: Invalid argument)`).
 * 이건 테스트 환경의 한계가 아니라 **설계가 이미 말한 것**이다: DP Agent 는 `/etc/barycenter`
 * 의 유일한 writer 이고 DP 컨테이너 안에 산다 (§3.2 · §11.1). 에이전트를 호스트에 두는
 * 구성은 애초에 설계에 없다.
 *
 * 마커가 세대별 리터럴이라는 게 핵심이다. shared 상태였다면 옛 워커도 새 값을 답한다
 * (S7 의 A4.3 에서 실측했다).
 *
 *   npm run test:e2e     (도커 필요)
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DpAgent } from '../../src/dp/agent.js';
import { FileStore } from '../../src/dp/store-fs.js';
import { ApplyRunner, CrashInjected, type Effects } from '../../src/dp/apply.js';
import type {
  ActivationEvidence,
  ApplyLease,
  ApplyOperation,
  PublishRecord,
  PublishedState,
} from '../../src/dp/operation.js';
import { materializeGeneration, verifyGeneration } from '../../src/dp/materialize.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'openresty/openresty:alpine';
const PORT = 18099;

let prefix: string;
let container: string;

/**
 * 앞선 실패가 남긴 컨테이너를 치운다.
 *
 * verify 전체 실행에서 e2e 가 **간헐적으로** 죽는 것을 두 번 봤다. 원인은 매번 같았다 —
 * 앞선 실패가 컨테이너를 남겨 포트를 잡고 있었고, 다음 `docker run` 이 거기서 깨졌다.
 * 재실행하면 통과하니 원인을 찾기 전까지는 "그냥 다시 돌리면 된다" 로 넘어가게 된다.
 * **간헐적으로 깨지는 테스트는 없느니만 못하다.**
 */
function reapStrays(): void {
  try {
    const names = execFileSync('docker', ['ps', '-aq', '--filter', `name=bary-e2e-`], {
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    if (names.length > 0) {
      execFileSync('docker', ['rm', '-f', ...names.split('\n')], { stdio: 'ignore' });
    }
  } catch {
    /* 도커가 없으면 beforeAll 이 따로 알린다 */
  }
}

const docker = (...args: string[]): string =>
  execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** 세대마다 **다른 리터럴**을 굽는다 — 이게 §6.3 의 활성 세대 마커다. */
const GENERATION_DIGESTS = new Map<string, string>();

/**
 * 세대를 **materializer 로** 만든다 (§7.2).
 *
 * 손으로 디렉토리를 써 두면 원자적 게시도 manifest 도 테스트되지 않는다. 6차 검수가
 * "세대 디렉토리 게시를 수행하는 production 코드가 없다" 고 지적한 자리다.
 */
function makeGeneration(name: string): void {
  const manifest = materializeGeneration({
    prefix,
    generation: name,
    // 이 세대는 http 와 stream 을 **함께** 구성한다 (10차 반례 ②).
    planes: ['http', 'stream'],
    files: {
      'nginx.conf': `daemon off;
error_log /prefix/logs/error.log warn;
pid /prefix/logs/nginx.pid;
events { worker_connections 64; }
http {
    access_log off;
    server {
        listen 8080;
        location /generation { return 200 "${name}"; }
    }
}
stream {
    server {
        listen 8443;
        content_by_lua_block { ngx.say("${name}") }
    }
}
`,
    },
  });
  GENERATION_DIGESTS.set(name, manifest.digest);
}

/**
 * stream 평면의 활성 세대. **http 와 별개로** 확인해야 §3.4 의 이중 평면이 실물에서
 * 성립하는지 알 수 있다. 한쪽만 보면 다른 쪽이 옛 세대로 남아도 모른다.
 *
 * busybox `nc` 는 stdin 이 EOF 면 소켓을 닫는다. 잠깐 열어 둬야 응답을 받는다.
 */
async function probeStream(): Promise<string | undefined> {
  try {
    const out = execFileSync(
      'docker',
      ['exec', container, 'sh', '-c', '(sleep 0.4) | nc 127.0.0.1 8443 2>/dev/null || true'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString().trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

async function probeAccepting(): Promise<string | undefined> {
  try {
    const out = execFileSync(
      'docker',
      ['exec', container, 'sh', '-c',
       `wget -qO- --timeout=2 http://127.0.0.1:8080/generation 2>/dev/null || true`],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString().trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 컨테이너 안에서 도는 DP Agent 의 부작용. `FsEffects` 와 같은 일을 하되 `docker exec` 를
 * 통해 컨테이너의 파일시스템에 대고 한다 — 그게 실제 배치다.
 */
/** 컨테이너 안 error log 의 줄 수. S7 의 음성 신호를 실물에서 잰다. */
function errorLogLines(): number {
  try {
    const out = docker('exec', container, 'sh', '-c',
      'wc -l < /prefix/logs/error.log 2>/dev/null || echo 0');
    return Number.parseInt(out.trim(), 10) || 0;
  } catch {
    return 0;
  }
}

const effects = (): Effects => {
  // HUP 을 보낸 시점의 워터마크. 그 이후 증가분만 이 전환의 것이다 (§6.3).
  let watermark: number | undefined;
  return {
  async preflight(op) {
    // 실제 파일을 다시 읽어 대조한다 — 호스트에서 돌지만 같은 바이트를 본다.
    try {
      verifyGeneration(prefix, op.targetGeneration, op.generationDigest, op.affectedPlanes);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
  },
  async publish(record, lease) {
    const generation = record.generation;
    const dir = `/prefix/generations/${generation}`;
    docker('exec', container, 'sh', '-c',
      `test -f ${dir}/nginx.conf || { echo "세대가 없다: ${dir}" >&2; exit 3; }`);
    // ln + mv -T. mv 는 -T 없이는 목적지 심볼릭 링크를 **따라가** 디렉토리 안으로 옮긴다.
    // 준비와 되돌릴 수 없는 교체를 나눈다 (8차 반례 ①).
    docker('exec', container, 'sh', '-c', `ln -sfn generations/${generation} /prefix/current.tmp`);
    // **소유 기록을 먼저 쓴다** — 포인터가 먼저 바뀌면 주인 없는 세대가 관측된다.
    docker('exec', container, 'sh', '-c',
      `cat > /prefix/current.owner <<'OWNER'\n${JSON.stringify(record)}\nOWNER`);
    lease?.assertValid();
    docker('exec', container, 'sh', '-c', `mv -T /prefix/current.tmp /prefix/current`);
  },
  async observePublished(): Promise<PublishedState> {
    const link = docker('exec', container, 'sh', '-c', 'readlink /prefix/current || true');
    const generation = link.length > 0 ? link.split('/').pop() : undefined;
    const raw = docker('exec', container, 'sh', '-c', 'cat /prefix/current.owner 2>/dev/null || true');
    let record: PublishRecord | undefined;
    try {
      record = raw.length > 0 ? (JSON.parse(raw) as PublishRecord) : undefined;
    } catch {
      record = undefined;
    }
    if (generation === undefined && record === undefined) return { kind: 'none' };
    if (generation !== undefined && record !== undefined && record.generation === generation) {
      return { kind: 'owned', record };
    }
    return record === undefined
      ? { kind: 'inconsistent', generation }
      : { kind: 'inconsistent', generation, record };
  },
  async signalReload(lease) {
    // **신호 전에** 찍는다. 뒤에 찍으면 신호가 만든 오류를 놓친다.
    watermark = errorLogLines();
    lease?.assertValid();
    docker('kill', '--signal=HUP', container);
  },
  async observeActivation(): Promise<ActivationEvidence | undefined> {
    const accepting = await probeAccepting();
    if (accepting === undefined) return undefined;
    const growth = watermark === undefined ? undefined : Math.max(0, errorLogLines() - watermark);
    return {
      acceptingGeneration: accepting,
      ...(growth === undefined ? {} : { errorLogGrowth: growth }),
    };
  },
  };
};

/** §3.6 봉투가 저널을 타고 흐른다. 여기서는 http 평면 하나를 옮긴다. */
const OP = (n: string, generation: string): ApplyOperation => ({
  leaderToken: '10',
  operationId: n,
  transitionId: `${n}-t`,
  // **두 평면을 선언한다.** 이 세대들의 nginx.conf 는 http 와 stream 을 함께 구성하므로
  // 한 평면만 선언하면 게시 전 검사가 plane_mismatch 로 막는다 (10차 반례 ②).
  // 실제로 그 검사가 이 파일을 잡았다.
  affectedPlanes: ['http', 'stream'],
  targetGeneration: generation,
  generationDigest: GENERATION_DIGESTS.get(generation) ?? 'sha256:없는세대',
  planes: {
    http: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: `sha256:${n}-h`,
    },
    stream: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: `sha256:${n}-s`,
    },
  },
});

/**
 * **실제 파일 저장소를 쓴다.** 5차 검수가 "e2e 도 MemoryStore 만 쓴다" 를 지적했다.
 * 원자적 교체·체크섬·버전 CAS 가 실물 경로에서도 도는지는 여기서만 드러난다.
 */
let storeSeq = 0;
const openStores: FileStore[] = [];
function newStore(): FileStore {
  storeSeq += 1;
  const s = FileStore.open(join(prefix, 'state', `agent-${storeSeq}.json`));
  openStores.push(s);
  return s;
}

/** 두 평면을 한 오퍼레이션으로 옮긴다 (§3.4). */
const BOTH = (n: string, generation: string): ApplyOperation => ({
  ...OP(n, generation),
  affectedPlanes: ['http', 'stream'],
  planes: {
    http: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: `sha256:${n}-h`,
    },
    stream: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: `sha256:${n}-s`,
    },
  },
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * 조건이 참이 될 때까지 기다린다.
 *
 * 고정 `sleep` 은 느린 머신에서 거짓 실패를, 빠른 머신에서 거짓 성공을 만든다.
 * 실제로 이 파일이 간헐적으로 깨졌다 — **간헐적으로 깨지는 테스트는 없느니만 못하다.**
 * green 이 될 때까지 다시 돌리는 습관을 들이기 때문이다.
 */
async function waitFor<T>(
  probe: () => Promise<T>,
  ok: (v: T) => boolean,
  budgetMs = 8000,
): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last: T = await probe();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(100);
    last = await probe();
  }
  return last;
}

const waitAccepting = (gen: string) => waitFor(probeAccepting, (g) => g === gen);

describe('S12 end-to-end — 실제 nginx', () => {
  beforeAll(() => {
    try {
      execFileSync('docker', ['info'], { stdio: 'ignore' });
    } catch {
      throw new Error('도커가 필요하다. end-to-end 는 실제 nginx 로 판정한다.');
    }
  });

  beforeEach(async () => {
    reapStrays();
    prefix = mkdtempSync(join(tmpdir(), 'bary-e2e-'));
    mkdirSync(join(prefix, 'generations'), { recursive: true });
    mkdirSync(join(prefix, 'logs'), { recursive: true });
    makeGeneration('gen-1');
    makeGeneration('gen-2');
    makeGeneration('gen-3');

    // gen-1 로 시작한다. 컨테이너가 뜨기 전이므로 호스트에서 최초 링크만 만든다
    // (교체가 아니라 생성이라 bind mount 문제가 없다).
    symlinkSync('generations/gen-1', join(prefix, 'current'));

    container = `bary-e2e-${process.pid}-${Date.now()}`;
    docker(
      'run', '-d', '--name', container,
      '-v', `${prefix}:/prefix`,
      '-p', `127.0.0.1:${PORT}:8080`,
      '--entrypoint', '/usr/local/openresty/bin/openresty',
      IMAGE, '-p', '/prefix', '-c', 'current/nginx.conf',
    );
    // 고정 대기 대신 **실제로 응답할 때까지** 기다린다.
    const up = await waitAccepting('gen-1');
    if (up !== 'gen-1') {
      throw new Error(`컨테이너가 뜨지 않았다: ${docker('logs', container)}`);
    }
  }, 120_000);

  afterEach(() => {
    for (const s of openStores.splice(0)) s.release();
    try {
      docker('rm', '-f', container);
    } catch {
      /* 이미 없으면 그만 */
    }
    rmSync(prefix, { recursive: true, force: true });
  });

  it('기동 직후 gen-1 을 서빙한다 — 두 평면 다', async () => {
    expect(await probeAccepting()).toBe('gen-1');
    expect(await probeStream(), 'stream 평면이 응답하지 않는다').toBe('gen-1');
    // **부트스트랩 포인터는 우리 것이 아니다.** 테스트가 손으로 만든 심볼릭 링크에는
    // 소유 기록이 없으므로 `inconsistent` 다 — 그게 맞다. 첫 apply 가 자기 이름으로
    // 다시 게시해 수렴시킨다 (9차 뒤 방향 전환).
    expect(await effects().observePublished()).toMatchObject({
      kind: 'inconsistent',
      generation: 'gen-1',
    });
  });

  /**
   * §3.4 — nginx 는 http 와 stream 을 **한 번의 HUP 으로** 함께 올린다.
   *
   * 무엇을 증명하고 무엇을 증명하지 않는지 갈라 둔다.
   *   · 마커 두 개가 바뀌는 것은 **엔진 사실**이다 — 렌더된 stream 블록이 실제로
   *     reload 에 반영된다는 것. 우리 두 평면 로직의 증거는 아니다.
   *   · 두 평면 로직의 증거는 **좌표와 progress** 다. 한 평면만 commit 하면 거기가 깨진다.
   */
  it('두 평면이 실물에서 함께 넘어간다 (§3.4)', async () => {
    const agent = new DpAgent(newStore());
    const result = await new ApplyRunner(agent, effects()).run(BOTH('e2e-both', 'gen-2'));

    expect(result.phase).toBe('activated');
    expect(result.progress.http).toBe('committed');
    expect(result.progress.stream).toBe('committed');
    expect(result.partialTransition).toBe(false);

    expect(await waitAccepting('gen-2'), 'http 평면이 안 넘어갔다').toBe('gen-2');
    expect(
      await waitFor(probeStream, (g) => g === 'gen-2'),
      'stream 평면이 안 넘어갔다',
    ).toBe('gen-2');

    // 좌표도 둘 다 움직였어야 한다.
    expect(agent.coordinate('http').activationEpoch).toBe('1');
    expect(agent.coordinate('stream').activationEpoch).toBe('1');
    // 활성화 근거가 남는다 (§6.3).
    expect(agent.evidenceFor('stream', '1')?.acceptingGeneration).toBe('gen-2');
  });

  it('저널이 실제 nginx 를 gen-2 로 옮긴다', async () => {
    const fx = effects();
    const phase = await new ApplyRunner(new DpAgent(newStore()), fx).run(OP('e2e-1', 'gen-2'));
    expect(phase.phase).toBe('activated');
    expect(await waitAccepting('gen-2')).toBe('gen-2');
  });

  it('게시 직후 죽어도 복구가 이어받는다', async () => {
    const store = newStore();

    // publish 는 성공하되 reload 직전에 죽는 부작용을 끼운다.
    const fx = effects();
    const crashing = {
      preflight: fx.preflight.bind(fx),
      publish: fx.publish.bind(fx),
      observePublished: fx.observePublished.bind(fx),
      observeActivation: fx.observeActivation.bind(fx),
      signalReload: async () => {
        throw new CrashInjected('reload 직전');
      },
    };
    await expect(
      new ApplyRunner(new DpAgent(store), crashing).run(OP('e2e-2', 'gen-2')),
    ).rejects.toBeInstanceOf(CrashInjected);

    // 이 시점: 링크는 gen-2, 실행 중인 nginx 는 아직 gen-1
    expect(await effects().observePublished()).toMatchObject({ kind: 'owned', record: { generation: 'gen-2' } });
    expect(await probeAccepting()).toBe('gen-1');

    // 재시작한 Agent 가 이어받는다.
    const phase = await new ApplyRunner(new DpAgent(store), effects()).recover();
    expect(phase.phase).toBe('activated');
    expect(await waitAccepting('gen-2')).toBe('gen-2');
  });

  it('이미 반영된 뒤 복구를 다시 돌려도 reload 를 더 보내지 않는다', async () => {
    const store = newStore();
    let reloads = 0;
    const fx = effects();
    const counted = {
      preflight: fx.preflight.bind(fx),
      publish: fx.publish.bind(fx),
      observePublished: fx.observePublished.bind(fx),
      observeActivation: fx.observeActivation.bind(fx),
      signalReload: async (lease: ApplyLease) => {
        reloads += 1;
        await fx.signalReload(lease);
      },
    };
    await new ApplyRunner(new DpAgent(store), counted).run(OP('e2e-3', 'gen-2'));
    expect(await waitAccepting('gen-2')).toBe('gen-2');
    expect(reloads).toBe(1);

    await new ApplyRunner(new DpAgent(store), counted).recover();
    await new ApplyRunner(new DpAgent(store), counted).recover();
    expect(reloads, '이미 활성화된 세대에 reload 를 다시 보냈다').toBe(1);
    expect(await probeAccepting()).toBe('gen-2');
  });

  // §3.3 — 롤백은 옛 세대를 되돌리는 게 아니라 **새 활성화 사건**이다.
  it('롤백도 새 오퍼레이션으로 수렴한다', async () => {
    const fx = effects();
    await new ApplyRunner(new DpAgent(newStore()), fx).run(OP('e2e-fwd', 'gen-2'));
    expect(await waitAccepting('gen-2')).toBe('gen-2');

    // gen-3 는 gen-1 과 같은 내용이라고 가정한 clone 이다 (§3.3 — 옛 topology, 새 세대).
    const back = await new ApplyRunner(new DpAgent(newStore()), fx).run(OP('e2e-back', 'gen-3'));
    expect(back.phase).toBe('activated');
    expect(await waitAccepting('gen-3')).toBe('gen-3');
  });

  it('없는 세대는 게시하지 않는다 — 실행 중인 nginx 를 건드리지 않는다', async () => {
    const store = newStore();
    // 없는 세대는 **게시 전 검사**에서 걸린다. 예외가 아니라 정상적인 실패다 (§6.2 #2).
    const r = await new ApplyRunner(new DpAgent(store), effects()).run(OP('e2e-4', 'gen-없음'));
    expect(r.phase).toBe('failed');
    expect(await probeAccepting()).toBe('gen-1');
    // 게시가 일어나지 않았으므로 부트스트랩 상태 그대로다.
    expect(await effects().observePublished()).toMatchObject({
      kind: 'inconsistent',
      generation: 'gen-1',
    });
  });
});

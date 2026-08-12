/**
 * DP Agent 를 **DP 컨테이너 안에서** 돌린다 — DESIGN.md §3.2 · §11.1 · §7.2
 *
 * 5차 검수 지적: e2e 가 `FsEffects` 를 쓰지 않는다. 맞다. 그런데 왜 못 썼는지가 중요하다.
 *
 * 호스트에서 심볼릭 링크를 교체하면 **컨테이너가 못 본다.** Docker Desktop 의 bind mount
 * 가 symlink 교체를 전파하지 않는다:
 *
 *   readlink /prefix/current  → 실패
 *   cat /prefix/current/x     → Invalid argument
 *
 * 한때 이게 `mv` 가 목적지 심볼릭 링크를 따라가던 버그 때문일까 의심했다. `mv -T` 로
 * 고친 뒤 **Node 의 `renameSync` 로 다시 실측했고 결과는 같았다.** 플랫폼 제약이 맞다.
 *
 * 그리고 이건 테스트 환경의 한계가 아니라 **설계가 이미 말한 것**이다. DP Agent 는
 * `/etc/barycenter` 의 유일한 writer 이고 DP 컨테이너 안에 산다 (§3.2 · §11.1).
 * 에이전트를 호스트에 두는 구성은 애초에 설계에 없다.
 *
 * 그래서 여기서는 **설계대로 배치한다.** 컨테이너 안에 node 를 넣고, 우리 코드를 번들해
 * 넣고, 거기서 `FileStore` · `DpAgent` · `FsEffects` · `ApplyRunner` 를 전부 진짜로 돌린다.
 * 심볼릭 링크 교체도, HUP 도, error log 워터마크도 전부 실물이다.
 *
 *   npm run test:e2e     (도커 필요)
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'openresty/openresty:alpine';
const repo = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

let prefix: string;
let container: string;
let bundle: string;

const docker = (...args: string[]): string =>
  execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/**
 * 컨테이너 안에서 돌 에이전트. **우리 소스를 번들한다** — 흉내 내면 아무것도 증명하지 못한다.
 */
function buildAgentBundle(): string {
  const out = mkdtempSync(join(tmpdir(), 'bary-agent-'));
  const entry = join(out, 'entry.mjs');
  const src = (f: string) => JSON.stringify(join(repo, 'src/dp', f));
  writeFileSync(
    entry,
    `import { readFileSync } from 'node:fs';
import { FileStore } from ${src('store-fs.ts')};
import { DpAgent } from ${src('agent.ts')};
import { FsEffects } from ${src('effects-fs.ts')};
import { ApplyRunner } from ${src('apply.ts')};

const [, , generation, operationId, epoch] = process.argv;

const store = FileStore.open('/prefix/state/agent.json');
const agent = new DpAgent(store);
const effects = new FsEffects({
  prefix: '/prefix',
  // 같은 PID 네임스페이스다. 마스터에 직접 신호를 보낸다.
  reload: async () => {
    const pid = Number(readFileSync('/prefix/logs/nginx.pid', 'utf8').trim());
    process.kill(pid, 'SIGHUP');
  },
  probeAccepting: async () => {
    try {
      const r = await fetch('http://127.0.0.1:8080/generation');
      return r.ok ? (await r.text()).trim() : undefined;
    } catch {
      return undefined;
    }
  },
});

const prev = String(Number(epoch) - 1);
const op = {
  leaderToken: '10',
  operationId,
  transitionId: operationId + '-t',
  affectedPlanes: ['http'],
  targetGeneration: generation,
  planes: {
    http: {
      expectedCurrent: { activationEpoch: prev, membershipRevision: prev },
      target: { activationEpoch: epoch, membershipRevision: epoch },
      payloadDigest: 'sha256:' + generation,
    },
  },
};

try {
  const result = await new ApplyRunner(agent, effects).run(op);
  console.log('PHASE=' + result.phase);
  console.log('EVIDENCE=' + JSON.stringify(result.evidence ?? null));
  console.log('EPOCH=' + agent.coordinate('http').activationEpoch);
} catch (e) {
  console.log('THREW=' + (e.kind ?? e.name));
} finally {
  store.release();
}
`,
    'utf8',
  );
  const outfile = join(out, 'agent.mjs');
  execFileSync(
    join(repo, 'node_modules/.bin/esbuild'),
    [entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${outfile}`],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  return outfile;
}

function makeGeneration(name: string): void {
  const dir = join(prefix, 'generations', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'nginx.conf'),
    `daemon off;
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
`,
    'utf8',
  );
}

/**
 * **뜰 수 없는 세대.** 이미 점유된 포트를 듣는다 → HUP 이 bind 에 실패하고 error log 가
 * 늘어난다. S7 이 실증한 상황을 프로덕션 경로로 재현하기 위한 것이다.
 */
function makeUnbindableGeneration(name: string, busyPort: number): void {
  const dir = join(prefix, 'generations', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'nginx.conf'),
    `daemon off;
error_log /prefix/logs/error.log warn;
pid /prefix/logs/nginx.pid;
events { worker_connections 64; }
http {
    access_log off;
    server {
        listen 8080;
        location /generation { return 200 "${name}"; }
    }
    server { listen ${busyPort}; }
}
`,
    'utf8',
  );
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(probe: () => Promise<T>, ok: (v: T) => boolean, budgetMs = 8000): Promise<T> {
  const deadline = Date.now() + budgetMs;
  let last: T = await probe();
  while (!ok(last) && Date.now() < deadline) {
    await sleep(100);
    last = await probe();
  }
  return last;
}

async function serving(): Promise<string | undefined> {
  try {
    const out = docker('exec', container, 'sh', '-c',
      'wget -qO- --timeout=2 http://127.0.0.1:8080/generation 2>/dev/null || true');
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** 컨테이너 안의 에이전트를 한 번 돌린다. */
const runAgent = (generation: string, operationId: string, epoch: string): string =>
  docker('exec', container, 'node', '/agent.mjs', generation, operationId, epoch);

const field = (out: string, key: string): string | undefined =>
  out.split('\n').find((l) => l.startsWith(`${key}=`))?.slice(key.length + 1);

describe('DP Agent 를 컨테이너 안에서 돌린다 — FsEffects 실물 경로', () => {
  beforeAll(() => {
    try {
      execFileSync('docker', ['info'], { stdio: 'ignore' });
    } catch {
      throw new Error('도커가 필요하다.');
    }
    bundle = buildAgentBundle();
  }, 180_000);

  beforeEach(async () => {
    prefix = mkdtempSync(join(tmpdir(), 'bary-inc-'));
    mkdirSync(join(prefix, 'generations'), { recursive: true });
    mkdirSync(join(prefix, 'logs'), { recursive: true });
    mkdirSync(join(prefix, 'state'), { recursive: true });
    makeGeneration('gen-1');
    makeGeneration('gen-2');
    makeGeneration('gen-3');
    // 최초 링크만 호스트에서 만든다 (교체가 아니라 생성이라 전파 문제가 없다).
    symlinkSync('generations/gen-1', join(prefix, 'current'));

    container = `bary-inc-${process.pid}-${Date.now()}`;
    docker(
      'run', '-d', '--name', container,
      '-v', `${prefix}:/prefix`,
      '--entrypoint', '/usr/local/openresty/bin/openresty',
      IMAGE, '-p', '/prefix', '-c', 'current/nginx.conf',
    );
    docker('exec', container, 'apk', 'add', '--no-cache', 'nodejs');
    docker('cp', bundle, `${container}:/agent.mjs`);

    const up = await waitFor(serving, (g) => g === 'gen-1');
    if (up !== 'gen-1') throw new Error(`컨테이너가 뜨지 않았다: ${docker('logs', container)}`);
  }, 180_000);

  afterEach(() => {
    try {
      docker('rm', '-f', container);
    } catch {
      /* 이미 없으면 그만 */
    }
    rmSync(prefix, { recursive: true, force: true });
  });

  it('컨테이너 안의 FsEffects 가 실제 nginx 를 gen-2 로 옮긴다', async () => {
    const out = runAgent('gen-2', 'inc-1', '1');
    expect(field(out, 'PHASE'), out).toBe('activated');
    expect(field(out, 'EPOCH')).toBe('1');
    expect(await waitFor(serving, (g) => g === 'gen-2')).toBe('gen-2');
  });

  it('심볼릭 링크 교체가 **컨테이너 안에서는** 보인다 — 설계가 말한 배치가 맞다', () => {
    runAgent('gen-2', 'inc-2', '1');
    expect(docker('exec', container, 'readlink', '/prefix/current')).toBe('generations/gen-2');
  });

  it('활성화 증거를 실물에서 수집한다 — error log 워터마크 포함 (§6.3 · S7)', () => {
    const out = runAgent('gen-2', 'inc-3', '1');
    const evidence = JSON.parse(field(out, 'EVIDENCE') ?? 'null') as {
      acceptingGeneration?: string;
      errorLogGrowth?: number;
    } | null;
    expect(evidence?.acceptingGeneration).toBe('gen-2');
    // 정상 reload 는 error log 를 늘리지 않는다 — S7 이 실측한 것과 같아야 한다.
    expect(evidence?.errorLogGrowth, '정상 reload 인데 error log 가 늘었다').toBe(0);
  });

  /**
   * 뜰 수 없는 세대가 실패로 끝나고 **좌표가 움직이지 않는지** 본다.
   *
   * ⚠️ **워터마크가 결정적이라고 주장하지 않는다.** 처음엔 그렇게 제목을 달았는데,
   * `provesActivation` 에서 error log 검사를 빼는 뮤턴트가 **그대로 통과했다.**
   *
   * 이유는 이렇다. nginx 는 새 listen 소켓 bind 에 실패하면 **옛 설정을 유지한다.**
   * 그래서 세대 마커가 애초에 안 바뀌고, 마커만으로 실패가 잡힌다. S7 이 4027ms 를
   * 헤맨 것은 *탐지 가능성* 이 아니라 *탐지 지연* 문제였다 — 그 지연은 여기서 재지 않는다.
   *
   * 워터마크가 실제로 결정적인 경우(마커는 넘어갔는데 음성 신호가 있는 경우)는
   * `tests/conformance/review5-apply-schema.test.ts` 가 본다. 거기서는 뮤턴트가 잡힌다.
   */
  it('bind 못 하는 세대는 실패로 끝나고 좌표가 움직이지 않는다', async () => {
    // 컨테이너 안에서 포트를 점유한다.
    docker('exec', '-d', container, 'sh', '-c', 'nc -l -p 9999 >/dev/null 2>&1');
    await sleep(500);
    makeUnbindableGeneration('gen-bad', 9999);

    const out = runAgent('gen-bad', 'inc-bad', '1');
    expect(field(out, 'PHASE'), out).toBe('failed');
    expect(field(out, 'EPOCH'), '실패했는데 좌표가 움직였다').toBe('0');

    // **다른 이유로 실패한 것이 아님**을 확인한다. 이게 없으면 오타 하나로 실패해도
    // 이 테스트는 통과한다.
    const bindErrors = docker('exec', container, 'sh', '-c',
      "grep -c 'bind()' /prefix/logs/error.log 2>/dev/null || echo 0");
    expect(Number(bindErrors), 'bind 실패가 error log 에 없다 — 다른 이유로 실패했다')
      .toBeGreaterThan(0);
    // 옛 세대를 계속 서빙해야 한다. 실패가 곧 중단이면 안 된다.
    expect(await serving(), '실패했는데 서빙이 멈췄다').toBe('gen-1');
  });

  /**
   * 워터마크는 **신호 시점 기준**이다.
   *
   * 이걸 따로 두는 이유가 있다. error log 가 비어 있으면 "워터마크를 안 찍는다" 는
   * 뮤턴트도 증가분 0 을 내놓아 통과한다 — 앞선 테스트들이 그 구멍을 못 막았다.
   * 기존 로그를 깔아 두면 기준선을 안 잡는 구현이 **그 줄들을 이 전환의 오류로 센다.**
   */
  it('기존 error log 는 이 전환의 오류가 아니다 — 워터마크는 신호 시점 기준이다', async () => {
    writeFileSync(
      join(prefix, 'logs', 'error.log'),
      Array.from({ length: 12 }, (_, i) => `2020/01/01 00:00:00 [warn] 옛 오류 ${i}`).join('\n') + '\n',
      'utf8',
    );

    const out = runAgent('gen-2', 'inc-wm', '1');
    expect(field(out, 'PHASE'), `기존 로그를 이 전환의 오류로 셌다: ${out}`).toBe('activated');
    const evidence = JSON.parse(field(out, 'EVIDENCE') ?? 'null') as { errorLogGrowth?: number } | null;
    expect(evidence?.errorLogGrowth, '기준선을 안 잡았다').toBe(0);
    expect(await waitFor(serving, (g) => g === 'gen-2')).toBe('gen-2');
  });

  it('durable 상태가 **실제 파일**로 남고 다음 프로세스가 이어받는다', async () => {
    runAgent('gen-2', 'inc-4', '1');

    const statePath = join(prefix, 'state', 'agent.json');
    expect(existsSync(statePath), '상태 파일이 없다').toBe(true);
    const saved = JSON.parse(readFileSync(statePath, 'utf8')) as {
      schema: number;
      state: { planes: { http: { activationEpoch: string } } };
    };
    expect(saved.schema).toBe(1);
    expect(saved.state.planes.http.activationEpoch).toBe('1');

    // 새 프로세스가 같은 파일을 열어 다음 세대로 간다. epoch 가 이어져야 한다.
    const next = runAgent('gen-3', 'inc-5', '2');
    expect(field(next, 'PHASE'), next).toBe('activated');
    expect(field(next, 'EPOCH')).toBe('2');
    expect(await waitFor(serving, (g) => g === 'gen-3')).toBe('gen-3');
  });

  it('없는 세대는 게시하지 않는다 — 실행 중인 nginx 를 건드리지 않는다', async () => {
    const out = runAgent('gen-없음', 'inc-6', '1');
    // **무엇으로 실패했는지까지 본다.** PHASE 부재만 보면 번들이 딴 이유로 죽어도 통과한다.
    expect(field(out, 'THREW'), `실패 사유가 없다: ${out}`).toBe('Error');
    expect(field(out, 'PHASE')).toBeUndefined();
    expect(await serving(), '없는 세대를 게시했다').toBe('gen-1');
    expect(docker('exec', container, 'readlink', '/prefix/current')).toBe('generations/gen-1');
  });
});

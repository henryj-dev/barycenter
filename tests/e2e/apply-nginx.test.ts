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

import { DpAgent, MemoryStore, type OperationTuple } from '../../src/dp/agent.js';
import { ApplyRunner, CrashInjected, type Effects, type Phase } from '../../src/dp/apply.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'openresty/openresty:alpine';
const PORT = 18099;

let prefix: string;
let container: string;

const docker = (...args: string[]): string =>
  execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();

/** 세대마다 **다른 리터럴**을 굽는다 — 이게 §6.3 의 활성 세대 마커다. */
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
const effects = (): Effects => ({
  async publish(generation) {
    const dir = `/prefix/generations/${generation}`;
    docker('exec', container, 'sh', '-c',
      `test -f ${dir}/nginx.conf || { echo "세대가 없다: ${dir}" >&2; exit 3; }`);
    // ln + mv -T. mv 는 -T 없이는 목적지 심볼릭 링크를 **따라가** 디렉토리 안으로 옮긴다.
    docker('exec', container, 'sh', '-c',
      `ln -sfn generations/${generation} /prefix/current.tmp && mv -T /prefix/current.tmp /prefix/current`);
  },
  async observePublished() {
    const out = docker('exec', container, 'sh', '-c', 'readlink /prefix/current || true');
    return out.length > 0 ? out.split('/').pop() : undefined;
  },
  async signalReload() {
    docker('kill', '--signal=HUP', container);
  },
  async observeAccepting() {
    return probeAccepting();
  },
});

/** apply 가 옮기는 멤버십 좌표. §3.6 튜플이 저널을 타고 흐른다. */
const OP = (n: string): OperationTuple => ({
  leaderToken: '10',
  operationId: n,
  transitionId: `${n}-t`,
  plane: 'http',
  expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
  target: { activationEpoch: '1', membershipRevision: '1' },
  payloadDigest: `sha256:${n}`,
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
    try {
      docker('rm', '-f', container);
    } catch {
      /* 이미 없으면 그만 */
    }
    rmSync(prefix, { recursive: true, force: true });
  });

  it('기동 직후 gen-1 을 서빙한다', async () => {
    expect(await probeAccepting()).toBe('gen-1');
    expect(await effects().observePublished()).toBe('gen-1');
  });

  it('저널이 실제 nginx 를 gen-2 로 옮긴다', async () => {
    const fx = effects();
    const phase = await new ApplyRunner(new DpAgent(new MemoryStore()), fx).run(OP('e2e-1'), 'gen-2');
    expect(phase).toBe<Phase>('activated');
    expect(await waitAccepting('gen-2')).toBe('gen-2');
  });

  it('게시 직후 죽어도 복구가 이어받는다', async () => {
    const store = new MemoryStore();

    // publish 는 성공하되 reload 직전에 죽는 부작용을 끼운다.
    const fx = effects();
    const crashing = {
      publish: fx.publish.bind(fx),
      observePublished: fx.observePublished.bind(fx),
      observeAccepting: fx.observeAccepting.bind(fx),
      signalReload: async () => {
        throw new CrashInjected('reload 직전');
      },
    };
    await expect(
      new ApplyRunner(new DpAgent(store), crashing).run(OP('e2e-2'), 'gen-2'),
    ).rejects.toBeInstanceOf(CrashInjected);

    // 이 시점: 링크는 gen-2, 실행 중인 nginx 는 아직 gen-1
    expect(await effects().observePublished()).toBe('gen-2');
    expect(await probeAccepting()).toBe('gen-1');

    // 재시작한 Agent 가 이어받는다.
    const phase = await new ApplyRunner(new DpAgent(store), effects()).recover();
    expect(phase).toBe<Phase>('activated');
    expect(await waitAccepting('gen-2')).toBe('gen-2');
  });

  it('이미 반영된 뒤 복구를 다시 돌려도 reload 를 더 보내지 않는다', async () => {
    const store = new MemoryStore();
    let reloads = 0;
    const fx = effects();
    const counted = {
      publish: fx.publish.bind(fx),
      observePublished: fx.observePublished.bind(fx),
      observeAccepting: fx.observeAccepting.bind(fx),
      signalReload: async () => {
        reloads += 1;
        await fx.signalReload();
      },
    };
    await new ApplyRunner(new DpAgent(store), counted).run(OP('e2e-3'), 'gen-2');
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
    await new ApplyRunner(new DpAgent(new MemoryStore()), fx).run(OP('e2e-fwd'), 'gen-2');
    expect(await waitAccepting('gen-2')).toBe('gen-2');

    // gen-3 는 gen-1 과 같은 내용이라고 가정한 clone 이다 (§3.3 — 옛 topology, 새 세대).
    const back = await new ApplyRunner(new DpAgent(new MemoryStore()), fx).run(OP('e2e-back'), 'gen-3');
    expect(back).toBe<Phase>('activated');
    expect(await waitAccepting('gen-3')).toBe('gen-3');
  });

  it('없는 세대는 게시하지 않는다 — 실행 중인 nginx 를 건드리지 않는다', async () => {
    const store = new MemoryStore();
    await expect(
      new ApplyRunner(new DpAgent(store), effects()).run(OP('e2e-4'), 'gen-없음'),
    ).rejects.toThrow();
    expect(await probeAccepting()).toBe('gen-1');
    expect(await effects().observePublished()).toBe('gen-1');
  });
});

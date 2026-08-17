#!/usr/bin/env node
/**
 * `barycenterd` — 컨트롤 플레인 데몬 (DESIGN.md §11.1)
 *
 * 조립만 한다. 정책은 전부 아래 모듈에 있다.
 *
 *   PG ── ConfigStore ──┐
 *                       ├── ControlPlane ── REST API
 *   FileStore + FsEffects ── LocalDataplaneDriver
 *
 * **DP Agent 는 `/etc/barycenter` 의 유일한 writer 이고 DP 와 같은 호스트에 산다**
 * (§3.2 · §11.1). e2e 가 실측했다 — 호스트에서 심볼릭 링크를 바꾸면 컨테이너 안에서
 * 그 링크가 비어 보인다(Docker bind mount 가 링크 교체를 전파 못 한다). 에이전트를
 * 원격에 두는 구성은 애초에 설계에 없다.
 */
import { execFile } from 'node:child_process';
import { existsSync, readFileSync, symlinkSync } from 'node:fs';
import { connect } from 'node:net';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { createApi } from '../api/server.js';
import { TokenAuth, type TokenSpec } from '../api/auth.js';
import { render } from '../conf/render.js';
import { encodeSlots, httpAdminConf, streamAdminConf } from '../control/membership.js';
import { HealthProber } from '../control/health.js';
import { ControlPlane } from '../control/plane.js';
import { LeaderElection } from '../control/leader.js';
import { LocalDataplaneDriver } from '../dp/driver.js';
import { FsEffects } from '../dp/effects-fs.js';
import { materializeGeneration } from '../dp/materialize.js';
import { FileStore } from '../dp/store-fs.js';
import { probeEngine } from '../engine/probe.js';
import { ConfigStore } from '../store/config-store.js';
import { Db } from '../store/pg.js';

const run = promisify(execFile);

const env = (name: string, fallback?: string): string => {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`환경변수 ${name} 이 필요하다`);
};

/**
 * 토큰 명세. **평문은 안 받는다** — `sha256:<hex>` 만.
 *
 * 평문을 받아 주면 그 편의가 곧 기본값이 되고, 설정 파일이 비밀이 된다.
 */
function loadTokens(): TokenSpec[] {
  const raw = process.env['BARY_TOKENS_FILE'] !== undefined
    ? readFileSync(process.env['BARY_TOKENS_FILE'], 'utf8')
    : env('BARY_TOKENS');
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('BARY_TOKENS 는 비어 있지 않은 배열이어야 한다');
  }
  return parsed as TokenSpec[];
}

/** http 평면 admin 에 적재하고 되읽는다. */
async function pushHttp(port: number, epoch: string, body: string): Promise<string> {
  const write = await fetch(`http://127.0.0.1:${port}/membership?epoch=${encodeURIComponent(epoch)}`, {
    method: 'POST', body, signal: AbortSignal.timeout(5000),
  });
  if (!write.ok) throw new Error(`멤버십 적재 실패 (http ${write.status}): ${await write.text()}`);
  const read = await fetch(
    `http://127.0.0.1:${port}/membership/read?epoch=${encodeURIComponent(epoch)}`,
    { signal: AbortSignal.timeout(5000) });
  return (await read.text()).trim();
}

/**
 * stream 평면 admin 과 이야기한다. **원시 TCP 다** — stream 에는 HTTP 가 없고, 두 zone 은
 * 서로 안 보이므로(E14 · E25 · §3.4) http admin 으로 대신 쓸 수도 없다.
 */
function talkStream(port: number, payload: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const s = connect({ host: '127.0.0.1', port });
    s.setTimeout(timeoutMs, () => {
      s.destroy();
      reject(new Error(`stream admin 이 ${timeoutMs}ms 안에 안 답했다`));
    });
    s.on('connect', () => s.end(payload));
    s.on('data', (d: Buffer) => chunks.push(d));
    s.on('close', () => resolve(Buffer.concat(chunks).toString()));
    s.on('error', (e) => reject(e));
  });
}

async function pushStream(port: number, epoch: string, body: string): Promise<string> {
  const wrote = await talkStream(port, `${epoch} write\n${body}\n\n`);
  if (!wrote.startsWith('staged ')) throw new Error(`stream 멤버십 적재 실패: ${wrote.trim()}`);
  return (await talkStream(port, `${epoch} read\n`)).trim();
}

/**
 * 부트스트랩 세대를 **우리가 만든다** (`--write-bootstrap`).
 *
 * §6.5-1 은 멤버십을 **HUP 전에** 적재하라고 한다. 그런데 그 시점에 돌고 있는 설정은 아직
 * **옛 세대**다 — 슬롯이 사는 `lua_shared_dict` 와 그걸 쓰는 admin 엔드포인트가 *옛 세대에
 * 이미 있어야* 적재할 곳이 있다. 첫 apply 에서 그 옛 세대가 부트스트랩이다.
 *
 * 운영자가 손으로 쓴 conf 에 그걸 기대할 수 없다 — **모양이 엔진 capability 에 따라
 * 달라지기 때문이다.** 그래서 데몬이 만든다. conf 를 만드는 자리가 하나로 유지된다.
 *
 * 이미 `current` 가 있으면 손대지 않는다. 재기동이 활성 세대를 되돌리면 안 된다.
 */
function writeBootstrap(prefix: string, adminPort: number, streamAdminPort: number): void {
  const link = join(prefix, 'current');
  if (existsSync(link)) {
    console.log('current 가 이미 있다 — 부트스트랩을 건드리지 않는다');
    return;
  }
  const probe = probeEngine(env('BARY_ENGINE_BIN', '/usr/local/openresty/bin/openresty'));
  const caps = probe.ok
    ? {
        streamRealip: probe.capabilities.supports.streamRealip,
        httpLua: probe.capabilities.supports.runtimeMembership.http,
        streamLua: probe.capabilities.supports.runtimeMembership.stream,
      }
    : { streamRealip: false };

  // **빈 모델이다.** 아직 아무것도 커밋되지 않았다 — 리스너가 없으니 트래픽 표면도 없고
  // admin 만 선다. 멤버십 dict 는 capability 가 있으면 여기서 이미 선언된다.
  const empty = { listeners: [], httpRoutes: [], passthroughRoutes: [], pools: [], backends: [] };
  const rendered = render(empty, caps);
  materializeGeneration({
    prefix,
    generation: 'bootstrap',
    planes: rendered.planes,
    files: {
      'nginx.conf': rendered.conf,
      // epoch 은 "0" 이다 — 부트스트랩은 어떤 활성화에도 속하지 않는다. 마커가 답하는
      // 세대 이름도 `bootstrap` 이라 어떤 오퍼레이션의 목표와도 다르다(거짓 양성 없음).
      'admin/marker.conf': httpAdminConf('bootstrap', '0', adminPort),
      ...(caps.streamLua === true
        ? { 'stream-admin/membership.conf': streamAdminConf('0', streamAdminPort) }
        : {}),
    },
  });
  symlinkSync('generations/bootstrap', link);
  console.log(`부트스트랩 세대를 만들었다 (멤버십 dict=${caps.httpLua === true})`);
}

export async function main(): Promise<void> {
  const prefix = env('BARY_PREFIX', '/etc/barycenter');
  const adminPort = Number(env('BARY_ADMIN_PORT', '19999'));
  const [host, port] = env('BARY_LISTEN', '127.0.0.1:8088').split(':');
  const streamAdminPort = Number(env('BARY_STREAM_ADMIN_PORT', String(adminPort + 1)));

  if (process.argv.includes('--write-bootstrap')) {
    writeBootstrap(prefix, adminPort, streamAdminPort);
    return;
  }

  const dsn = env('BARY_DSN');
  const db = new Db(dsn);
  const applied = await db.migrate();
  if (applied.length > 0) console.log(`마이그레이션 적용: ${applied.join(', ')}`);

  // ── 엔진 capability (§7.6) ───────────────────────────────────────────
  //
  // **못 물어보면 보수적으로 간다.** 다만 조용히 넘어가지 않는다 — 그렇게 두면 "왜 이
  // 조합이 막히지" 에 아무도 답할 수 없다. PROXY 신뢰 경계를 넣은 뒤로 stream 수신이
  // 엔진과 무관하게 막혔던 것이 정확히 그 상태였다.
  const probe = probeEngine(env('BARY_ENGINE_BIN', '/usr/local/openresty/bin/openresty'));
  const renderCaps = probe.ok
    ? {
        streamRealip: probe.capabilities.supports.streamRealip,
        // **멤버십 평면의 전제**다 (§7.3 · S1). `runtimeMembership` 이 lua 모듈 유무를
        // 평면별로 이미 접어 준다 — 여기서 다시 계산하면 두 자리가 갈린다.
        httpLua: probe.capabilities.supports.runtimeMembership.http,
        streamLua: probe.capabilities.supports.runtimeMembership.stream,
      }
    : { streamRealip: false };
  const engineInfo = probe.ok
    ? {
        probed: true, via: probe.via,
        flavor: probe.capabilities.flavor, version: probe.capabilities.version,
        supports: probe.capabilities.supports,
      }
    : { probed: false, reason: probe.reason };
  console.log(probe.ok
    ? `엔진: ${probe.capabilities.flavor} ${probe.capabilities.version} `
      + `(stream_realip=${probe.capabilities.supports.streamRealip}, `
      + `멤버십 평면 http=${probe.capabilities.supports.runtimeMembership.http} `
      + `stream=${probe.capabilities.supports.runtimeMembership.stream})`
    : `엔진 조회 실패 — 보수적으로 간다: ${probe.reason}`);

  const store = new ConfigStore(db, renderCaps);

  /**
   * 멤버십 슬롯을 데이터 플레인에 밀어 넣는다 (§6.5).
   *
   * **쓰고 나서 되읽어 대조한다.** `nginx -t` 는 Lua 를 하나도 검증하지 않으므로(E64)
   * admin 조각이 깨져 있어도 게시 전 검사와 활성화 판정을 그대로 통과한다. 되읽기가
   * 그 경로가 살아 있다는 유일한 증거다.
   */
  const pushMembership = async (
    plane: 'http' | 'stream', epoch: string, slots: Record<string, string[]>,
  ): Promise<void> => {
    const want = encodeSlots(slots);
    const got = plane === 'http'
      ? await pushHttp(adminPort, epoch, want)
      : await pushStream(streamAdminPort, epoch, want);
    if (got !== want) {
      throw new Error(
        `멤버십 적재를 되읽었더니 다르다 (${plane}, epoch ${epoch}).\n`
        + `  보낸 것: ${JSON.stringify(want)}\n  읽은 것: ${JSON.stringify(got)}`);
    }
  };

  const effects = new FsEffects({
    prefix,
    pushMembership,
    reload: async () => {
      // **실패는 진짜 실패다.** 여기서 삼키면 활성화 판정이 타임아웃까지 늘어진다.
      const cmd = process.env['BARY_RELOAD_CMD'];
      if (cmd !== undefined) {
        await run('/bin/sh', ['-c', cmd]);
        return;
      }
      const pid = readFileSync(`${prefix}/logs/nginx.pid`, 'utf8').trim();
      process.kill(Number(pid), 'SIGHUP');
    },
    // §6.3-4 — 세대에 **구워진 리터럴**을 읽는다. 이게 활성화의 양성 신호다.
    probeAccepting: async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${adminPort}/generation`, {
          signal: AbortSignal.timeout(2000),
        });
        return r.ok ? (await r.text()).trim() : undefined;
      } catch {
        return undefined;
      }
    },
    // 게시 전 `nginx -t`. 없으면 manifest 대조만 하고 넘어간다 — 못 본 것과 실패한 것은
    // 다르므로 막지는 않되, 그만큼 늦게 발견한다.
    ...(process.env['BARY_CONFIGTEST_CMD'] === undefined ? {} : {
      configTest: async (generation: string): Promise<boolean> => {
        try {
          await run('/bin/sh', ['-c',
            (process.env['BARY_CONFIGTEST_CMD'] ?? '').replace(/\{generation\}/g, generation)]);
          return true;
        } catch {
          return false;
        }
      },
    }),
  });

  const driver = LocalDataplaneDriver.create({
    store: FileStore.open(`${prefix}/state/agent.json`),
    effects,
  });

  // ── 리더 선출 (§3.5) ────────────────────────────────────────────────
  //
  // **못 되면 죽지 않는다.** 스탠바이는 읽기로 서비스하면서 기다린다 — §11.4 의 콜드
  // 스탠바이가 그 모양이다. 죽어 버리면 오케스트레이터가 재시작 루프를 돌고, 그건
  // "리더가 아니다" 가 아니라 "고장" 으로 보인다.
  const election = new LeaderElection(dsn, env('BARY_NODE_NAME', `${hostname()}:${port}`));
  const became = await election.tryAcquire();

  if (became) {
    // §3.5 — **어떤 operation 보다 먼저** 펜싱을 끝낸다. 이게 ACK 되기 전에 낸 변이는
    // 전부 거부된다.
    const token = election.assertLeader();
    const fenced = await driver.fence(token);
    console.log(`리더가 됐다: token=${token} (DP maxToken=${fenced.maxToken})`);
  } else {
    console.log(`스탠바이로 뜬다 — ${election.state.reason}. 읽기만 답한다.`);
  }

  // 리더가 아니면 주기적으로 다시 시도한다. 앞선 리더가 죽으면 락이 풀린다.
  const retry = setInterval(() => {
    if (election.state.isLeader) return;
    void election.tryAcquire().then(async (got) => {
      if (!got) return;
      const token = election.assertLeader();
      const fenced = await driver.fence(token);
      console.log(`리더로 승격됐다: token=${token} (DP maxToken=${fenced.maxToken})`);
    }).catch((e: unknown) => {
      console.error(`승격 시도 실패: ${String(e)}`);
    });
  }, Number(env('BARY_ELECTION_INTERVAL_MS', '5000')));
  retry.unref();

  const control = new ControlPlane(db, store, driver, election,
    { prefix, adminPort, streamAdminPort, renderCaps, engine: engineInfo });

  // **기동 시 멤버십을 되돌려 놓는다** (§6.4). shared dict 는 프로세스 수명이라 엔진이
  // 재시작하면 슬롯이 통째로 빈다 — 설정은 멀쩡한데 트래픽이 전부 죽는다.
  if (election.state.isLeader) {
    const restaged = await control.restageMembership().catch((e: unknown) => {
      console.error(`멤버십 재적재 실패: ${String(e)}`);
      return undefined;
    });
    if (restaged !== undefined) {
      console.log(`멤버십 재적재: epoch ${restaged.epoch} [${restaged.planes.join(',')}]`);
    }
  }
  /**
   * 헬스 프로버 (§6.5 · §6.6).
   *
   * **리더만 돈다.** 스탠바이가 함께 찌르면 백엔드가 두 배로 맞고, 무엇보다 두 리듀서가
   * 같은 슬롯을 서로 다른 관측으로 덮는다 — §6.6 이 *단일 리듀서*를 요구한 이유다.
   *
   * 멤버십 평면이 없는 배포에서는 안 돈다. 헬스를 알아도 **반영할 곳이 없기 때문이다** —
   * 정적 `server` 줄은 세대 전환으로만 바뀐다. 판정만 쌓고 못 쓰는 것보다 안 하는 편이
   * 정직하다.
   */
  const proberOn = renderCaps.httpLua === true || renderCaps.streamLua === true;
  const prober = new HealthProber(db, {
    intervalMs: Number(env('BARY_PROBE_INTERVAL_MS', '2000')),
    timeoutMs: Number(env('BARY_PROBE_TIMEOUT_MS', '1000')),
    failThreshold: Number(env('BARY_PROBE_FAIL_THRESHOLD', '2')),
    riseThreshold: Number(env('BARY_PROBE_RISE_THRESHOLD', '1')),
  });
  if (proberOn) {
    prober.start(
      async () => (election.state.isLeader ? control.headModel() : undefined),
      async () => {
        const out = await control.projectHealth();
        if (out !== undefined) {
          console.log(`헬스 반영: epoch [${out.epochs.join(',')}] 평면 [${out.planes.join(',')}]`);
        }
      },
    );
    console.log(`헬스 프로버 시작 (주기 ${env('BARY_PROBE_INTERVAL_MS', '2000')}ms)`);
  } else {
    console.log('헬스 프로버 없음 — 멤버십 평면이 꺼진 배포다 (반영할 곳이 없다)');
  }

  const auth = new TokenAuth(loadTokens());

  const server = createApi({ db, store, control, auth, election });
  await new Promise<void>((resolve) => {
    server.listen(Number(port), host, resolve);
  });
  console.log(`barycenterd: http://${host}:${port}  prefix=${prefix}  admin=:${adminPort}  토큰 ${auth.size}개`);

  const stop = (): void => {
    server.close(() => {
      // **물러난 것을 적고 나간다.** 락은 세션 종료로 어차피 풀리지만, 깨끗하게 물러난
      // 것과 죽은 것을 나중에 구분할 수 있어야 한다.
      prober.stop();
      void election.release()
        .then(() => db.close())
        .then(() => process.exit(0));
    });
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

// 진입점으로 실행됐을 때만 돈다 — 테스트가 import 할 수 있어야 한다.
if (process.argv[1]?.endsWith('barycenterd.ts') === true
  || process.argv[1]?.endsWith('barycenterd.js') === true) {
  main().catch((e: unknown) => {
    console.error(`기동 실패: ${String(e)}`);
    process.exit(1);
  });
}

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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { createApi } from '../api/server.js';
import { EventHub } from '../api/events.js';
import { FsSecretStore } from '../dp/secrets.js';
import {
  TokenAuth, oidcKeyFrom, parseTokenSpecs, type OidcSettings, type TokenSpec,
} from '../api/auth.js';
import type { OidcRpSettings } from '../api/oidc-code.js';
import { render } from '../conf/render.js';
import { encodeSlots, httpAdminConf, resolveSlots, streamAdminConf } from '../control/membership.js';
import { HealthProber } from '../control/health.js';
import { AcmeStore } from '../control/acme-store.js';
import { AcmeRunner, HttpChallengePlacer } from '../control/acme-runner.js';
import { FileDns01 } from '../control/dns01.js';
import { publishIssued } from '../control/acme-publish.js';
import { collectSecretRoots, expandVersionRoots } from '../control/secret-roots.js';
import { sweepSecrets } from '../dp/secret-gc.js';
import { ControlPlane } from '../control/plane.js';
import { LeaderElection } from '../control/leader.js';
import { bootDrivers, readDriverBootSource } from '../dp/boot.js';
import { LocalDataplaneDriver } from '../dp/driver.js';
import { FsEffects } from '../dp/effects-fs.js';
import { materializeGeneration } from '../dp/materialize.js';
import { FileStore } from '../dp/store-fs.js';
import { log } from '../obs/log.js';
import { count } from '../obs/metrics.js';
import { dataplaneCapabilitiesOf } from '../engine/native-dns.js';
import { probeEngine } from '../engine/probe.js';
import { renderCapsOf } from '../engine/render-caps.js';
import { DEFAULT_HEALTH_EVENT_DAYS, sweepDatabase } from '../store/db-retention.js';
import { ConfigStore } from '../store/config-store.js';
import { Db } from '../store/pg.js';
import { isLoopbackBind } from '../validate/sockets.js';

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
  // **캐스팅하지 않는다.** `role` 오타 하나가 전권 토큰이 되던 자리다 (검수 S-03) —
  // 해독은 `parseTokenSpecs` 가 한다. 모델 경계와 같은 규칙이다.
  return parseTokenSpecs(JSON.parse(raw));
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
    log.info('bootstrap.skipped', { reason: 'current 가 이미 있다' });
    return;
  }
  const probe = probeEngine(env('BARY_ENGINE_BIN', '/usr/local/openresty/bin/openresty'));
  const caps = renderCapsOf(probe);

  // **빈 모델이다.** 아직 아무것도 커밋되지 않았다 — 리스너가 없으니 트래픽 표면도 없고
  // admin 만 선다. 멤버십 dict 는 capability 가 있으면 여기서 이미 선언된다.
  const empty = { listeners: [], httpRoutes: [], passthroughRoutes: [], pools: [], backends: [],
    certificates: [], tlsPolicies: [], sniBindings: [] };
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
  log.info('bootstrap.written', { membershipDict: caps.httpLua === true });
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
  if (applied.length > 0) log.info('migrate.applied', { migrations: applied });

  // ── 엔진 capability (§7.6) ───────────────────────────────────────────
  //
  // **못 물어보면 보수적으로 간다.** 다만 조용히 넘어가지 않는다 — 그렇게 두면 "왜 이
  // 조합이 막히지" 에 아무도 답할 수 없다. PROXY 신뢰 경계를 넣은 뒤로 stream 수신이
  // 엔진과 무관하게 막혔던 것이 정확히 그 상태였다.
  const probe = probeEngine(env('BARY_ENGINE_BIN', '/usr/local/openresty/bin/openresty'));
  // **매핑은 `renderCapsOf` 한 자리에만 있다** (검수 B-02). 여기 인라인으로 적었다가
  // `writeBootstrap` 쪽과 갈렸고, 그 결과가 "엔진이 지원해도 HTTP/2 가 안 켜진다" 였다.
  const renderCaps = renderCapsOf(probe);
  const nativeDns = probe.ok
    ? dataplaneCapabilitiesOf(probe.capabilities).nativeDns
    : undefined;
  const engineInfo = probe.ok
    ? {
        probed: true, via: probe.via,
        flavor: probe.capabilities.flavor, version: probe.capabilities.version,
        supports: probe.capabilities.supports,
        nativeDns,
      }
    : { probed: false, reason: probe.reason };
  if (probe.ok) {
    log.info('engine.probed', {
      flavor: probe.capabilities.flavor, version: probe.capabilities.version,
      // **엔진이 무엇을 할 수 있는가가 아니라, 렌더러가 무엇을 받았는가를 찍는다.**
      // 둘이 갈렸던 것이 B-02 였고, 갈린 쪽을 안 찍고 있어서 아무도 못 봤다.
      caps: renderCaps,
      nativeDns,
    });
  } else {
    log.warn('engine.probe_failed', { reason: probe.reason, assuming: 'conservative' });
  }

  // 핀이 없으면 설정 평면은 지금처럼 LocalDataplaneDriver 만. 핀이 있으면
  // capability 패키지를 기동에서 집어넣는다. apply 경로를 갈아 끼우지 않는다.
  const driverBoot = await bootDrivers(readDriverBootSource(process.env));
  if (driverBoot.loaded) {
    log.info('driver.loaded', { name: driverBoot.name, nativeDns: driverBoot.capabilities.nativeDns });
  }

  /**
   * 인증서 자료 저장소 (§4.8).
   *
   * **평문 파일이다.** 보호는 파일 권한과 "메인 DB 가 아니다" 뿐이고 암호화가 아니다 —
   * KMS·Vault 드라이버는 같은 인터페이스 뒤에 따로 붙는다. 지금 없는 것을 있다고
   * 적지 않는다.
   *
   * `ConfigStore` 보다 먼저 만든다 — 저장소가 SAN 커버리지를 보려면 사실을 읽을 창구가
   * 있어야 한다 (검수 B-05).
   */
  const secretsRoot = env('BARY_SECRETS', `${prefix}/secrets`);
  const secrets = new FsSecretStore(secretsRoot);

  // **사실 창구를 넘긴다** (검수 B-05). 안 넘기면 바인딩된 인증서가 그 호스트를
  // 덮는지 아무도 안 본다 — `certCoversHost` 가 구현돼 있는데 호출자가 없었다.
  const store = new ConfigStore(db, renderCaps, secrets);

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
    const want = encodeSlots(await resolveSlots(slots));
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

  // **핸들을 들고 있는다.** 종료할 때 놓아야 다음 기동이 즉시 열린다 (검수 B-16) —
  // 안 놓으면 죽은 주인을 가려내는 `/proc` 폴백에 기대게 되고, 그 파일을 못 읽는
  // 플랫폼에서는 "살아 있는 쪽으로" 틀려 pid 재사용 때 기동이 막힌다.
  const agentStore = FileStore.open(`${prefix}/state/agent.json`);
  const driver = LocalDataplaneDriver.create({
    store: agentStore,
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
    log.info('leader.acquired', { token, dpMaxToken: fenced.maxToken });
  } else {
    log.info('leader.standby', { reason: election.state.reason });
  }

  // 리더가 아니면 주기적으로 다시 시도한다. 앞선 리더가 죽으면 락이 풀린다.
  const retry = setInterval(() => {
    if (election.state.isLeader) return;
    void election.tryAcquire().then(async (got) => {
      if (!got) return;
      const token = election.assertLeader();
      const fenced = await driver.fence(token);
      log.info('leader.promoted', { token, dpMaxToken: fenced.maxToken });
    }).catch((e: unknown) => {
      log.error('leader.promote_failed', { error: String(e) });
    });
  }, Number(env('BARY_ELECTION_INTERVAL_MS', '5000')));
  retry.unref();

  const control = new ControlPlane(db, store, driver, election,
    { prefix, adminPort, streamAdminPort, renderCaps, engine: engineInfo, driver: driverBoot, secrets });

  // **기동 시 멤버십을 되돌려 놓는다** (§6.4). shared dict 는 프로세스 수명이라 엔진이
  // 재시작하면 슬롯이 통째로 빈다 — 설정은 멀쩡한데 트래픽이 전부 죽는다.
  if (election.state.isLeader) {
    const restaged = await control.restageMembership().catch((e: unknown) => {
      log.error('membership.restage_failed', { error: String(e) });
      return undefined;
    });
    if (restaged !== undefined) {
      log.info('membership.restaged', { epoch: restaged.epoch, planes: restaged.planes });
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
  const events = new EventHub();
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
      async (flips) => {
        count('bary_health_transition_total');
        for (const flip of flips) events.publish('health', flip);
        const out = await control.projectHealth();
        if (out !== undefined) {
          log.info('health.projected', { epochs: out.epochs, planes: out.planes });
        }
      },
    );
    log.info('prober.started', { intervalMs: Number(env('BARY_PROBE_INTERVAL_MS', '2000')) });
  } else {
    log.info('prober.disabled', { reason: '멤버십 평면이 꺼진 배포 — 반영할 곳이 없다' });
  }

  /**
   * **DB 보존** (검수 B-08 · 제안#10).
   *
   * 세대는 상한이 있고(`dp/retention.ts`) 시크릿도 뒤늦게 얻었는데(`dp/secret-gc.ts`)
   * DB 는 없었다. `health_events` 와 `audit` 은 삽입만 있고 지우는 코드가 없다.
   *
   * **ACME 와 무관하게 돈다.** 시크릿 청소는 `acmeOn` 안에 사는데, 그건 자동 갱신이
   * 만드는 쓰레기를 치우는 것이라 그렇다. 이 둘은 ACME 를 안 켠 배포에서도 자란다.
   *
   * **리더만.** 여러 노드가 동시에 밀면 서로의 잠금을 기다리기만 한다.
   */
  const auditDaysRaw = env('BARY_AUDIT_RETENTION_DAYS', '');
  const dbRetention = {
    healthEventDays: Number(env('BARY_HEALTH_EVENT_RETENTION_DAYS', String(DEFAULT_HEALTH_EVENT_DAYS))),
    // 빈 값은 **무한 보존**이다. 감사 추적의 보존 기간은 우리가 정할 것이 아니라
    // 운영자가 정하는 것이고, 기본값으로 지우면 업그레이드가 곧 데이터 소실이다.
    ...(auditDaysRaw === '' ? {} : { auditDays: Number(auditDaysRaw) }),
  };
  const dbRetentionTimer = setInterval(() => {
    void (async (): Promise<void> => {
      if (!election.state.isLeader) return;
      try {
        const out = await sweepDatabase({ db, ...dbRetention });
        if (out.healthEvents > 0 || out.audit > 0) log.info('db.swept', out);
      } catch (e) {
        log.error('db.sweep_failed', { error: (e as Error).message });
      }
    })();
  }, Number(env('BARY_DB_RETENTION_INTERVAL_MS', '3600000')));
  dbRetentionTimer.unref?.();
  const stopDbRetention = (): void => clearInterval(dbRetentionTimer);

  /**
   * ACME 갱신 러너 (§8.2 · ADR-ACME).
   *
   * **`httpLua` 가 있어야 돈다.** 챌린지는 shared dict 에서 서빙되고(ADR-ACME ①), 그게
   * 없으면 토큰을 conf 에 실어야 한다 — 갱신 한 번에 세대 전환 한 번이고 그 대가는
   * 실측돼 있다(트래픽 2.6%). **없는 경로를 있는 척하지 않는다.**
   *
   * **리더만 돈다.** 스탠바이가 함께 주문하면 nonce 가 서로를 깨뜨린다.
   */
  const acmeOn = renderCaps.httpLua === true && env('BARY_ACME', '1') !== '0';
  let stopPublish = (): void => {};
  let stopSecretGc = (): void => {};
  const acmeStore = new AcmeStore(db);
  const dnsDir = env('BARY_DNS01_DIR', '');
  const acmeRunner = new AcmeRunner({
    store: acmeStore,
    secrets,
    placer: new HttpChallengePlacer(adminPort),
    ...(dnsDir === '' ? {} : { dnsPlacer: new FileDns01(dnsDir) }),
    renewBeforeDays: Number(env('BARY_ACME_RENEW_DAYS', '30')),
  });
  if (acmeOn) {
    acmeRunner.start(
      Number(env('BARY_ACME_INTERVAL_MS', '30000')),
      () => election.state.isLeader,
      async () => {
        // 인증서 목록은 **head 리비전**에서 온다 — 의도는 설정이고, 주문만 운영 상태다.
        const head = await store.head();
        const model = await store.modelAt(head.revision);
        const ids = new Map((await db.query('SELECT id, key FROM certificates')).rows
          .map((r) => [String(r['key']), String(r['id'])]));
        return model.certificates.flatMap((c) => {
          const id = ids.get(c.key);
          if (id === undefined) return [];
          return [{
            key: c.key, id,
            ...(c.materialRef === undefined ? {} : { materialRef: c.materialRef }),
            ...(c.acme === undefined ? {} : { acme: c.acme }),
          }];
        });
      },
    );
    /**
     * **발급된 것을 설정에 반영한다** (ADR-ACME ⑥).
     *
     * 러너와 별도 타이머다 — 러너 틱이 CA 를 기다리는 동안 게시가 막히면, 이미 받은
     * 인증서가 nginx 에 안 간 채로 남는다.
     *
     * ⚠️ **자동 활성화는 세대 전환을 부른다** (전환당 트래픽 2.6%, 소크 실측). 인증서
     * 경로에 버전이 들어가므로(§7.2) 교체가 렌더 산출물을 바꾸기 때문이고, nginx 가 새
     * 파일을 읽으려면 reload 가 필요하다. `BARY_ACME_AUTOAPPLY=0` 이면 커밋까지만 한다.
     */
    const publishTimer = setInterval(() => {
      void (async (): Promise<void> => {
        if (!election.state.isLeader) return;
        try {
          await publishIssued({
            db, store, control, acme: acmeStore, secrets,
            applyAutomatically: env('BARY_ACME_AUTOAPPLY', '1') !== '0',
          });
        } catch (e) {
          log.error('acme.publish.tick_failed', { error: (e as Error).message });
        }
      })();
    }, Number(env('BARY_ACME_PUBLISH_INTERVAL_MS', '15000')));
    publishTimer.unref?.();
    stopPublish = () => clearInterval(publishTimer);

    /**
     * **시크릿 청소** (§8.3 · §8.4).
     *
     * 자동 갱신은 새 버전을 만들 뿐 옛 것을 안 덮는다. 인증서 하나가 90 일마다 버전
     * 하나씩 쌓고, **그 버전들은 개인키를 담고 있다.** 세대는 이미 상한이 있는데
     * (`retention.ts`) 시크릿은 없었다 — 자동화가 부채를 스스로 채우기 시작한 것이다.
     *
     * ⚠️ root 를 하나라도 놓치면 **살아 있는 개인키를 지운다.** 그 증상은 S8 이
     * 실측했다: 열린 fd 로 트래픽은 계속 흐르고 **다음 reload 가 깨진다.** 그래서
     * 남기는 쪽으로 틀린다 — 이름당 안전망과 최소 나이가 그 장치다.
     */
    const secretGcTimer = setInterval(() => {
      void (async (): Promise<void> => {
        if (!election.state.isLeader) return;
        try {
          const raw = await collectSecretRoots({ db, prefix });
          const all = [...raw].filter((r) => !r.startsWith('@'));
          const roots = expandVersionRoots(raw, all);
          const out = sweepSecrets({ root: secretsRoot, roots });
          if (out.removed.length > 0 || out.failed.length > 0) {
            log.info('secrets.swept', {
              removed: out.removed.length, kept: out.kept.length,
              failed: out.failed.length,
            });
          }
        } catch (e) {
          log.error('secrets.sweep_failed', { error: (e as Error).message });
        }
      })();
    }, Number(env('BARY_SECRET_GC_INTERVAL_MS', '3600000')));
    secretGcTimer.unref?.();
    const stopSecretGcTimer = (): void => clearInterval(secretGcTimer);
    stopSecretGc = stopSecretGcTimer;

    log.info('acme.started', {
      intervalMs: Number(env('BARY_ACME_INTERVAL_MS', '30000')),
      renewBeforeDays: Number(env('BARY_ACME_RENEW_DAYS', '30')),
      autoApply: env('BARY_ACME_AUTOAPPLY', '1') !== '0',
    });
  } else {
    log.info('acme.disabled', {
      reason: renderCaps.httpLua === true ? 'BARY_ACME=0' : '엔진에 http lua 가 없다 — 챌린지를 서빙할 곳이 없다',
    });
  }

  const oidcIss = env('BARY_OIDC_ISSUER', '');
  const oidcAud = env('BARY_OIDC_AUD', '');
  /**
   * 검증 키 (검수 S-06).
   *
   * 전에는 `BARY_OIDC_KEY` 문자열만 있었고, 문자열은 HS256 으로만 검증된다 —
   * **RS256 경로가 프로덕션에서 도달 불가였다.** 실물 IdP 는 거의 다 RS256 이다.
   *
   * 파일 쪽을 따로 두는 이유: PEM 은 여러 줄이라 환경변수에 넣으면 줄바꿈이
   * 배포 도구마다 다르게 망가진다. 그래도 인라인 PEM 을 막지는 않는다 —
   * `oidcKeyFrom` 이 접두사로 가른다.
   */
  const oidcKeyFile = env('BARY_OIDC_KEY_FILE', '');
  const oidcKey = oidcKeyFile !== '' ? readFileSync(oidcKeyFile, 'utf8') : env('BARY_OIDC_KEY', '');
  // 어느 클레임이 역할인지는 **배포가 정한다** (검수 S-07). 안 정하면 `role`.
  const oidcRoleClaim = env('BARY_OIDC_ROLE_CLAIM', '');
  const oidc: OidcSettings | undefined = oidcIss !== '' && oidcAud !== '' && oidcKey !== ''
    ? {
        issuer: oidcIss,
        audience: oidcAud,
        key: oidcKeyFrom(oidcKey),
        ...(oidcRoleClaim === '' ? {} : { roleClaim: oidcRoleClaim }),
      }
    : undefined;
  const auth = oidc === undefined ? new TokenAuth(loadTokens()) : new TokenAuth(loadTokens(), oidc);
  const oidcAuthz = env('BARY_OIDC_AUTHORIZATION', '');
  const oidcToken = env('BARY_OIDC_TOKEN', '');
  const oidcClient = env('BARY_OIDC_CLIENT_ID', '');
  const oidcRedirect = env('BARY_OIDC_REDIRECT_URI', '');
  const oidcSecret = env('BARY_OIDC_CLIENT_SECRET', '');
  const oidcRp: OidcRpSettings | undefined = oidc !== undefined
    && oidcAuthz !== '' && oidcToken !== '' && oidcClient !== '' && oidcRedirect !== ''
    ? {
        ...oidc,
        authorizationEndpoint: oidcAuthz,
        tokenEndpoint: oidcToken,
        clientId: oidcClient,
        redirectUri: oidcRedirect,
        ...(oidcSecret === '' ? {} : { clientSecret: oidcSecret }),
      }
    : undefined;

  const explicitGui = process.env['BARY_GUI'];
  const guiRoot = explicitGui !== undefined && explicitGui !== ''
    ? explicitGui
    : join(dirname(fileURLToPath(import.meta.url)), '../../gui/build');
  if (explicitGui !== undefined && explicitGui !== '' && !existsSync(guiRoot)) {
    throw new Error(`BARY_GUI (${guiRoot}) 가 없다`);
  }
  const serveRoot = existsSync(guiRoot) ? guiRoot : undefined;

  const server = createApi({
    db, store, control, auth, election, secrets, events,
    ...(serveRoot === undefined ? {} : { guiRoot: serveRoot }),
    ...(oidcRp === undefined ? {} : { oidcRp }),
  });
  await new Promise<void>((resolve) => {
    server.listen(Number(port), host, resolve);
  });
  log.info('listening', {
    host, port: Number(port), prefix, adminPort, tokens: auth.size,
    gui: serveRoot ?? false,
  });
  /**
   * **루프백 밖에 묶었으면 말한다** (검수 S-05a).
   *
   * 이 API 로 개인키 PEM 이 본문에 담겨 올라가고 Bearer 토큰이 매 요청에 실린다.
   * 그런데 TLS 가 없다. 컨테이너에서는 `0.0.0.0` 이 **필요한** 값이라(포트 퍼블리시가
   * 루프백 바인드에 닿지 못한다) 막을 수는 없다 — 대신 드러낸다.
   *
   * 진짜 답은 서버 TLS 이고 그건 별건이다. 그때까지 이 줄이 자리를 지킨다.
   */
  if (!isLoopbackBind(host ?? '')) {
    log.warn('listen.exposed', {
      host,
      why: '제어 API 에 TLS 가 없다 — 개인키와 토큰이 평문으로 지나간다',
      advice: '앞단에서 TLS 를 종단하거나 루프백에만 퍼블리시하라',
    });
  }

  const stop = (): void => {
    server.close(() => {
      // **물러난 것을 적고 나간다.** 락은 세션 종료로 어차피 풀리지만, 깨끗하게 물러난
      // 것과 죽은 것을 나중에 구분할 수 있어야 한다.
      prober.stop();
      acmeRunner.stop();
      stopPublish();
      stopSecretGc();
      stopDbRetention();
      // **durable store 의 락도 놓는다** (검수 B-16). 안 놓으면 다음 기동이 죽은
      // 주인을 가려내는 `/proc` 폴백에 기댄다 — 그 파일을 못 읽는 플랫폼에서는
      // `stillHolding` 이 안전한 쪽(살아 있다)으로 틀려 기동이 막힌다.
      // 던지더라도 종료는 계속한다. 나가는 길에 못 적는 것이 나가지 못하는 것보다 낫다.
      try {
        agentStore.release();
      } catch (e) {
        log.warn('agent_store.release_failed', { error: String(e) });
      }
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
    log.error('startup.failed', { error: String(e) });
    process.exit(1);
  });
}

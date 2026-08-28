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
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { createServer as createHttpsServer } from 'node:https';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { apiHandler, apiTlsOptions, createApi } from '../api/server.js';
import { JwksCache } from '../api/jwks.js';
import { EventHub } from '../api/events.js';
import { FsSecretStore, type SecretStore } from '../dp/secrets.js';
import { PgSecretStore, readKek } from '../dp/secrets-pg.js';
import {
  TokenAuth, oidcKeyFrom, parseTokenSpecs, type OidcSettings, type TokenSpec,
} from '../api/auth.js';
import type { OidcRpSettings } from '../api/oidc-code.js';
import { render } from '../conf/render.js';
import { adminFetch, adminTalk, clearStaleSockets } from '../control/admin-client.js';
import { httpAdminConf, streamAdminConf } from '../control/membership.js';
import { HealthProber } from '../control/health.js';
import { AcmeStore } from '../control/acme-store.js';
import { AcmeRunner, HttpChallengePlacer } from '../control/acme-runner.js';
import { FileDns01 } from '../control/dns01.js';
import { publishIssued } from '../control/acme-publish.js';
import { collectSecretRoots } from '../control/secret-roots.js';
import { sweepSecrets } from '../dp/secret-gc.js';
import { sweepSecretsPg } from '../dp/secret-gc-pg.js';
import { ControlPlane, defaultStreamSocket } from '../control/plane.js';
import { LeaderElection } from '../control/leader.js';
import { bootDrivers, readDriverBootSource } from '../dp/boot.js';
import { LocalDataplaneDriver, type DataplaneDriver } from '../dp/driver.js';
import { RemoteDataplaneDriver } from '../dp/remote.js';
import { bootEffects } from '../dp/effects-boot.js';
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
import { envBool, envInt, envIntOpt } from '../validate/env.js';
import { isLoopbackBind, parseListen } from '../validate/sockets.js';

const run = promisify(execFile);

const env = (name: string, fallback?: string): string => {
  const v = process.env[name];
  if (v !== undefined && v !== '') return v;
  if (fallback !== undefined) return fallback;
  throw new Error(`환경변수 ${name} 이 필요하다`);
};

const MINUTE = 60_000;
const DAY_MS = 86_400_000;

/**
 * 종료 마감 (검수 D9). `bary-dp-agent` 의 5 초보다 넉넉하다 — 이쪽은 락 반납과
 * DB 닫기가 더 있고, 그 둘은 망을 지난다.
 */
const SHUTDOWN_DEADLINE_MS = 10_000;

export function plaintextExposureError(
  host: string, tlsOn: boolean, allowPlaintextExposed: boolean,
): string | undefined {
  if (tlsOn || isLoopbackBind(host) || allowPlaintextExposed) return undefined;
  return '제어 API를 외부 주소에 평문으로 묶을 수 없다. '
    + 'TLS를 켜거나(BARY_TLS_CERT_FILE/BARY_TLS_KEY_FILE), '
    + '루프백에 묶거나(BARY_LISTEN=127.0.0.1:8088), '
    + '앞단이 TLS를 종단한다면 BARY_ALLOW_PLAINTEXT_EXPOSED=1을 명시하라';
}

/**
 * SecretStore 의 보안 자세를 로그에 남긴다. 자료 자체나 파일 이름은 읽지 않는다.
 * `FsSecretStore` 는 암호화 저장소가 아니므로, "암호화돼 있겠지"라는 운영자의 추측을
 * 기동 로그에서 끊어야 한다 (DESIGN.md §4.8).
 */
export function fsSecretStorePosture(root: string): {
  backend: 'filesystem'; encrypted: false; root: string; exists: boolean; mode?: string;
} {
  if (!existsSync(root)) return { backend: 'filesystem', encrypted: false, root, exists: false };
  const mode = (statSync(root).mode & 0o7777).toString(8).padStart(4, '0');
  return { backend: 'filesystem', encrypted: false, root, exists: true, mode };
}

/**
 * **숫자 설정을 한 자리에서, 한 번만 읽는다** (검수 G3).
 *
 * ── 왜 `Number(env(...))` 가 아닌가
 *
 * `Number('abc')` 는 던지지 않는다. `NaN` 이고, `NaN` 은 조용히 두 가지로 갈린다 —
 * `setInterval(f, NaN)` 은 Node 가 `1` 로 읽어 **초당 천 번** 돌고,
 * `left <= NaN * 86_400_000` 은 항상 거짓이라 **인증서가 영영 갱신 안 된다.**
 * 어느 쪽도 실패로 안 보인다. `parseTokenSpecs` 와 `decodeModel` 이 각각 같은 자리에서
 * 내린 판단을 여기도 적용한다: **환경변수도 런타임 입력이다.**
 *
 * ── 왜 하나로 모으나
 *
 * `BARY_PROBE_INTERVAL_MS` 는 **두 번** 읽혔다 — 프로버에 넘길 때 한 번, 그 사실을
 * 로그에 찍을 때 또 한 번. `BARY_ACME_INTERVAL_MS`·`BARY_ACME_RENEW_DAYS`·
 * `BARY_ACME_ORPHAN_INTERVAL_MS` 도 같다. 기본값이 같아서 지금은 안 갈리지만,
 * 한쪽만 고치는 날 **로그가 거짓말을 하기 시작한다.** 이 저장소가 반복해서 배운
 * *"자리가 둘이면 언젠가 갈린다"* 다.
 *
 * ── 왜 DB 접속보다 먼저인가
 *
 * 설정이 틀린 채로 PG 에 붙어 마이그레이션까지 돌리고 나서 죽는 것은 아무에게도
 * 이롭지 않다. 그리고 그래야 이 판정을 **도커 없이** 잴 수 있다.
 *
 * 범위가 하는 일은 "이 값이 옳은가" 가 아니라 **"이 값이 이 변수의 것인가"** 다 —
 * 초와 밀리초를 바꿔 적는 것이 이 부류의 실수다. 그래서 상한은 넉넉하다.
 */
function readTimings(): {
  electionMs: number; probeMs: number; probeTimeoutMs: number;
  probeFail: number; probeRise: number;
  healthEventDays: number; dbRetentionMs: number;
  acmeMs: number; acmeRenewDays: number; acmePublishMs: number;
  secretGcMs: number; acmeOrphanMs: number; acmeOrphanAgeS: number;
  oidcJwksMs: number; secretFactsMs: number;
} {
  return {
    electionMs: envInt('BARY_ELECTION_INTERVAL_MS', 5_000, { min: 100, max: DAY_MS }),
    probeMs: envInt('BARY_PROBE_INTERVAL_MS', 2_000, { min: 100, max: DAY_MS }),
    probeTimeoutMs: envInt('BARY_PROBE_TIMEOUT_MS', 1_000, { min: 1, max: 5 * MINUTE }),
    probeFail: envInt('BARY_PROBE_FAIL_THRESHOLD', 2, { min: 1, max: 100 }),
    probeRise: envInt('BARY_PROBE_RISE_THRESHOLD', 1, { min: 1, max: 100 }),
    healthEventDays: envInt('BARY_HEALTH_EVENT_RETENTION_DAYS',
      DEFAULT_HEALTH_EVENT_DAYS, { min: 1, max: 3_650 }),
    dbRetentionMs: envInt('BARY_DB_RETENTION_INTERVAL_MS', 3_600_000, { min: MINUTE, max: DAY_MS }),
    acmeMs: envInt('BARY_ACME_INTERVAL_MS', 30_000, { min: 1_000, max: DAY_MS }),
    acmeRenewDays: envInt('BARY_ACME_RENEW_DAYS', 30, { min: 1, max: 365 }),
    acmePublishMs: envInt('BARY_ACME_PUBLISH_INTERVAL_MS', 15_000, { min: 1_000, max: DAY_MS }),
    secretGcMs: envInt('BARY_SECRET_GC_INTERVAL_MS', 3_600_000, { min: MINUTE, max: DAY_MS }),
    acmeOrphanMs: envInt('BARY_ACME_ORPHAN_INTERVAL_MS', 900_000, { min: MINUTE, max: DAY_MS }),
    acmeOrphanAgeS: envInt('BARY_ACME_ORPHAN_AGE_S', 3_600, { min: 60, max: 86_400 * 30 }),
    oidcJwksMs: envInt('BARY_OIDC_JWKS_INTERVAL_MS', 300_000, { min: MINUTE, max: DAY_MS }),
    // 사실 캐시 재적재 (§4.8.1). `pg` 드라이버에서만 쓴다. 짧게 둘 이유가 없다 —
    // 놓친 사실은 「모른다」로 안전하게 흐르고, 자기 인스턴스가 넣은 것은 즉시 반영된다.
    secretFactsMs: envInt('BARY_SECRET_FACTS_INTERVAL_MS', 60_000, { min: 1_000, max: DAY_MS }),
  };
}

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

/** http 평면 admin 에 적재하고 되읽는다. **유닉스 소켓이다** (검수 S-08b). */
async function pushHttp(socket: string, epoch: string, body: string): Promise<string> {
  const call = adminFetch(socket);
  const write = await call(`http://admin/membership?epoch=${encodeURIComponent(epoch)}`, {
    method: 'POST', body, signal: AbortSignal.timeout(5000),
  });
  if (!write.ok) throw new Error(`멤버십 적재 실패 (http ${write.status}): ${await write.text()}`);
  const read = await call(
    `http://admin/membership/read?epoch=${encodeURIComponent(epoch)}`,
    { signal: AbortSignal.timeout(5000) });
  return (await read.text()).trim();
}

/**
 * stream 평면에 슬롯을 밀고 **되읽는다.**
 *
 * 전송은 `adminTalk` 이 진다 — 드레인의 `inflight` 창구와 같은 소켓·같은 문법이라
 * 클라이언트를 둘로 두면 한쪽만 고치는 날이 온다.
 */
async function pushStream(socket: string, epoch: string, body: string): Promise<string> {
  const talk = adminTalk(socket);
  const wrote = await talk(`${epoch} write\n${body}\n\n`);
  if (!wrote.startsWith('staged ')) throw new Error(`stream 멤버십 적재 실패: ${wrote.trim()}`);
  return (await talk(`${epoch} read\n`)).trim();
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
function writeBootstrap(prefix: string, adminSocket: string, streamAdminSocket: string): void {
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
      'admin/marker.conf': httpAdminConf('bootstrap', '0', adminSocket),
      ...(caps.streamLua === true
        ? { 'stream-admin/membership.conf': streamAdminConf('0', streamAdminSocket) }
        : {}),
    },
  });
  symlinkSync('generations/bootstrap', link);
  log.info('bootstrap.written', { membershipDict: caps.httpLua === true });
}

export async function main(): Promise<void> {
  const prefix = env('BARY_PREFIX', '/etc/barycenter');
  // **`split(':')` 이 아니다** (검수 G7). 그러면 IPv6 를 표현할 수 없고, 포트가 비거나
  // 숫자가 아니면 `listen(0)`·`listen(NaN)` 이 되어 **무작위 포트가 조용히 열린다.**
  const { host, port } = parseListen(env('BARY_LISTEN', '127.0.0.1:8088'));
  /**
   * **admin 은 유닉스 소켓이다** (검수 S-08b).
   *
   * 전에는 루프백 TCP 포트(`BARY_ADMIN_PORT`)였다. 그 표면에는 인증이 없고
   * `/membership` 은 밸런서 슬롯을 다시 쓴다 — §11.3 이 권장하는 hostNetwork 배포에서는
   * 같은 호스트의 아무 프로세스나 그걸 할 수 있었다.
   *
   * 디렉토리를 먼저 만든다. nginx 는 소켓을 만들 뿐 부모 디렉토리를 안 만든다. 권한은
   * `0700` 이다 — 접근 통제를 지는 것이 이 디렉토리이기 때문이다(nginx 의 `listen unix:`
   * 에는 mode 옵션이 없어 소켓 자체의 모드는 정할 수 없다).
   */
  const runDir = join(prefix, 'run');
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  const adminSocket = env('BARY_ADMIN_SOCKET', join(runDir, 'admin.sock'));
  const streamAdminSocket = env('BARY_STREAM_ADMIN_SOCKET', defaultStreamSocket(adminSocket));

  if (process.argv.includes('--write-bootstrap')) {
    /**
     * **엔진을 띄우기 직전이 여기다.** 부트스트랩을 쓰는 이 호출은 컨테이너 기동에서
     * nginx 바로 앞에 한 번 돈다 — 죽은 소켓 파일을 치울 자리가 정확히 그 자리다.
     *
     * 데몬만 재기동하는 경로(`exec node barycenterd.js`)에는 이 플래그가 없으므로
     * 여기 안 온다. 그래도 `clearStaleSockets` 는 붙어 보고 정한다 — 이 순서에
     * 기대는 것과 안전이 두 겹이라야 다음 사람이 순서를 바꿔도 안 깨진다.
     */
    await clearStaleSockets([adminSocket, streamAdminSocket]);
    writeBootstrap(prefix, adminSocket, streamAdminSocket);
    return;
  }

  /**
   * **숫자 설정을 DB 보다 먼저 읽는다** (검수 G3). 설정이 틀린 채로 PG 에 붙어
   * 마이그레이션까지 돌리고 나서 죽는 것은 아무에게도 이롭지 않다.
   */
  const t = readTimings();

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
   * 인증서 자료 저장소 (§4.8 · §4.8.1).
   *
   * **드라이버 선택은 배포의 것이다.** 기본은 `fs` 다 — 전용 VM 한 대(§11.3 의 v1 권장
   * 배포)에서는 KEK 를 어디 둘지가 새 문제이고, 그 결정을 안 한 배포를 조용히 바꾸지
   * 않는다. `pg` 는 봉투 암호화로 PG 에 넣으므로 인스턴스 사이에 공유된다.
   *
   * `ConfigStore` 보다 먼저 만든다 — 저장소가 SAN 커버리지를 보려면 사실을 읽을 창구가
   * 있어야 한다 (검수 B-05).
   */
  const secretBackend = env('BARY_SECRET_BACKEND', 'fs');
  let secrets: SecretStore;
  let refreshSecretFacts: (() => Promise<number>) | undefined;
  if (secretBackend === 'pg') {
    // **KEK 가 없으면 안 뜬다** (§4.8.1). 없는 것을 지어내면 「암호화된 줄 알았다」가
    // 그대로 돌아온다 — 아직 아무 자료도 안 들어간 지금 죽는 편이 정직하다.
    const pgSecrets = new PgSecretStore({
      db,
      kek: readKek(env('BARY_SECRET_KEK', '')),
      ...(env('BARY_SECRET_KEK_ID', '') === '' ? {} : { kekId: env('BARY_SECRET_KEK_ID', '') }),
    });
    // 동기 창구(`facts`)의 뒷받침을 기동에서 채운다. **자료를 복호화하지 않는다** —
    // `facts` 는 평문 열이다.
    const loaded = await pgSecrets.refreshFacts();
    secrets = pgSecrets;
    refreshSecretFacts = () => pgSecrets.refreshFacts();
    log.warn('secrets.posture', {
      backend: 'postgres', encrypted: true, kekId: env('BARY_SECRET_KEK_ID', 'env'), facts: loaded,
    });
  } else if (secretBackend === 'fs') {
    const secretsRoot = env('BARY_SECRETS', `${prefix}/secrets`);
    secrets = new FsSecretStore(secretsRoot);
    log.warn('secrets.posture', fsSecretStorePosture(secretsRoot));
  } else {
    throw new Error(
      `BARY_SECRET_BACKEND 가 아는 값이 아니다: ${JSON.stringify(secretBackend)} — fs | pg`);
  }

  // **사실 창구를 넘긴다** (검수 B-05). 안 넘기면 바인딩된 인증서가 그 호스트를
  // 덮는지 아무도 안 본다 — `certCoversHost` 가 구현돼 있는데 호출자가 없었다.
  const store = new ConfigStore(db, renderCaps, secrets);

  /**
   * DP 쪽 부작용. **`bary-dp-agent` 와 같은 팩토리를 쓴다** — 둘이 각자 만들면
   * 한쪽만 고치는 날이 오고, 그 차이는 "원격 배포에서만 reload 가 안 걸린다" 처럼
   * 나중에 드러난다.
   */
  const effects = bootEffects({ prefix, adminSocket, streamAdminSocket });

  // **핸들을 들고 있는다.** 종료할 때 놓아야 다음 기동이 즉시 열린다 (검수 B-16) —
  // 안 놓으면 죽은 주인을 가려내는 `/proc` 폴백에 기대게 되고, 그 파일을 못 읽는
  // 플랫폼에서는 "살아 있는 쪽으로" 틀려 pid 재사용 때 기동이 막힌다.
  const agentStore = FileStore.open(`${prefix}/state/agent.json`);
  /**
   * **드라이버를 고른다** (§3.1 · §11.1).
   *
   * 기본은 로컬이다 — 지금 배포에서 CP 와 에이전트는 한 프로세스이고, 그 사이에는
   * 전송이 없다. `BARY_DP_REMOTE_URL` 을 주면 원격으로 간다.
   *
   * ⚠️ **가르는 것은 CP↔에이전트뿐이다.** §11.1 이 실측한 *"에이전트와 nginx 는 같은
   * 파일시스템을 봐야 한다"* 는 그대로다 — 원격으로 가면 에이전트가 **저쪽 호스트에서**
   * `createDpAgentServer` 로 서고, nginx 는 그 옆에 있다. 이쪽에는 nginx 가 없다.
   *
   * 넷을 다 주거나 하나도 안 준다. 셋만 주면 "인증서를 깜빡했다" 가 조용히 평문이나
   * 검증 없음이 되는데, 이 모듈은 그 길을 아예 안 낸다.
   */
  const remoteUrl = env('BARY_DP_REMOTE_URL', '');
  const remoteCert = env('BARY_DP_REMOTE_CERT_FILE', '');
  const remoteKey = env('BARY_DP_REMOTE_KEY_FILE', '');
  const remoteCa = env('BARY_DP_REMOTE_CA_FILE', '');
  const remoteBits = [remoteUrl, remoteCert, remoteKey, remoteCa].filter((x) => x !== '');
  if (remoteBits.length !== 0 && remoteBits.length !== 4) {
    throw new Error(
      'BARY_DP_REMOTE_* 는 넷을 다 주거나 하나도 안 준다 — '
      + 'URL·CERT_FILE·KEY_FILE·CA_FILE. 일부만 주면 조용히 검증 없는 연결이 된다',
    );
  }
  const driver: DataplaneDriver = remoteUrl === ''
    ? LocalDataplaneDriver.create({ store: agentStore, effects })
    : new RemoteDataplaneDriver({
      baseUrl: remoteUrl,
      clientCertFile: remoteCert,
      clientKeyFile: remoteKey,
      caFile: remoteCa,
    });
  if (remoteUrl !== '') log.info('driver.remote', { baseUrl: remoteUrl });

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
  }, t.electionMs);
  retry.unref();

  const control = new ControlPlane(db, store, driver, election,
    { prefix, adminSocket, streamAdminSocket, renderCaps, engine: engineInfo, driver: driverBoot, secrets });

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
    intervalMs: t.probeMs,
    timeoutMs: t.probeTimeoutMs,
    failThreshold: t.probeFail,
    riseThreshold: t.probeRise,
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
    log.info('prober.started', { intervalMs: t.probeMs });
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
  const auditDaysRaw = envIntOpt('BARY_AUDIT_RETENTION_DAYS', { min: 1, max: 3_650 });
  // 제안 #10 의 남은 절반. **전부 빈 값이면 안 지운다** — 같은 이유다.
  const planDaysRaw = envIntOpt('BARY_PLAN_RETENTION_DAYS', { min: 1, max: 3_650 });
  const changesetDaysRaw = envIntOpt('BARY_CHANGESET_RETENTION_DAYS', { min: 1, max: 3_650 });
  // 종단한 apply 이력. 비종단 행은 나이와 무관하게 남는다 — 복구가 이어받을 것이다.
  const operationDaysRaw = envIntOpt('BARY_OPERATION_RETENTION_DAYS', { min: 1, max: 3_650 });
  /**
   * 옛 리비전. **켜도 대개 아무것도 안 지운다** — 사슬이라 붙잡힌 것이 나오면 거기서
   * 멈추고, 롤백 수단인 plan 이 가리키는 리비전은 붙잡힌 것에 든다. 그게 맞는 동작이다.
   */
  const revisionDaysRaw = envIntOpt('BARY_REVISION_RETENTION_DAYS', { min: 1, max: 3_650 });
  const dbRetention = {
    healthEventDays: t.healthEventDays,
    // 빈 값은 **무한 보존**이다. 감사 추적의 보존 기간은 우리가 정할 것이 아니라
    // 운영자가 정하는 것이고, 기본값으로 지우면 업그레이드가 곧 데이터 소실이다.
    ...(auditDaysRaw === undefined ? {} : { auditDays: auditDaysRaw }),
    ...(planDaysRaw === undefined ? {} : { planDays: planDaysRaw }),
    ...(changesetDaysRaw === undefined ? {} : { changesetDays: changesetDaysRaw }),
    ...(operationDaysRaw === undefined ? {} : { operationDays: operationDaysRaw }),
    ...(revisionDaysRaw === undefined ? {} : { revisionDays: revisionDaysRaw }),
  };
  const dbRetentionTimer = setInterval(() => {
    void (async (): Promise<void> => {
      if (!election.state.isLeader) return;
      try {
        const out = await sweepDatabase({ db, ...dbRetention });
        if (out.healthEvents > 0 || out.audit > 0 || out.plans > 0 || out.changesets > 0) {
          log.info('db.swept', out);
        }
      } catch (e) {
        log.error('db.sweep_failed', { error: (e as Error).message });
      }
    })();
  }, t.dbRetentionMs);
  dbRetentionTimer.unref?.();
  const stopDbRetention = (): void => clearInterval(dbRetentionTimer);

  /**
   * **사실 캐시를 다시 읽는다** (§4.8.1). `pg` 드라이버에서만 돈다.
   *
   * 동기 창구(`facts`)는 캐시가 뒷받침하고, 다른 인스턴스가 넣은 자료는 이 틱에
   * 들어온다. **리더만 도는 것이 아니다** — 이것은 부작용이 아니라 읽기이고, 스탠바이의
   * `GET /certificates` 도 만료를 말해야 한다.
   *
   * 그 사이의 miss 는 「사실을 모른다」다. 없는 사실을 0 으로 채우지 않는다.
   */
  let stopSecretFacts = (): void => {};
  if (refreshSecretFacts !== undefined) {
    const factsTimer = setInterval(() => {
      void refreshSecretFacts!().catch((e: unknown) => {
        log.error('secrets.facts_refresh_failed', { error: String(e) });
      });
    }, t.secretFactsMs);
    factsTimer.unref?.();
    stopSecretFacts = (): void => clearInterval(factsTimer);
  }

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
  let stopOrphans = (): void => {};
  const acmeStore = new AcmeStore(db);
  const dnsDir = env('BARY_DNS01_DIR', '');
  const acmeRunner = new AcmeRunner({
    store: acmeStore,
    secrets,
    placer: new HttpChallengePlacer(adminFetch(adminSocket)),
    ...(dnsDir === '' ? {} : { dnsPlacer: new FileDns01(dnsDir) }),
    renewBeforeDays: t.acmeRenewDays,
  });
  if (acmeOn) {
    acmeRunner.start(
      t.acmeMs,
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
    }, t.acmePublishMs);
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
          // **부를 자리가 하나다** (검수 D1). 전에는 여기서 `@` 자리표를 손으로
          // 넓혔는데, 넘긴 목록이 *이미 root 인 것들*이라 넓히기가 아무것도 안 했다 —
          // 디스크의 세대가 참조하는 자료가 조용히 보호 밖이었다.
          const roots = await collectSecretRoots({ db, prefix, secrets });
          // **드라이버가 정한다.** 정책은 한 자리(`partitionForSweep`)이고 여기서
          // 갈리는 것은 어디를 훑고 무엇을 지우느냐뿐이다 (§4.8.1).
          const out = secretBackend === 'pg'
            ? await sweepSecretsPg({ db, roots })
            : sweepSecrets({ root: env('BARY_SECRETS', `${prefix}/secrets`), roots });
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
    }, t.secretGcMs);
    secretGcTimer.unref?.();
    const stopSecretGcTimer = (): void => clearInterval(secretGcTimer);
    stopSecretGc = stopSecretGcTimer;

    /**
     * **주기적 고아 스캔** (§8.2 · 검수 G6 이 이 배선의 부재를 잡았다).
     *
     * `AcmeRunner.cleanup` 은 구현돼 있었고 테스트도 초록인데 **프로덕션 호출자가
     * 0 개였다.** 도달성 게이트가 export 된 이름만 세던 시절에는 안 보였다 —
     * 클래스는 쓰이고 그 안의 메서드 하나만 죽어 있었다.
     *
     * 왜 필요한가는 S18 이 실측했다: **버려진 주문을 CA 는 안 치운다.** 주문 상태로
     * 물으면 영영 안 걸리므로 원장이 "놓았는가" 로 판단하고(`orphans`), 그것을 도는
     * 것이 이 틱이다. dict 쪽은 TTL(`ACME_TTL_SECONDS`)이 덮지만 **원장은 안 덮는다** —
     * `cleaned_at` 이 안 적히면 고아 목록이 영원히 자란다.
     *
     * 러너 틱과 **다른 타이머**다. 발급 한 바퀴가 CA 를 기다리는 동안 청소가 막히면
     * 안 되고, 청소는 실패해도 발급을 막을 이유가 없다.
     */
    const orphanTimer = setInterval(() => {
      void (async (): Promise<void> => {
        if (!election.state.isLeader) return;
        try {
          const n = await acmeRunner.cleanup(
            t.acmeOrphanAgeS);
          if (n > 0) log.info('acme.orphans.cleaned', { challenges: n });
        } catch (e) {
          log.error('acme.orphans.failed', { error: (e as Error).message });
        }
      })();
    }, t.acmeOrphanMs);
    orphanTimer.unref?.();
    stopOrphans = (): void => clearInterval(orphanTimer);

    log.info('acme.started', {
      intervalMs: t.acmeMs,
      renewBeforeDays: t.acmeRenewDays,
      autoApply: env('BARY_ACME_AUTOAPPLY', '1') !== '0',
      orphanIntervalMs: t.acmeOrphanMs,
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
  /**
   * **JWKS 로 키 회전을 따라간다** (검수 S-06 나머지).
   *
   * 안 켜면 지금까지처럼 고정 키다. 켜면 `kid` 로 고르고, 모르는 `kid` 는 거절한다 —
   * 고정 키로 떨어지면 회전을 켠 배포가 실제로는 안 켠 상태로 돈다.
   *
   * **모르는 `kid` 에 다시 안 당긴다.** 이 검증은 Bearer 를 확인하기 *전에* 도는
   * 자리라, 재조회를 넣으면 아무나 임의 `kid` 로 우리 아웃바운드를 흔들 수 있다.
   * 당기는 것은 아래 타이머의 몫이다.
   */
  const jwksUrl = env('BARY_OIDC_JWKS_URL', '');
  const jwks = jwksUrl === '' ? undefined : new JwksCache(jwksUrl);
  let stopJwks = (): void => {};
  if (jwks !== undefined) {
    // **기동에서 한 번 기다린다.** 안 기다리면 첫 로그인 몇 개가 빈 캐시를 만나 401 이고,
    // 그 증상은 "가끔 로그인이 안 된다" 라 원인을 못 찾는다.
    const first = await jwks.refresh();
    log.info('oidc.jwks.loaded', { url: jwksUrl, keys: first.keys });
    if (first.keys === 0) {
      // 던지지 않는다 — IdP 가 잠깐 죽었다고 컨트롤 플레인이 안 뜨면 그게 더 넓은 장애다.
      // 다만 조용히 넘어가지도 않는다. 이 상태에서는 OIDC 로 아무도 못 들어온다.
      log.warn('oidc.jwks.empty', { url: jwksUrl, reason: 'OIDC 로그인이 전부 거절된다' });
    }
    const jwksTimer = setInterval(() => {
      void (async (): Promise<void> => {
        const out = await jwks.refresh();
        if (out.changed) log.info('oidc.jwks.rotated', { keys: out.keys });
      })();
    }, t.oidcJwksMs);
    jwksTimer.unref?.();
    stopJwks = (): void => clearInterval(jwksTimer);
  }

  const oidc: OidcSettings | undefined
    = oidcIss !== '' && oidcAud !== '' && (oidcKey !== '' || jwks !== undefined)
      ? {
          issuer: oidcIss,
          audience: oidcAud,
          key: oidcKeyFrom(oidcKey),
          ...(jwks === undefined ? {} : { keys: (kid: string | undefined) => jwks.keyFor(kid) }),
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

  const apiOpts = {
    db, store, control, auth, election, secrets, events,
    plaintextExposed: false,
    sessionSecure: false,
    ...(serveRoot === undefined ? {} : { guiRoot: serveRoot }),
    ...(oidcRp === undefined ? {} : { oidcRp }),
  };

  /**
   * **제어 API 서버 TLS** (검수 S-05b).
   *
   * 이 API 로 개인키 PEM 이 본문에 담겨 올라가고 Bearer 토큰이 매 요청에 실린다.
   * 아래 S-05a 경고가 *"진짜 답은 서버 TLS 이고 그건 별건이다"* 라고 적어 둔 자리다.
   *
   * 선택이다 — 안 켜면 지금과 같다. 다만 반만 켜지지는 않는다(`apiTlsOptions` 가 던진다).
   * 클라이언트 CA 는 **망 관문**까지만 연다. 누구인지는 여전히 토큰이 답한다.
   */
  const tlsCert = env('BARY_TLS_CERT_FILE', '');
  const tlsKey = env('BARY_TLS_KEY_FILE', '');
  const tlsClientCa = env('BARY_TLS_CLIENT_CA_FILE', '');
  const tlsOn = tlsCert !== '' || tlsKey !== '';
  const allowPlaintextExposed = envBool('BARY_ALLOW_PLAINTEXT_EXPOSED');
  const plaintextExposed = !tlsOn && !isLoopbackBind(host ?? '');
  const exposureError = plaintextExposureError(host ?? '', tlsOn, allowPlaintextExposed);
  if (exposureError !== undefined) throw new Error(exposureError);
  apiOpts.plaintextExposed = plaintextExposed;
  apiOpts.sessionSecure = tlsOn;
  const server = tlsOn
    ? createHttpsServer(
        apiTlsOptions({
          cert: tlsCert === '' ? '' : readFileSync(tlsCert, 'utf8'),
          key: tlsKey === '' ? '' : readFileSync(tlsKey, 'utf8'),
          ...(tlsClientCa === '' ? {} : { clientCa: readFileSync(tlsClientCa, 'utf8') }),
        }),
        apiHandler(apiOpts),
      )
    : createApi(apiOpts);
  await new Promise<void>((resolve) => {
    server.listen(port, host, resolve);
  });
  log.info('listening', {
    host, port: Number(port), prefix, adminSocket, tokens: auth.size,
    gui: serveRoot ?? false,
    // 켰다고 생각했는데 안 켜진 상태를 밖에서 확인할 수 있어야 한다.
    tls: tlsOn ? (tlsClientCa === '' ? 'server' : 'server+client-ca') : false,
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
  if (plaintextExposed) {
    log.warn('listen.exposed', {
      host,
      why: '제어 API 에 TLS 가 없다 — 개인키와 토큰이 평문으로 지나간다',
      advice: allowPlaintextExposed
        ? 'BARY_ALLOW_PLAINTEXT_EXPOSED=1 로 명시적으로 허용됨 — 앞단 TLS 종단을 확인하라'
        : '앞단에서 TLS 를 종단하거나 루프백에만 퍼블리시하라',
    });
  }

  /**
   * 종료 (검수 D9).
   *
   * ── `server.close()` 만으로는 안 끝난다
   *
   * 그 콜백은 **모든 연결이 끝난 뒤에** 온다. SSE 는 끝나지 않는 연결이라, GUI 가 한
   * 탭이라도 열려 있으면 아래 정리가 통째로 안 돈다 — 리더 락도 durable store 락도
   * 안 놓이고, 프로세스는 오케스트레이터의 `SIGKILL` 유예가 다 지나야 죽는다.
   * 그리고 그 뒤에 뜨는 인스턴스는 **죽은 주인을 가려내는 `/proc` 폴백**에 기댄다
   * (`agentStore.release` 의 주석이 그 폴백의 실패 모드를 이미 적어 뒀다).
   * **깨끗한 종료가 안 되는 것이 다음 기동의 위험이다.**
   *
   * 순서가 셋이다:
   *
   *   ① 화면에 **정상 종료**를 알린다. 그냥 끊으면 브라우저가 재연결을 시도하고,
   *      그 재연결은 실패하며, 화면은 「끊겼다」가 아니라 「멎었다」로 보인다
   *   ② 새 연결을 안 받고, 남은 연결도 끊는다
   *   ③ 그래도 안 끝나면 마감에서 나간다 — `bary-dp-agent` 가 이미 그 모양이다
   */
  const stop = (): void => {
    events.closeAll();
    /**
     * **마감을 씌운다.** ①·② 로 안 끝나는 경우가 남는다 — 느린 클라이언트, 우리가 아직
     * 모르는 keep-alive. 나가는 길이 막히는 것보다 덜 깨끗하게 나가는 편이 낫다.
     */
    setTimeout(() => {
      log.warn('shutdown.deadline', { ms: SHUTDOWN_DEADLINE_MS });
      process.exit(0);
    }, SHUTDOWN_DEADLINE_MS).unref();
    server.close(() => {
      // **물러난 것을 적고 나간다.** 락은 세션 종료로 어차피 풀리지만, 깨끗하게 물러난
      // 것과 죽은 것을 나중에 구분할 수 있어야 한다.
      prober.stop();
      acmeRunner.stop();
      stopPublish();
      stopSecretGc();
      stopOrphans();
      stopDbRetention();
      stopSecretFacts();
      stopJwks();
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
    /**
     * **남은 연결도 끊는다.** `close()` 는 새 연결만 막는다 — 이미 열린 keep-alive 는
     * 그대로 산다. ① 이 SSE 를 닫았으므로 여기 남는 것은 평범한 요청 소켓이고,
     * 그것들은 응답을 이미 받았거나 곧 받는다.
     */
    server.closeAllConnections?.();
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

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
import { readFileSync } from 'node:fs';
import { promisify } from 'node:util';

import { createApi } from '../api/server.js';
import { TokenAuth, type TokenSpec } from '../api/auth.js';
import { ControlPlane } from '../control/plane.js';
import { LocalDataplaneDriver } from '../dp/driver.js';
import { FsEffects } from '../dp/effects-fs.js';
import { FileStore } from '../dp/store-fs.js';
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

export async function main(): Promise<void> {
  const prefix = env('BARY_PREFIX', '/etc/barycenter');
  const adminPort = Number(env('BARY_ADMIN_PORT', '19999'));
  const [host, port] = env('BARY_LISTEN', '127.0.0.1:8088').split(':');

  const db = new Db(env('BARY_DSN'));
  const applied = await db.migrate();
  if (applied.length > 0) console.log(`마이그레이션 적용: ${applied.join(', ')}`);

  const store = new ConfigStore(db);

  const effects = new FsEffects({
    prefix,
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

  // §3.5 — 어떤 오퍼레이션보다 먼저 펜싱을 끝낸다.
  const leaderToken = env('BARY_LEADER_TOKEN', '1');
  const fenced = await driver.fence(leaderToken);
  console.log(`fence: token=${leaderToken} maxToken=${fenced.maxToken}`);

  const control = new ControlPlane(db, store, driver, { prefix, leaderToken, adminPort });
  const auth = new TokenAuth(loadTokens());

  const server = createApi({ db, store, control, auth });
  await new Promise<void>((resolve) => {
    server.listen(Number(port), host, resolve);
  });
  console.log(`barycenterd: http://${host}:${port}  prefix=${prefix}  admin=:${adminPort}  토큰 ${auth.size}개`);

  const stop = (): void => {
    server.close(() => {
      void db.close().then(() => process.exit(0));
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

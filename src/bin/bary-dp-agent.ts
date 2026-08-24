#!/usr/bin/env node
/**
 * `bary-dp-agent` — **DP 호스트에서 도는 에이전트** (DESIGN.md §3.1 · §11.1)
 *
 *   bary-dp-agent
 *
 * `barycenterd` 를 원격 드라이버로 띄웠을 때 그 반대편이다. nginx 와 **같은 호스트**에서
 * 돌고, `/etc/barycenter` 의 유일한 writer 다.
 *
 * ── 왜 이 프로세스가 nginx 옆에 있어야 하는가
 *
 * §11.1 이 실측했다 — 호스트에서 `current` 심볼릭 링크를 바꿨더니 컨테이너가 보는 링크가
 * **비어 있었고** `open() ".../current/nginx.conf" failed (22: Invalid argument)` 가 났다.
 * **에이전트와 nginx 는 같은 파일시스템을 봐야 한다.** 원격으로 가르는 것은 CP↔에이전트
 * 뿐이고, 이 프로세스는 그 경계의 **안쪽**에 산다.
 *
 * ── 환경변수
 *
 *   BARY_DP_AGENT_PORT        듣는 포트 (기본 8443)
 *   BARY_DP_AGENT_BIND        바인드 (기본 0.0.0.0)
 *   BARY_DP_AGENT_CERT_FILE   서버 인증서 · 키 · CA — **셋 다 필수다**
 *   BARY_DP_AGENT_KEY_FILE
 *   BARY_DP_AGENT_CA_FILE
 *   BARY_DP_AGENT_CLIENTS     받아 줄 CP 의 CN, 쉼표로 여럿. **비어 있을 수 없다**
 *   BARY_PREFIX               세대 루트 (기본 /etc/barycenter)
 *   BARY_NGINX_RELOAD         reload 명령
 */
import { readFileSync } from 'node:fs';

import { createDpAgentServer } from '../dp/agent-server.js';
import { bootEffects } from '../dp/effects-boot.js';
import { FileStore } from '../dp/store-fs.js';
import { LocalDataplaneDriver } from '../dp/driver.js';
import { log } from '../obs/log.js';

const env = (name: string, fallback: string): string => process.env[name] ?? fallback;

function required(name: string): string {
  const v = process.env[name];
  if (v === undefined || v === '') {
    throw new Error(`${name} 이 필요하다 — 인증 없는 창구를 안 연다`);
  }
  return v;
}

async function main(): Promise<void> {
  const prefix = env('BARY_PREFIX', '/etc/barycenter');
  const port = Number(env('BARY_DP_AGENT_PORT', '8443'));
  const bind = env('BARY_DP_AGENT_BIND', '0.0.0.0');

  /**
   * **CN 목록이 비면 안 뜬다.** `undefined` 를 "아무나" 로 읽는 길을 안 만든다 —
   * CA 를 나눠 쓰는 배포에서 "이 CA 의 아무 인증서" 는 너무 넓다.
   */
  const clients = required('BARY_DP_AGENT_CLIENTS')
    .split(',').map((x) => x.trim()).filter((x) => x !== '');
  if (clients.length === 0) throw new Error('BARY_DP_AGENT_CLIENTS 에 CN 이 하나도 없다');

  /**
   * **`barycenterd` 와 같은 팩토리다.** 여기서 따로 만들면 두 배포의 부작용이 갈리고,
   * 그 차이는 "원격에서만 reload 가 안 걸린다" 처럼 나중에 드러난다.
   */
  const effects = bootEffects({
    prefix,
    adminSocket: env('BARY_ADMIN_SOCKET', `${prefix}/run/admin.sock`),
    streamAdminSocket: env('BARY_STREAM_ADMIN_SOCKET', `${prefix}/run/stream-admin.sock`),
  });
  const driver = LocalDataplaneDriver.create({
    store: FileStore.open(`${prefix}/state/agent.json`),
    effects,
  });

  const server = createDpAgentServer({
    driver,
    cert: readFileSync(required('BARY_DP_AGENT_CERT_FILE')),
    key: readFileSync(required('BARY_DP_AGENT_KEY_FILE')),
    ca: readFileSync(required('BARY_DP_AGENT_CA_FILE')),
    allowedClientNames: clients,
  });

  await new Promise<void>((r) => server.listen(port, bind, r));
  log.info('dp_agent.listening', { bind, port, clients: clients.length, prefix });

  const stop = (): void => {
    server.close(() => process.exit(0));
    // 열린 keep-alive 가 있으면 `close` 가 안 끝난다 — 상한을 둔다.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

// 진입점으로 실행됐을 때만 돈다 — 테스트가 import 할 수 있어야 한다 (검수 N1).
//
// 다른 두 진입점(`barycenterd` · `bary`)은 처음부터 이 가드를 갖고 있었는데 여기만
// 없었다. 그래서 이 파일을 import 하는 것이 **서버를 띄우거나(환경이 갖춰졌으면)
// 프로세스를 죽이는 일**(`main` 이 던지면 `process.exit(1)`)이었다.
if (process.argv[1]?.endsWith('bary-dp-agent.ts') === true
  || process.argv[1]?.endsWith('bary-dp-agent.js') === true) {
  main().catch((e: unknown) => {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  });
}

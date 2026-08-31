/**
 * `soft_max_conns` — **후보를 좁힐 뿐 알고리즘을 안 바꾼다** (§4.4 · ADR 3 조각 3, 4-a)
 *
 * ── nginx 의 `max_conns` 와 뜻이 다르다
 *
 * 그쪽은 초과분을 큐에 넣거나 502 로 끊는다. **여기서는 안 끊는다.** 초과한 peer 를
 * 후보에서 빼고, **전부 초과했으면 상한을 통째로 무시한다.** 백엔드가 멀쩡한데 프록시가
 * 끊는 것을 이 저장소는 반복해서 피해 왔다. 이름에 `soft` 가 붙은 이유가 그것이다.
 *
 * ── 왜 「최소 부하로」가 아닌가 (ADR 4-a)
 *
 * 전부 초과했을 때 최소 부하로 고르면 그건 **설정한 알고리즘을 갈아 끼우는 것**이다.
 * `hash` 풀에서는 곧 세션 친화가 깨지는 것이고, 하필 부하가 가장 높은 순간에 깨진다 —
 * S15 가 잰 재매핑률(peer 하나 바뀔 때 75~94%)이 그 값의 크기를 말한다.
 *
 * ── 무대: 인플라이트를 실제로 만든다
 *
 * 상한은 `in:` 을 보고 걸리므로 **동시 요청이 있어야** 잴 수 있다. 백엔드 하나를 느리게
 * 만들어(응답을 붙잡아) 인플라이트를 쌓고, 그동안 온 요청이 어디로 가는지 본다.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { dropScratch } from '../scratch.js';
import { encodeSlots, httpAdminConf } from '../../src/control/membership.js';
import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const PORT = 18981;
/** 상한 1. 느리게 답해 인플라이트를 붙잡는다. */
const CAPPED = 19221;
/** 상한 없음. 빨리 답한다. */
const FREE = 19222;
const SOCK = '/run/bary-cap.sock';
const ON = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };

const model: Model = {
  listeners: [{
    key: 'web', protocol: 'http', bind: '0.0.0.0', port: PORT, enabled: true,
    http: { defaultAction: { pool: 'app' } },
  }],
  httpRoutes: [], passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' } as Model['pools'][number]],
  backends: [
    { key: 'c', pool: 'app', host: '127.0.0.1', port: CAPPED, weight: 1, softMaxConns: 1 },
    { key: 'f', pool: 'app', host: '127.0.0.1', port: FREE, weight: 1 },
  ],
  certificates: [], tlsPolicies: [], sniBindings: [],
};

/** 프로덕션이 실제로 보내는 형식으로 만든다 — 손으로 적으면 두 자리가 된다. */
const both = encodeSlots(
  { pool_app: [`127.0.0.1:${CAPPED}`, `127.0.0.1:${FREE}`] },
  { pool_app: { [`127.0.0.1:${CAPPED}`]: { softMaxConns: 1 } } },
);
/** 상한 걸린 것 **하나뿐**인 슬롯 — 전부 초과했을 때를 만든다. */
const cappedOnly = encodeSlots(
  { pool_app: [`127.0.0.1:${CAPPED}`] },
  { pool_app: { [`127.0.0.1:${CAPPED}`]: { softMaxConns: 1 } } },
);

function probe(): { spill: string; allOver: string; errorLog: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bary-cap-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf', 'admin'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'),
      `daemon off;\nworker_processes 1;\n${render(model, ON).conf}`, 'utf8');
    writeFileSync(join(dir, 'conf', 'admin', 'admin.conf'),
      httpAdminConf('g1', '0', SOCK), 'utf8');

    // 상한 걸린 쪽은 **2초 붙잡는다** — 그동안 `in:` 이 1 이라 상한에 걸린다.
    writeFileSync(join(dir, 'back.conf'), `daemon off;
error_log logs/b.log warn;
pid logs/b.pid;
events { worker_connections 64; }
http {
  access_log off;
  server {
    listen ${CAPPED};
    location / { content_by_lua_block { ngx.sleep(2); ngx.print("CAPPED") } }
  }
  server { listen ${FREE}; location / { return 200 "FREE"; } }
}
`, 'utf8');

    const push = (lines: string): string =>
      `curl -s --unix-socket ${SOCK} -X POST --data-binary '${lines}' `
      + `"http://admin/membership?epoch=0" > /dev/null`;

    writeFileSync(join(dir, 'probe.sh'), `
      set -e
      # **붙잡는 요청을 결정적으로 만든다.** 후보를 상한 걸린 것 하나로 두고 쏘면
      # 반드시 거기로 간다 — round_robin 의 차례에 기대면 무대가 흔들린다(실제로
      # 첫 판에서 배경 요청이 FREE 로 가 아무것도 안 붙잡았다).
      ${push(cappedOnly)}
      curl -s http://127.0.0.1:${PORT}/ > /dev/null &
      sleep 0.5
      # 이제 둘 다 후보에 넣는다. 붙잡힌 쪽의 in: 은 1 이라 상한에 걸려 있다.
      ${push(both)}
      echo "---spill---"
      # 그동안 온 요청들. 상한이 걸리면 전부 FREE 로 넘쳐야 한다.
      for i in 1 2 3; do curl -s http://127.0.0.1:${PORT}/; echo; done
      wait

      ${push(cappedOnly)}
      curl -s http://127.0.0.1:${PORT}/ > /dev/null &
      sleep 0.5
      echo "---allOver---"
      # 후보가 상한 걸린 것뿐이다. **끊지 않고** 그리로 보내야 한다.
      curl -s --max-time 10 http://127.0.0.1:${PORT}/; echo
      wait
    `, 'utf8');

    const out = execFileSync('docker', [
      'run', '--rm', '-v', `${dir}:/w:Z`, '--entrypoint', '/bin/sh', IMAGE, '-c',
      'apk add --no-cache curl >/dev/null 2>&1; '
      + '/usr/local/openresty/bin/openresty -p /w -c back.conf & sleep 1; '
      + '/usr/local/openresty/bin/openresty -p /w -c conf/nginx.conf & sleep 2; '
      + 'sh /w/probe.sh 2>&1; echo "---errorlog---"; tail -10 /w/logs/error.log',
    ], { encoding: 'utf8', timeout: 240_000 });

    if (process.env['BARY_DEBUG'] === '1') console.log(out);
    const part = (name: string): string => {
      const after = out.split(`---${name}---`)[1] ?? '';
      return (after.split('---')[0] ?? '').trim();
    };
    return { spill: part('spill'), allOver: part('allOver'), errorLog: part('errorlog') };
  } finally {
    dropScratch(dir);
  }
}

describe('soft_max_conns — 실제 엔진', () => {
  it('**상한에 걸린 peer 를 후보에서 뺀다** — 그리고 전부 걸렸으면 무시한다', () => {
    const r = probe();

    // ① 상한을 넘긴 쪽으로는 안 간다. round_robin 이면 셋 중 하나는 CAPPED 차례였다.
    expect(r.spill, `응답: ${JSON.stringify(r.spill)}\n${r.errorLog}`).not.toContain('CAPPED');
    // **넘친 곳이 실제로 응답했는지 먼저 못 박는다** — 전부 502 여도 위 검사는 통과한다.
    expect(r.spill).toContain('FREE');

    /**
     * ② **전부 초과했으면 끊지 않는다.**
     *
     * 후보가 상한 걸린 것뿐일 때 502 를 내면 *"백엔드는 살아 있는데 프록시가 끊었다"* 가
     * 된다. 상한이 힌트라는 말의 정확한 뜻이 이것이다.
     */
    expect(r.allOver, `응답: ${JSON.stringify(r.allOver)}\n${r.errorLog}`).toContain('CAPPED');
  }, 300_000);
});

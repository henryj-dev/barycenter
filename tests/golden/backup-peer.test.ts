/**
 * `is_backup` — **전부 죽었을 때만 받는다** (§4.4 · ADR 3, 조각 2)
 *
 * 이 평면에는 `server ... backup` 줄이 없다. 멤버십 평면이 켜지면 upstream 에 자리표시
 * 하나만 남고 peer 는 dict 에 살기 때문이다. 그래서 **Lua 밸런서가 1차/backup 을 가른다.**
 *
 * ── 왜 실물이어야 하나
 *
 * 렌더 산출물을 읽어 "분기가 있다" 를 보는 것으로는 **돈다**를 못 말한다. 이 저장소가
 * 반복해서 물린 자리다 — `nginx -t` 는 깨진 Lua 밸런서도 통과시킨다(E64). 그래서 실제
 * 엔진을 띄우고 **어느 백엔드가 응답했는지**로 판정한다.
 *
 * ── 무대
 *
 *   PRIMARY  1차. 살았다 죽었다 한다
 *   BACKUP   `isBackup: true`. 늘 살아 있다
 *
 * 1차가 살아 있으면 backup 은 **한 번도 안 받아야** 하고, 1차가 슬롯에서 빠지면
 * backup 이 **받아야** 한다.
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
const PORT = 18971;
const PRIMARY = 19211;
const BACKUP = 19212;
const SOCK = '/run/bary-backup.sock';
const ON = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };

const model: Model = {
  listeners: [{
    key: 'web', protocol: 'http', bind: '0.0.0.0', port: PORT, enabled: true,
    http: { defaultAction: { pool: 'app' } },
  }],
  httpRoutes: [], passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' } as Model['pools'][number]],
  backends: [
    { key: 'p', pool: 'app', host: '127.0.0.1', port: PRIMARY, weight: 1 },
    { key: 'b', pool: 'app', host: '127.0.0.1', port: BACKUP, weight: 1, isBackup: true },
  ],
  certificates: [], tlsPolicies: [], sniBindings: [],
};

/**
 * **속성을 `encodeSlots` 로 만든다.** 손으로 적으면 와이어 형식이 두 자리에 생기고,
 * 그러면 이 검사가 프로덕션이 실제로 보내는 것과 다른 것을 재게 된다.
 */
const bothLines = encodeSlots(
  { pool_app: [`127.0.0.1:${PRIMARY}`, `127.0.0.1:${BACKUP}`] },
  { pool_app: { [`127.0.0.1:${BACKUP}`]: { isBackup: true } } },
);
const backupOnlyLines = encodeSlots(
  { pool_app: [`127.0.0.1:${BACKUP}`] },
  { pool_app: { [`127.0.0.1:${BACKUP}`]: { isBackup: true } } },
);

function probe(): { withPrimary: string; withoutPrimary: string; errorLog: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bary-bk-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf', 'admin'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'),
      `daemon off;\nworker_processes 1;\n${render(model, ON).conf}`, 'utf8');
    writeFileSync(join(dir, 'conf', 'admin', 'admin.conf'),
      httpAdminConf('g1', '0', SOCK), 'utf8');

    // **둘 다 띄운다.** 여기서 재는 것은 「죽어서 못 간다」가 아니라 「살아 있어도 안
    // 고른다」이다 — backup 의 뜻이 그것이다.
    writeFileSync(join(dir, 'back.conf'), `daemon off;
error_log logs/b.log warn;
pid logs/b.pid;
events { worker_connections 64; }
http {
  access_log off;
  server { listen ${PRIMARY}; location / { return 200 "PRIMARY"; } }
  server { listen ${BACKUP};  location / { return 200 "BACKUP"; } }
}
`, 'utf8');

    const push = (lines: string): string =>
      `curl -s --unix-socket ${SOCK} -X POST --data-binary '${lines}' `
      + `"http://admin/membership?epoch=0" > /dev/null`;

    writeFileSync(join(dir, 'probe.sh'), `
      set -e
      ${push(bothLines)}
      echo "---withPrimary---"
      for i in 1 2 3 4 5 6; do curl -s http://127.0.0.1:${PORT}/; echo; done
      ${push(backupOnlyLines)}
      echo "---withoutPrimary---"
      for i in 1 2 3; do curl -s http://127.0.0.1:${PORT}/; echo; done
    `, 'utf8');

    const out = execFileSync('docker', [
      'run', '--rm', '-v', `${dir}:/w:Z`, '--entrypoint', '/bin/sh', IMAGE, '-c',
      'apk add --no-cache curl >/dev/null 2>&1; '
      + '/usr/local/openresty/bin/openresty -p /w -c back.conf & sleep 1; '
      + '/usr/local/openresty/bin/openresty -p /w -c conf/nginx.conf & sleep 2; '
      + 'sh /w/probe.sh 2>&1; echo "---errorlog---"; tail -10 /w/logs/error.log',
    ], { encoding: 'utf8', timeout: 180_000 });

    if (process.env['BARY_DEBUG'] === '1') console.log(out);
    const part = (name: string): string => {
      const after = out.split(`---${name}---`)[1] ?? '';
      return (after.split('---')[0] ?? '').trim();
    };
    return {
      withPrimary: part('withPrimary'),
      withoutPrimary: part('withoutPrimary'),
      errorLog: part('errorlog'),
    };
  } finally {
    dropScratch(dir);
  }
}

describe('is_backup — 실제 엔진', () => {
  it('**1차가 살아 있으면 backup 은 한 번도 안 받는다**', () => {
    const r = probe();
    expect(r.withPrimary, `응답: ${JSON.stringify(r.withPrimary)}\n${r.errorLog}`)
      .not.toContain('BACKUP');
    // **살아 있는 쪽을 먼저 못 박는다.** `not.toContain` 만 두면 전부 502 여도 통과한다.
    expect(r.withPrimary).toContain('PRIMARY');

    // 1차가 슬롯에서 빠지면 그때 backup 이 받는다 — 안 그러면 backup 이 아니라 죽은 peer 다.
    expect(r.withoutPrimary, `응답: ${JSON.stringify(r.withoutPrimary)}\n${r.errorLog}`)
      .toContain('BACKUP');
  }, 240_000);
});

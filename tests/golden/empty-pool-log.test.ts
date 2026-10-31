/**
 * 풀의 peer 가 비면 오류 로그에 이유를 남긴다 — **실물 nginx 로** 잰다 (2026-11-01, web-01).
 *
 * 헬스가 풀을 비우자 모든 요청이 500 이었는데 오류 로그는 비어 있었다. 원인(백엔드 헬스)을 찾기까지 오래 걸렸다.
 * 재는 것: 멤버십 슬롯을 채우지 않은 세대에 요청하면 500 이고, 오류 로그에 풀 이름과 「적격 peer 가 없다」 가 있다.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';
import { dropScratch } from '../scratch.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const PORT = 18981;
const dockerAvailable = (): boolean => {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
};

const model = {
  listeners: [{ key: 'l', protocol: 'http', bind: '0.0.0.0', port: PORT, enabled: true, http: { defaultAction: { pool: 'web' } } }],
  httpRoutes: [], passthroughRoutes: [],
  pools: [{ key: 'web', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [{ key: 'w', pool: 'web', host: '127.0.0.1', port: 19999, weight: 1 }],
  certificates: [], tlsPolicies: [], sniBindings: [],
} as unknown as Model;

describe('빈 풀 — 실물 nginx', () => {
  it('**500 이고 오류 로그에 이유가 있다**', () => {
    if (!dockerAvailable()) return;
    const conf = render(model, { streamRealip: false, httpLua: true, streamLua: false }).conf;
    const dir = mkdtempSync(join(tmpdir(), 'bary-emptypool-'));
    chmodSync(dir, 0o777);
    try {
      mkdirSync(join(dir, 'conf'), { recursive: true });
      mkdirSync(join(dir, 'logs'), { recursive: true });
      // 멤버십 슬롯을 안 채운다 — 헬스가 풀을 비운 것과 같은 상태다.
      writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\nerror_log logs/error.log error;\n${conf}`, 'utf8');
      const out = execFileSync('docker',
        ['run', '--rm', '-v', `${dir}:/prefix:Z`, '--entrypoint', '/bin/sh', IMAGE, '-c',
          '/usr/local/openresty/bin/openresty -p /prefix -c conf/nginx.conf & sleep 1.5; '
          + `echo "status=$(wget -q -S -O /dev/null http://127.0.0.1:${PORT}/ 2>&1 | sed -n 's/^ *HTTP[^ ]* \\([0-9]*\\).*/\\1/p' | head -1)"; `
          + 'wget -q -O /dev/null http://127.0.0.1:' + PORT + '/ 2>&1 | head -1; echo "---"; cat /prefix/logs/error.log'],
        { stdio: ['ignore', 'pipe', 'pipe'] }).toString();
      expect(out, out).toMatch(/500/);
      expect(out, out).toMatch(/pool_web 에 적격 peer 가 없다/);
    } finally {
      dropScratch(dir);
    }
  }, 120_000);
});

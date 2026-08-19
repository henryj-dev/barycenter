/**
 * `worker_shutdown_timeout` — 모르는 것을 유계로 바꾸는 거래 (DESIGN.md §4.10 · S13)
 *
 * S13 이 실측했다: **마커로는 옛 워커를 셀 수 없다.** HUP 뒤 옛 워커는 리스닝 소켓을
 * 닫으므로 새 요청이 절대 안 가고, nginx 는 "어느 워커가 어느 세대인가" 를 안 알려준다.
 * 그래서 GC 는 *"이 세대를 아직 누가 쓰는가"* 를 영영 모른다.
 *
 * 이 설정이 그걸 **유계로 바꾼다** — 상한이 있으면 *"이 시간이 지나면 아무도 안 든다"*
 * 를 쓸 수 있다. **값은 in-flight 다.**
 *
 * ── 여기서 재는 것은 그 값이다 ──────────────────────────────────────────
 *
 * "설정이 나간다" 가 아니라 **"켜면 무슨 일이 일어나는가"** 를 잰다. 대가를 모르고
 * 켜게 두면 안 되는 종류의 설정이다.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dropScratch } from '../scratch.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'openresty/openresty:alpine';
const PORT = 18931;

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const model = (timeout?: number): Model => ({
  ...(timeout === undefined ? {} : { engine: { workerShutdownTimeoutS: timeout } }),
  listeners: [{
    key: 'l', protocol: 'http', bind: '0.0.0.0', port: PORT, enabled: true,
    http: { defaultAction: 'reject' },
  }],
  httpRoutes: [{ key: 'r', listener: 'l', hosts: ['a.test'], priority: 10,
    action: { kind: 'redirect', to: 'https://x/', status: 302 } }],
  passthroughRoutes: [], pools: [], backends: [],
  certificates: [], tlsPolicies: [], sniBindings: [],
});

const caps = { httpLua: false, streamLua: false, streamRealip: true };

/**
 * **긴 요청을 걸어 두고 HUP 을 보낸 뒤, 클라이언트가 무엇을 보는지 읽는다.**
 *
 * 렌더된 conf 에 `echo_sleep` 자리를 하나 끼워 넣는다 — 모델에는 "느린 응답" 을 낼
 * 방법이 없고, 여기서 재려는 것은 **워커 종료 거동**이지 라우팅이 아니다.
 */
const PROBE = `
( curl -s -o /prefix/body -w "%{exitcode} %{http_code}" --max-time 20 \\
    http://127.0.0.1:${PORT}/slow > /prefix/res 2>&1 & )
sleep 0.8
kill -HUP "$(cat /prefix/logs/nginx.pid)"
sleep 8
echo "result=$(cat /prefix/res 2>/dev/null)"
echo "bodylen=$(wc -c < /prefix/body 2>/dev/null | tr -d ' ')"
`;

function serve(conf: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-wst-'));
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    // 느린 location 을 서버 블록에 하나 끼운다.
    const withSlow = conf.replace(
      /(\n        location \/ \{)/,
      '\n        location = /slow { echo_sleep 6; echo "done"; }$1');
    writeFileSync(join(dir, 'conf', 'nginx.conf'),
      `pid logs/nginx.pid;\n${withSlow}`, 'utf8');
    writeFileSync(join(dir, 'probe.sh'), PROBE, 'utf8');
    return execFileSync('docker',
      ['run', '--rm', '-v', `${dir}:/prefix`, '--entrypoint', '/bin/sh', IMAGE, '-c',
        'apk add --no-cache curl >/dev/null 2>&1; ' +
        '/usr/local/openresty/bin/openresty -p /prefix -c conf/nginx.conf; sleep 1.2; ' +
        'sh /prefix/probe.sh'],
      { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } finally {
    dropScratch(dir);
  }
}

describe('worker_shutdown_timeout — 값을 잰다', () => {
  let bounded = '';
  let unbounded = '';

  beforeAll(() => {
    if (!dockerAvailable()) return;
    bounded = serve(render(model(2), caps).conf);
    unbounded = serve(render(model(), caps).conf);
  }, 300_000);

  const val = (out: string, k: string): string =>
    out.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim() ?? '';

  it.runIf(dockerAvailable())(
    '**안 적으면 in-flight 가 끝까지 간다** — 그래서 기본값이 안전하다',
    () => {
      // curl exitcode 0 + 200 + 본문이 있다.
      expect(val(unbounded, 'result'), unbounded).toBe('0 200');
      expect(Number(val(unbounded, 'bodylen')), unbounded).toBeGreaterThan(0);
    },
  );

  it.runIf(dockerAvailable())(
    '**켜면 in-flight 가 응답 없이 죽는다** — 502 도 부분 응답도 아니다',
    () => {
      // exitcode 52 = "empty reply from server". 클라이언트는 이것을 **네트워크 장애와
      // 구분할 수 없고**, 비멱등 요청이면 부작용이 이미 일어났을 수 있다.
      expect(val(bounded, 'result'), bounded).toBe('52 000');
      expect(Number(val(bounded, 'bodylen')), bounded).toBe(0);
    },
  );
});

describe('렌더', () => {
  it('안 적으면 디렉티브가 아예 없다', () => {
    expect(render(model(), caps).conf).not.toContain('worker_shutdown_timeout');
  });

  it('적으면 main 컨텍스트에 초 단위로 나간다', () => {
    expect(render(model(30), caps).conf).toContain('worker_shutdown_timeout 30s;');
  });
});

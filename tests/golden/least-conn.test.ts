/**
 * S6 — **`least_conn` 이 실제로 최소를 고르는가** (골든)
 *
 * §12.0 의 합격 기준: *"균등 부하에서 편차 < 10%"*. 렌더가 서는 것으로는 아무것도
 * 증명하지 못한다 — Lua 가 `d:get` 을 잘못 읽으면 조용히 첫 번째만 고르고, 그 증상은
 * "한 백엔드만 뜨겁다" 라 트래픽을 실제로 흘려 봐야 보인다.
 *
 * ── 무엇을 재는가
 *
 * 백엔드 셋을 띄우고 요청을 흘린 뒤 **각자가 받은 수**를 센다. 백엔드가 자기 이름을
 * 답하므로 분포를 밖에서 셀 수 있다.
 *
 * 균등한 백엔드에서 `least_conn` 은 round_robin 과 비슷하게 퍼진다 — inflight 가 계속
 * 0 으로 돌아오기 때문이다. **그게 맞는 거동이고**, 편차로 그걸 잰다. 한쪽으로 쏠리면
 * `d:get` 이 nil 을 큰 값으로 읽었거나 목록을 안 훑은 것이다.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { dropScratch } from '../scratch.js';
import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const PORT = 18951;

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** 멤버십 평면이 켜진 엔진 — 이 경로가 Lua 밸런서다. */
const ON = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };

const model = (algorithm: string): Model => ({
  listeners: [{
    key: 'web', protocol: 'http', bind: '0.0.0.0', port: PORT, enabled: true,
    http: { defaultAction: { pool: 'app' } },
  }],
  httpRoutes: [], passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass: 'http', algorithm } as Model['pools'][number]],
  backends: [
    { key: 'a', pool: 'app', host: '127.0.0.1', port: 19101, weight: 1 },
    { key: 'b', pool: 'app', host: '127.0.0.1', port: 19102, weight: 1 },
    { key: 'c', pool: 'app', host: '127.0.0.1', port: 19103, weight: 1 },
  ],
  certificates: [], tlsPolicies: [], sniBindings: [],
});

/**
 * 백엔드 셋 + 우리 conf 를 한 컨테이너에 띄우고 분포를 센다.
 *
 * 멤버십 평면이 켜지면 백엔드가 conf 에 없고 dict 슬롯에 산다 — admin 소켓으로 밀어야
 * 한다. 그래서 부트스트랩 슬롯을 `init_worker_by_lua` 로 직접 심는다: 이 테스트가 재는
 * 것은 **고르는 규칙**이지 적재 경로가 아니다(그건 e2e v03 이 잰다).
 */
function distribution(algorithm: string): Record<string, number> {
  const dir = mkdtempSync(join(tmpdir(), 'bary-lc-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    const rendered = render(model(algorithm), ON).conf;
    // 슬롯을 심는다 — epoch 은 "0" 이고 렌더러가 `_G.BARY_EPOCH or "0"` 로 읽는다.
    const seed = `init_worker_by_lua_block {
      local d = ngx.shared.bary_http
      d:set("slot:pool_app:0", "127.0.0.1:19101,127.0.0.1:19102,127.0.0.1:19103")
    }`;
    const conf = rendered.replace(/^(http \{)/m, `$1\n${seed}`);
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\nworker_processes 2;\n${conf}`, 'utf8');
    writeFileSync(join(dir, 'back.conf'), `daemon off;
error_log logs/b.log warn;
pid logs/b.pid;
events { worker_connections 64; }
http {
  access_log off;
  server { listen 19101; location / { return 200 "A"; } }
  server { listen 19102; location / { return 200 "B"; } }
  server { listen 19103; location / { return 200 "C"; } }
}
`, 'utf8');
    writeFileSync(join(dir, 'probe.sh'), `
      for i in $(seq 1 60); do
        curl -s http://127.0.0.1:${PORT}/
      done
      echo
    `, 'utf8');
    const out = execFileSync('docker', [
      'run', '--rm', '-v', `${dir}:/w:Z`, '--entrypoint', '/bin/sh', IMAGE, '-c',
      'apk add --no-cache curl >/dev/null 2>&1; '
      + '/usr/local/openresty/bin/openresty -p /w -c back.conf & sleep 1; '
      + '/usr/local/openresty/bin/openresty -p /w -c conf/nginx.conf & sleep 1.5; '
      + 'sh /w/probe.sh; echo "---errorlog---"; tail -5 /w/logs/error.log',
    ], { encoding: 'utf8', timeout: 180_000 });
    const body = out.split('---errorlog---')[0] ?? '';
    if (process.env['BARY_DEBUG'] === '1') console.log(out.slice(0, 2000));
    return {
      A: (body.match(/A/g) ?? []).length,
      B: (body.match(/B/g) ?? []).length,
      C: (body.match(/C/g) ?? []).length,
      raw: body.trim().length,
    } as unknown as Record<string, number>;
  } finally {
    dropScratch(dir);
  }
}

describe('least_conn 이 실제로 고른다 (S6)', () => {
  beforeAll(() => {
    if (!dockerAvailable()) throw new Error('도커가 없다 — 골든은 실물 엔진으로만 잰다');
  }, 180_000);

  it('**셋 다 트래픽을 받는다** — 한쪽으로 안 쏠린다', () => {
    /**
     * 이것이 이 테스트의 핵심이다. `d:get` 이 nil 을 큰 값으로 읽거나 목록을 안 훑으면
     * **첫 번째만 계속 고른다** — 그러면 A 가 60, B·C 가 0 이다.
     */
    const d = distribution('least_conn');
    expect(d['raw'], `요청이 안 갔다: ${JSON.stringify(d)}`).toBeGreaterThan(0);
    expect(d['A'], JSON.stringify(d)).toBeGreaterThan(0);
    expect(d['B'], JSON.stringify(d)).toBeGreaterThan(0);
    expect(d['C'], JSON.stringify(d)).toBeGreaterThan(0);
  }, 180_000);

  it('**균등 부하에서 편차 < 10%** — §12.0 S6 의 합격 기준', () => {
    const d = distribution('least_conn');
    const counts = [d['A']!, d['B']!, d['C']!];
    const total = counts.reduce((a, b) => a + b, 0);
    expect(total, JSON.stringify(d)).toBeGreaterThan(0);
    const mean = total / counts.length;
    const worst = Math.max(...counts.map((c) => Math.abs(c - mean) / mean));
    expect(worst, `분포 ${JSON.stringify(d)} — 평균 ${mean}`).toBeLessThan(0.10);
  }, 180_000);
});

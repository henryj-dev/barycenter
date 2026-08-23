/**
 * 제안 #6 — **엔진이 실제로 막는가** (골든)
 *
 * 여기는 렌더가 서는 것만으로는 아무것도 증명하지 못한다. zone 이름이 선언과 적용에서
 * 어긋나면 nginx 는 **기동 자체를 거부하고**(`unknown limit_req_zone`), 순서가 뒤집혀도
 * 같다. 그리고 `rate=1r/s` 를 적었는데 안 막히면 이 기능은 없는 것과 같다.
 *
 *   ① `nginx -t` — 선언과 적용이 이름·순서로 맞물리는가
 *   ② **실제로 503 이 나는가** — 초당 1 개로 좁히고 여러 번 친다
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { dropScratch } from '../scratch.js';
import { render } from '../../src/conf/render.js';
import type { Model, RateLimit } from '../../src/model/provisional.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const PORT = 18941;

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const caps = { httpLua: false, streamLua: false, streamRealip: true, sslConfCommand: true };

const model = (rateLimit: RateLimit, key = 'web'): Model => ({
  listeners: [{
    key, protocol: 'http', bind: '0.0.0.0', port: PORT, enabled: true,
    http: { defaultAction: 'reject', rateLimit },
  }],
  httpRoutes: [], passthroughRoutes: [], pools: [], backends: [],
  certificates: [], tlsPolicies: [], sniBindings: [],
});

function serve(conf: string, probe: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-rl-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\n${conf}`, 'utf8');
    writeFileSync(join(dir, 'probe.sh'), probe, 'utf8');
    return execFileSync('docker', [
      'run', '--rm', '-v', `${dir}:/w:Z`, '--entrypoint', '/bin/sh', IMAGE, '-c',
      'apk add --no-cache curl >/dev/null 2>&1; ' +
      '/usr/local/openresty/bin/openresty -p /w -c conf/nginx.conf & sleep 1.5; ' +
      'sh /w/probe.sh; echo "---errorlog---"; tail -3 /w/logs/error.log',
    ], { encoding: 'utf8', timeout: 180_000 });
  } finally {
    dropScratch(dir);
  }
}

function configTest(conf: string): { ok: boolean; out: string } {
  const dir = mkdtempSync(join(tmpdir(), 'bary-rl-t-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), conf, 'utf8');
    const out = execFileSync('docker', [
      'run', '--rm', '-v', `${dir}:/w`, '--entrypoint', '/bin/sh', IMAGE, '-c',
      'openresty -p /w -c /w/conf/nginx.conf -t 2>&1 || true',
    ], { encoding: 'utf8', timeout: 120_000 });
    return { ok: /syntax is ok/.test(out) && /test is successful/.test(out), out };
  } finally {
    dropScratch(dir);
  }
}

describe('레이트리밋이 실제 엔진에 선다 (제안 #6)', () => {
  beforeAll(() => {
    if (!dockerAvailable()) throw new Error('도커가 없다 — 골든은 실물 엔진으로만 잰다');
  }, 180_000);

  it('선언과 적용이 이름·순서로 맞물린다', () => {
    // 어긋나면 `unknown limit_req_zone` 으로 **기동 자체가 거부된다.**
    const r = configTest(render(model({ requestsPerSecond: 10, burst: 5 }), caps).conf);
    expect(r.ok, r.out).toBe(true);
  }, 180_000);

  it('커넥션 제한도 같다 — req 와 conn 은 다른 zone 타입이다', () => {
    const r = configTest(render(model({ maxConnections: 10 }), caps).conf);
    expect(r.ok, r.out).toBe(true);
  }, 180_000);

  it('**판 이름도 선다** — nginx 식별자가 아닌 리스너 키', () => {
    const r = configTest(render(model({ requestsPerSecond: 10 }, 'web-edge.1'), caps).conf);
    expect(r.ok, r.out).toBe(true);
  }, 180_000);

  it('**실제로 막는다** — 초당 1 개에 여러 번 치면 503 이 난다', () => {
    /**
     * 통과분과 막힌 분이 **둘 다 숫자 있는 응답**이어야 판정이 선다.
     *
     * 백엔드가 안 뜬 프록시 라우트를 쓴다: 통과하면 502(업스트림에 못 붙음), 막히면
     * 503. 둘이 겹치지 않는다.
     *
     * ⚠️ `reject`(444) 로는 못 잰다 — 응답 없이 끊으므로 curl 이 `000` 을 보고, 그건
     * 레이트리밋에 막힌 것과 구분되지 않는다. 실제로 한 번 그렇게 물렸다.
     */
    const m = model({ requestsPerSecond: 1 });
    m.pools = [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' }];
    m.backends = [{ key: 'a', pool: 'app', host: '127.0.0.1', port: 19998, weight: 1 }];
    m.httpRoutes = [{
      key: 'r', listener: 'web', hosts: ['a.test'], priority: 10,
      action: { kind: 'proxy', pool: 'app', websocket: false },
    }];
    const conf = render(m, caps).conf;
    const out = serve(conf, `
      for i in 1 2 3 4 5 6 7 8; do
        curl -s -o /dev/null -w '%{http_code} ' -H 'Host: a.test' http://127.0.0.1:${PORT}/
      done
      echo
    `);
    expect(out, out).toContain('503');
  }, 180_000);

  /**
   * ── 실측으로 배운 것: **`return` 으로 끝나는 라우트는 레이트리밋에 안 걸린다**
   *
   * nginx 의 단계 순서가 그렇다. `return` 은 **rewrite** 단계이고 `limit_req` 는
   * **preaccess** 단계인데, rewrite 가 **앞**이다. 그래서 redirect·reject 라우트는
   * `limit_req` 가 돌기 전에 끝난다.
   *
   * 이 저장소가 같은 함정에 두 번 물렸다 — *"`if` 는 rewrite 단계다 — location 선택보다
   * 앞이다"*, 그리고 server 레벨 `return` 때문에 ACME 예약 라우트가 조용히 죽어 있었다.
   *
   * **고치지 않는다.** 고치려면 `return` 을 content 단계로 옮겨야 하고(빈 프록시나 Lua),
   * 그건 redirect 한 줄의 대가로는 너무 크다. 대신 **사실로 못 박는다** — 다음 사람이
   * "redirect 에 레이트리밋이 안 먹는다" 를 버그로 파고들지 않도록.
   */
  it('`return` 라우트(redirect)는 레이트리밋 앞에서 끝난다 — nginx 단계 순서다', () => {
    const m = model({ requestsPerSecond: 1 });
    m.httpRoutes = [{
      key: 'r', listener: 'web', hosts: ['a.test'], priority: 10,
      action: { kind: 'redirect', to: 'https://x/', status: 302 },
    }];
    const out = serve(render(m, caps).conf, `
      for i in 1 2 3 4 5 6 7 8; do
        curl -s -o /dev/null -w '%{http_code} ' -H 'Host: a.test' http://127.0.0.1:${PORT}/
      done
      echo
    `);
    // 전부 통과한다. 이것이 현재의 계약이다.
    expect(out, out).not.toContain('503');
  }, 180_000);
});

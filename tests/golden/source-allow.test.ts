/**
 * 리스너 출발지 제한 — **엔진이 실제로 막는가** (골든, 2026-10-29)
 *
 * 렌더가 서는 것만으로는 아무것도 증명하지 못한다. 이 기능에는 nginx 단계 순서의 함정이
 * 둘 있고, 둘 다 `nginx -t` 는 통과한 채로 조용히 틀린다:
 *
 *   ① `allow` 였다면 **rewrite 단계의 `return`** (redirect·reject 라우트)이 먼저 응답한다.
 *      → 허용 목록 밖에서 redirect 라우트로 와도 끊기는가.
 *   ② `allow` 였다면 **realip 이 바꾼 뒤** 주소를 본다. Cloudflare 대역만 받으면서
 *      `CF-Connecting-IP` 로 방문자 IP 를 꺼내면 전부 막힌다.
 *      → 허용된 앞단이 목록 밖의 방문자 IP 를 헤더로 넘겨도 통과하는가.
 *      **proxy 라우트로 잰다** — redirect 로 재면 ① 이 ② 를 가린다.
 *
 * 둘 다 `allow`/`deny` 로 바꾼 돌연변이에서 빨개지는 것을 확인했다 (①: 302 가 나간다,
 * ②: 허용된 앞단의 요청이 403 으로 막힌다).
 *
 * 그리고 stream(`allow`)이 실제로 끊는가.
 *
 * 컨테이너 하나 안에서 두 출발지를 만든다: `127.0.0.1`(허용)과 컨테이너 자기 주소(불허 —
 * 자기 eth0 주소로 붙으면 출발지가 그 주소다).
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
const P = 18961;   // http: redirect 라우트 + 기본 거절
const R = 18962;   // http: CF-Connecting-IP realip 과 함께
const T = 18963;   // tcp: P 로 넘긴다

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const caps = { httpLua: false, streamLua: false, streamRealip: true, sslConfCommand: true };
const LOCAL = ['127.0.0.1', '::1'];

const model: Model = {
  listeners: [
    { key: 'web', protocol: 'http', bind: '0.0.0.0', port: P, enabled: true, sourceAllow: LOCAL,
      http: { defaultAction: 'reject' } },
    { key: 'cf', protocol: 'http', bind: '0.0.0.0', port: R, enabled: true, sourceAllow: LOCAL,
      realIpFromHeader: { header: 'CF-Connecting-IP', trustedCidrs: LOCAL },
      http: { defaultAction: 'reject' } },
    { key: 'l4', protocol: 'tcp', bind: '0.0.0.0', port: T, enabled: true, sourceAllow: LOCAL,
      defaultPool: 'loop' },
  ],
  httpRoutes: [
    { key: 'go', listener: 'web', hosts: ['a.test'], priority: 0,
      action: { kind: 'redirect', to: 'https://elsewhere.test/', status: 302 } },
    // **proxy 라우트다.** ② 는 content 단계에서만 드러난다 — redirect 는 rewrite 단계라
    // `allow` 보다 먼저 응답해서 ② 를 가린다(돌연변이로 실측했다). 업스트림은 P 자신이고,
    // 넘기는 연결의 출발지가 127.0.0.1 이라 P 의 가드를 통과해 302 를 낸다.
    { key: 'go-cf', listener: 'cf', hosts: ['a.test'], priority: 0,
      action: { kind: 'proxy', pool: 'back', websocket: false } },
  ],
  passthroughRoutes: [],
  pools: [
    { key: 'loop', protocolClass: 'tcp', algorithm: 'round_robin' },
    { key: 'back', protocolClass: 'http', algorithm: 'round_robin' },
  ],
  // tcp 리스너가 http 리스너로 넘긴다. 넘기는 연결의 출발지는 127.0.0.1 이라 P 가 받는다.
  backends: [
    { key: 'self', pool: 'loop', host: '127.0.0.1', port: P, weight: 1 },
    { key: 'self-http', pool: 'back', host: '127.0.0.1', port: P, weight: 1 },
  ],
  certificates: [], tlsPolicies: [], sniBindings: [],
};

/** 응답 코드와 curl 종료 코드. 444 는 응답 없이 끊으므로 `000 rc=52` 로 보인다. */
const PROBE = `
IP=$(hostname -i | awk '{print $1}')
c() { code=$(curl -s -o /dev/null -w '%{http_code}' -m 3 -H 'Host: a.test' "$@"); echo "$code rc=$?"; }
echo "WEB_LOCAL $(c http://127.0.0.1:${P}/)"
echo "WEB_REMOTE $(c http://$IP:${P}/)"
echo "WEB_REMOTE_UNKNOWN_HOST $(curl -s -o /dev/null -w '%{http_code}' -m 3 -H 'Host: nope.test' http://$IP:${P}/; echo " rc=$?")"
echo "CF_LOCAL_VISITOR $(c -H 'CF-Connecting-IP: 203.0.113.9' http://127.0.0.1:${R}/)"
echo "CF_REMOTE_SPOOF $(c -H 'CF-Connecting-IP: 127.0.0.1' http://$IP:${R}/)"
echo "TCP_LOCAL $(c http://127.0.0.1:${T}/)"
echo "TCP_REMOTE $(c http://$IP:${T}/)"
`;

function serve(conf: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-sa-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\n${conf}`, 'utf8');
    writeFileSync(join(dir, 'probe.sh'), PROBE, 'utf8');
    return execFileSync('docker', [
      'run', '--rm', '-v', `${dir}:/w:Z`, '--entrypoint', '/bin/sh', IMAGE, '-c',
      'apk add --no-cache curl >/dev/null 2>&1; ' +
      '/usr/local/openresty/bin/openresty -p /w -c conf/nginx.conf -t 2>&1 | tail -2; ' +
      '/usr/local/openresty/bin/openresty -p /w -c conf/nginx.conf & sleep 1.5; ' +
      'sh /w/probe.sh; echo "---errorlog---"; tail -3 /w/logs/error.log',
    ], { encoding: 'utf8', timeout: 180_000 });
  } finally {
    dropScratch(dir);
  }
}

describe('출발지 제한이 실제 엔진에서 막는다 (sourceAllow)', () => {
  let out = '';
  const line = (name: string): string => {
    const m = new RegExp(`^${name} (.*)$`, 'm').exec(out);
    expect(m, `${name} 줄이 없다:\n${out}`).not.toBeNull();
    return m![1]!;
  };

  beforeAll(() => {
    if (!dockerAvailable()) throw new Error('도커가 없다 — 골든은 실물 엔진으로만 잰다');
    out = serve(render(model, caps).conf);
  }, 240_000);

  it('설정이 선다 (`nginx -t`)', () => {
    expect(out).toMatch(/test is successful/);
  });

  it('허용된 출발지는 redirect 라우트에 닿는다', () => {
    expect(line('WEB_LOCAL')).toBe('302 rc=0');
  });

  it('**허용 목록 밖은 redirect 라우트 앞에서 끊긴다** — `allow` 였다면 302 가 나갔다 (①)', () => {
    expect(line('WEB_REMOTE')).toBe('000 rc=52');
  });

  it('모르는 Host 로 와도 끊긴다 — default_server 에도 가드가 있다', () => {
    expect(line('WEB_REMOTE_UNKNOWN_HOST')).toBe('000 rc=52');
  });

  it('**허용된 앞단이 목록 밖 방문자 IP 를 넘겨도 통과한다** — 바뀌기 전 주소를 본다 (②)', () => {
    expect(line('CF_LOCAL_VISITOR')).toBe('302 rc=0');
  });

  it('목록 밖 상대가 헤더로 허용 주소를 사칭해도 끊긴다 — 헤더가 아니라 연결을 본다', () => {
    expect(line('CF_REMOTE_SPOOF')).toBe('000 rc=52');
  });

  it('tcp 도 막는다 (`allow …; deny all;`)', () => {
    expect(line('TCP_LOCAL')).toBe('302 rc=0');
    expect(line('TCP_REMOTE')).toMatch(/^000 rc=(52|56|7)$/);
  });
});

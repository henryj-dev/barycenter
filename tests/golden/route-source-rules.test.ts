/**
 * **라우트 출발지 규칙** — 실물 nginx 로 잰다 (2026-11-02).
 *
 * 한 라우트가 출발지마다 다르게 간다. 컨테이너 안에서 `curl --interface` 로 출발지를 127.0.0.1–4 로 바꿔 보낸다(lo).
 *
 *   · 127.0.0.2 → 규칙 1: 풀로 보내기 + 경로 바꾸기(`/api/` → `/v1/`). 뒤쪽 리스너가 받은 경로를 Location 에 담아 돌려준다
 *   · 127.0.0.5 → 규칙 2: redirect
 *   · 127.0.0.4 → 규칙 3: reject 403
 *   · 127.0.0.1 → 맞는 규칙 없음: 라우트 기본 동작(redirect)
 *   · 위 규칙이 먼저다 — 규칙 2(127.0.0.5/32)가 규칙 3(127.0.0.4/30) 안에 들어도 127.0.0.5 는 규칙 2 로 간다
 *   · 경로가 여럿이면 경로마다 규칙이 선다
 *   · 출발지는 원본 IP 헤더(`realIpFromHeader`)가 바꾼 뒤의 주소다 — 믿는 앞단에서 온 헤더만 먹는다
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';
import { validateModel } from '../../src/validate/model.js';
import { dropScratch } from '../scratch.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const FRONT = 18981;
const BACK = 18982;
const VIA = 18983;

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

// 멤버십 평면을 끈다 — 정적 upstream 이라 lua dict 없이 바로 붙는다.
const caps = { streamRealip: false, httpLua: false, streamLua: false };

const model: Model = {
  listeners: [
    { key: 'front', protocol: 'http', bind: '127.0.0.1', port: FRONT, enabled: true, http: { defaultAction: 'reject' } },
    { key: 'back', protocol: 'http', bind: '127.0.0.1', port: BACK, enabled: true, http: { defaultAction: 'reject' } },
    // 앞단 프록시 뒤 — 127.0.0.1 이 보낸 X-Real-IP 를 믿는다. 규칙은 그 방문자 주소를 본다.
    { key: 'via', protocol: 'http', bind: '127.0.0.1', port: VIA, enabled: true, http: { defaultAction: 'reject' },
      realIpFromHeader: { header: 'X-Real-IP', trustedCidrs: ['127.0.0.1/32'] } },
  ],
  httpRoutes: [
    // 뒤쪽: 받은 경로를 Location 에 담아 돌려준다 — 앞쪽이 무엇을 보냈는지 보인다.
    { key: 'echo', listener: 'back', hosts: ['x.test'], priority: 0,
      action: { kind: 'redirect', to: 'https://back$request_uri', status: 302 } },
    { key: 'site', listener: 'front', hosts: ['x.test'], priority: 0, pathPrefixes: ['/api/', '/v2/'],
      action: { kind: 'redirect', to: 'https://default/', status: 302 },
      sourceRules: [
        { from: ['127.0.0.2'], action: { kind: 'proxy', pool: 'back', websocket: false, rewritePrefix: '/v1/' } },
        { from: ['127.0.0.5/32'], action: { kind: 'redirect', to: 'https://rule-two/', status: 302 } },
        { from: ['127.0.0.4/30'], action: { kind: 'reject', status: 403 } },
      ] },
    { key: 'visitor', listener: 'via', hosts: ['x.test'], priority: 0,
      action: { kind: 'redirect', to: 'https://not-visitor/', status: 302 },
      sourceRules: [{ from: ['203.0.113.0/24'], action: { kind: 'redirect', to: 'https://visitor/', status: 302 } }] },
  ],
  passthroughRoutes: [],
  pools: [{ key: 'back', protocolClass: 'http', algorithm: 'round_robin' }],
  backends: [{ key: 'b1', pool: 'back', host: '127.0.0.1', port: BACK, weight: 1 }],
  certificates: [], tlsPolicies: [], sniBindings: [],
};

// 출발지 · 경로마다 「Location 의 호스트+경로」 또는 상태 코드를 낸다.
const PROBE = `
hit() { out=$(curl -s -o /dev/null -D - --interface "$1" -H 'Host: x.test' "http://127.0.0.1:${FRONT}$2" 2>/dev/null)
  loc=$(printf '%s' "$out" | tr -d '\\r' | sed -n 's/^[Ll]ocation: https:\\/\\/\\(.*\\)$/\\1/p')
  code=$(printf '%s' "$out" | head -1 | awk '{print $2}')
  if [ -n "$loc" ]; then echo "$loc"; else echo "code=$code"; fi; }
echo "s1=$(hit 127.0.0.1 /api/users)"
echo "s2=$(hit 127.0.0.2 /api/users?q=1)"
echo "s2v2=$(hit 127.0.0.2 /v2/items)"
echo "s3=$(hit 127.0.0.5 /api/users)"
echo "s4=$(hit 127.0.0.4 /api/users)"
via() { curl -s -o /dev/null -D - --interface "$1" -H 'Host: x.test' -H "X-Real-IP: $2" "http://127.0.0.1:${VIA}/" 2>/dev/null | tr -d '\\r' | sed -n 's/^[Ll]ocation: https:\\/\\/\\(.*\\)$/\\1/p'; }
echo "via_trusted=$(via 127.0.0.1 203.0.113.7)"
echo "via_untrusted=$(via 127.0.0.2 203.0.113.7)"
`;

function serve(conf: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-srcrule-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\n${conf}`, 'utf8');
    writeFileSync(join(dir, 'probe.sh'), PROBE, 'utf8');
    return execFileSync('docker',
      ['run', '--rm', '-v', `${dir}:/prefix:Z`, '--entrypoint', '/bin/sh', IMAGE, '-c',
        'apk add --no-cache curl >/dev/null 2>&1 || { echo "설치 실패 (망?)" >&2; exit 70; }; '
        + '/usr/local/openresty/bin/openresty -p /prefix -c conf/nginx.conf & sleep 1.5; '
        + 'sh /prefix/probe.sh; echo "---errorlog---"; tail -5 /prefix/logs/error.log'],
      { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } finally {
    dropScratch(dir);
  }
}

const value = (out: string, k: string): string | undefined =>
  new RegExp(`^${k}=(.*)$`, 'm').exec(out)?.[1];

describe('출발지 규칙 — 실물 nginx', () => {
  let out = '';
  beforeAll(() => {
    if (!dockerAvailable()) return;
    // 렌더가 던지면(수정 전) 그 말을 담아 둔다 — 여기서 던지면 시험이 0 건으로 끝난다.
    try { out = serve(render(model, caps).conf); } catch (e) { out = `render-failed: ${String(e)}`; }
  }, 300_000);

  it('검증기가 이 모델을 받는다', () => {
    expect(validateModel(model, caps)).toEqual([]);
  });

  it('**출발지마다 다른 동작으로 간다** — 맞는 규칙이 없으면 기본 동작이다', () => {
    if (!dockerAvailable()) return;
    expect(value(out, 's1'), out).toBe('default/');
    expect(value(out, 's3'), out).toBe('rule-two/');
    expect(value(out, 's4'), out).toBe('code=403');
  });

  it('**출발지는 원본 IP 헤더가 바꾼 뒤의 방문자 주소다** — 믿지 않는 앞단의 헤더는 안 먹는다', () => {
    if (!dockerAvailable()) return;
    expect(value(out, 'via_trusted'), out).toBe('visitor/');
    expect(value(out, 'via_untrusted'), out).toBe('not-visitor/');
  });

  it('**프록시 규칙은 경로 바꾸기까지 한다** — 쿼리는 그대로, 경로마다 같다', () => {
    if (!dockerAvailable()) return;
    expect(value(out, 's2'), out).toBe('back/v1/users?q=1');
    expect(value(out, 's2v2'), out).toBe('back/v1/items');
  });
});

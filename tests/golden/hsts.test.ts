/**
 * HSTS (DESIGN.md §4.6)
 *
 * ── 왜 이게 조심스러운 기능인가 ─────────────────────────────────────────
 *
 * HSTS 는 **클라이언트 쪽에서 되돌릴 수 없다.** `max-age` 동안 브라우저가 이 도메인을
 * https 로만 가고, 인증서가 깨지면 사용자에게 우회 수단이 없다. 설정을 되돌려도 이미
 * 나간 헤더는 회수가 안 된다. 그래서 **기본이 꺼짐**이고, 여기서는 켰을 때 **정확히
 * 무엇이 나가는지**를 잰다.
 *
 * ── 그리고 nginx 의 함정 ────────────────────────────────────────────────
 *
 * **`add_header` 는 상속이 아니라 대체다.** location 에 `add_header` 가 하나라도 있으면
 * 상위 server 의 것이 **전부 사라진다.** 실측했다:
 *
 * ```
 * 자기 add_header 가 없는 location → HSTS 나온다
 * 자기 add_header 가 있는 location → **안 나온다**
 * ```
 *
 * 지금 렌더러는 location 에 `add_header` 를 하나도 안 낸다. **그 사실에 기대고 있어서**,
 * 아래 마지막 테스트가 그 불변식을 지킨다.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dropScratch } from '../scratch.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import { ModelValidationError } from '../../src/validate/model.js';
import type { HstsPolicy, Model } from '../../src/model/provisional.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'openresty/openresty:alpine';
const PORT = 18921;
const V = 'a'.repeat(32);

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const model = (hsts?: HstsPolicy): Model => ({
  listeners: [{
    key: 'l', protocol: 'https', bind: '0.0.0.0', port: PORT, enabled: true,
    tls: { policy: 'p', defaultCertificate: 'c' }, http: { defaultAction: 'reject' },
  }],
  httpRoutes: [
    { key: 'ok', listener: 'l', hosts: ['a.test'], priority: 10,
      action: { kind: 'redirect', to: 'https://x/', status: 302 } },
    // **에러 응답에도 붙어야 한다.** 인증서가 깨져 5xx 를 내는 동안 HSTS 가 사라지면
    // 의미가 정반대다 — `always` 가 그것을 한다.
    { key: 'err', listener: 'l', hosts: ['a.test'], priority: 20, pathPrefix: '/deny',
      action: { kind: 'reject', status: 403 } },
  ],
  passthroughRoutes: [], pools: [], backends: [],
  certificates: [{ key: 'c', materialRef: `store://c@${V}`,
    chainDigest: `sha256:${'0'.repeat(64)}`, keyDigest: `sha256:${'1'.repeat(64)}` }],
  tlsPolicies: [{ key: 'p', minVersion: '1.2', ...(hsts === undefined ? {} : { hsts }) }],
  sniBindings: [{ key: 'b', listener: 'l', hosts: ['a.test'], certificate: 'c' }],
});

const caps = { httpLua: false, streamLua: false, streamRealip: true, sslConfCommand: true };

const PROBE = `
hdr() {
  curl -sk -o /dev/null -D - --resolve a.test:${PORT}:127.0.0.1 "https://a.test:${PORT}$1" 2>/dev/null \\
    | tr -d '\\r' | sed -n 's/^[Ss]trict-[Tt]ransport-[Ss]ecurity: //p'
}
echo "root=$(hdr /)"
echo "deny=$(hdr /deny)"
`;

function serve(conf: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-hsts-'));
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\n${conf}`, 'utf8');
    writeFileSync(join(dir, 'probe.sh'), PROBE, 'utf8');
    return execFileSync('docker',
      ['run', '--rm', '-v', `${dir}:/prefix`, '--entrypoint', '/bin/sh', IMAGE, '-c',
        'apk add --no-cache openssl curl >/dev/null 2>&1; ' +
        `mkdir -p /prefix/conf/certs/c/${V} && ` +
        'openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=a.test" ' +
        '-addext "subjectAltName=DNS:a.test" ' +
        `-keyout /prefix/conf/certs/c/${V}/privkey.pem ` +
        `-out /prefix/conf/certs/c/${V}/fullchain.pem >/dev/null 2>&1; ` +
        '/usr/local/openresty/bin/openresty -p /prefix -c conf/nginx.conf & sleep 1.5; ' +
        'sh /prefix/probe.sh; echo "---errorlog---"; tail -3 /prefix/logs/error.log'],
      { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } finally {
    dropScratch(dir);
  }
}

describe('HSTS — 나가는 헤더로 판정한다', () => {
  let on = '';
  let off = '';

  beforeAll(() => {
    if (!dockerAvailable()) return;
    on = serve(render(model({ maxAgeSeconds: 31536000, includeSubdomains: true }), caps).conf);
    off = serve(render(model(), caps).conf);
  }, 300_000);

  const val = (out: string, k: string): string =>
    out.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim() ?? '';

  it.runIf(dockerAvailable())('**기본은 안 낸다** — 되돌릴 수 없는 설정이다', () => {
    expect(val(off, 'root'), off).toBe('');
    expect(val(off, 'deny'), off).toBe('');
  });

  it.runIf(dockerAvailable())('켜면 정확히 그 값이 나간다', () => {
    expect(val(on, 'root'), on).toBe('max-age=31536000; includeSubDomains');
  });

  it.runIf(dockerAvailable())(
    '**에러 응답에도 붙는다** — 없으면 의미가 정반대다 (`always`)',
    () => {
      // 인증서가 깨져 5xx 를 내는 동안 HSTS 가 사라지면, 그때가 바로 downgrade 를
      // 막아야 하는 순간이다.
      expect(val(on, 'deny'), on).toBe('max-age=31536000; includeSubDomains');
    },
  );
});

describe('preload 는 요구조건을 강제한다', () => {
  const build = (h: HstsPolicy): (() => unknown) => () => render(model(h), caps);

  it('**max-age 가 1년 미만이면 거절한다** — 목록이 요구한다', () => {
    expect(build({ maxAgeSeconds: 86400, includeSubdomains: true, preload: true }))
      .toThrow(ModelValidationError);
  });

  it('**includeSubdomains 없이 preload 는 거절한다**', () => {
    expect(build({ maxAgeSeconds: 31536000, preload: true })).toThrow(ModelValidationError);
  });

  it('둘 다 갖추면 통과한다', () => {
    expect(build({ maxAgeSeconds: 31536000, includeSubdomains: true, preload: true }))
      .not.toThrow();
  });

  it('preload 없이 짧은 max-age 는 정당하다 — 처음 켤 때 그렇게 한다', () => {
    expect(build({ maxAgeSeconds: 300 })).not.toThrow();
  });
});

describe('add_header 상속 함정 (§4.6)', () => {
  it('**렌더러는 location 에 `add_header` 를 안 낸다** — 내면 HSTS 가 사라진다', () => {
    // nginx 의 `add_header` 는 상속이 아니라 **대체**다. location 에 하나라도 있으면
    // 상위 server 의 것이 전부 사라진다(실측). 지금은 그 사실에 기대고 있으므로,
    // 응답 헤더 기능을 라우트에 붙이는 사람은 여기서 걸려야 한다.
    const conf = render(model({ maxAgeSeconds: 300 }), caps).conf;
    const locations = conf.split(/\n(?=\s*location )/).slice(1);
    expect(locations.length).toBeGreaterThan(0);
    for (const block of locations) {
      const body = block.slice(0, block.indexOf('\n        }'));
      expect(body, `location 안에 add_header 가 생겼다:\n${body}`).not.toContain('add_header');
    }
  });
});

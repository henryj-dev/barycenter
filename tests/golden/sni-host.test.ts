/**
 * SNI ↔ Host 불일치 (DESIGN.md §4.6)
 *
 * §4.6 이 *"둘이 다를 수 있다는 사실 자체를 모델이 인정해야 한다"* 고 적어 뒀다. 실측하면
 * 왜인지 보인다 — **인증서는 한쪽 것이고 응답은 다른 쪽 것이다**:
 *
 * ```
 * SNI=a.test + Host=b.test → 인증서 a.test / 응답 TENANT-B
 * ```
 *
 * handshake 는 SNI 로, 요청은 Host 로 server 를 고르기 때문이다. 그 자체로 권한 상승은
 * 아니다(클라이언트가 처음부터 SNI=b 로 붙을 수 있었다). 위험은 **운영자가 "a 의 인증서를
 * 받았으면 a 의 트래픽" 이라고 가정할 때** 생기고, **HTTP/2 가 그 가정을 깬다** —
 * 브라우저는 인증서가 덮는 다른 오리진에 같은 커넥션을 재사용한다(RFC 7540 §9.1.1).
 * 그래서 그 RFC 가 **421 Misdirected Request** 를 답으로 정해 뒀다.
 *
 * 여기서는 `reject_421` 을 켰을 때 **실제로 421 이 나오는지**, 그리고 **정당한 트래픽을
 * 안 끊는지**를 잰다. 후자가 더 중요하다 — 잘못 켜면 서비스가 죽는다.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dropScratch } from '../scratch.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const PORT = 18901;

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const REF = (n: string): string => `store://${n}@${'a'.repeat(32)}`;
const D = (c: string): string => `sha256:${c.repeat(64)}`;

/** 두 테넌트. 각자 인증서와 각자 라우트. */
const model = (mismatch: 'allow' | 'reject_421'): Model => ({
  listeners: [{
    key: 'l', protocol: 'https', bind: '0.0.0.0', port: PORT, enabled: true,
    tls: { policy: 'p', defaultCertificate: 'cert-a' },
    http: { defaultAction: 'reject' },
  }],
  httpRoutes: [
    { key: 'ra', listener: 'l', hosts: ['a.test'], priority: 10,
      action: { kind: 'redirect', to: 'https://tenant-a/', status: 302 } },
    { key: 'rb', listener: 'l', hosts: ['b.test'], priority: 10,
      action: { kind: 'redirect', to: 'https://tenant-b/', status: 302 } },
  ],
  passthroughRoutes: [], pools: [], backends: [],
  certificates: [
    { key: 'cert-a', materialRef: REF('a'), chainDigest: D('0'), keyDigest: D('1') },
    { key: 'cert-b', materialRef: REF('b'), chainDigest: D('2'), keyDigest: D('3') },
  ],
  tlsPolicies: [{ key: 'p', minVersion: '1.2', sniHostMismatch: mismatch }],
  sniBindings: [
    { key: 'ba', listener: 'l', hosts: ['a.test'], certificate: 'cert-a' },
    { key: 'bb', listener: 'l', hosts: ['b.test'], certificate: 'cert-b' },
  ],
});

const CERTS = [{ key: 'cert-a', cn: 'a.test' }, { key: 'cert-b', cn: 'b.test' }];

function serve(conf: string, probe: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-snihost-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\n${conf}`, 'utf8');
    writeFileSync(join(dir, 'probe.sh'), probe, 'utf8');
    const mk = CERTS.map((c) =>
      `mkdir -p /prefix/conf/certs/${c.key}/${'a'.repeat(32)} && ` +
      `openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=${c.cn}" ` +
      `-addext "subjectAltName=DNS:${c.cn}" ` +
      `-keyout /prefix/conf/certs/${c.key}/${'a'.repeat(32)}/privkey.pem ` +
      `-out /prefix/conf/certs/${c.key}/${'a'.repeat(32)}/fullchain.pem >/dev/null 2>&1`).join('; ');
    return execFileSync('docker',
      ['run', '--rm', '-v', `${dir}:/prefix`, '--entrypoint', '/bin/sh', IMAGE, '-c',
        'apk add --no-cache openssl >/dev/null 2>&1; ' + mk + '; ' +
        '/usr/local/openresty/bin/openresty -p /prefix -c conf/nginx.conf & sleep 1.5; ' +
        'sh /prefix/probe.sh; echo "---errorlog---"; tail -4 /prefix/logs/error.log'],
      { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } finally {
    dropScratch(dir);
  }
}

const PROBE = `
code() {
  printf "GET / HTTP/1.1\\r\\nHost: %s\\r\\nConnection: close\\r\\n\\r\\n" "$2" \\
    | timeout 5 openssl s_client -connect 127.0.0.1:${PORT} -servername "$1" -quiet 2>/dev/null \\
    | head -1 | tr -d '\\r' | awk '{print $2}'
}
nosni() {
  printf "GET / HTTP/1.1\\r\\nHost: %s\\r\\nConnection: close\\r\\n\\r\\n" "$1" \\
    | timeout 5 openssl s_client -connect 127.0.0.1:${PORT} -noservername -quiet 2>/dev/null \\
    | head -1 | tr -d '\\r' | awk '{print $2}'
}
echo "match=$(code a.test a.test)"
echo "mismatch=$(code a.test b.test)"
echo "port=$(code a.test a.test:${PORT})"
echo "upper=$(code a.test A.TEST)"
echo "nosni=$(nosni a.test)"
`;

const caps = { httpLua: false, streamLua: false, streamRealip: true, http2: true };

describe('SNI↔Host 불일치 (§4.6)', () => {
  let guarded = '';
  let open = '';

  beforeAll(() => {
    if (!dockerAvailable()) return;
    guarded = serve(render(model('reject_421'), caps).conf, PROBE);
    open = serve(render(model('allow'), caps).conf, PROBE);
  }, 300_000);

  const val = (out: string, k: string): string =>
    out.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim() ?? '(없음)';

  it.runIf(dockerAvailable())('**기본(allow)은 안 막는다** — 불일치도 그대로 지난다', () => {
    // 이게 §4.6 이 말한 사실이다. 막는 것이 기본이면 옛 클라이언트가 끊긴다.
    expect(val(open, 'match'), open).toBe('302');
    expect(val(open, 'mismatch'), open).toBe('302');
  });

  it.runIf(dockerAvailable())('**reject_421 은 불일치를 421 로 막는다** (RFC 7540 §9.1.1)', () => {
    expect(val(guarded, 'mismatch'), guarded).toBe('421');
  });

  it.runIf(dockerAvailable())(
    '**정당한 트래픽을 안 끊는다** — 잘못 켜면 서비스가 죽는 자리다',
    () => {
      expect(val(guarded, 'match'), guarded).toBe('302');
      // `$host` 가 포트를 떼고 소문자로 내린다 — 실측이다. 안 그러면 흔한 요청이 전부
      // 421 이 된다.
      expect(val(guarded, 'port'), guarded).toBe('302');
      expect(val(guarded, 'upper'), guarded).toBe('302');
    },
  );

  it.runIf(dockerAvailable())(
    '**SNI 가 없으면 통과시킨다** — 비교할 것이 없다',
    () => {
      // 여기서 막으면 SNI 를 안 보내는 옛 클라이언트가 통째로 끊긴다.
      expect(val(guarded, 'nosni'), guarded).toBe('302');
    },
  );
});

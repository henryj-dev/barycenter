/**
 * 암호군 정책 (DESIGN.md §4.6 — `CipherPolicyRef`)
 *
 * §4.6 이 *"버전된 정책 참조. 자유 문자열이 아니다. **TLS1.2 이하와 TLS1.3 산출물을
 * 분리한다**"* 고 적어 뒀다. 그 분리가 왜 필요한지는 재 보면 보인다:
 *
 * ```
 * ssl_ciphers ECDHE-RSA-AES128-GCM-SHA256
 *   → TLS1.2 는 그것,  TLS1.3 은 TLS_AES_256_GCM_SHA384  (전혀 다른 것)
 * ```
 *
 * **`ssl_ciphers` 는 TLS1.3 에 안 걸린다.** 그걸 모르고 "약한 암호를 껐다" 고 믿으면
 * 1.3 쪽은 손도 안 댄 것이다. 그래서 1.3 은 `ssl_conf_command Ciphersuites` 로 따로 낸다.
 *
 * 판정은 **협상된 암호군**으로 한다 — conf 문자열이 아니라.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { dropScratch } from '../scratch.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { render } from '../../src/conf/render.js';
import type { CipherPolicyRef, Model } from '../../src/model/provisional.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const PORT = 18911;
const V = 'a'.repeat(32);

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const model = (cipher: CipherPolicyRef): Model => ({
  listeners: [{
    key: 'l', protocol: 'https', bind: '0.0.0.0', port: PORT, enabled: true,
    tls: { policy: 'p', defaultCertificate: 'c' }, http: { defaultAction: 'reject' },
  }],
  httpRoutes: [{ key: 'r', listener: 'l', hosts: ['a.test'], priority: 10,
    action: { kind: 'redirect', to: 'https://x/', status: 302 } }],
  passthroughRoutes: [], pools: [], backends: [],
  certificates: [{ key: 'c', materialRef: `store://c@${V}`,
    chainDigest: `sha256:${'0'.repeat(64)}`, keyDigest: `sha256:${'1'.repeat(64)}` }],
  tlsPolicies: [{ key: 'p', minVersion: '1.2', cipherPolicy: cipher }],
  sniBindings: [{ key: 'b', listener: 'l', hosts: ['a.test'], certificate: 'c' }],
});

/** **`New, TLSvX, Cipher is Y` 로 읽는다.** 들여쓴 `Cipher :` 블록은 TLS1.3 에서 안 나온다 —
 *  그걸로 재다가 "TLS1.3 이 아예 안 붙는다" 는 잘못된 결론을 한 번 냈다. */
const PROBE = `
try() {
  out=$(echo | timeout 5 openssl s_client -connect 127.0.0.1:${PORT} -servername a.test $1 2>&1)
  case "$out" in
    *"Cipher is (NONE)"*|*alert*|*failure*) echo "거절" ;;
    *"Cipher is "*) echo "$out" | sed -n 's/^New, [^,]*, Cipher is //p' | head -1 ;;
    *) echo "거절" ;;
  esac
}
echo "tls12=$(try -tls1_2)"
echo "tls13=$(try -tls1_3)"
# **여기가 판정이다.** 비-PFS·CBC 를 요구했을 때 우리 정책은 거절하고, nginx 기본값
# (HIGH:!aNULL:!MD5)은 **받아 준다.** 이 차이가 없으면 위 두 줄은 기본값과 구분이 안 된다.
echo "weak=$(try '-tls1_2 -cipher AES128-SHA')"
`;

function serve(conf: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-ciph-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\n${conf}`, 'utf8');
    writeFileSync(join(dir, 'probe.sh'), PROBE, 'utf8');
    return execFileSync('docker',
      ['run', '--rm', '-v', `${dir}:/prefix:Z`, '--entrypoint', '/bin/sh', IMAGE, '-c',
        'apk add --no-cache openssl >/dev/null 2>&1; ' +
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

const caps = { httpLua: false, streamLua: false, streamRealip: true, sslConfCommand: true };

describe('암호군 정책 — 협상된 것으로 판정한다', () => {
  let modern = '';
  let noConf = '';

  beforeAll(() => {
    if (!dockerAvailable()) return;
    modern = serve(render(model('modern-2026'), caps).conf);
    // 엔진이 `ssl_conf_command` 를 못 낸다고 하면 **TLS1.3 을 손 못 댄다.**
    noConf = serve(render(model('modern-2026'), { ...caps, sslConfCommand: false }).conf);
  }, 300_000);

  const val = (out: string, k: string): string =>
    out.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim() ?? '(없음)';

  it.runIf(dockerAvailable())(
    '**비-PFS 암호군을 거절한다** — nginx 기본값은 받아 준다',
    () => {
      // 처음엔 "협상된 것이 ECDHE 로 시작한다" 로 쟀는데 **변별력이 0 이었다** —
      // nginx 기본값(`HIGH:!aNULL:!MD5`)도 ECDHE 를 고른다. `ssl_ciphers` 를 통째로
      // 빼는 변이가 그대로 통과했다.
      //
      // 구분되는 것은 **우리가 뺀 것을 요구했을 때**다. `AES128-SHA` 는 PFS 도 AEAD 도
      // 아니고, 기본값에는 있고 우리 정책에는 없다.
      expect(val(modern, 'weak'), modern).toBe('거절');
    },
  );

  it.runIf(dockerAvailable())('정상 연결은 우리 목록 안에서 협상된다', () => {
    expect(val(modern, 'tls12'), modern).toMatch(/^ECDHE-(RSA|ECDSA)-(AES(128|256)-GCM|CHACHA20)/);
  });

  it.runIf(dockerAvailable())(
    'TLS1.3 은 **`ssl_ciphers` 로 못 건드린다** — 별도 산출물이라는 사실 자체가 계약이다',
    () => {
      // ⚠️ **이 단언은 오늘 변별력이 약하다.** `modern-2026` 의 1.3 목록이 OpenSSL
      // 기본값과 같아서, `ssl_conf_command` 를 빼도 협상 결과가 안 바뀐다.
      //
      // 그래도 내는 이유는 **엔진 기본값이 바뀌어도 우리 설정이 안 바뀌게** 하기
      // 위해서다(재현 가능한 배포). 안 낸다면 그건 "지금 기본값과 같으니 생략" 이고,
      // 기본값이 움직이는 날 조용히 따라 움직인다.
      //
      // 여기서 확실히 재는 것은 **1.2 와 1.3 이 서로 다른 값으로 협상된다**는 것 —
      // 즉 한 필드로 둘을 함께 정할 수 없다는 §4.6 의 전제다.
      expect(val(modern, 'tls13'), modern).toMatch(/^TLS_/);
      expect(val(modern, 'tls13')).not.toBe(val(modern, 'tls12'));
    },
  );

  it.runIf(dockerAvailable())(
    '`ssl_conf_command` 가 없는 엔진에서도 1.2 정책은 그대로 걸린다',
    () => {
      expect(val(noConf, 'weak'), noConf).toBe('거절');
      expect(val(noConf, 'tls13'), noConf).toMatch(/^TLS_/);
    },
  );
});

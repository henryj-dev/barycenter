/**
 * TLS 종단 — **렌더 산출물이 실제 엔진에서 인증서를 옳게 제시하는가** (§4.6, §12.0 S16·S17)
 *
 * S16·S17 은 손으로 쓴 conf 로 *엔진이 무엇을 하는가*를 쟀다. 여기서는 **렌더러가 낸
 * conf** 로 같은 것을 잰다. 둘은 다른 질문이다 — 스파이크가 통과해도 렌더러가 그 규칙을
 * 안 따르면 아무것도 보장되지 않는다.
 *
 * 특히 이 저장소가 반복해서 밟은 함정이 *"필드는 있는데 아무도 안 읽는다"* 이다.
 * `sniBindings` 를 모델에 넣어 놓고 렌더러가 default 인증서만 낸다면, 타입도 통과하고
 * `nginx -t` 도 통과하고 **트래픽도 흐른다.** 틀린 인증서로.
 *
 * 도커가 필요하다:  npm run test:golden
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

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * 렌더 산출물로 nginx 를 띄우고 프로브를 돌린다.
 *
 * **인증서를 세대 안에 만들어 넣는다.** `certKeys` 마다 `conf/certs/<key>/` 에 자기
 * 이름을 CN 으로 한 자체서명 인증서를 굽는다 — 어느 인증서가 제시됐는지 CN 으로 알 수
 * 있어야 하기 때문이다. 경로는 렌더러가 내는 것과 같은 **conf_prefix 상대경로**다(§7.2).
 */
function serveTls(
  conf: string,
  certs: readonly { key: string; version: string; cn: string; san: string }[],
  probe: string,
): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-tls-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\n${conf}`, 'utf8');
    const mkcerts = certs.map((c) =>
      // **경로에 버전이 들어간다** — 렌더러의 `certPaths` 와 같은 규칙이다. 갱신이 곧
      // 다른 conf 가 되게 하려고 그렇게 정했다.
      `mkdir -p /prefix/conf/certs/${c.key}/${c.version} && ` +
      `openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj "/CN=${c.cn}" ` +
      `-addext "subjectAltName=${c.san}" ` +
      `-keyout /prefix/conf/certs/${c.key}/${c.version}/privkey.pem ` +
      `-out /prefix/conf/certs/${c.key}/${c.version}/fullchain.pem >/dev/null 2>&1`,
    ).join('; ');
    writeFileSync(join(dir, 'probe.sh'), probe, 'utf8');
    return execFileSync(
      'docker',
      ['run', '--rm', '-v', `${dir}:/prefix:Z`, '--entrypoint', '/bin/sh', IMAGE, '-c',
        'apk add --no-cache openssl curl >/dev/null 2>&1; ' + mkcerts + '; ' +
        '/usr/local/openresty/bin/openresty -p /prefix -c conf/nginx.conf & sleep 1.5; ' +
        'sh /prefix/probe.sh; echo "---errorlog---"; tail -5 /prefix/logs/error.log'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString().trim();
  } finally {
    dropScratch(dir);
  }
}

/**
 * 제시된 인증서의 CN 과 협상된 버전을 읽는 셸 함수들.
 *
 * **`Protocol :` 줄로 성공을 판정하지 않는다.** s_client 는 자기 설정을 거기 찍으므로,
 * 서버가 alert 70 으로 끊어도 그대로 나온다 — S16 이 이 함정을 실제로 밟았고, 그때는
 * *모든 조합이 통과로 보였다.* handshake 가 실제로 섰는지로 판정한다.
 */
const HELPERS = `
cn() {
  echo | timeout 5 openssl s_client -connect 127.0.0.1:$1 -servername "$2" 2>/dev/null \\
    | openssl x509 -noout -subject 2>/dev/null | sed 's/.*CN *= *//'
}
cn_nosni() {
  echo | timeout 5 openssl s_client -connect 127.0.0.1:$1 -noservername 2>/dev/null \\
    | openssl x509 -noout -subject 2>/dev/null | sed 's/.*CN *= *//'
}
alpn() {
  echo | timeout 5 openssl s_client -connect 127.0.0.1:$1 -servername "$2" \\
    -alpn h2,http/1.1 2>/dev/null | sed -n 's/^ALPN protocol: //p'
}
hs() {
  out=$(echo | timeout 5 openssl s_client -connect 127.0.0.1:$1 -servername "$2" "$3" 2>&1)
  case "$out" in
    *"Cipher is (NONE)"*|*"alert protocol version"*|*"unsupported protocol"*) echo "거절" ;;
    *"Cipher is "*) echo "$out" | sed -n 's/^New, \\(TLSv[0-9.]*\\),.*/\\1/p' | head -1 ;;
    *) echo "거절" ;;
  esac
}
`;

const PORT = 18443;

const model: Model = {
  listeners: [{
    key: 'l-tls', protocol: 'https', bind: '0.0.0.0', port: PORT, enabled: true,
    tls: { policy: 'modern', defaultCertificate: 'cert-default' },
    http: { defaultAction: 'reject' },
    // 기본(생략)이 켜는 것이다 — 아래 alpn 테스트가 그걸 잰다.
  }],
  httpRoutes: [
    { key: 'r-a', listener: 'l-tls', hosts: ['a.test'], priority: 10,
      action: { kind: 'reject', status: 403 } },
    { key: 'r-wild', listener: 'l-tls', hosts: ['*.wild.test'], priority: 10,
      action: { kind: 'reject', status: 403 } },
    { key: 'r-old', listener: 'l-tls', hosts: ['old.test'], priority: 10,
      action: { kind: 'reject', status: 403 } },
  ],
  passthroughRoutes: [],
  pools: [],
  backends: [],
  certificates: [
    { key: 'cert-default', materialRef: 'store://default@' + 'a'.repeat(32),
      chainDigest: `sha256:${'0'.repeat(64)}`, keyDigest: `sha256:${'1'.repeat(64)}` },
    { key: 'cert-a', materialRef: 'store://a@' + 'b'.repeat(32),
      chainDigest: `sha256:${'2'.repeat(64)}`, keyDigest: `sha256:${'3'.repeat(64)}` },
    { key: 'cert-wild', materialRef: 'store://wild@' + 'c'.repeat(32),
      chainDigest: `sha256:${'4'.repeat(64)}`, keyDigest: `sha256:${'5'.repeat(64)}` },
  ],
  tlsPolicies: [{ key: 'modern', minVersion: '1.2' }],
  sniBindings: [
    { key: 'b-a', listener: 'l-tls', hosts: ['a.test'], certificate: 'cert-a' },
    { key: 'b-wild', listener: 'l-tls', hosts: ['*.wild.test'], certificate: 'cert-wild' },
    // **override 로 이 호스트만 TLS1.3 이상.** S16 이 성립을 실측했으므로 표시가 아니라
    // 실물이어야 한다.
    { key: 'b-old', listener: 'l-tls', hosts: ['old.test'], certificate: 'cert-default',
      override: { minVersion: '1.3' } },
  ],
};

/** 버전은 모델의 `materialRef` 에서 뽑는다 — 렌더러가 경로에 쓰는 그 값이다. */
const versionOf = (certKey: string): string =>
  model.certificates.find((c) => c.key === certKey)!.materialRef!.split('@')[1]!;

const CERTS = [
  { key: 'cert-default', version: versionOf('cert-default'),
    cn: 'default.test', san: 'DNS:default.test,DNS:old.test' },
  { key: 'cert-a', version: versionOf('cert-a'), cn: 'a.test', san: 'DNS:a.test' },
  { key: 'cert-wild', version: versionOf('cert-wild'), cn: '*.wild.test', san: 'DNS:*.wild.test' },
];

describe('TLS 종단 — 실제 엔진', () => {
  let out = '';

  beforeAll(() => {
    if (!dockerAvailable()) return;
    const conf = render(model,
      { httpLua: false, streamLua: false, streamRealip: true, http2: true }).conf;
    out = serveTls(conf, CERTS, `
${HELPERS}
echo "exact=$(cn ${PORT} a.test)"
echo "wild=$(cn ${PORT} x.wild.test)"
echo "deep=$(cn ${PORT} deep.x.wild.test)"
echo "unknown=$(cn ${PORT} nope.test)"
echo "nosni=$(cn_nosni ${PORT})"
echo "old12=$(hs ${PORT} old.test -tls1_2)"
echo "old13=$(hs ${PORT} old.test -tls1_3)"
echo "a12=$(hs ${PORT} a.test -tls1_2)"
echo "alpn_a=$(alpn ${PORT} a.test)"
echo "alpn_default=$(alpn ${PORT} nope.test)"
`);
  }, 180_000);

  const val = (k: string): string =>
    out.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim() ?? '(없음)';

  it.runIf(dockerAvailable())('**SNI 마다 자기 인증서를 제시한다** — 바인딩이 실제로 읽힌다', () => {
    expect(val('exact'), out).toBe('a.test');
    expect(val('wild'), out).toBe('*.wild.test');
  });

  it.runIf(dockerAvailable())(
    '**다중 라벨은 와일드카드 인증서를 못 받는다** — S17 이 겨눈 SAN 미커버 제시',
    () => {
      // 렌더러가 `server_name *.wild.test` 를 냈다면 여기서 `*.wild.test` 가 나온다.
      // 앵커 정규식으로 냈으므로 default 로 떨어진다.
      expect(val('deep'), out).toBe('default.test');
    },
  );

  it.runIf(dockerAvailable())(
    '**모르는 SNI 와 SNI 부재는 default_server 인증서** — 첫 블록으로 새지 않는다',
    () => {
      expect(val('unknown'), out).toBe('default.test');
      expect(val('nosni'), out).toBe('default.test');
    },
  );

  /**
   * **§4.9 — ALPN 을 잰다. conf 문자열이 아니라.**
   *
   * `http2 on;` 이 conf 에 있다는 것과 클라이언트가 h2 를 받는다는 것은 다르다. nginx
   * 1.25.1 부터 기본이 off 라, 이 줄을 안 내면 **클라이언트가 h2 를 제안해도 http/1.1
   * 로 떨어진다** — 그리고 그건 트래픽을 봐야만 보인다.
   */
  it.runIf(dockerAvailable())('**HTTP/2 가 실제로 협상된다** — 기본이 켜는 것이다', () => {
    expect(val('alpn_a'), out).toBe('h2');
    // default_server 에도 나야 한다. 첫 발급 직후처럼 라우트가 아직 없는 호스트도
    // h2 로 붙는다.
    expect(val('alpn_default'), out).toBe('h2');
  });

  it.runIf(dockerAvailable())(
    '**override 가 실제 handshake 에 걸린다** — 그 호스트만 TLS1.3 이상',
    () => {
      expect(val('old12'), out).toBe('거절');
      expect(val('old13'), out).toBe('TLSv1.3');
      // 같은 리스너의 다른 호스트는 정책대로 1.2 를 받는다. 이게 없으면 "리스너 전체가
      // 조인 것" 과 구분이 안 된다.
      expect(val('a12'), out).toBe('TLSv1.2');
    },
  );
});

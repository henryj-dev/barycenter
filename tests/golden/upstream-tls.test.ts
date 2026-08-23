/**
 * `upstream_tls` — **실물 nginx 가 이 설정을 받는가** (§4.3, 골든)
 *
 * 단위는 문자열을 본다. 그건 "우리가 낸 줄이 맞다" 까지고, **nginx 가 그 줄을
 * 받아들이는지**는 다른 물음이다. `proxy_ssl_*` 는 http 와 stream 에서 **모듈이
 * 다르고**(`ngx_http_proxy` · `ngx_stream_proxy`), 같은 이름이 두 컨텍스트에서 다
 * 유효한지는 실물이 답한다.
 *
 * 특히 stream 의 `proxy_ssl_trusted_certificate` 는 파일이 **있어야** conf 검사를
 * 통과한다 — 그래서 세대 배치를 흉내 내 파일을 함께 놓는다. 그게 실제 배포의 모양이고
 * (`certs/<key>/<version>/fullchain.pem`), 그 경로가 틀리면 여기서 죽는다.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { dropScratch } from '../scratch.js';
import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const VERSION = '0123456789abcdef';

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const CA = {
  key: 'upstream-ca',
  materialRef: `store://upstream-ca@${VERSION}`,
  chainDigest: 'sha256:c',
  keyDigest: 'sha256:k',
};

const model = (upstreamTls: unknown): Model => ({
  listeners: [
    {
      key: 'web', protocol: 'http', bind: '0.0.0.0', port: 18971, enabled: true,
      http: { defaultAction: { pool: 'app' } },
    },
    {
      key: 'raw', protocol: 'tcp', bind: '0.0.0.0', port: 18972, enabled: true,
      defaultPool: 'tcpapp',
    },
  ],
  httpRoutes: [], passthroughRoutes: [],
  pools: [
    { key: 'app', protocolClass: 'http', algorithm: 'round_robin', upstreamTls },
    { key: 'tcpapp', protocolClass: 'tcp', algorithm: 'round_robin', upstreamTls },
  ],
  backends: [
    { key: 'a', pool: 'app', host: '10.0.0.1', port: 443, weight: 1 },
    { key: 't', pool: 'tcpapp', host: '10.0.0.2', port: 443, weight: 1 },
  ],
  certificates: [CA], tlsPolicies: [], sniBindings: [],
} as unknown as Model);

/**
 * 자체서명 인증서 하나를 만들어 세대 배치대로 놓고 `nginx -t` 를 돌린다.
 *
 * **번들 파일을 진짜로 만든다.** `proxy_ssl_trusted_certificate` 는 없는 파일을 가리키면
 * conf 검사에서 죽는다 — 그 죽음이 이 테스트가 잡으려는 것 중 하나다(경로 규칙이
 * `certPaths` 와 어긋나면 여기서 드러난다).
 */
function configTest(upstreamTls: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-uts-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    const conf = render(model(upstreamTls)).conf;
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\nworker_processes 1;\n${conf}`, 'utf8');
    /**
     * **`conf/` 밑에 둔다.** nginx 는 상대 경로를 `-p` prefix 가 아니라 **conf 파일이
     * 있는 디렉토리** 기준으로 푼다 — 처음에 prefix 기준으로 뒀다가 실물이
     * `cannot load certificate "/w/conf/certs/…"` 로 알려 줬다. 기존 TLS 골든도 같은
     * 자리에 놓는다.
     */
    const bundle = join(dir, 'conf', 'certs', 'upstream-ca', VERSION, 'fullchain.pem');
    mkdirSync(dirname(bundle), { recursive: true });
    execFileSync('sh', ['-c',
      `openssl req -x509 -newkey rsa:2048 -nodes -days 2 -subj /CN=bary-upstream-ca \
       -keyout /dev/null -out ${bundle} 2>/dev/null`]);
    // **비-0 종료에도 출력을 본다.** `nginx -t` 가 실패하면 그 이유가 stdout 에 있는데,
    // 던지게 두면 그 이유를 못 읽고 "명령이 실패했다" 만 남는다 — 계측기가 답을 가린다.
    try {
      return execFileSync('docker', [
        'run', '--rm', '-v', `${dir}:/w:Z`, '--entrypoint', '/bin/sh', IMAGE, '-c',
        '/usr/local/openresty/bin/openresty -p /w -c conf/nginx.conf -t 2>&1',
      ], { encoding: 'utf8', timeout: 180_000 });
    } catch (e) {
      return String((e as { stdout?: string }).stdout ?? e);
    }
  } finally {
    dropScratch(dir);
  }
}

describe('upstream_tls 가 실물 nginx 를 통과한다', () => {
  beforeAll(() => {
    if (!dockerAvailable()) throw new Error('도커가 없다 — 골든은 실물 엔진으로만 잰다');
  }, 180_000);

  it('안 켜면 통과한다 (대조군)', () => {
    expect(configTest(undefined)).toContain('syntax is ok');
  }, 180_000);

  it('켜면 통과한다 — http 는 스킴, stream 은 `proxy_ssl on`', () => {
    const out = configTest({ enabled: true, sni: 'backend.internal' });
    expect(out, out).toContain('syntax is ok');
  }, 180_000);

  /**
   * **이 검사가 이 파일의 이유다.** 번들 경로가 `certPaths` 와 어긋나면 nginx 가
   * "no such file" 로 죽는다 — 문자열만 보는 단위로는 절대 안 잡힌다.
   */
  it('신뢰 번들과 verify 가 실물에서 선다 — 경로가 세대 배치와 맞는다', () => {
    const out = configTest({ enabled: true, verify: true, caBundle: 'upstream-ca' });
    expect(out, out).toContain('syntax is ok');
    expect(out, '번들 파일을 못 찾았다 — 경로 규칙이 certPaths 와 어긋난다')
      .not.toContain('No such file');
  }, 180_000);
});

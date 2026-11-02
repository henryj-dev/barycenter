/**
 * **라우트 하나에 경로 여럿** — 실물 nginx 로 잰다 (2026-11-02).
 *
 * 재는 것: 경로마다 location 이 서고(`nginx -t` 통과), 각 경로가 같은 동작으로 간다. 덮지 않은 경로는 리스너의 기본
 * 동작(거절)이 받는다. 다른 라우트의 경로는 그 라우트가 받는다.
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
const P = 18971;

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const caps = { streamRealip: false, httpLua: true, streamLua: false };

const model: Model = {
  listeners: [{ key: 'web', protocol: 'http', bind: '127.0.0.1', port: P, enabled: true, http: { defaultAction: 'reject' } }],
  httpRoutes: [
    { key: 'many', listener: 'web', hosts: ['x.test'], priority: 0, pathPrefixes: ['/api/', '/v2/', '/graphql'],
      action: { kind: 'redirect', to: 'https://many/', status: 302 } },
    { key: 'other', listener: 'web', hosts: ['x.test'], priority: 0, pathPrefix: '/other/',
      action: { kind: 'redirect', to: 'https://other/', status: 302 } },
  ],
  passthroughRoutes: [], pools: [], backends: [], certificates: [], tlsPolicies: [], sniBindings: [],
};

const PROBE = `
hit() { out=$(curl -s -o /dev/null -D - -H 'Host: x.test' "http://127.0.0.1:${P}$1" 2>/dev/null); rc=$?
  loc=$(printf '%s' "$out" | tr -d '\\r' | sed -n 's/^[Ll]ocation: https:\\/\\/\\([^/]*\\)\\/.*/\\1/p')
  if [ -n "$loc" ]; then echo "$loc"; else echo "rc=$rc"; fi; }
echo "api=$(hit /api/users)"
echo "v2=$(hit /v2/x)"
echo "graphql=$(hit /graphql)"
echo "other=$(hit /other/x)"
echo "none=$(hit /nope)"
`;

function serve(conf: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-paths-'));
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

describe('경로 여럿 — 실물 nginx', () => {
  let out = '';
  beforeAll(() => {
    if (!dockerAvailable()) return;
    // 렌더가 던지면(수정 전 — `pathPrefixes` 를 모른다) 그 말을 담아 둔다. 여기서 던지면 시험이 0 건으로 끝나
    // 「수정 전에 빨갛다」 를 못 잰다.
    try { out = serve(render(model, caps).conf); } catch (e) { out = `render-failed: ${String(e)}`; }
  }, 300_000);

  it('검증기가 이 모델을 받는다', () => {
    expect(validateModel(model, caps)).toEqual([]);
  });

  it('**경로마다 같은 동작으로 간다**', () => {
    if (!dockerAvailable()) return;
    expect(value(out, 'api'), out).toBe('many');
    expect(value(out, 'v2'), out).toBe('many');
    expect(value(out, 'graphql'), out).toBe('many');
  });

  it('다른 라우트의 경로는 그 라우트가, 덮지 않은 경로는 기본 동작이 받는다', () => {
    if (!dockerAvailable()) return;
    expect(value(out, 'other'), out).toBe('other');
    expect(value(out, 'none'), out).toMatch(/^rc=/);
  });
});

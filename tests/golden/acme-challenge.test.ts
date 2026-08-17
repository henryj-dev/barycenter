/**
 * ACME http-01 예약 라우트 — **reload 없이 서빙되는가** (§8.2 · S18)
 *
 * ── 재는 것은 "안 일어난 일" 이다 ───────────────────────────────────────
 *
 * 챌린지 토큰은 주문마다 바뀐다. 그걸 conf 에 실으면 **인증서 갱신 한 번에 세대 전환이
 * 한 번** 붙는데, 이 저장소는 그 대가를 실측해 뒀다 — 세대 전환당 트래픽 **2.6%** 손실.
 * 인증서가 여럿이고 90 일마다 갱신하면 그게 곱해진다.
 *
 * 그래서 토큰은 shared dict 에 산다. 멤버십 평면이 백엔드에 대해 푼 문제와 같은 문제이고
 * 같은 수법이다(S1). 여기서 확인하는 것은 **마스터 PID 와 워커 기동 수가 안 변한다**는
 * 것 — "토큰이 서빙된다" 만으로는 부족하다. HUP 을 보내도 그렇게 되기 때문이다.
 *
 * ── 그리고 가로채기 ─────────────────────────────────────────────────────
 *
 * nginx 의 location 은 **최장 접두사**가 이긴다. 사용자가 더 긴 경로를 내면 CA 의 요청이
 * 그쪽으로 가고, 증상은 "챌린지 검증 실패" 다 — 인증서 설정을 아무리 봐도 이상이 없다.
 * 검증기가 막는 것을 여기서 확인한다.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { render, ACME_PREFIX } from '../../src/conf/render.js';
import { httpAdminConf } from '../../src/control/membership.js';
import { ModelValidationError } from '../../src/validate/model.js';
import type { Model } from '../../src/model/provisional.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'openresty/openresty:alpine';
const PORT = 18701;
const ADMIN = 18702;

function dockerAvailable(): boolean {
  try {
    execFileSync('docker', ['info'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const model: Model = {
  listeners: [{
    key: 'front', protocol: 'http', bind: '0.0.0.0', port: PORT, enabled: true,
    http: { defaultAction: 'reject' },
  }],
  httpRoutes: [{
    key: 'r', listener: 'front', hosts: ['a.test'], priority: 10,
    action: { kind: 'reject', status: 403 },
  }],
  passthroughRoutes: [], pools: [], backends: [],
  certificates: [], tlsPolicies: [], sniBindings: [],
};

/** 렌더 산출물로 nginx 를 띄우고 프로브를 돌린다. admin 조각을 세대에 넣는다. */
function serve(conf: string, probe: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-acme-'));
  try {
    mkdirSync(join(dir, 'conf', 'admin'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'), `daemon off;\n${conf}`, 'utf8');
    writeFileSync(join(dir, 'conf', 'admin', 'marker.conf'),
      httpAdminConf('gen-1', '1', ADMIN), 'utf8');
    writeFileSync(join(dir, 'probe.sh'), probe, 'utf8');
    return execFileSync(
      'docker',
      ['run', '--rm', '-v', `${dir}:/prefix`, '--entrypoint', '/bin/sh', IMAGE, '-c',
        'apk add --no-cache curl >/dev/null 2>&1; ' +
        '/usr/local/openresty/bin/openresty -p /prefix -c conf/nginx.conf & sleep 1.5; ' +
        'sh /prefix/probe.sh; echo "---errorlog---"; tail -5 /prefix/logs/error.log'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    ).toString().trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('ACME http-01 예약 라우트', () => {
  let out = '';

  beforeAll(() => {
    if (!dockerAvailable()) return;
    const conf = render(model, { httpLua: true, streamLua: false, streamRealip: true }).conf;
    out = serve(conf, `
# **안 일어난 일을 재기 위한 관측치.** 토큰이 서빙된다는 것만으로는 부족하다 —
# HUP 을 보내도 그렇게 되기 때문이다.
master_before=$(cat /prefix/logs/nginx.pid)
workers_before=$(grep -c 'start worker process' /prefix/logs/error.log)

echo "before=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}${ACME_PREFIX}tok1)"

# dict 에 적재 — **설정을 안 바꾼다.**
echo "staged=$(curl -s --data-binary 'tok1=tok1.thumb' http://127.0.0.1:${ADMIN}/acme)"

echo "after=$(curl -s http://127.0.0.1:${PORT}${ACME_PREFIX}tok1)"
echo "unknown=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}${ACME_PREFIX}nope)"
echo "empty=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}${ACME_PREFIX})"

# 라우트가 없는 호스트(첫 발급 상황)에서도 서빙돼야 한다 — default_server 경로.
echo "default=$(curl -s -H 'Host: brand-new.test' http://127.0.0.1:${PORT}${ACME_PREFIX}tok1)"

# 되읽기 — nginx -t 가 Lua 를 안 보므로(E64) 이 경로가 도는 유일한 증거다.
echo "readback=$(curl -s http://127.0.0.1:${ADMIN}/acme/read)"

master_after=$(cat /prefix/logs/nginx.pid)
workers_after=$(grep -c 'start worker process' /prefix/logs/error.log)
echo "master=$master_before/$master_after"
echo "workers=$workers_before/$workers_after"
`);
  }, 180_000);

  const val = (k: string): string =>
    out.split('\n').find((l) => l.startsWith(`${k}=`))?.slice(k.length + 1).trim() ?? '(없음)';

  it.runIf(dockerAvailable())('**적재하면 바로 서빙된다** — 그 전에는 404 다', () => {
    expect(val('before'), out).toBe('404');
    expect(val('staged'), out).toBe('staged 1');
    expect(val('after'), out).toBe('tok1.thumb');
  });

  it.runIf(dockerAvailable())(
    '**reload 가 없다** — 마스터 PID 도 워커 기동 수도 안 변한다',
    () => {
      const [before, after] = val('master').split('/');
      expect(before, out).toBe(after);
      const [wb, wa] = val('workers').split('/');
      // HUP 이었다면 워커가 새로 뜬다. 이게 이 설계의 전부다.
      expect(wb, out).toBe(wa);
    },
  );

  it.runIf(dockerAvailable())(
    '모르는 토큰은 **404 다 — 빈 200 이 아니다**',
    () => {
      // 빈 200 을 주면 CA 는 "틀린 값" 으로 읽고, 실패 원인이 "토큰이 없다" 가 아니라
      // "값이 다르다" 로 보인다.
      expect(val('unknown'), out).toBe('404');
      expect(val('empty'), out).toBe('404');
    },
  );

  it.runIf(dockerAvailable())(
    '**라우트가 없는 호스트에서도 서빙된다** — 첫 발급이 그 상황이다',
    () => {
      // 여기가 안 되면 "설정을 넣어야 인증서를 받고, 인증서가 있어야 설정이 선다" 가 된다.
      expect(val('default'), out).toBe('tok1.thumb');
    },
  );

  it.runIf(dockerAvailable())('되읽기가 적재를 확인한다 (E64 — nginx -t 는 Lua 를 안 본다)', () => {
    expect(val('readback'), out).toBe('tok1=tok1.thumb');
  });
});

describe('예약 경로는 사용자가 못 가로챈다 (§8.2)', () => {
  const withRoute = (pathPrefix: string): Model => ({
    ...model,
    httpRoutes: [{
      key: 'steal', listener: 'front', hosts: ['a.test'], priority: 10,
      pathPrefix, action: { kind: 'reject', status: 403 },
    }],
  });

  it('**예약 경로 아래를 가리키는 라우트는 거절된다**', () => {
    // nginx 는 최장 접두사가 이기므로, 이걸 허용하면 CA 의 요청이 여기로 온다.
    expect(() => render(withRoute(`${ACME_PREFIX}foo`), { httpLua: true, streamLua: false, streamRealip: true }))
      .toThrow(ModelValidationError);
    expect(() => render(withRoute(ACME_PREFIX), { httpLua: true, streamLua: false, streamRealip: true }))
      .toThrow(ModelValidationError);
  });

  it('위쪽 경로는 허용한다 — 더 짧은 접두사라 `^~` 가 이긴다', () => {
    expect(() => render(withRoute('/.well-known/'), { httpLua: true, streamLua: false, streamRealip: true }))
      .not.toThrow();
  });
});

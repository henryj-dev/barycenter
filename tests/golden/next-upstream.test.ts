/**
 * 멤버십 평면에 페일오버가 있는가 — 검수 2026-08-24 **N5** (그리고 D3 의 무대)
 *
 * ── 이 파일은 D3 을 재려고 만들었다가 다른 것을 찾았다
 *
 * 투두 W3-0 은 D3(재시도마다 `in:` 이 샌다)의 **무대**를 세우는 항목이었다. 검수 문서가
 * 그 결함을 이렇게 세웠다:
 *
 * > nginx 는 `proxy_next_upstream error timeout` 이 기본으로 켜져 있고 렌더러는 그것을
 * > 끄지 않는다. 그래서 연결 실패로 한 번이라도 재시도가 나면 첫 peer 의 카운터가
 * > +1 인 채로 영원히 남는다.
 *
 * **실물로 재 보니 그 전제가 틀렸다.** 백엔드 둘 중 하나를 안 띄우고 요청 넷을 보냈다:
 *
 *   LIVE · 502 · LIVE · 502
 *   error.log: connect() failed (111: Connection refused) … upstream: "127.0.0.1:19201"
 *   inflight: 죽은 쪽 0 · 산 쪽 0
 *
 * **재시도가 아예 안 난다.** `balancer_by_lua_block` 을 쓰면 nginx 는
 * `balancer.set_more_tries(n)` 을 부른 경우에만 밸런서를 다시 부른다. 이 저장소에는
 * 그 호출이 **한 번도 안 나온다**(`grep -rn set_more_tries src/` → 0 건).
 * `proxy_next_upstream` 은 기본으로 켜져 있지만, 다시 고를 peer 를 밸런서가 안 주면
 * 아무 데도 못 간다.
 *
 * ── 그래서 실제 결함은 이것이다 (N5)
 *
 * **죽은 백엔드가 있으면 그쪽으로 배정된 요청이 곧바로 502 다.** 백엔드 둘에
 * round_robin 이면 **트래픽의 절반**이 죽는다. 로드밸런서가 하지 말아야 할 일의 목록에서
 * 제일 위에 있는 것이다.
 *
 * 헬스 프로버가 몇 초 뒤 그 백엔드를 슬롯에서 뺀다(`failThreshold` × `probeMs`,
 * 기본 2 × 2 초). 그건 **완화이지 페일오버가 아니다**:
 *
 *   · 그 몇 초 동안 절반이 죽는다
 *   · **일시적 실패**(백엔드 재기동 · 연결 리셋 · 순간적 과부하)는 프로버가 볼 새도 없이
 *     클라이언트에게 502 로 간다 — `proxy_next_upstream` 이 존재하는 이유가 그것이다
 *   · 프로버를 안 켠 배포에는 회복 경로가 아예 없다
 *
 * 정적 `server` 줄 경로(Lua 없는 엔진)에서는 nginx 가 알아서 다음 peer 로 넘어간다.
 * **즉 같은 모델이 엔진에 따라 다르게 동작한다** — D2 가 가중치에서 지적한 것과 **같은
 * 부류**이고, 이쪽이 더 무겁다.
 *
 * ── D3 은 틀린 게 아니라 **잠복**이다
 *
 * `in:` 은 지금 안 샌다. 샐 재시도가 없기 때문이다. 그런데 N5 를 고치면
 * (`set_more_tries` 를 부르면) **그 순간 D3 이 살아난다** — `balancer_by_lua_block` 은
 * 재시도마다 `d:incr("in:", 1)` 하는데 `ngx.ctx.bary_peer` 는 마지막 peer 만 들고
 * `log_by_lua` 는 요청당 한 번만 돈다.
 *
 * **그래서 둘은 같은 커밋에서 고쳐야 한다.** 아래 두 번째 검사가 그 감시자다 — 지금은
 * 초록이고, 페일오버만 고치고 누수를 안 고치면 **그때 빨개진다.**
 *
 *   npm run test:golden     (도커 필요)
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { dropScratch } from '../scratch.js';
import { httpAdminConf } from '../../src/control/membership.js';
import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const PORT = 18961;
/** **첫째는 안 띄운다.** 그것이 이 무대의 전부다. */
const DEAD = 19201;
const LIVE = 19202;
const REQUESTS = 4;

/**
 * admin 소켓은 **바인드 마운트 밖**에 둔다.
 *
 * macOS 의 Docker 바인드 마운트에는 유닉스 소켓을 못 만든다 — 처음에 `/w/run/` 에
 * 뒀더니 소켓 파일이 안 생겼고, 증상은 「admin 창구가 연결 거부」였다. e2e 가 안 물린
 * 이유는 거기서는 소켓이 컨테이너 안 경로(`/prefix/run`)에 살기 때문이다.
 */
const SOCK = '/run/bary-admin.sock';

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

/** 멤버십 평면이 켜진 엔진 — 이 경로가 Lua 밸런서다. */
const ON = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };

/**
 * `round_robin` 이다. **`least_conn` 이면 이 테스트가 자기 꼬리를 문다** — 누수된
 * `in:` 이 다음 선택을 바꾸므로, 재는 대상이 재는 행위에 끼어든다.
 */
const model: Model = {
  listeners: [{
    key: 'web', protocol: 'http', bind: '0.0.0.0', port: PORT, enabled: true,
    http: { defaultAction: { pool: 'app' } },
  }],
  httpRoutes: [], passthroughRoutes: [],
  pools: [{ key: 'app', protocolClass: 'http', algorithm: 'round_robin' } as Model['pools'][number]],
  backends: [
    { key: 'dead', pool: 'app', host: '127.0.0.1', port: DEAD, weight: 1 },
    { key: 'live', pool: 'app', host: '127.0.0.1', port: LIVE, weight: 1 },
  ],
  certificates: [], tlsPolicies: [], sniBindings: [],
};

type Reading = {
  /** 응답 본문 넷. 성공은 `LIVE`, 실패는 `502` 를 담은 html. */
  bodies: string[];
  ok: number;
  bad: number;
  dead: number | undefined;
  live: number | undefined;
  slots: string;
  errorLog: string;
};

/**
 * 죽은 백엔드 하나를 끼워 두고 요청을 흘린 뒤 양쪽 `in:` 을 읽는다.
 *
 * **슬롯을 admin 창구로 민다.** `init_worker_by_lua` 로 심는 지름길도 있지만
 * (`least-conn.test.ts` 가 그렇게 한다), 여기서는 `/membership/inflight` 도 같은
 * 창구라 어차피 admin 조각이 필요하다 — 그러면 적재도 진짜 경로로 하는 편이 낫다.
 */
function probe(): Reading {
  const dir = mkdtempSync(join(tmpdir(), 'bary-nu-'));
  chmodSync(dir, 0o777);
  try {
    // **`admin/` 은 `conf/` 안이다.** nginx 의 상대 `include` 는 `-p`(prefix)가 아니라
    // **설정 파일이 있는 디렉토리** 기준이다. `/w/admin` 에 뒀더니 glob 이 아무것도
    // 안 잡았고, 빈 glob 은 오류가 아니라(E62) **조용히** admin 창구가 없는 채로 떴다.
    mkdirSync(join(dir, 'conf', 'admin'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });

    writeFileSync(join(dir, 'conf', 'nginx.conf'),
      `daemon off;\nworker_processes 1;\n${render(model, ON).conf}`, 'utf8');
    writeFileSync(join(dir, 'conf', 'admin', 'admin.conf'),
      httpAdminConf('g1', '0', SOCK), 'utf8');

    // **살아 있는 쪽만 띄운다.**
    writeFileSync(join(dir, 'back.conf'), `daemon off;
error_log logs/b.log warn;
pid logs/b.pid;
events { worker_connections 64; }
http {
  access_log off;
  server { listen ${LIVE}; location / { return 200 "LIVE"; } }
}
`, 'utf8');

    const admin = (path: string): string => `curl -s --unix-socket ${SOCK} "http://admin${path}"`;
    writeFileSync(join(dir, 'probe.sh'), `
      set -e
      curl -s --unix-socket ${SOCK} -X POST \
        --data-binary 'pool_app=127.0.0.1:${DEAD},127.0.0.1:${LIVE}' \
        "http://admin/membership?epoch=0" > /dev/null
      echo "---slots---"
      ${admin('/membership/read?epoch=0')}
      echo
      echo "---bodies---"
      for i in $(seq 1 ${REQUESTS}); do
        printf '%s\\n' "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}/)"
      done
      # 요청이 전부 끝난 뒤에 읽는다 — log_by_lua 가 돌 시간을 준다.
      sleep 1
      echo "---dead---"
      ${admin(`/membership/inflight?peer=127.0.0.1:${DEAD}`)}
      echo
      echo "---live---"
      ${admin(`/membership/inflight?peer=127.0.0.1:${LIVE}`)}
      echo
    `, 'utf8');

    const out = execFileSync('docker', [
      'run', '--rm', '-v', `${dir}:/w:Z`, '--entrypoint', '/bin/sh', IMAGE, '-c',
      'apk add --no-cache curl >/dev/null 2>&1; '
      + '/usr/local/openresty/bin/openresty -p /w -c back.conf & sleep 1; '
      + '/usr/local/openresty/bin/openresty -p /w -c conf/nginx.conf & sleep 2; '
      + 'sh /w/probe.sh 2>&1; echo "---errorlog---"; tail -10 /w/logs/error.log',
    ], { encoding: 'utf8', timeout: 180_000 });

    if (process.env['BARY_DEBUG'] === '1') console.log(out);
    const part = (name: string): string => {
      const after = out.split(`---${name}---`)[1] ?? '';
      return (after.split('---')[0] ?? '').trim();
    };
    const bodies = part('bodies').split('\n').map((x) => x.trim()).filter((x) => x !== '');
    return {
      bodies,
      ok: bodies.filter((c) => c === '200').length,
      bad: bodies.filter((c) => c !== '200').length,
      dead: inflightOf(part('dead')),
      live: inflightOf(part('live')),
      slots: part('slots'),
      errorLog: part('errorlog'),
    };
  } finally {
    dropScratch(dir);
  }
}

/** `{"inflight":N,...}` 또는 `{}`. 없으면 `undefined` — **0 과 안 섞는다.** */
const inflightOf = (s: string): number | undefined => {
  const m = /"inflight":(-?\d+)/.exec(s);
  return m === null ? undefined : Number(m[1]);
};

describe('멤버십 평면의 페일오버 (N5) 와 `in:` 누수 (D3)', () => {
  beforeAll(() => {
    if (!dockerAvailable()) throw new Error('도커가 없다 — 골든은 실물 엔진으로만 잰다');
  }, 180_000);

  /** **무대가 서는지 먼저 본다.** 슬롯이 안 실리면 아래는 아무것도 안 재는 셈이다. */
  it('무대가 선다 — 슬롯 둘이 실리고 산 백엔드가 답한다', () => {
    const r = probe();
    expect(r.slots, `slots=${JSON.stringify(r.slots)}`)
      .toContain(`127.0.0.1:${DEAD},127.0.0.1:${LIVE}`);
    expect(r.ok, `bodies=${JSON.stringify(r.bodies)}`).toBeGreaterThan(0);
  }, 180_000);

  /**
   * **N5 의 재현물.**
   *
   * 백엔드 하나가 죽어 있어도 **모든 요청이 성공해야** 한다 — 살아 있는 peer 가 있기
   * 때문이다. 지금은 절반이 502 다: `balancer_by_lua_block` 이
   * `balancer.set_more_tries()` 를 안 불러서 nginx 가 밸런서를 다시 안 부른다.
   */
  it('죽은 백엔드가 있어도 모든 요청이 성공한다 — 페일오버가 있다', () => {
    const r = probe();
    expect(r.bad, `응답 코드 ${JSON.stringify(r.bodies)} · errorlog: ${r.errorLog}`).toBe(0);
    expect(r.ok, JSON.stringify(r.bodies)).toBe(REQUESTS);
  }, 180_000);

  /**
   * **D3 의 감시자.** 지금은 초록이다 — 샐 재시도가 없기 때문이다.
   *
   * 위 검사를 고치면(`set_more_tries`) **이 검사가 빨개진다.** 재시도마다
   * `d:incr("in:", 1)` 하는데 `ngx.ctx.bary_peer` 는 마지막 peer 만 들고 `log_by_lua`
   * 는 요청당 한 번만 돌기 때문이다. 그래서 둘은 **같은 커밋**에서 고쳐야 한다.
   */
  it('요청이 끝나면 어느 peer 에도 inflight 가 안 남는다', () => {
    const r = probe();
    // `undefined` 는 "그 peer 를 한 번도 안 골랐다" 이고, 그것도 누수가 아니다.
    expect(r.live ?? 0, `live inflight · bodies=${JSON.stringify(r.bodies)}`).toBe(0);
    expect(r.dead ?? 0, `dead inflight · errorlog: ${r.errorLog}`).toBe(0);
  }, 180_000);
});

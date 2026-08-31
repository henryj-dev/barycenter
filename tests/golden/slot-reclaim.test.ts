/**
 * 퇴역한 epoch 의 슬롯이 안 남는다 — 검수 2026-08-24 D4 (골든)
 *
 * ── 쓰기만 있고 지우기가 없다
 *
 * `/membership` 은 슬롯을 **만료 없이** 쓴다:
 *
 *   d:set("slot:" .. name .. ":" .. epoch, peers)
 *
 * ACME 토큰에는 `remove` 동사와 TTL 이 **둘 다** 있는데 슬롯에는 둘 다 없고, 지우는
 * 코드도 어디에도 없다 — `membership.ts` 의 `d:delete` 는 ACME 토큰용 한 줄뿐이다.
 *
 * dict 는 프로세스 수명이므로 nginx 재시작 전까지 **세대 전환마다 풀 수만큼 키가
 * 쌓인다.** 그 끝은 이 저장소가 이미 두 곳에 적어 뒀다 — 차면 LRU 가 밀어내고,
 * 밀려난 것이 `slot:` 이면 `balancer_by_lua` 가 `ngx.exit(ngx.ERROR)` 를 타
 * **그 풀의 모든 요청이 끊긴다.**
 *
 * `membershipDictKb` 를 연 것(B-12)은 그 절벽을 뒤로 미는 손잡이인데,
 * **미는 것과 안 자라게 하는 것은 다르다.**
 *
 * ── 이 파일이 재는 것
 *
 * 데몬을 안 띄운다. epoch 을 올려 가며 슬롯을 적재하고 **옛 epoch 을 회수한 뒤 그것이
 * 정말 없는가**를 admin 창구로 본다. 재는 것은 **창구의 계약**이지 세대 GC 의 판정이
 * 아니다 — 「언제 퇴역인가」는 `workerLingerMs` 가 이미 답하고, 그 배선은 e2e 가 잰다.
 *
 * 새 읽기 창구를 만들지 않는다. `read?epoch=<옛것>` 이 비는 것으로 충분하고, 관측용
 * 창구를 재현물 때문에 늘리면 그 창구가 곧 계약이 된다.
 *
 *   npm run test:golden     (도커 필요)
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { dropScratch } from '../scratch.js';
import { httpAdminConf, streamAdminConf } from '../../src/control/membership.js';
import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const PORT = 18971;
const STREAM_PORT = 18972;
/** **바인드 마운트 밖.** macOS 는 거기 유닉스 소켓을 못 만든다 (W3-0 에서 물렸다). */
const HTTP_SOCK = '/run/bary-http.sock';
const STREAM_SOCK = '/run/bary-stream.sock';

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const ON = { httpLua: true, streamLua: true, streamRealip: false, sslConfCommand: true };

const model: Model = {
  listeners: [
    {
      key: 'web', protocol: 'http', bind: '0.0.0.0', port: PORT, enabled: true,
      http: { defaultAction: { pool: 'app' } },
    },
    {
      key: 'edge', protocol: 'tcp', bind: '0.0.0.0', port: STREAM_PORT, enabled: true,
      defaultPool: 'edge',
    } as Model['listeners'][number],
  ],
  httpRoutes: [], passthroughRoutes: [],
  pools: [
    { key: 'app', protocolClass: 'http', algorithm: 'round_robin' } as Model['pools'][number],
    { key: 'edge', protocolClass: 'tcp', algorithm: 'round_robin' } as Model['pools'][number],
  ],
  backends: [
    { key: 'a', pool: 'app', host: '127.0.0.1', port: 19301, weight: 1 },
    { key: 'e', pool: 'edge', host: '127.0.0.1', port: 19302, weight: 1 },
  ],
  certificates: [], tlsPolicies: [], sniBindings: [],
};

/** admin 창구에 대고 스크립트를 돌린다. */
function run(script: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-slot-'));
  chmodSync(dir, 0o777);
  try {
    // **`admin/` 은 `conf/` 안이다** — nginx 의 상대 `include` 는 설정 파일이 있는
    // 디렉토리 기준이다 (W3-0 에서 물렸다).
    mkdirSync(join(dir, 'conf', 'admin'), { recursive: true });
    mkdirSync(join(dir, 'conf', 'stream-admin'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });

    writeFileSync(join(dir, 'conf', 'nginx.conf'),
      `daemon off;\nworker_processes 1;\n${render(model, ON).conf}`, 'utf8');
    writeFileSync(join(dir, 'conf', 'admin', 'admin.conf'),
      httpAdminConf('g1', '0', HTTP_SOCK), 'utf8');
    writeFileSync(join(dir, 'conf', 'stream-admin', 'admin.conf'),
      streamAdminConf('0', STREAM_SOCK), 'utf8');
    writeFileSync(join(dir, 'probe.sh'), script, 'utf8');

    return execFileSync('docker', [
      'run', '--rm', '-v', `${dir}:/w:Z`, '--entrypoint', '/bin/sh', IMAGE, '-c',
      // **`socat` 이 필요하다.** stream admin 은 유닉스 소켓의 **생 TCP** 프로토콜이고
      // busybox `nc` 에는 `-U` 가 없다.
      'apk add --no-cache curl socat >/dev/null 2>&1; '
      + '/usr/local/openresty/bin/openresty -p /w -c conf/nginx.conf & sleep 2; '
      + 'sh /w/probe.sh 2>&1; echo "---errorlog---"; tail -5 /w/logs/error.log',
    ], { encoding: 'utf8', timeout: 180_000 });
  } finally {
    dropScratch(dir);
  }
}

const section = (out: string, name: string): string => {
  const after = out.split(`---${name}---`)[1] ?? '';
  return (after.split('---')[0] ?? '').trim();
};

describe('퇴역한 epoch 의 슬롯 (D4)', () => {
  beforeAll(() => {
    if (!dockerAvailable()) throw new Error('도커가 없다 — 골든은 실물 엔진으로만 잰다');
  }, 180_000);

  /**
   * **이것이 D4 의 재현물이다.**
   *
   * epoch 을 다섯 번 올리며 적재한 뒤 앞의 넷을 회수한다. 회수 동사가 없으면 그
   * 요청들이 아무 일도 안 하고, 옛 epoch 을 읽으면 슬롯이 그대로 나온다.
   */
  it('퇴역한 epoch 의 슬롯이 안 남는다', () => {
    const out = run(`
      for e in 0 1 2 3 4; do
        curl -s --unix-socket ${HTTP_SOCK} -X POST \
          --data-binary 'pool_app=127.0.0.1:19301' \
          "http://admin/membership?epoch=$e" > /dev/null
      done
      for e in 0 1 2 3; do
        curl -s --unix-socket ${HTTP_SOCK} -X POST \
          "http://admin/membership?epoch=$e&remove=1" > /dev/null
      done
      echo "---old---"
      for e in 0 1 2 3; do
        curl -s --unix-socket ${HTTP_SOCK} "http://admin/membership/read?epoch=$e"
      done
      echo
      echo "---live---"
      curl -s --unix-socket ${HTTP_SOCK} "http://admin/membership/read?epoch=4"
      echo
    `);
    // 옛 epoch 넷은 전부 비어야 한다.
    expect(section(out, 'old'), `옛 epoch 이 남았다`).toBe('');
    // **그리고 지금 epoch 은 멀쩡하다.** 회수가 서비스를 끊으면 안 된다.
    expect(section(out, 'live')).toBe('pool_app=127.0.0.1:19301');
  }, 180_000);

  /** 회수는 **그 epoch 만** 지운다. 하나 지우려다 옆을 지우면 트래픽이 끊긴다. */
  it('회수가 이웃 epoch 을 안 건드린다', () => {
    const out = run(`
      curl -s --unix-socket ${HTTP_SOCK} -X POST --data-binary 'pool_app=127.0.0.1:19301' \
        "http://admin/membership?epoch=7" > /dev/null
      curl -s --unix-socket ${HTTP_SOCK} -X POST --data-binary 'pool_app=127.0.0.1:19399' \
        "http://admin/membership?epoch=8" > /dev/null
      curl -s --unix-socket ${HTTP_SOCK} -X POST "http://admin/membership?epoch=7&remove=1" > /dev/null
      echo "---read7---"
      curl -s --unix-socket ${HTTP_SOCK} "http://admin/membership/read?epoch=7"
      echo
      echo "---read8---"
      curl -s --unix-socket ${HTTP_SOCK} "http://admin/membership/read?epoch=8"
      echo
    `);
    expect(section(out, 'read7')).toBe('');
    expect(section(out, 'read8')).toBe('pool_app=127.0.0.1:19399');
  }, 180_000);

  /**
   * **stream 평면도 같은 동사를 낸다.** 한쪽만 회수하면 다른 쪽이 계속 자라고,
   * 두 zone 은 서로 안 보이므로(E14 · E25) http 쪽으로 대신 물을 수도 없다.
   */
  it('stream 평면도 회수한다', () => {
    const talk = (lines: string) =>
      `printf '${lines}' | socat -t 3 - UNIX-CONNECT:${STREAM_SOCK}`;
    const out = run(`
      ${talk('3 write\\npool_edge=127.0.0.1:19302\\n\\n')} > /dev/null
      ${talk('4 write\\npool_edge=127.0.0.1:19402\\n\\n')} > /dev/null
      ${talk('3 remove\\n')} > /dev/null
      echo "---read3---"
      ${talk('3 read\\n')}
      echo "---read4---"
      ${talk('4 read\\n')}
    `);
    expect(section(out, 'read3'), 'stream 의 옛 epoch 이 남았다').toBe('');
    expect(section(out, 'read4')).toBe('pool_edge=127.0.0.1:19402');
  }, 180_000);

  /**
   * **속성도 회수돼야 한다** (ADR ②-b).
   *
   * 속성 채널을 넣으면서 회수를 안 넓히면 `attr:` 키가 세대마다 쌓인다. 그 결말은 이
   * 파일 머리말이 이미 적었다 — 차면 LRU 가 밀어내고, 밀려난 것이 `slot:` 이면
   * `balancer_by_lua` 가 `ngx.exit(ngx.ERROR)` 를 타 **그 풀의 모든 요청이 끊긴다.**
   *
   * 즉 **속성을 새는 채로 넣으면 결국 트래픽이 끊긴다.** 회수가 `slot:` 만 훑던 자리라
   * 실물로 잰다.
   */
  it('퇴역한 epoch 의 **속성**도 안 남는다', () => {
    const out = run(`
      curl -s --unix-socket ${HTTP_SOCK} -X POST         --data-binary 'pool_app=127.0.0.1:19301,127.0.0.1:19302
!pool_app=127.0.0.1:19302|9|,127.0.0.1:19301|100|'         "http://admin/membership?epoch=11" > /dev/null
      curl -s --unix-socket ${HTTP_SOCK} -X POST         --data-binary 'pool_app=127.0.0.1:19301
!pool_app=127.0.0.1:19301|200|'         "http://admin/membership?epoch=12" > /dev/null
      echo "---before---"
      curl -s --unix-socket ${HTTP_SOCK} "http://admin/membership/read?epoch=11"
      echo
      curl -s --unix-socket ${HTTP_SOCK} -X POST         "http://admin/membership?epoch=11&remove=1" > /dev/null
      echo "---after---"
      curl -s --unix-socket ${HTTP_SOCK} "http://admin/membership/read?epoch=11"
      echo
      echo "---live---"
      curl -s --unix-socket ${HTTP_SOCK} "http://admin/membership/read?epoch=12"
      echo
    `);
    // 쓰였는지 먼저 못 박는다 — 안 쓰였으면 아래 「안 남았다」가 공허하다.
    /**
     * **peer 순서가 뒤집혀 나와야 한다.**
     *
     * 위에서 일부러 내림차순(`19302` 먼저)으로 보냈다. 속성을 **peer 마다 키로 펴는**
     * 구현만이 되읽을 때 다시 정렬해 오름차순을 낸다. 그리고 그 대칭이 곧 계약이다 —
     * 적재가 되읽어 비교하므로 형식이나 순서가 갈리면 그 검사가 언제나 실패한다.
     *
     * 이 단언이 없으면 이 검사는 **엉뚱한 이유로 통과한다** — 속성 경로가 없는 코드는
     * `!pool_app=…` 줄을 그냥 **슬롯**으로 읽어(`^([^=]+)=(.*)$` 에 이름 `!pool_app` 으로
     * 걸린다) 값을 통째로 저장하고 그대로 되돌려주고, 회수도 `slot:` 이라 지워진다.
     * **핀 게이트가 그것을 잡았다.**
     */
    expect(section(out, 'before'), '속성이 peer 별로 안 펴졌다 — 줄이 통째로 저장됐다')
      .toContain('!pool_app=127.0.0.1:19301|100|,127.0.0.1:19302|9|');
    expect(section(out, 'after'), '회수가 속성을 안 지웠다 — 세대마다 쌓인다').toBe('');
    // 살아 있는 epoch 은 멀쩡하다. 회수가 옆을 지우면 트래픽이 끊긴다.
    expect(section(out, 'live')).toContain('!pool_app=127.0.0.1:19301|200|');
    expect(section(out, 'live')).toContain('pool_app=127.0.0.1:19301');
  }, 180_000);
});

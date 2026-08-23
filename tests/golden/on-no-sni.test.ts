/**
 * S9 — **우리가 렌더한 conf** 가 no-SNI 를 실제로 가르는가 (골든)
 *
 * `spike/s9` 는 **손으로 쓴** conf 로 엔진의 성질을 쟀다. 그건 "nginx 가 가를 수 있다"
 * 까지만 말한다. 여기서 재는 것은 다른 것이다 — **`render()` 가 낸 conf 가 그 성질을
 * 실제로 쓰는가.** 두 map 의 순서·변수 이름·업스트림 존재는 렌더러의 몫이고, 그중
 * 어느 하나만 틀려도 스파이크는 여전히 초록이면서 제품은 조용히 틀린다.
 *
 * ── 왜 손으로 만든 ClientHello 인가
 *
 * `openssl s_client` 는 핸드셰이크를 끝내려 하고, 백엔드는 TLS 가 아니다. 그러면
 * "분기가 틀렸다" 와 "핸드셰이크가 실패했다" 가 구분되지 않는다 — 계측기가 하나 더
 * 붙는 셈이다. 재려는 것은 **어느 백엔드에 닿았는가** 뿐이므로, ClientHello 바이트를
 * 직접 만들고 백엔드가 뱉는 표식 한 줄만 읽는다.
 */
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';

import { dropScratch } from '../scratch.js';
import { render } from '../../src/conf/render.js';
import type { Model } from '../../src/model/provisional.js';

const IMAGE = process.env['BARY_ENGINE_IMAGE'] ?? 'docker.io/openresty/openresty:alpine';
const PORT = 18961;

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['info'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const pool = (key: string) => ({ key, protocolClass: 'tcp' as const, algorithm: 'round_robin' as const });

const model: Model = {
  listeners: [{
    key: 'tls', protocol: 'tls_passthrough', bind: '0.0.0.0', port: PORT, enabled: true,
    onUnmatchedSni: { pool: 'unmatched' },
    onNoSni: { pool: 'nosni' },
    prereadTimeoutS: 2,
  }],
  httpRoutes: [],
  passthroughRoutes: [{
    key: 'r', listener: 'tls', snis: ['a.example.com'], priority: 10,
    action: { kind: 'proxy', pool: 'named' },
  }],
  pools: [pool('named'), pool('unmatched'), pool('nosni')],
  backends: [
    { key: 'n', pool: 'named', host: '127.0.0.1', port: 19201, weight: 1 },
    { key: 'u', pool: 'unmatched', host: '127.0.0.1', port: 19202, weight: 1 },
    { key: 's', pool: 'nosni', host: '127.0.0.1', port: 19203, weight: 1 },
  ],
  certificates: [], tlsPolicies: [], sniBindings: [],
} as unknown as Model;

/**
 * 백엔드 셋 + **프로브 하나**를 한 conf 에 담는다.
 *
 * 프로브가 nginx 안에 사는 이유: openresty:alpine 에는 node 도 perl 도 없다(그래서
 * `resty` 도 못 돈다). 이미지에 런타임을 더 얹으면 그 설치 실패가 곧 이 테스트의
 * 실패로 보이는데, 그건 우리가 재려는 것과 아무 상관이 없다. cosocket 은 우리가
 * 이미 의존하는 것이므로 계측기를 늘리지 않는다.
 *
 * 백엔드는 연결 즉시 표식을 뱉는다 — 클라이언트가 TLS 를 말할 필요가 없어진다.
 */
const backendsConf = (probeLua: string) => `daemon off;
error_log logs/b.log warn;
pid logs/b.pid;
events { worker_connections 64; }
stream {
  access_log off;
  server { listen 127.0.0.1:19201; content_by_lua_block { ngx.say("NAMED")     } }
  server { listen 127.0.0.1:19202; content_by_lua_block { ngx.say("UNMATCHED") } }
  server { listen 127.0.0.1:19203; content_by_lua_block { ngx.say("NOSNI")     } }
}
http {
  access_log off;
  server {
    listen 127.0.0.1:19299;
    location /probe { content_by_lua_block { ${probeLua} } }
  }
}
`;

/**
 * 최소 TLS 1.2 ClientHello. `name` 이 있으면 server_name 확장을 붙인다.
 *
 * 확장 블록이 아예 없는 경우와, 확장 목록은 있는데 SNI 만 없는 경우를 **둘 다** 낸다.
 * 실물에서 흔한 쪽은 후자인데, 앞의 것만 재고 "no-SNI 를 쟀다" 고 하면 실제 트래픽을
 * 안 잰 것이 된다.
 */
function clientHello(name?: string, emptyExtList = false): Buffer {
  const u16 = (n: number) => Buffer.from([(n >> 8) & 0xff, n & 0xff]);
  const u24 = (n: number) => Buffer.from([(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]);
  const exts: Buffer[] = [];
  if (name !== undefined) {
    const host = Buffer.from(name, 'ascii');
    const entry = Buffer.concat([Buffer.from([0x00]), u16(host.length), host]);
    const list = Buffer.concat([u16(entry.length), entry]);
    exts.push(Buffer.concat([Buffer.from([0x00, 0x00]), u16(list.length), list]));
  }
  const extBlock = Buffer.concat(exts);
  const body = Buffer.concat([
    Buffer.from([0x03, 0x03]),
    Buffer.alloc(32, 0x41),
    Buffer.from([0x00]),
    u16(2), Buffer.from([0x00, 0x2f]),
    Buffer.from([0x01, 0x00]),
    ...(name === undefined && !emptyExtList ? [] : [u16(extBlock.length), extBlock]),
  ]);
  const hs = Buffer.concat([Buffer.from([0x01]), u24(body.length), body]);
  return Buffer.concat([Buffer.from([0x16, 0x03, 0x01]), u16(hs.length), hs]);
}

const PROBES: Record<string, Buffer> = {
  sni: clientHello('a.example.com'),
  other_sni: clientHello('zzz.nowhere.test'),
  no_sni: clientHello(),
  no_sni_empty_ext: clientHello(undefined, true),
  // TLS 레코드처럼 시작하지만 본문이 쓰레기다. **비-TLS 와 한 통으로 가야 한다.**
  malformed: Buffer.concat([Buffer.from([0x16, 0x03, 0x01, 0x00, 0x10]), Buffer.alloc(0x10, 0xff)]),
  plain: Buffer.from('GET / HTTP/1.0\r\n\r\n'),
};

let RESULT: Record<string, string> | undefined;

/** 컨테이너를 한 번만 띄우고 모든 프로브를 한 번에 흘린다 — 도커 왕복이 비싸다. */
function measure(): Record<string, string> {
  if (RESULT !== undefined) return RESULT;
  const dir = mkdtempSync(join(tmpdir(), 'bary-s9-'));
  chmodSync(dir, 0o777);
  try {
    mkdirSync(join(dir, 'conf'), { recursive: true });
    mkdirSync(join(dir, 'logs'), { recursive: true });
    writeFileSync(join(dir, 'conf', 'nginx.conf'),
      `daemon off;\nworker_processes 1;\n${render(model).conf}`, 'utf8');

    // **프로브를 Lua 로 쓴다.** openresty:alpine 에는 node 가 없다 (`resty` 는 있다).
    // 이미지에 런타임을 더 설치하면 그 설치 실패가 곧 이 테스트의 실패로 보이는데,
    // 그건 우리가 재려는 것과 아무 상관이 없다.
    //
    // 바이트는 hex 로 넘긴다 — 셸·conf 인용을 안 거치므로 상하지 않는다.
    const hexOf = Object.entries(PROBES)
      .map(([k, v]) => `{"${k}","${v.toString('hex')}"},`).join('');
    writeFileSync(join(dir, 'back.conf'), backendsConf(`
      local probes = {${hexOf}}
      local function unhex(h)
        return (h:gsub("..", function(c) return string.char(tonumber(c, 16)) end))
      end
      local out = {}
      for _, pair in ipairs(probes) do
        local sock = ngx.socket.tcp()
        sock:settimeout(5000)
        local ok, err = sock:connect("127.0.0.1", ${PORT})
        local verdict
        if not ok then
          verdict = "CONNERR:" .. tostring(err)
        else
          sock:send(unhex(pair[2]))
          local line, rerr = sock:receive("*l")
          if line then verdict = line
          -- **끊긴 것과 시간 초과를 가른다.** 둘 다 표식이 없지만 원인이 다르다.
          elseif rerr == "closed" then verdict = "CLOSED"
          else verdict = "TIMEOUT:" .. tostring(rerr) end
          sock:close()
        end
        out[#out + 1] = string.format('%q:%q', pair[1], verdict)
      end
      ngx.print("---json---{" .. table.concat(out, ",") .. "}")
    `), 'utf8');
    const out = execFileSync('docker', [
      'run', '--rm', '-v', `${dir}:/w:Z`, '--entrypoint', '/bin/sh', IMAGE, '-c',
      'apk add --no-cache curl >/dev/null 2>&1; '
      + '/usr/local/openresty/bin/openresty -p /w -c back.conf & sleep 1.5; '
      + '/usr/local/openresty/bin/openresty -p /w -c conf/nginx.conf & sleep 1.5; '
      + 'curl -s --max-time 60 http://127.0.0.1:19299/probe; '
      + 'echo; echo "---errorlog---"; tail -10 /w/logs/error.log; tail -10 /w/logs/b.log',
    ], { encoding: 'utf8', timeout: 240_000 });
    if (process.env['BARY_DEBUG'] === '1') console.log(out.slice(0, 3000));
    const j = out.split('---json---')[1]?.split('---errorlog---')[0]?.trim();
    if (j === undefined || j === '') throw new Error(`프로브 출력이 없다:\n${out.slice(0, 2000)}`);
    RESULT = JSON.parse(j) as Record<string, string>;
    return RESULT;
  } finally {
    dropScratch(dir);
  }
}

describe('S9 — 렌더된 conf 가 no-SNI 를 가른다', () => {
  beforeAll(() => {
    if (!dockerAvailable()) throw new Error('도커가 없다 — 골든은 실물 엔진으로만 잰다');
  }, 240_000);

  it('`nginx -t` 없이 그냥 선다 — 두 map 과 세 업스트림이 다 맞다', () => {
    const r = measure();
    // 하나라도 값이 오면 엔진이 우리 conf 로 실제로 떴다는 뜻이다.
    expect(Object.values(r).some((v) => v.length > 0), JSON.stringify(r)).toBe(true);
  }, 240_000);

  it('SNI 가 맞으면 그 풀로 간다', () => {
    expect(measure()['sni']).toBe('NAMED');
  }, 240_000);

  it('유효한 SNI 인데 매칭이 없으면 onUnmatchedSni 로 간다', () => {
    expect(measure()['other_sni']).toBe('UNMATCHED');
  }, 240_000);

  it('**TLS 인데 SNI 가 없으면 onNoSni 로 간다** — 확장 유무 둘 다 (S9 가 연 것)', () => {
    const r = measure();
    expect(r['no_sni'], JSON.stringify(r)).toBe('NOSNI');
    expect(r['no_sni_empty_ext'], JSON.stringify(r)).toBe('NOSNI');
  }, 240_000);

  /**
   * **이 파일에서 제일 중요한 두 검사.** §4.1 은 "TLS 패스스루 포트에 온, TLS 로 안
   * 읽히는 바이트를 어디로도 안 보낸다" 고 적었다. `onNoSni` 를 열면서 그 규칙을
   * 깨면 승격을 하지 말았어야 한다 — 사용자가 no-SNI 용으로 고른 풀에 쓰레기
   * 바이트가 닿게 되기 때문이다.
   */
  it('malformed ClientHello 는 어느 풀에도 안 닿는다 — 연결이 끊긴다', () => {
    const r = measure();
    expect(['NAMED', 'UNMATCHED', 'NOSNI'], JSON.stringify(r)).not.toContain(r['malformed']);
    // **끊겼다는 것까지 못 박는다.** 위 검사만 두면 프로브가 붙지도 못했을 때(CONNERR)도
    // 통과한다 — "어디에도 안 닿았다" 가 맞긴 하지만 아무것도 증명하지 않는다.
    //
    // 실측은 `CLOSED`(정상 FIN)가 아니라 **RST** 다: nginx 는 목적지가 빈 값이면
    // 스트림 세션을 즉시 버린다. 그 차이를 얼버무리지 않고 그대로 적는다.
    expect(r['malformed'], JSON.stringify(r)).toMatch(/^(CLOSED|TIMEOUT:connection reset)/);
  }, 240_000);

  it('비-TLS 바이트도 어느 풀에도 안 닿는다 — 연결이 끊긴다', () => {
    const r = measure();
    expect(['NAMED', 'UNMATCHED', 'NOSNI'], JSON.stringify(r)).not.toContain(r['plain']);
    expect(r['plain'], JSON.stringify(r)).toMatch(/^(CLOSED|TIMEOUT:connection reset)/);
  }, 240_000);
});

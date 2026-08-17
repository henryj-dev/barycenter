#!/usr/bin/env node
/**
 * **오래 돌려 본다** (DESIGN.md §6.4)
 *
 * 이 제품이 10 초보다 오래 돌아 본 적이 없다. e2e 는 전부 수십 초짜리이고, 그 사이에는
 * 아무것도 안 샌다. 그런데 이 저장소가 달고 있는 부채는 전부 **"오래 돌면 자란다"**
 * 부류다 — `terminal`·`completed` 원장, 세대 디렉토리, 워커 누적.
 *
 * §6.4 가 못 박은 것들이 하나도 구현돼 있지 않다:
 *
 *   · **디바운스는 옵션이 아니다** — 장수 세션 + 잦은 reload = 워커/메모리 누적
 *   · **reload admission control** — `serving_generations` 상한
 *   · `worker_shutdown_timeout` 의 기본값
 *
 * 이 스크립트는 그것들이 **정말 필요한지, 어떤 모양이어야 하는지**를 재기 위한 것이다.
 * 추측으로 숫자를 넣으면 근거 없는 값이 계약처럼 굳는다 (§11.4 가 자기 표에 대해 경고한
 * 그것). **먼저 재고 그다음에 정한다.**
 *
 *   node scripts/soak.mjs [--minutes 10] [--config-every 8] [--kill-every 5]
 *
 * 판정은 이 스크립트가 하지 않는다. **기울기를 찍어 주고 사람이 본다** — "무엇이 자라면
 * 나쁜가" 의 임계값을 아직 모르기 때문이다. 그걸 정하는 것이 이 실행의 목적이다.
 */
import { execFileSync } from 'node:child_process';
import { connect as netConnect } from 'node:net';
import { createHash } from 'node:crypto';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : Number(process.argv[i + 1]);
};

const MINUTES = arg('minutes', 10);
const CONFIG_EVERY = arg('config-every', 8);   // 설정 변경 주기(초)
const KILL_EVERY = arg('kill-every', 5);       // 백엔드 죽이고 살리는 주기(초)

const NET = 'bary-soak-net';
const PG = 'bary-soak-pg';
const DP = 'bary-soak-dp';
const API = 18601;
const DATA = 18602;
const TOKEN = 'soak-token';

const docker = (...a) => execFileSync('docker', a, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
const quiet = (...a) => { try { docker(...a); } catch { /* 없으면 그만 */ } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, path, body) {
  const r = await fetch(`http://127.0.0.1:${API}${path}`, {
    method,
    headers: {
      authorization: `Bearer ${TOKEN}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await r.text();
  try { return { status: r.status, body: JSON.parse(text) }; } catch { return { status: r.status, body: text }; }
}

function tearDown() {
  quiet('rm', '-f', DP);
  quiet('rm', '-f', PG);
  quiet('network', 'rm', NET);
}

async function up() {
  tearDown();
  docker('network', 'create', NET);
  docker('run', '-d', '--name', PG, '--network', NET,
    '-e', 'POSTGRES_PASSWORD=bary', '-e', 'POSTGRES_DB=bary', 'postgres:17-alpine');
  const hash = createHash('sha256').update(TOKEN).digest('hex');
  docker('run', '-d', '--name', DP, '--network', NET,
    '-p', `${API}:8088`, '-p', `${DATA}:999`,
    '-v', `${process.cwd()}:/app:ro`,
    '-e', `BARY_DSN=postgres://postgres:bary@${PG}:5432/bary`,
    '-e', 'BARY_PREFIX=/prefix', '-e', 'BARY_LISTEN=0.0.0.0:8088',
    '-e', 'BARY_ADMIN_PORT=19999', '-e', 'BARY_STREAM_ADMIN_PORT=19998',
    '-e', 'BARY_ENGINE_BIN=/usr/local/openresty/bin/openresty',
    '-e', `BARY_TOKENS=[{"name":"soak","hash":"sha256:${hash}","scopes":["read","write","apply"]}]`,
    '-e', 'BARY_RELOAD_CMD=kill -HUP $(cat /prefix/logs/nginx.pid)',
    '-e', 'BARY_CONFIGTEST_CMD=/usr/local/openresty/bin/openresty -p /prefix -c /prefix/generations/{generation}/nginx.conf -t',
    '--entrypoint', '/bin/sh', 'openresty/openresty:alpine', '-c', [
      'set -e',
      'apk add --no-cache nodejs >/dev/null 2>&1',
      'mkdir -p /prefix/logs /prefix/state /prefix/generations /backend/logs',
      `printf '%s' 'error_log logs/e.log warn;
pid logs/p.pid;
events { worker_connections 256; }
http { access_log off;
    server { listen 11; location / { return 200 "B11"; }
             location /slow { content_by_lua_block { ngx.sleep(25) ngx.say("SLOW") } } }
    server { listen 12; location / { return 200 "B12"; } }
}
' > /backend/nginx.conf`,
      '/usr/local/openresty/bin/openresty -p /backend -c /backend/nginx.conf',
      'node /app/dist/bin/barycenterd.js --write-bootstrap',
      '/usr/local/openresty/bin/openresty -p /prefix -c /prefix/current/nginx.conf',
      'exec node /app/dist/bin/barycenterd.js',
    ].join(' && '));

  const deadline = Date.now() + 180_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${API}/healthz`, { signal: AbortSignal.timeout(2000) })).ok) return;
    } catch { /* 아직 */ }
    if (Date.now() > deadline) throw new Error(`데몬이 안 떴다:\n${docker('logs', '--tail', '30', DP)}`);
    await sleep(1000);
  }
}

/** patch 한 장을 끝까지 민다. */
async function push(patch) {
  const head = await api('GET', '/api/v1/config/head');
  const cs = await api('POST', '/api/v1/changesets', { base_revision: head.body.revision });
  await api('PATCH', `/api/v1/changesets/${cs.body.id}`, { patch });
  const plan = await api('POST', `/api/v1/changesets/${cs.body.id}/plan`);
  if (plan.status !== 200) return { ok: false, why: plan.body };
  await api('POST', `/api/v1/changesets/${cs.body.id}/commit`, { plan_id: plan.body.id });
  const applied = await api('POST', '/api/v1/apply', { plan_id: plan.body.id });
  return { ok: applied.body?.phase === 'activated', why: applied.body, detail: applied.body?.detail };
}

const metric = (text, name) => {
  const m = new RegExp(`^${name.replace(/[{}"]/g, '\\$&')} (\\d+)$`, 'm').exec(text);
  return m === null ? Number.NaN : Number(m[1]);
};

async function sample() {
  const r = await fetch(`http://127.0.0.1:${API}/metrics`, { headers: { authorization: `Bearer ${TOKEN}` } });
  const text = await r.text();
  // **워커 수는 엔진에서 직접 센다.** §6.4 의 "워커 누적" 이 이 실행의 주된 관심사인데
  // 컨트롤 플레인은 그걸 모른다 — 메트릭의 빈칸을 여기서 손으로 메운다.
  const workers = Number(docker('exec', DP, 'sh', '-c',
    "ps | grep -c '[n]ginx: worker' || echo 0").trim());
  // busybox `ps` 는 `-C` 도 `-o` 도 모른다. 전체를 찍고 골라 센다 — 처음엔 0 만 나왔고,
  // **0 은 "없다" 가 아니라 "못 읽었다" 였다.**
  const engineRss = Number(docker('exec', DP, 'sh', '-c',
    "ps -o pid,rss,args 2>/dev/null | grep '[n]ginx:' | awk '{s+=$2} END {print s+0}'").trim());
  return {
    t: Math.round(process.uptime()),
    generations: metric(text, 'bary_generations'),
    generationKb: Math.round(metric(text, 'bary_generation_bytes') / 1024),
    agentStateKb: Math.round(metric(text, 'bary_agent_state_bytes') / 1024),
    head: metric(text, 'bary_config_head_revision'),
    epoch: metric(text, 'bary_activation_epoch_http'),
    rssMb: Math.round(metric(text, 'bary_process_rss_bytes') / 1048576),
    workers,
    engineRssMb: Math.round(engineRss / 1024),
  };
}

const COLS = ['t', 'head', 'epoch', 'generations', 'generationKb', 'agentStateKb', 'workers', 'rssMb', 'engineRssMb'];
const row = (s) => COLS.map((c) => String(s[c]).padStart(c.length)).join('  ');

async function main() {
  console.log(`soak: ${MINUTES}분 · 설정 변경 ${CONFIG_EVERY}초마다 · 백엔드 토글 ${KILL_EVERY}초마다`);
  await up();

  await push([
    { op: 'put', kind: 'pool', key: 'app', body: { protocolClass: 'http', algorithm: 'round_robin' } },
    { op: 'put', kind: 'backend', key: 'b11', body: { pool: 'app', host: '127.0.0.1', port: 11, weight: 1 } },
    { op: 'put', kind: 'backend', key: 'b12', body: { pool: 'app', host: '127.0.0.1', port: 12, weight: 1 } },
    { op: 'put', kind: 'listener', key: 'front', body: {
      protocol: 'http', bind: '0.0.0.0', port: 999, enabled: true,
      http: { defaultAction: { pool: 'app' } } } },
  ]);

  const first = await sample();
  console.log(`\n${COLS.join('  ')}`);
  console.log(row(first));

  const end = Date.now() + MINUTES * 60_000;
  let i = 0;
  let dead = false;
  let failures = 0;
  let requests = 0;
  let errors = 0;
  const keepAlive = new AbortController();

  /**
   * **장수 연결을 붙든다** — §6.4 의 경고가 *"장수 TCP 세션 + 잦은 reload = 워커/메모리
   * 누적"* 이므로 그 조합을 만들어야 잰다. 짧은 요청만 흘리면 옛 워커가 바로 죽어서
   * 누적이 안 생기고, 그러면 "안 자란다" 는 결론이 **무대 탓**이 된다.
   *
   * 응답을 받은 뒤 소켓을 안 닫고 들고 있는다. HUP 이 와도 이 연결을 쥔 옛 워커는
   * 남는다.
   */
  // **유휴 keepalive 로는 안 된다.** S11 의 P8 이 실측했다 — HUP 은 옛 워커의 유휴
  // keepalive 연결을 닫는다. 워커를 붙들려면 **진행 중인 요청**이어야 한다. 처음엔
  // 유휴 연결 여덟 개를 쥐고 "워커가 안 자란다" 는 결론을 낼 뻔했는데, 그건 제품이
  // 아니라 무대가 만든 답이었다.
  const held = [];
  const holdSlow = () => {
    const sock = netConnect({ host: '127.0.0.1', port: DATA });
    sock.on('error', () => undefined);
    sock.on('close', () => {
      if (!keepAlive.signal.aborted) held.push(holdSlow());
    });
    sock.write('GET /slow HTTP/1.1\r\nHost: soak\r\nConnection: keep-alive\r\n\r\n');
    sock.resume();
    return sock;
  };

  for (let k = 0; k < 8; k += 1) held.push(holdSlow());

  // **트래픽을 계속 흘린다.**
  const traffic = (async () => {
    const agent = { keepalive: true };
    while (!keepAlive.signal.aborted) {
      try {
        requests += 1;
        const r = await fetch(`http://127.0.0.1:${DATA}/`, { signal: AbortSignal.timeout(3000), ...agent });
        await r.text();
        if (!r.ok) errors += 1;
      } catch {
        // **여기서도 요청은 한 번이다.** 처음엔 성공에서만 세어 실패율이 205% 로 나왔다 —
        // 계측기가 100% 를 넘는 비율을 답하면 그건 계측기가 틀린 것이다.
        errors += 1;
      }
      await sleep(50);
    }
  })();

  while (Date.now() < end) {
    i += 1;
    // 설정 변경 — 매번 산출물이 바뀌게 해서 **세대 전환 + reload** 를 강제한다.
    // **와이어 프로토콜을 안 바꾸는 변경**이어야 한다. 처음엔 :999 의
    // `acceptProxyProtocol` 을 격번으로 켰는데, 그러면 평문으로 던지는 이 하네스가 절반
    // 실패한다 — 실패율 51% 는 제품이 아니라 **계측기가 만든 것**이었다.
    // 다른 포트의 리스너를 켰다 껐다 하면 산출물은 바뀌고 :999 는 안 건드린다.
    const res = await push(i % 2 === 0
      ? [{ op: 'put', kind: 'listener', key: 'side', body: {
          protocol: 'http', bind: '0.0.0.0', port: 998, enabled: true,
          http: { defaultAction: { pool: 'app' } } } }]
      : [{ op: 'delete', kind: 'listener', key: 'side' }]);
    if (!res.ok) {
      failures += 1;
      const d = res.why?.detail ?? {};
      console.log(`  ! apply 실패 (${i}회차) phase=${res.why?.phase} `
        + `failure=${d.failure ?? res.why?.message ?? JSON.stringify(res.why).slice(0, 120)}`);
    }

    // 백엔드를 죽였다 살린다 — 헬스 전이와 멤버십 투영을 계속 만든다.
    if (i % Math.max(1, Math.round(KILL_EVERY / CONFIG_EVERY)) === 0) {
      dead = !dead;
      const [from, to] = dead ? ['listen 11;', 'listen 1111;'] : ['listen 1111;', 'listen 11;'];
      quiet('exec', DP, 'sh', '-c',
        `sed -i 's/${from}/${to}/' /backend/nginx.conf && /usr/local/openresty/bin/openresty -p /backend -c /backend/nginx.conf -s reload`);
    }

    await sleep(CONFIG_EVERY * 1000);
    console.log(row(await sample()));
  }

  keepAlive.abort();
  await traffic.catch(() => undefined);
  for (const sock of held) sock.destroy();

  const last = await sample();
  console.log('\n── 기울기 ─────────────────────────────────────────────');
  for (const c of COLS.slice(1)) {
    const d = last[c] - first[c];
    console.log(`  ${c.padEnd(14)} ${String(first[c]).padStart(6)} → ${String(last[c]).padStart(6)}   ${d >= 0 ? '+' : ''}${d}`);
  }
  console.log(`\n  설정 변경 ${i}회 · apply 실패 ${failures}회`);
  console.log(`  트래픽 ${requests}건 · 실패 ${errors}건 (${(errors / Math.max(1, requests) * 100).toFixed(1)}%)`);
  console.log('\n※ 판정은 사람이 한다. 무엇이 자라면 나쁜지의 임계값을 정하는 것이 이 실행의 목적이다.');

  if (process.argv.includes('--keep')) {
    console.log(`\n컨테이너를 남긴다: docker logs ${DP}`);
  } else {
    tearDown();
  }
}

main().catch((e) => {
  console.error(String(e));
  tearDown();
  process.exit(1);
});

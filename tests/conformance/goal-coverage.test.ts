/**
 * **검수 목록이 코드에 닿아 있는가** — 한 줄에 한 검사
 *
 * 검수가 남긴 목록(①②③)이 닫혔는지를 사람이 매번 다시 세고 있었다. 그때마다 근거는
 * 커밋 로그였고, 커밋 로그는 *"그래서 지금 되는가"* 에 답하지 못한다 — 되돌려졌을 수도,
 * 중간 한 마디가 빠졌을 수도 있다.
 *
 * **그 판정을 기계에 옮긴다.** 이 파일이 빨개지면 그 줄이 실제로 열린 것이고, 초록이면
 * 그 줄은 닫혀 있다. 세는 일이 아니라 도는 일이 된다.
 *
 * ── 무엇을 재고 무엇을 안 재나
 *
 * **동작을 잰다.** 파일이 있는지가 아니라 값을 넣으면 값이 나오는지를 본다 — 파일 존재는
 * 이 저장소가 반복해서 잡아 온 *"필드는 있는데 아무도 안 읽는다"* 를 못 잡는다.
 *
 * 스파이크만 예외다. 그건 도커가 필요해 여기서 못 돌리므로 **게이트에 배선돼 있는가**를
 * 본다 — 안 도는 스파이크는 없는 것과 같고, 일부러 뺀 것은 `verify.sh` 가 이유와 함께
 * 적어 두는 것이 이 저장소의 규칙이다.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseListenerOptions, putPassthroughListenerPatch, upstreamTlsField } from '../../src/web/edit.js';
import { listenerCreatePatch } from '../../src/cli/listener.js';
import { poolCreatePatch } from '../../src/cli/pool.js';
import { getPath } from '../../src/cli/get.js';
import { render } from '../../src/conf/render.js';
import { trafficMarkOf } from '../../src/web/pools-view.js';
import { transportsOf, transportSetsOverlap } from '../../src/validate/sockets.js';
import { planStrictPriority } from '../../src/route/compile.js';
import { parseHostPattern } from '../../src/validate/strings.js';
import { principalFromClientCert, TokenAuth } from '../../src/api/auth.js';
import { socketRows } from '../../src/web/sockets-view.js';
import { RemoteDataplaneDriver } from '../../src/dp/remote.js';
import { createDpAgentServer } from '../../src/dp/agent-server.js';
import { sweepDatabase } from '../../src/store/db-retention.js';
import type { Model } from '../../src/model/provisional.js';

const ROOT = join(import.meta.dirname, '..', '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf8');

// ── ① 저작 표면 ─────────────────────────────────────────────────────────
//
// > 레이트리밋·헤더·프록시 한계값은 **모델·API·렌더러까지만 갔다.**
// > CLI 전용 플래그 ❌ · GUI 폼 ❌ · 제안 9 를 GUI 가 보여주기 ❌

describe('① 저작 표면', () => {
  it('CLI 플래그가 파서를 지나 값이 된다', () => {
    const o = parseListenerOptions({
      rate: '10r/s', burst: '20', nodelay: true, maxConn: '100',
      maxBody: '50m', connectTimeout: '5s', readTimeout: '120s', sendTimeout: '90s',
      header: ['req:X-A:1', 'res:X-B:2'],
    });
    expect(o.rateLimit?.requestsPerSecond, '--rate 가 안 읽힌다').toBe(10);
    expect(o.rateLimit?.maxConnections, '--max-conn 이 안 읽힌다').toBe(100);
    expect(o.limits?.clientMaxBodyBytes, '--max-body 가 안 읽힌다').toBe(50 * 1024 * 1024);
    expect(o.limits?.readTimeoutMs, '--read-timeout 이 안 읽힌다').toBe(120_000);
    expect(o.headers?.request?.[0]?.name, '--header req 가 안 읽힌다').toBe('X-A');
    expect(o.headers?.response?.[0]?.name, '--header res 가 안 읽힌다').toBe('X-B');
  });

  /** **바이너리가 그 이름을 실제로 받는가.** 파서만 있고 플래그가 없으면 못 쓴다. */
  it('바이너리가 그 플래그 이름들을 받는다', () => {
    const bin = read('src/bin/bary.ts');
    for (const flag of [
      '--rate', '--burst', '--nodelay', '--max-conn', '--max-body',
      '--connect-timeout', '--read-timeout', '--send-timeout', '--header',
      '--strict-priority', '--no-sni-pool', '--upstream-tls',
    ]) {
      expect(bin.includes(`'${flag}'`), `${flag} 를 안 받는다`).toBe(true);
    }
  });

  it('GUI 폼이 같은 파서를 쓴다 — 두 벌이면 값이 갈린다', () => {
    const form = read('gui/src/lib/ListenerOptions.svelte');
    for (const field of ['value.rate', 'value.maxBody', 'value.nodelay', 'value.strictPriority']) {
      expect(form.includes(field), `폼에 ${field} 가 없다`).toBe(true);
    }
    expect(form, '폼이 자기 파서를 갖고 있으면 CLI 와 갈린다').toContain('parseListenerOptions');
  });

  /** 제안 #9 — 왜 트래픽을 안 받나. 관측 없음·받는 중·안 받음이 셋 다 다르다. */
  it('제안 9 를 화면이 읽을 수 있다', () => {
    expect(trafficMarkOf(undefined)).toBeUndefined();
    expect(trafficMarkOf({ receivingTraffic: true, reasons: [] })).toBeUndefined();
    const mark = trafficMarkOf({ receivingTraffic: false, reasons: ['unhealthy'] });
    expect(mark?.reasons?.[0]).toBeDefined();
    expect(mark?.reasons?.[0], '코드가 사람 말로 안 바뀐다').not.toBe('unhealthy');
    expect(read('gui/src/lib/Pools.svelte'), '화면이 그것을 안 읽는다').toContain('trafficMark');
  });

  it('CLI 가 backends/status 를 읽을 수 있다', () => {
    expect(getPath('backends/status')).toBe('/api/v1/backends/status');
  });
});

// ── ② 축소 등급 스파이크 ────────────────────────────────────────────────

describe('② 스파이크가 게이트에 배선돼 있다', () => {
  const gate = read('scripts/verify.sh');

  /**
   * **도는 것과 일부러 뺀 것을 가른다.** 안 도는 스파이크는 없는 것과 같고,
   * 뺀 것은 이유가 적혀 있어야 한다 — 그게 이 저장소가 S20·S10·S14 에 대해 한 것이다.
   */
  it('도는 스파이크는 게이트가 부른다', () => {
    for (const s of ['s1-s5', 's7', 's8', 's9', 's11', 's12', 's13', 's15', 's16', 's17', 's18', 's19']) {
      expect(gate.includes(`./spike/${s}/run.sh`), `spike/${s} 가 게이트에 없다`).toBe(true);
    }
  });

  it('뺀 스파이크는 이유가 적혀 있다', () => {
    for (const [s, why] of [['s10', '게이트에 안 넣는다'], ['s14', '게이트에 안 넣는다'], ['s20', '일부러 안 넣는다']] as const) {
      expect(gate.includes(why), `spike/${s} 를 뺀 이유가 없다`).toBe(true);
    }
  });
});

describe('② 스파이크가 연 기능이 실제로 선다', () => {
  const pool = (extra: Record<string, unknown>) => ({
    key: 'app', protocolClass: 'http', algorithm: 'round_robin', ...extra,
  });
  const model = (pools: unknown[], listeners: unknown[]): Model => ({
    listeners, httpRoutes: [], passthroughRoutes: [], pools,
    backends: [{ key: 'a', pool: 'app', host: '10.0.0.1', port: 80, weight: 1 }],
    certificates: [], tlsPolicies: [], sniBindings: [],
  } as unknown as Model);

  /** S6 — `least_conn`. 렌더가 `in:` 을 읽어 최소를 고른다. */
  it('S6 least_conn 이 렌더까지 간다', () => {
    const conf = render(model(
      [pool({ algorithm: 'least_conn' })],
      [{ key: 'w', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true, http: { defaultAction: { pool: 'app' } } }],
    ), { httpLua: true, streamLua: true, streamRealip: false }).conf;
    expect(conf, 'least_conn 이 inflight 를 안 읽는다').toContain('d:get("in:"');
  });

  /** S9 — `on_no_sni`. */
  it('S9 on_no_sni 가 패치까지 간다', () => {
    const [op] = putPassthroughListenerPatch('pt', {
      bind: '0.0.0.0', port: 8443, noSniPool: 'nosni',
    });
    expect(op!.body.onNoSni).toEqual({ pool: 'nosni' });
  });

  /** S10 — `strict_priority`. 역전이 있으면 연결 요소 전체를 내린다. */
  it('S10 strict_priority 가 연결 요소를 내린다', () => {
    const pat = (h: string) => {
      const p = parseHostPattern(h);
      if (!p.ok) throw new Error(h);
      return p.value;
    };
    const plan = planStrictPriority([
      { key: 'a.x.test', pattern: pat('a.x.test'), priority: 10 },
      { key: '*.x.test', pattern: pat('*.x.test'), priority: 20 },
    ]);
    expect(plan.lowered.size, '역전인데 안 내린다').toBe(2);
  });

  /** S20 의 선결 조건 — §4.5 가 전송을 **집합**으로 낸다. */
  it('S20 선결 조건: 전송이 집합이고 교집합으로 겹친다', () => {
    expect(transportsOf('https')).toEqual(['tcp']);
    expect(transportSetsOverlap(['tcp', 'udp'], transportsOf('udp')), 'h3 의 UDP 를 못 잡는다').toBe(true);
    expect(transportSetsOverlap(transportsOf('http'), transportsOf('udp'))).toBe(false);
  });
});

// ── ③ 그 밖 ─────────────────────────────────────────────────────────────

describe('③ 그 밖', () => {
  it('보존 정책이 여섯 표를 안다 — 다섯은 안 정하면 안 지운다', async () => {
    const calls: string[] = [];
    const db = {
      query: (sql: string) => {
        calls.push(sql);
        return Promise.resolve({ rows: [], rowCount: 0 });
      },
    };
    const out = await sweepDatabase({ db });
    expect(Object.keys(out).sort()).toEqual(
      ['audit', 'changesets', 'healthEvents', 'operations', 'plans', 'revisions'],
    );
    // 안 정한 다섯은 질의조차 안 나간다.
    expect(out.audit).toBe(0);
    expect(out.plans).toBe(0);
    expect(out.changesets).toBe(0);
    expect(out.operations).toBe(0);
    expect(out.revisions).toBe(0);
  });

  /** `terminal` 원장은 DB 가 아니라 에이전트 상태다 — 거기 규칙이 산다. */
  it('terminal 원장에 자르는 규칙이 있다', () => {
    const agent = read('src/dp/agent.ts');
    expect(agent, 'terminal 가지치기가 없다').toContain('function pruneTerminal');
    expect(agent, '좌표를 값에 안 적으면 못 자른다').toContain('terminalAt');
  });

  it('mTLS 가 인증서를 신원으로 쓴다 — 역할은 표에서 온다', () => {
    // 해시는 `sha256:<64 hex>` 여야 한다 — `TokenAuth` 가 모양을 스스로 지킨다.
    const auth = new TokenAuth([
      { name: 'cp-1', hash: `sha256:${'a'.repeat(64)}`, scopes: ['read'] },
    ]);
    const who = principalFromClientCert(
      { subject: { CN: 'cp-1' }, authorized: true }, auth,
    );
    expect(who?.name, '검증된 CN 을 신원으로 못 쓴다').toBe('cp-1');
    // **검증 안 된 인증서는 안 본다.** 그 판정이 혼자 서야 한다.
    expect(
      principalFromClientCert({ subject: { CN: 'cp-1' }, authorized: false }, auth),
      '검증 안 된 인증서를 신원으로 썼다',
    ).toBeUndefined();
    // **모르는 CN 은 아무것도 아니다.** 인증서가 신원을 만들지 않는다.
    expect(principalFromClientCert({ subject: { CN: 'nope' }, authorized: true }, auth))
      .toBeUndefined();
  });

  it('원격 드라이버가 있고 평문·무인증을 안 받는다', () => {
    expect(() => new RemoteDataplaneDriver({
      baseUrl: 'http://dp-1:8443',
      clientCertFile: 'x', clientKeyFile: 'x', caFile: 'x',
    }), '평문 URL 을 받는다').toThrow(/https/);
    expect(() => createDpAgentServer({
      driver: {} as never, cert: '', key: '', ca: '', allowedClientNames: [],
    }), 'CN 목록이 비어도 창구를 연다').toThrow(/비어 있다/);
  });

  it('§11.3 — 배포가 열어야 할 소켓 집합이 나온다', () => {
    const rows = socketRows({
      listeners: [
        { key: 'web', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true },
        { key: 'dns', protocol: 'udp', bind: '0.0.0.0', port: 53, enabled: false },
      ],
      httpRoutes: [], passthroughRoutes: [], pools: [], backends: [],
      certificates: [], tlsPolicies: [], sniBindings: [],
    } as unknown as Model);
    expect(rows.map((r) => `${r.transport}:${r.port}`)).toEqual(['udp:53', 'tcp:80']);
    // 꺼진 것도 낸다 — 방화벽에서 빼 두면 켤 때 트래픽이 안 들어온다.
    expect(rows.find((r) => r.port === 53)?.enabled).toBe(false);
  });

  it('▲ 잔여물의 두 절이 따로 재어진다', () => {
    // 창이 열리는가 / 수렴이 덮는가 — 앞의 것을 안 재면 뒤의 것은 아무것도 안 지킨다.
    expect(read('tests/conformance/check-effect-gap.test.ts')).toContain('창이 정말 열리는가');
    expect(read('tests/store/reproject-window.test.ts')).toContain('projectHealth');
  });

  it('§4.3 — upstream_tls 가 있고 verify 는 번들 없이 못 켠다', () => {
    const patch = poolCreatePatch({
      name: 'app', protocolClass: 'http', backend: 'a', host: '10.0.0.1', port: 443,
      upstreamTls: { enabled: true, sni: 'backend.internal' },
    })!;
    expect(JSON.stringify(patch)).toContain('upstreamTls');
    expect(() => upstreamTlsField({ enabled: true, verify: true }), '번들 없는 verify 가 통과한다')
      .toThrow(/caBundle/);
  });

  it('리스너 옵션이 http 계열에만 붙는다 — 없는 자리를 안 만든다', () => {
    // tcp 리스너에는 옵션 자리가 없다. 있으면 저장되고 아무도 안 읽는다.
    const patch = listenerCreatePatch({
      name: 'raw', protocol: 'tcp', bind: '0.0.0.0', port: 9000, pool: 'app',
      options: parseListenerOptions({ rate: '10r/s' }),
    })!;
    expect(JSON.stringify(patch)).not.toContain('rateLimit');
  });
});

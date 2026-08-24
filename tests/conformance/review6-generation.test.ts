/**
 * 6차 검수 — 오퍼레이션과 artifact 의 결박 (DESIGN.md §7.2 · §6.2 #2)
 *
 * 지적은 이랬다.
 *
 *   · `publish()` 는 디렉토리와 `nginx.conf` 의 **존재만** 확인한다.
 *   · `payloadDigest` 를 실제 바이트와 대조하지 않는다.
 *   · `.tmp-N` · manifest/READY · 디렉토리 rename 을 수행하는 production 코드가 **없다.**
 *     테스트가 세대를 손으로 써 뒀을 뿐이다.
 *
 * 그래서 **같은 세대 이름 아래 임의의 바이트를 활성화하고 좌표까지 commit** 할 수 있었다.
 * 세대 이름은 무엇을 활성화하는지 말하지 못한다. 내용이 말한다.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { FakeEffects } from '../../src/testing/apply-fakes.js';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  GenerationError,
  MANIFEST_NAME,
  materializeGeneration,
  readManifest,
  verifyGeneration,
} from '../../src/dp/materialize.js';
import { DpAgent, MemoryStore } from '../../src/dp/agent.js';
import { CHECKED_TOKEN } from '../../src/dp/operation.js';
import { ApplyRunner } from '../../src/dp/apply.js';
import { FsEffects } from '../../src/dp/effects-fs.js';
import type { ApplyOperation } from '../../src/dp/operation.js';

let prefix: string;

beforeEach(() => {
  prefix = mkdtempSync(join(tmpdir(), 'bary-gen-'));
});
afterEach(() => rmSync(prefix, { recursive: true, force: true }));

const FILES = { 'nginx.conf': 'events {}\nhttp { server { listen 80; } }\n' };
const make = (generation: string, files = FILES) => materializeGeneration({ prefix, generation, files, planes: ['http'] });

const kindOf = (fn: () => unknown): string => {
  try {
    fn();
    return '거부되지 않았다';
  } catch (e) {
    return e instanceof GenerationError ? e.kind : (e as Error).name;
  }
};

// ── 원자적 게시 ─────────────────────────────────────────────────────────

describe('세대는 통째로 나타난다 (§7.2)', () => {
  it('만들면 manifest 와 파일이 함께 있다', () => {
    const m = make('gen-1');
    expect(existsSync(join(prefix, 'generations', 'gen-1', 'nginx.conf'))).toBe(true);
    expect(readManifest(prefix, 'gen-1').digest).toBe(m.digest);
  });

  it('임시 디렉토리를 남기지 않는다', () => {
    make('gen-1');
    make('gen-2');
    const leftovers = readdirSync(join(prefix, 'generations')).filter((f) => f.startsWith('.tmp-'));
    expect(leftovers, `임시 디렉토리가 남았다: ${leftovers.join(', ')}`).toEqual([]);
  });

  it('manifest 가 마지막이다 — 있으면 나머지도 있다는 뜻이어야 한다', () => {
    make('gen-1');
    const dir = join(prefix, 'generations', 'gen-1');
    expect(readdirSync(dir).sort()).toEqual([MANIFEST_NAME, 'nginx.conf'].sort());
  });

  it('같은 이름 같은 내용은 멱등이다', () => {
    const a = make('gen-1');
    const b = make('gen-1');
    expect(b.digest).toBe(a.digest);
  });

  it('**같은 이름 다른 내용은 거부된다** — 세대는 불변이다', () => {
    make('gen-1');
    expect(kindOf(() => make('gen-1', { 'nginx.conf': '다른 내용\n' }))).toBe('generation_conflict');
    // 원본이 그대로여야 한다.
    expect(readFileSync(join(prefix, 'generations', 'gen-1', 'nginx.conf'), 'utf8')).toBe(
      FILES['nginx.conf'],
    );
  });
});

// ── 활성화 직전 대조 ────────────────────────────────────────────────────

describe('활성화 직전에 디스크를 다시 읽는다', () => {
  it('정상 세대는 통과한다', () => {
    const m = make('gen-1');
    expect(verifyGeneration(prefix, 'gen-1', m.digest).digest).toBe(m.digest);
  });

  it('오퍼레이션의 digest 가 다르면 거부된다 — 같은 이름, 다른 바이트', () => {
    make('gen-1');
    expect(kindOf(() => verifyGeneration(prefix, 'gen-1', 'sha256:남의것'))).toBe('digest_mismatch');
  });

  it('**manifest 만 맞고 내용이 바뀐 세대**는 거부된다', () => {
    const m = make('gen-1');
    // manifest 는 그대로 두고 파일만 바꾼다 — manifest 를 믿으면 통과한다.
    writeFileSync(join(prefix, 'generations', 'gen-1', 'nginx.conf'), '바꿔치기\n', 'utf8');
    expect(kindOf(() => verifyGeneration(prefix, 'gen-1', m.digest))).toBe('digest_mismatch');
  });

  it('파일이 사라졌으면 거부된다', () => {
    const m = make('gen-1');
    rmSync(join(prefix, 'generations', 'gen-1', 'nginx.conf'));
    expect(kindOf(() => verifyGeneration(prefix, 'gen-1', m.digest))).toBe('incomplete');
  });

  it('manifest 에 없는 파일이 끼어 있으면 거부된다', () => {
    const m = make('gen-1');
    writeFileSync(join(prefix, 'generations', 'gen-1', '몰래.conf'), 'x\n', 'utf8');
    expect(kindOf(() => verifyGeneration(prefix, 'gen-1', m.digest))).toBe('digest_mismatch');
  });

  it('manifest 없이 손으로 만든 디렉토리는 우리 것이 아니다', () => {
    // 6차 검수 전에는 테스트가 세대를 이렇게 써 뒀고, publish 는 존재만 확인했다.
    const dir = join(prefix, 'generations', 'gen-손수');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'nginx.conf'), 'events {}\n', 'utf8');
    expect(kindOf(() => verifyGeneration(prefix, 'gen-손수'))).toBe('manifest_missing');
  });

  it('없는 세대도 마찬가지다', () => {
    expect(kindOf(() => verifyGeneration(prefix, 'gen-없음'))).toBe('manifest_missing');
  });
});

// ── 러너까지 이어진다 ───────────────────────────────────────────────────

const OP = (o: Partial<ApplyOperation> = {}): ApplyOperation => ({
  leaderToken: '10',
  operationId: 'op-1',
  transitionId: 't-1',
  affectedPlanes: ['http', 'stream'],
  targetGeneration: 'gen-1',
  generationDigest: 'sha256:채워짐',
  planes: {
    http: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: 'sha256:h',
    },
    stream: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: 'sha256:s',
    },
  },
  ...o,
});

const FAST = { attempts: 1, intervalMs: 0, sleep: async () => {} };

describe('게시 전 검사가 실제로 게시를 막는다 (§6.2 #2)', () => {
  const fsEffects = (over: Partial<ConstructorParameters<typeof FsEffects>[0]> = {}) =>
    new FsEffects({
      prefix,
      reload: async () => undefined,
      probeAccepting: async () => 'gen-1',
      ...over,
    });

  it('digest 가 맞으면 게시한다 — 막는 것만 하는 게 아니다', async () => {
    const m = make('gen-1');
    const agent = new DpAgent(new MemoryStore());
    const r = await new ApplyRunner(agent, fsEffects(), FAST).run(
      OP({ generationDigest: m.digest }),
    );
    expect(r.phase).toBe('activated');
    expect(existsSync(join(prefix, 'current'))).toBe(true);
  });

  it('**digest 가 다르면 current 를 건드리지 않는다**', async () => {
    make('gen-1');
    const agent = new DpAgent(new MemoryStore());
    const r = await new ApplyRunner(agent, fsEffects(), FAST).run(
      OP({ generationDigest: 'sha256:남의것' }),
    );
    expect(r.phase).toBe('failed');
    expect(existsSync(join(prefix, 'current')), '거부됐는데 게시했다').toBe(false);
    expect(agent.coordinate('http').activationEpoch).toBe('0');
  });

  it('엔진이 설정을 거부하면 게시하지 않는다 (nginx -t)', async () => {
    const m = make('gen-1');
    const agent = new DpAgent(new MemoryStore());
    const r = await new ApplyRunner(
      agent,
      fsEffects({ configTest: async () => false }),
      FAST,
    ).run(OP({ generationDigest: m.digest }));
    expect(r.phase).toBe('failed');
    expect(existsSync(join(prefix, 'current')), 'nginx -t 가 거부했는데 게시했다').toBe(false);
  });

  it('config test 를 **돌리지 못한 것**은 게시 전 실패다', async () => {
    const m = make('gen-1');
    const agent = new DpAgent(new MemoryStore());
    const r = await new ApplyRunner(
      agent,
      fsEffects({
        configTest: async () => {
          throw new Error('바이너리가 없다');
        },
      }),
      FAST,
    ).run(OP({ generationDigest: m.digest }));
    // §6.3은 활성화 증거 판정의 원칙이고, 게시 전 게이트는 실행 오류를 막는다.
    expect(r.phase).toBe('failed');
  });

  it('preflight 는 게시보다 **먼저** 불린다', async () => {
    const agent = new DpAgent(new MemoryStore());
    const fx = new FakeEffects();
    fx.preflightOk = false;
    const r = await new ApplyRunner(agent, fx, FAST).run(OP());
    expect(r.phase).toBe('failed');
    expect(fx.preflightCalls).toBe(1);
    expect(fx.publishCalls, 'preflight 가 막았는데 게시했다').toBe(0);
    expect(fx.reloadSignals).toBe(0);
  });
});

// ── 세대와 평면의 결박 (10차 반례 ②) ───────────────────────────────────

describe('세대가 구성하는 평면을 오퍼레이션이 전부 선언해야 한다', () => {
  /**
   * 하나의 `nginx.conf` 가 http 와 stream 을 **함께** 바꾼다. 그런데 apply 는 평면별로
   * 좌표를 옮기므로, 오퍼레이션이 한 평면만 선언하면 나머지 평면은 **설정은 활성화되고
   * 좌표는 옛 값**으로 남는다. 조용한 갈라짐이다.
   *
   * 그래서 manifest 가 어느 평면을 구성하는지 적고, 게시 전에 대조한다.
   */
  const BOTH_FILES = {
    'nginx.conf': 'events {}\nhttp { server { listen 80; } }\nstream { server { listen 9000; proxy_pass p; } }\n',
  };

  it('manifest 가 평면을 기록한다', () => {
    const m = materializeGeneration({
      prefix, generation: 'gen-both', files: BOTH_FILES, planes: ['http', 'stream'],
    });
    expect(m.planes).toEqual(['http', 'stream']);
    expect(readManifest(prefix, 'gen-both').planes).toEqual(['http', 'stream']);
  });

  it('선언한 평면이 맞으면 통과한다 — 막는 것만 하는 게 아니다', () => {
    const m = materializeGeneration({
      prefix, generation: 'gen-both', files: BOTH_FILES, planes: ['http', 'stream'],
    });
    expect(verifyGeneration(prefix, 'gen-both', m.digest, ['http', 'stream']).planes)
      .toEqual(['http', 'stream']);
  });

  it('**한 평면만 선언하면 거부된다** — stream 좌표가 옛 값으로 남는다', () => {
    const m = materializeGeneration({
      prefix, generation: 'gen-both', files: BOTH_FILES, planes: ['http', 'stream'],
    });
    expect(kindOf(() => verifyGeneration(prefix, 'gen-both', m.digest, ['http'])))
      .toBe('plane_mismatch');
  });

  /**
   * 11차 뒤 규칙이 **포함 관계**로 바뀌었다. 설정 apply 는 항상 두 평면을 선언하고,
   * 세대는 그중 일부만 구성할 수 있다 — 비는 평면도 전환이기 때문이다.
   * 반대 방향(세대가 구성하는데 선언 안 함)만 거부한다.
   */
  it('세대보다 넓게 선언하는 것은 허용된다 — 비는 평면도 전환이다', () => {
    const m = materializeGeneration({
      prefix, generation: 'gen-http', files: FILES, planes: ['http'],
    });
    expect(verifyGeneration(prefix, 'gen-http', m.digest, ['http', 'stream']).planes)
      .toEqual(['http']);
  });

  /**
   * 11차 뒤로 **러너에서는 이 경로에 닿지 않는다.** 설정 apply 가 두 평면을 모두
   * 선언하도록 `assertEnvelope` 가 먼저 막기 때문이다 (`review11-reconcile`).
   *
   * 그래도 `verifyGeneration` 의 검사는 남긴다 — 러너를 거치지 않는 호출자가 있고,
   * 한 층이 막는다고 다른 층을 비우면 그 층을 우회하는 경로가 생긴다.
   */
  it('한 평면만 선언한 오퍼레이션은 **게시 앞에서** 막힌다', async () => {
    const m = materializeGeneration({
      prefix, generation: 'gen-both', files: BOTH_FILES, planes: ['http', 'stream'],
    });
    const agent = new DpAgent(new MemoryStore());
    let kind = '통과';
    try {
      await new ApplyRunner(
        agent,
        new FsEffects({ prefix, reload: async () => undefined, probeAccepting: async () => 'gen-both' }),
        FAST,
      ).run(OP({
        targetGeneration: 'gen-both',
        generationDigest: m.digest,
        affectedPlanes: ['http'],
        planes: { http: OP().planes.http! },
      }));
    } catch (e) {
      kind = (e as { kind?: string }).kind ?? (e as Error).name;
    }
    expect(kind).toBe('envelope_mismatch');
    expect(existsSync(join(prefix, 'current')), '평면이 어긋나는데 게시했다').toBe(false);
  });

  it('렌더러가 구성한 평면이 manifest 로 이어지고 대조에 쓰인다', async () => {
    const { render } = await import('../../src/conf/render.js');
    const { parseModel } = await import('../../src/model/decode.js');
    const parsed = parseModel({
      listeners: [
        { key: 'lh', protocol: 'http', bind: '0.0.0.0', port: 80, enabled: true },
        { key: 'lt', protocol: 'tcp', bind: '0.0.0.0', port: 9000, enabled: true, defaultPool: 'p' },
      ],
      httpRoutes: [{
        key: 'r', listener: 'lh', hosts: ['a.example'], priority: 1,
        action: { kind: 'proxy', pool: 'ph', websocket: false },
      }],
      certificates: [], tlsPolicies: [], sniBindings: [],
      passthroughRoutes: [],
      pools: [
        { key: 'p', protocolClass: 'tcp', algorithm: 'round_robin' },
        { key: 'ph', protocolClass: 'http', algorithm: 'round_robin' },
      ],
      backends: [
        { key: 'b', pool: 'p', host: '10.0.0.1', port: 80, weight: 1 },
        { key: 'bh', pool: 'ph', host: '10.0.0.2', port: 80, weight: 1 },
      ],
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;

    const rendered = render(parsed.model);
    expect(rendered.planes).toEqual(['http', 'stream']);

    // **여기까지 와야 제목이 사실이 된다.**
    const m = materializeGeneration({
      prefix,
      generation: 'gen-rendered',
      files: { 'nginx.conf': rendered.conf },
      planes: rendered.planes,
    });
    expect(readManifest(prefix, 'gen-rendered').planes).toEqual(['http', 'stream']);
    // 그리고 그 기록이 실제 대조에 쓰인다.
    expect(verifyGeneration(prefix, 'gen-rendered', m.digest, ['http', 'stream']).planes)
      .toEqual(['http', 'stream']);
    expect(kindOf(() => verifyGeneration(prefix, 'gen-rendered', m.digest, ['http'])))
      .toBe('plane_mismatch');
  });
});

// ── 실물 부작용도 lease 를 지킨다 ──────────────────────────────────────

describe('FsEffects 도 lease 를 확인한다 — FakeEffects 로만 보면 놓친다', () => {
  /**
   * lease 계약을 `FakeEffects` 로만 시험하고 있었다. 그건 테스트 도구고, 실제로 파일을
   * 만지는 것은 `FsEffects` 다. 뮤테이션이 그 구멍을 드러냈다 — `FsEffects` 의 검사를
   * 지워도 conformance 가 전부 통과했다.
   */
  const invalid = { leaderToken: '10', assertValid: () => { throw new Error('lease 를 잃었다'); } };
  const valid = { leaderToken: '10', assertValid: () => CHECKED_TOKEN };

  it('잃은 lease 로는 심볼릭 링크를 바꾸지 못한다', async () => {
    const m = make('gen-1');
    const fx = new FsEffects({ prefix, reload: async () => undefined, probeAccepting: async () => undefined });

    await expect(fx.publish({
      generation: 'gen-1', leaderToken: '10', operationId: 'o',
      transitionId: 't', generationDigest: m.digest,
    }, invalid)).rejects.toThrow();

    expect(existsSync(join(prefix, 'current')), 'lease 를 잃었는데 게시했다').toBe(false);
  });

  it('유효한 lease 로는 게시된다 — 막는 것만 하는 게 아니다', async () => {
    const m = make('gen-1');
    const fx = new FsEffects({ prefix, reload: async () => undefined, probeAccepting: async () => undefined });

    await fx.publish({
      generation: 'gen-1', leaderToken: '10', operationId: 'o',
      transitionId: 't', generationDigest: m.digest,
    }, valid);

    expect(await fx.observePublished()).toMatchObject({ kind: 'owned', record: { generation: 'gen-1' } });
  });

  it('잃은 lease 로는 HUP 도 못 보낸다', async () => {
    let signals = 0;
    const fx = new FsEffects({
      prefix,
      reload: async () => void (signals += 1),
      probeAccepting: async () => undefined,
    });
    await expect(fx.signalReload(invalid)).rejects.toThrow();
    expect(signals, 'lease 를 잃었는데 HUP 을 보냈다').toBe(0);
  });
});

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
import { ApplyRunner, FakeEffects } from '../../src/dp/apply.js';
import { FsEffects } from '../../src/dp/effects-fs.js';
import type { ApplyOperation } from '../../src/dp/operation.js';

let prefix: string;

beforeEach(() => {
  prefix = mkdtempSync(join(tmpdir(), 'bary-gen-'));
});
afterEach(() => rmSync(prefix, { recursive: true, force: true }));

const FILES = { 'nginx.conf': 'events {}\nhttp { server { listen 80; } }\n' };
const make = (generation: string, files = FILES) => materializeGeneration({ prefix, generation, files });

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
  affectedPlanes: ['http'],
  targetGeneration: 'gen-1',
  generationDigest: 'sha256:채워짐',
  planes: {
    http: {
      expectedCurrent: { activationEpoch: '0', membershipRevision: '0' },
      target: { activationEpoch: '1', membershipRevision: '1' },
      payloadDigest: 'sha256:h',
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

  it('config test 를 **돌리지 못한 것**은 실패가 아니다', async () => {
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
    // 관측 못 한 것과 거부당한 것은 다르다 (§6.3).
    expect(r.phase).toBe('activated');
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

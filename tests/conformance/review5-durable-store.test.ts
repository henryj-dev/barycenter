/**
 * 5차 검수 반례 — durable store 계약 (DESIGN.md §9.1.1 blocker 5)
 *
 * 4·5차의 교훈이 같은 문장이다: **모의로만 검증한 것은 실물에서 깨진다.** `MemoryStore`
 * 는 계약을 정의했을 뿐인데 그 위에서 전 스위트가 녹색이었다.
 *
 * 특히 두 가지는 모의로 절대 드러나지 않는다.
 *
 *   · **손상 ≠ 빈 것.** 체크섬이 깨진 파일을 "없는 것" 으로 읽으면 Agent 는 신규 부팅으로
 *     알고 `maxLeaderToken` 을 0 으로 되돌린다. 손상 하나가 §3.5 펜싱을 통째로 무너뜨리고
 *     옛 리더에게 문을 열어 준다.
 *   · **프로세스 간 단일 writer.** `serial()` 도 버전 CAS 도 한 프로세스 안까지다.
 *     그래서 이 파일은 **진짜 두 번째 node 프로세스를 띄워서** 확인한다.
 *
 * ⚠️ **여기서 증명하지 못하는 것.** fsync 의 *순서*(내용 → rename → 부모 디렉토리)는
 * 이 테스트로 확인되지 않는다. 전원 차단을 주입해야 드러나는 성질이고, 그건 파일시스템
 * 수준의 fault injection 이 필요하다. 코드에는 있지만 **검증되지는 않았다** — 그 사실을
 * 여기 적어 둔다. 통과한다고 durability 가 증명된 것이 아니다.
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { DpAgent, StoreConflict, type AgentState } from '../../src/dp/agent.js';
import { FileStore, StoreCorrupted, StoreLocked } from '../../src/dp/store-fs.js';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');

let dir: string;
let statePath: string;
let store: FileStore;

/** 별도 프로세스에서 돌릴 번들. esbuild 로 한 번만 만든다. */
let childBundle: string;

beforeAll(() => {
  const out = mkdtempSync(join(tmpdir(), 'bary-child-'));
  const entry = join(out, 'entry.mjs');
  // 두 번째 프로세스가 **우리 코드로** 락을 잡아 봐야 의미가 있다. 흉내 내면 안 된다.
  writeFileSync(
    entry,
    `import { FileStore, StoreLocked } from ${JSON.stringify(join(repo, 'src/dp/store-fs.ts'))};
     try {
       const s = FileStore.open(process.argv[2]);
       console.log('OPENED');
       s.release();
     } catch (e) {
       console.log(e instanceof StoreLocked ? 'LOCKED' : 'ERR:' + e.name);
     }`,
    'utf8',
  );
  childBundle = join(out, 'child.mjs');
  execFileSync(
    join(repo, 'node_modules/.bin/esbuild'),
    [entry, '--bundle', '--platform=node', '--format=esm', `--outfile=${childBundle}`],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
}, 120_000);

const runChild = (path: string): string =>
  execFileSync('node', [childBundle, path], { stdio: ['ignore', 'pipe', 'pipe'] })
    .toString()
    .trim();

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bary-store-'));
  statePath = join(dir, 'agent.json');
  store = FileStore.open(statePath);
});

afterEach(() => {
  store.release();
  rmSync(dir, { recursive: true, force: true });
});

const state = (over: Partial<AgentState> = {}): AgentState => ({
  version: 1,
  maxLeaderToken: '7',
  planes: {
    http: { activationEpoch: '0', membershipRevision: '0', payloadDigest: '' },
    stream: { activationEpoch: '0', membershipRevision: '0', payloadDigest: '' },
  },
  reservations: { http: {}, stream: {} },
  completed: {},
  terminal: {},
  activationEvidence: {},
  ...over,
});

const rejectionOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return '거부되지 않았다';
  } catch (e) {
    return (e as Error).name;
  }
};

// ── 왕복 ─────────────────────────────────────────────────────────────────

describe('왕복', () => {
  it('없는 파일은 신규 부팅이다', () => {
    expect(store.load()).toBeUndefined();
  });

  it('저장한 것을 그대로 읽는다', async () => {
    await store.save(state());
    expect(store.load()?.maxLeaderToken).toBe('7');
  });

  it('임시 파일을 남기지 않는다', async () => {
    await store.save(state());
    await store.save(state({ version: 2, maxLeaderToken: '8' }));
    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers, `임시 파일이 남았다: ${leftovers.join(', ')}`).toEqual([]);
  });
});

// ── 손상은 빈 것이 아니다 ────────────────────────────────────────────────

describe('손상은 빈 것이 아니다 — 여기서 undefined 를 돌려주면 펜싱이 무너진다', () => {
  it('체크섬이 안 맞으면 던진다', async () => {
    await store.save(state());
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    (raw['state'] as AgentState).maxLeaderToken = '0'; // 옛 리더가 되살아나는 변조
    writeFileSync(statePath, JSON.stringify(raw), 'utf8');

    expect(() => store.load()).toThrow(StoreCorrupted);
  });

  it('잘린 파일(부분 쓰기)도 던진다', async () => {
    await store.save(state());
    const raw = readFileSync(statePath, 'utf8');
    writeFileSync(statePath, raw.slice(0, Math.floor(raw.length / 2)), 'utf8');
    expect(() => store.load()).toThrow(StoreCorrupted);
  });

  it('빈 파일도 던진다 — 쓰다 만 흔적이지 신규 부팅이 아니다', () => {
    writeFileSync(statePath, '', 'utf8');
    expect(() => store.load()).toThrow(StoreCorrupted);
  });

  it('모르는 스키마 버전은 읽지 않는다', async () => {
    await store.save(state());
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as Record<string, unknown>;
    raw['schema'] = 99;
    writeFileSync(statePath, JSON.stringify(raw), 'utf8');
    expect(() => store.load()).toThrow(StoreCorrupted);
  });

  it('**손상된 상태에서는 Agent 가 아무것도 하지 못한다** — 열려서 0 으로 시작하면 안 된다', async () => {
    const agent = new DpAgent(store);
    await agent.fence('20');
    writeFileSync(statePath, '{"schema":1,"checksum":"sha256:틀림","state":{}}', 'utf8');

    // 던져야 한다. undefined 를 돌려주면 maxLeaderToken 이 0 이 되고
    // 토큰 1 짜리 옛 리더의 변이가 통과한다.
    expect(await rejectionOf(agent.fence('21'))).toBe('StoreCorrupted');
  });
});

// ── 버전 CAS ─────────────────────────────────────────────────────────────

describe('버전 CAS', () => {
  it('낡은 버전으로 쓰면 거부된다', async () => {
    await store.save(state());
    await expect(store.save(state({ version: 1, maxLeaderToken: '9' }))).rejects.toBeInstanceOf(
      StoreConflict,
    );
    expect(store.load()?.maxLeaderToken, '거부됐는데 내용이 바뀌었다').toBe('7');
  });

  // 제목을 실제로 검증하는 것에 맞췄다. 처음엔 "임시 파일조차 만들지 않는다" 라고 썼는데,
  // 뮤테이션으로 확인해 보니 **만들었다가 지우는 구현도 통과**했다. 검증하지 않는 것을
  // 제목이 주장하면 그게 거짓 신호다.
  it('밀린 쓰기는 디렉토리에 흔적을 남기지 않는다', async () => {
    await store.save(state());
    await store.save(state({ version: 2 })).catch(() => undefined);
    await store.save(state({ version: 1 })).catch(() => undefined);
    expect(readdirSync(dir).filter((f) => f.endsWith('.tmp'))).toEqual([]);
  });
});

// ── 프로세스 간 단일 writer ──────────────────────────────────────────────

describe('프로세스 간 단일 writer — 진짜 두 번째 프로세스로 확인한다', () => {
  it('이미 열려 있으면 다른 프로세스는 열지 못한다', () => {
    // `store` 가 beforeEach 에서 락을 잡고 있다.
    expect(runChild(statePath)).toBe('LOCKED');
  });

  it('놓으면 다른 프로세스가 연다', () => {
    store.release();
    expect(runChild(statePath)).toBe('OPENED');
    store = FileStore.open(statePath); // afterEach 를 위해 다시 잡는다
  });

  it('죽은 프로세스가 남긴 락은 회수한다', () => {
    store.release();
    // 존재하지 않을 pid 로 락을 위조한다.
    writeFileSync(`${statePath}.lock`, JSON.stringify({ pid: 0x7ffffff0 }), 'utf8');
    expect(runChild(statePath), '죽은 락에 영원히 막혔다').toBe('OPENED');
    store = FileStore.open(statePath);
  });

  it('같은 프로세스 안에서도 두 번 열지 못한다', () => {
    expect(() => FileStore.open(statePath)).toThrow(StoreLocked);
  });
});

// ── Agent 가 실제 파일 위에서 돈다 ───────────────────────────────────────

describe('Agent 가 실제 파일 위에서 돈다', () => {
  it('리더 토큰이 재시작을 넘어 유지된다 (§3.5)', async () => {
    await new DpAgent(store).fence('42');
    store.release();

    // 재시작 — 새 프로세스라고 치고 파일만 다시 연다.
    const reopened = FileStore.open(statePath);
    try {
      const agent = new DpAgent(reopened);
      expect(agent.maxLeaderToken()).toBe('42');
      // 낮은 토큰은 재시작 후에도 거부된다. 이게 안 되면 재시작이 곧 펜싱 리셋이다.
      expect(await rejectionOf(agent.fence('41'))).toBe('DpRejection');
    } finally {
      reopened.release();
    }
    store = FileStore.open(statePath);
  });

  it('연속 변이가 버전을 하나씩 올린다', async () => {
    const agent = new DpAgent(store);
    await agent.fence('10');
    await agent.fence('11');
    await agent.fence('12');
    expect(store.load()?.version).toBe(3);
    expect(store.load()?.maxLeaderToken).toBe('12');
  });

  it('디렉토리가 없어도 만든다', () => {
    const nested = join(dir, 'a', 'b', 'agent.json');
    mkdirSync(dirname(nested), { recursive: true });
    const s = FileStore.open(nested);
    try {
      expect(s.load()).toBeUndefined();
    } finally {
      s.release();
    }
  });
});

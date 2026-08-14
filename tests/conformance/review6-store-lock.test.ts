/**
 * 6차 검수 반례 ⑤ — 락이 쓰기 권한과 연결돼야 한다 (DESIGN.md §11.2 · §9.1.1)
 *
 * 5차 뒤에 "프로세스 간 단일 writer" 를 세웠다고 적었다. 별도 프로세스로 `open()` 경쟁도
 * 확인했다. 그런데 6차가 세 가지로 우회했다.
 *
 *   (a) `openUnlocked().save()` — 주인이 있는데도 덮어쓴다.
 *   (b) `release()` 한 옛 handle 로 계속 쓴다.
 *   (c) 새 주인이 죽은 락을 회수한 뒤, 옛 handle 의 `release()` 가 **그 락을 지운다.**
 *       그러면 제3 writer 가 열린다.
 *
 * 원인은 하나다. **락을 잡는 것과 쓰는 것이 연결돼 있지 않았다.** `open()` 만 경쟁했고
 * `save()` 는 아무것도 확인하지 않았다.
 *
 * 그래서 셋을 바꾼다.
 *   · 락 레코드에 **nonce** 를 둔다. `save()` 는 매번 그게 아직 내 것인지 확인한다.
 *   · `release()` 도 nonce 를 확인한다 — 남의 락은 못 지운다.
 *   · 읽기 전용은 **타입이 다르다.** `save()` 가 아예 없다.
 *
 * ⚠️ **여기서 증명하지 못하는 것.** 락 파일을 만드는 것 자체의 원자성은 확인되지 않는다.
 * `link()` 로 완성된 파일을 거는 것과 `wx` 로 만들고 나서 내용을 쓰는 것은 **중간 시점을
 * 관측해야** 갈린다. 뮤테이션으로 확인했고 이 스위트는 둘을 구별하지 못한다 — fsync
 * 순서와 같은 부류다. 코드는 `link` 를 쓰지만 그 선택이 검증되지는 않았다.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DpAgent, type StoredState } from '../../src/dp/agent.js';
import { FileStore, ReadOnlyFileStore, StoreLocked } from '../../src/dp/store-fs.js';

let dir: string;
let path: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'bary-lock-'));
  path = join(dir, 'agent.json');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** 저장소가 보는 것은 **봉투**다. 내용은 해석하지 않는다 (9차 반례 ④). */
const state = (over: { version?: number; maxLeaderToken?: string } = {}): StoredState => ({
  version: over.version ?? 1,
  payload: {
    maxLeaderToken: over.maxLeaderToken ?? '7',
    planes: {
      http: { activationEpoch: '0', membershipRevision: '0', payloadDigest: '' },
      stream: { activationEpoch: '0', membershipRevision: '0', payloadDigest: '' },
    },
    reservations: { http: {}, stream: {} },
    completed: {},
    terminal: {},
    activationEvidence: {},
  },
});

const nameOf = async (p: Promise<unknown>): Promise<string> => {
  try {
    await p;
    return '거부되지 않았다';
  } catch (e) {
    return (e as Error).name;
  }
};

// ── positive control ─────────────────────────────────────────────────────

describe('정상 경로', () => {
  it('주인은 읽고 쓴다', async () => {
    const s = FileStore.open(path);
    try {
      await s.save(state());
      expect((s.load()?.payload as {maxLeaderToken:string} | undefined)?.maxLeaderToken).toBe('7');
    } finally {
      s.release();
    }
  });

  it('놓으면 다음 주인이 이어서 쓴다', async () => {
    const a = FileStore.open(path);
    await a.save(state());
    a.release();

    const b = FileStore.open(path);
    try {
      await b.save(state({ version: 2, maxLeaderToken: '8' }));
      expect((b.load()?.payload as {maxLeaderToken:string} | undefined)?.maxLeaderToken).toBe('8');
    } finally {
      b.release();
    }
  });
});

// ── (a) 락 없는 쓰기 ────────────────────────────────────────────────────

describe('(a) 락 없이는 쓸 수 없다', () => {
  it('읽기 전용 핸들에는 save 가 없다', () => {
    const ro = FileStore.openReadOnly(path);
    // 타입에도 없고 런타임에도 없다. 캐스팅해도 부를 것이 없다.
    expect((ro as unknown as Record<string, unknown>)['save']).toBeUndefined();
    expect(ro).toBeInstanceOf(ReadOnlyFileStore);
  });

  it('읽기 전용 핸들은 읽기는 한다 — 막는 것만 하는 게 아니다', async () => {
    const owner = FileStore.open(path);
    try {
      await owner.save(state());
      expect((FileStore.openReadOnly(path).load()?.payload as { maxLeaderToken: string }).maxLeaderToken).toBe('7');
    } finally {
      owner.release();
    }
  });
});

// ── (b) 놓은 핸들 ───────────────────────────────────────────────────────

describe('(b) 놓은 핸들은 더 못 쓴다', () => {
  it('release 뒤의 save 는 거부된다', async () => {
    const s = FileStore.open(path);
    await s.save(state());
    s.release();
    expect(await nameOf(s.save(state({ version: 2, maxLeaderToken: '99' })))).toBe('StoreLockLost');
  });

  it('놓은 핸들이 다음 주인의 상태를 덮지 못한다', async () => {
    const a = FileStore.open(path);
    await a.save(state());
    a.release();

    const b = FileStore.open(path);
    try {
      await b.save(state({ version: 2, maxLeaderToken: '8' }));
      await a.save(state({ version: 3, maxLeaderToken: '99' })).catch(() => undefined);
      expect((b.load()?.payload as {maxLeaderToken:string} | undefined)?.maxLeaderToken, '놓은 핸들이 덮어썼다').toBe('8');
    } finally {
      b.release();
    }
  });
});

// ── (c) 회수 뒤의 늦은 release ──────────────────────────────────────────

describe('(c) 옛 주인의 늦은 release 가 새 주인의 락을 지우지 못한다', () => {
  it('죽은 것으로 오인돼 회수당한 뒤, 옛 핸들이 놓아도 새 주인은 유지된다', () => {
    const a = FileStore.open(path);
    // a 가 죽은 것처럼 락 레코드를 위조한다 → b 가 회수한다.
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: 0x7ffffff0, nonce: '위조' }), 'utf8');
    const b = FileStore.open(path);

    a.release(); // 옛 주인이 뒤늦게 놓는다

    expect(existsSync(`${path}.lock`), '새 주인의 락이 지워졌다').toBe(true);
    let third = '막힘';
    try {
      const c = FileStore.open(path);
      third = '열림';
      c.release();
    } catch {
      /* 막히는 것이 정상 */
    }
    expect(third, '제3 writer 가 열렸다 — 동시 writer 가 둘이다').toBe('막힘');
    b.release();
  });

  it('회수당한 옛 주인은 쓰지도 못한다', async () => {
    const a = FileStore.open(path);
    await a.save(state());
    writeFileSync(`${path}.lock`, JSON.stringify({ pid: 0x7ffffff0, nonce: '위조' }), 'utf8');
    const b = FileStore.open(path);
    try {
      expect(await nameOf(a.save(state({ version: 2, maxLeaderToken: '99' })))).toBe('StoreLockLost');
    } finally {
      b.release();
    }
  });
});

// ── 락 레코드 자체 ──────────────────────────────────────────────────────

describe('락 레코드는 언제 봐도 완전하다', () => {
  it('빈 락 파일이 관측되지 않는다 — 만들고 나서 쓰면 그 사이가 열린다', () => {
    const s = FileStore.open(path);
    try {
      const raw = readFileSync(`${path}.lock`, 'utf8');
      expect(raw.length, '락 파일이 비어 있다').toBeGreaterThan(0);
      const parsed = JSON.parse(raw) as { pid?: number; nonce?: string };
      expect(parsed.pid).toBe(process.pid);
      expect(typeof parsed.nonce, 'nonce 가 없다 — 주인을 구별할 수 없다').toBe('string');
    } finally {
      s.release();
    }
  });

  it('읽을 수 없는 락은 **회수하지 않는다** — 안 열리는 쪽으로 틀린다', () => {
    // 자동 회수는 편하지만, 판단이 틀리면 두 writer 가 열린다. 읽을 수 없는 락은
    // 사람이 치우게 둔다. 가용성보다 단일 writer 가 먼저다.
    writeFileSync(`${path}.lock`, '망가진 내용', 'utf8');
    // **무엇으로 막히는지까지 본다.** `.toThrow()` 만 쓰면 회수하려다 TypeError 로
    // 죽는 구현도 통과한다 — 실제로 뮤테이션에서 그렇게 통과했다.
    expect(() => FileStore.open(path)).toThrow(StoreLocked);
    expect(existsSync(`${path}.lock`), '읽을 수 없는 락을 지웠다').toBe(true);
  });

  it('두 번 열면 nonce 가 다르다 — 같으면 옛 주인과 구별이 안 된다', () => {
    const a = FileStore.open(path);
    const first = JSON.parse(readFileSync(`${path}.lock`, 'utf8')) as { nonce: string };
    a.release();
    const b = FileStore.open(path);
    const second = JSON.parse(readFileSync(`${path}.lock`, 'utf8')) as { nonce: string };
    b.release();
    expect(second.nonce).not.toBe(first.nonce);
  });
});

// ── Agent 까지 이어진다 ─────────────────────────────────────────────────

describe('Agent 도 락을 잃으면 멈춘다', () => {
  it('락을 뺏긴 Agent 는 변이를 완료하지 못한다', async () => {
    const a = FileStore.open(path);
    const agent = new DpAgent(a);
    await agent.fence('10');

    writeFileSync(`${path}.lock`, JSON.stringify({ pid: 0x7ffffff0, nonce: '위조' }), 'utf8');
    const b = FileStore.open(path);
    try {
      // 여기서 조용히 성공하면 두 프로세스가 같은 상태를 각자 옮긴다.
      expect(await nameOf(agent.fence('11'))).toBe('StoreLockLost');
      expect((a.load()?.payload as {maxLeaderToken:string} | undefined)?.maxLeaderToken, '뺏긴 뒤에도 상태를 바꿨다').toBe('10');
    } finally {
      b.release();
    }
  });
});

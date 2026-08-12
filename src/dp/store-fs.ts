/**
 * 파일 기반 durable store — DESIGN.md §6.2 · §11.2 · §9.1.1 blocker 5
 *
 * `MemoryStore` 는 계약을 정의했을 뿐이다. 5차 검수의 지적이 그것이었다 — 단위·golden·
 * e2e 가 전부 메모리 위에서 도는데 `DurableStore` 를 공개 계약으로 고정하려 했다.
 *
 * 여기서 네 가지를 세운다.
 *
 *   1. **원자적 교체** — 임시 파일에 쓰고 fsync 한 뒤 rename, 그리고 **부모 디렉토리도
 *      fsync**. rename 만 하면 메타데이터가 아직 디스크에 없어 전원이 끊기면 되돌아간다.
 *   2. **손상 ≠ 빈 것** — 체크섬이 안 맞으면 `undefined` 가 아니라 **던진다.** 빈 것으로
 *      읽으면 Agent 는 신규 부팅으로 알고 `maxLeaderToken` 을 0 으로 되돌린다. 그 순간
 *      §3.5 의 펜싱이 통째로 무너진다 — 손상 하나가 옛 리더에게 문을 열어 준다.
 *   3. **버전 CAS** — 같은 파일을 여는 다른 writer 가 있어도 밀린 쓰기는 거부된다.
 *   4. **프로세스 간 단일 writer** — 락 파일. CAS 는 손실을 막을 뿐 두 writer 가 번갈아
 *      진행하는 것 자체를 막지는 못한다.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { AgentState, DurableStore } from './agent.js';
import { StoreConflict } from './agent.js';

/** 저장 형식이 바뀌면 올린다. 모르는 버전은 읽지 않는다. */
export const STORE_SCHEMA = 1;

export class StoreCorrupted extends Error {
  constructor(message: string) {
    super(`durable 상태가 손상됐다: ${message}`);
    this.name = 'StoreCorrupted';
  }
}

export class StoreLocked extends Error {
  constructor(readonly holderPid: number) {
    super(`다른 프로세스(pid ${holderPid})가 이 상태를 쓰고 있다`);
    this.name = 'StoreLocked';
  }
}

type Envelope = {
  schema: number;
  checksum: string;
  state: AgentState;
};

const digestOf = (state: AgentState): string =>
  `sha256:${createHash('sha256').update(JSON.stringify(state), 'utf8').digest('hex')}`;

/** 디렉토리 엔트리를 디스크에 내린다. rename 만으로는 부족하다. */
function fsyncDir(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class FileStore implements DurableStore {
  private tmpCounter = 0;
  private lockPath: string | undefined;

  private constructor(readonly path: string) {}

  /**
   * 상태 파일을 연다. **락을 잡지 못하면 열리지 않는다.**
   *
   * 락은 프로세스가 죽으면 남는다. 그래서 잡고 있던 pid 가 살아 있는지 확인하고, 죽었으면
   * 회수한다. pid 재사용이라는 잔여 경합이 있다 — 같은 pid 로 다른 프로세스가 떠 있으면
   * 살아 있다고 잘못 본다. 그때는 열리지 않을 뿐이라 **안전한 쪽으로 틀린다.**
   */
  static open(path: string): FileStore {
    mkdirSync(dirname(path), { recursive: true });
    const store = new FileStore(path);
    store.acquire(`${path}.lock`);
    return store;
  }

  /** 락 없이 연다. **읽기 전용 검사에만 쓴다** — 두 writer 가 붙으면 안 된다. */
  static openUnlocked(path: string): FileStore {
    return new FileStore(path);
  }

  private acquire(lockPath: string): void {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const fd = openSync(lockPath, 'wx');
        writeSync(fd, JSON.stringify({ pid: process.pid }), 0, 'utf8');
        fsyncSync(fd);
        closeSync(fd);
        fsyncDir(dirname(lockPath));
        this.lockPath = lockPath;
        return;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
        const holder = readHolder(lockPath);
        if (holder !== undefined && isAlive(holder)) throw new StoreLocked(holder);
        // 죽은 프로세스가 남긴 락이다. 회수하고 한 번 더 시도한다.
        try {
          unlinkSync(lockPath);
        } catch {
          /* 그 사이 남이 치웠으면 그대로 재시도 */
        }
      }
    }
    throw new StoreLocked(-1);
  }

  /** 락을 놓는다. 프로세스 종료 시에도 불러야 다음 기동이 즉시 열린다. */
  release(): void {
    if (this.lockPath === undefined) return;
    try {
      unlinkSync(this.lockPath);
    } catch {
      /* 이미 없으면 그만 */
    }
    this.lockPath = undefined;
  }

  load(): AgentState | undefined {
    if (!existsSync(this.path)) return undefined;

    let raw: string;
    try {
      raw = readFileSync(this.path, 'utf8');
    } catch (e) {
      throw new StoreCorrupted(`읽을 수 없다: ${(e as Error).message}`);
    }
    // 빈 파일은 "없는 것" 이 아니다. 쓰다 만 흔적일 수 있다.
    if (raw.length === 0) throw new StoreCorrupted('파일이 비어 있다');

    let envelope: Envelope;
    try {
      envelope = JSON.parse(raw) as Envelope;
    } catch (e) {
      throw new StoreCorrupted(`JSON 이 아니다 (부분 쓰기?): ${(e as Error).message}`);
    }
    if (envelope.schema !== STORE_SCHEMA) {
      throw new StoreCorrupted(`모르는 스키마 ${envelope.schema} (아는 것은 ${STORE_SCHEMA})`);
    }
    if (envelope.state === undefined || envelope.state === null) {
      throw new StoreCorrupted('상태가 없다');
    }
    const actual = digestOf(envelope.state);
    if (actual !== envelope.checksum) {
      throw new StoreCorrupted(`체크섬 불일치 (${envelope.checksum} ≠ ${actual})`);
    }
    return envelope.state;
  }

  async save(state: AgentState): Promise<void> {
    // CAS 를 **먼저** 본다. 밀린 쓰기가 임시 파일조차 만들지 않게.
    const current = existsSync(this.path) ? this.load() : undefined;
    const expected = (current?.version ?? 0) + 1;
    if (state.version !== expected) {
      throw new StoreConflict(`버전 충돌: ${expected} 를 기대했는데 ${state.version} 이 왔다`);
    }

    const envelope: Envelope = { schema: STORE_SCHEMA, checksum: digestOf(state), state };
    const body = JSON.stringify(envelope);

    this.tmpCounter += 1;
    const tmp = join(dirname(this.path), `.${process.pid}-${this.tmpCounter}.tmp`);
    const fd = openSync(tmp, 'w');
    try {
      writeSync(fd, body, 0, 'utf8');
      // **파일 내용을 먼저 내린다.** rename 이 먼저 보이면 빈 파일이 정본이 된다.
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, this.path);
    // rename 은 원자적이지만 디렉토리 엔트리는 아직 캐시에 있다. 여기서 내린다.
    fsyncDir(dirname(this.path));
  }
}

function readHolder(lockPath: string): number | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as { pid?: number };
    return typeof parsed.pid === 'number' ? parsed.pid : undefined;
  } catch {
    return undefined;
  }
}

function isAlive(pid: number): boolean {
  try {
    // 신호 0 은 보내지 않고 존재만 확인한다.
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM 은 "있는데 내 것이 아니다" 이므로 살아 있는 것이다.
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

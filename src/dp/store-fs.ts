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
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { dirname, join } from 'node:path';
import type { DurableStore, StoredState } from './agent.js';
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

/**
 * 락을 잃었다. 놓았거나, 죽은 줄 알고 남이 회수했거나.
 *
 * **조용히 성공하면 안 된다.** 두 프로세스가 같은 상태를 각자 옮기게 된다.
 */
export class StoreLockLost extends Error {
  constructor(message: string) {
    super(`이 상태의 쓰기 권한이 없다: ${message}`);
    this.name = 'StoreLockLost';
  }
}

/**
 * 락 레코드.
 *
 * `startedAt` 이 왜 있는가 — **컨테이너에서 pid 생존 판정이 무의미하기 때문이다.**
 *
 * 원래는 pid 만 보고 "살아 있으면 남의 락" 으로 판단했고, pid 재사용은 *잔여 경합*이라고
 * 적어 뒀다. 그런데 §11.1 이 규정한 배포 형태(DP 컨테이너 안의 에이전트)에서는 그게 잔여
 * 경합이 아니라 **확정**이다. 데몬은 언제나 pid 1 근처이고, 재기동하면 그 자리에 새
 * 프로세스가 다시 선다. 그래서 **자기가 남긴 락을 자기가 회수하지 못하고** 데몬이 아예
 * 못 뜬다. v0.1 e2e 를 짜다가 실제로 이걸로 막혔다:
 *
 *   기동 실패: StoreLocked: 다른 프로세스(pid 1)가 이 상태를 쓰고 있다
 *
 * pid 에 **프로세스 시작 시각**을 붙이면 재사용이 구별된다. 같은 pid 라도 시작 시각이
 * 다르면 다른 프로세스다. Linux 는 `/proc/<pid>/stat` 의 22번째 필드가 그것이다.
 *
 * 읽을 수 없는 플랫폼(macOS 등)에서는 `undefined` 로 두고 **옛 동작 그대로** 간다 —
 * 모르는 것을 안다고 하지 않는다. 옛 락 파일에 이 필드가 없는 경우도 같다.
 */
type LockRecord = { pid: number; nonce: string; startedAt?: string };

/**
 * 프로세스 시작 시각. 못 읽으면 `undefined`.
 *
 * 값의 의미는 플랫폼마다 다르다 — 비교만 하고 해석하지 않는다.
 */
function startTimeOf(pid: number): string | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    // comm 필드가 괄호 안에 있고 공백을 품을 수 있다. **뒤에서부터 센다.**
    const after = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    // stat 의 3번째 필드(state)가 여기서 인덱스 0 이므로 22번째 필드는 인덱스 19 다.
    const t = after[19];
    return t === undefined || t === '' ? undefined : t;
  } catch {
    return undefined;
  }
}

/** 상태를 읽기만 하는 핸들. **`save` 가 없다** — 타입에도 런타임에도. */
export class ReadOnlyFileStore {
  constructor(readonly path: string) {}

  load(): StoredState | undefined {
    return readState(this.path);
  }
}

type Envelope = {
  schema: number;
  checksum: string;
  state: StoredState;
};

const digestOf = (state: StoredState): string =>
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
  /**
   * 이 핸들의 락 표식 (6차 반례 ⑤).
   *
   * pid 만으로는 부족하다. 놓았다 다시 잡은 같은 프로세스, 죽은 줄 알고 회수당한 뒤의
   * 옛 핸들 — 둘 다 pid 가 같다. **매 쓰기마다 이게 아직 파일에 있는지 확인한다.**
   */
  private nonce: string | undefined;

  private constructor(readonly path: string) {}

  /**
   * 상태 파일을 연다. **락을 잡지 못하면 열리지 않는다.**
   *
   * 락은 프로세스가 죽으면 남는다. 그래서 잡고 있던 프로세스가 아직 그 자리에 있는지
   * 확인하고, 아니면 회수한다. **pid 만으로는 안 된다** — 컨테이너에서 데몬은 늘 같은
   * 낮은 pid 를 쓰므로 재기동하면 자기가 남긴 락을 자기가 못 회수한다. 그래서 pid 에
   * 프로세스 시작 시각을 붙여 재사용을 가른다 (`LockRecord.startedAt`).
   *
   * 시작 시각을 못 읽는 플랫폼에서는 옛 동작(pid 생존)으로 물러난다. 그때 남는 경합은
   * 열리지 않는 쪽으로 틀리므로 **안전한 쪽으로 틀린다.**
   */
  static open(path: string): FileStore {
    mkdirSync(dirname(path), { recursive: true });
    const store = new FileStore(path);
    store.acquire(`${path}.lock`);
    return store;
  }

  /**
   * 읽기 전용으로 연다. 락을 잡지 않는 대신 **쓸 수 없는 타입**을 돌려준다.
   *
   * 6차 검수 전에는 이게 `FileStore` 를 돌려줬고, 그래서 주인이 있는 파일을 그냥
   * 덮어쓸 수 있었다. "쓰기에만 쓰지 마세요" 는 계약이 아니다.
   */
  static openReadOnly(path: string): ReadOnlyFileStore {
    return new ReadOnlyFileStore(path);
  }

  private acquire(lockPath: string): void {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const nonce = randomBytes(16).toString('hex');
      // **완성된 파일을 원자적으로 건다.** `wx` 로 만들고 나서 내용을 쓰면 그 사이에
      // 남이 빈 파일을 읽고 "망가진 락" 으로 판단해 지울 수 있다 (6차 지적).
      // `link` 는 대상이 있으면 EEXIST 로 실패하므로 만들기와 걸기가 한 번에 끝난다.
      const tmp = `${lockPath}.new-${process.pid}-${nonce}`;
      const mine = startTimeOf(process.pid);
      writeLockFile(tmp, {
        pid: process.pid, nonce,
        ...(mine === undefined ? {} : { startedAt: mine }),
      });
      try {
        linkSync(tmp, lockPath);
        unlinkSync(tmp);
        fsyncDir(dirname(lockPath));
        this.lockPath = lockPath;
        this.nonce = nonce;
        return;
      } catch (e) {
        unlinkSync(tmp);
        if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      }

      const holder = readLock(lockPath);
      if (holder === undefined || stillHolding(holder)) {
        // 읽을 수 없는 락은 **살아 있는 것으로 취급한다.** 지우는 쪽으로 틀리면
        // 두 writer 가 열린다 — 안 열리는 쪽으로 틀리는 게 낫다.
        throw new StoreLocked(holder?.pid ?? -1);
      }
      // 죽은 프로세스의 락이다. **그 레코드가 아직 그대로일 때만** 지운다 —
      // 그 사이 남이 새로 잡았으면 nonce 가 다르다.
      const still = readLock(lockPath);
      if (still?.nonce === holder.nonce) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* 그 사이 남이 치웠으면 그대로 재시도 */
        }
      }
    }
    throw new StoreLocked(-1);
  }

  /** 이 핸들이 아직 주인인가. 아니면 던진다. */
  private assertOwner(): void {
    if (this.lockPath === undefined || this.nonce === undefined) {
      throw new StoreLockLost('락을 잡지 않았거나 이미 놓았다');
    }
    const holder = readLock(this.lockPath);
    if (holder === undefined) throw new StoreLockLost('락 파일이 사라졌다');
    if (holder.nonce !== this.nonce) {
      throw new StoreLockLost(`락의 주인이 바뀌었다 (pid ${holder.pid})`);
    }
  }

  /**
   * 락을 놓는다. 프로세스 종료 시에도 불러야 다음 기동이 즉시 열린다.
   *
   * **내 락만 지운다.** 죽은 줄 알고 회수당한 뒤 뒤늦게 놓으면, 확인 없이 지우는 순간
   * 새 주인의 락이 사라지고 제3 writer 가 열린다 (6차 반례 ⑤c).
   */
  release(): void {
    const lockPath = this.lockPath;
    const nonce = this.nonce;
    this.lockPath = undefined;
    this.nonce = undefined;
    if (lockPath === undefined) return;
    if (readLock(lockPath)?.nonce !== nonce) return;
    try {
      unlinkSync(lockPath);
    } catch {
      /* 이미 없으면 그만 */
    }
  }

  load(): StoredState | undefined {
    return readState(this.path);
  }

  async save(state: StoredState): Promise<void> {
    // **쓰기마다 주인인지 확인한다** (6차 반례 ⑤). `open()` 경쟁만으로는 부족하다 —
    // 놓은 핸들도, 회수당한 핸들도 계속 쓸 수 있었다.
    this.assertOwner();

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

function readState(path: string): StoredState | undefined {
  if (!existsSync(path)) return undefined;

  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
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

function writeLockFile(path: string, record: LockRecord): void {
  const fd = openSync(path, 'wx');
  try {
    writeSync(fd, JSON.stringify(record), 0, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function readLock(lockPath: string): LockRecord | undefined {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8')) as Partial<LockRecord>;
    return typeof parsed.pid === 'number' && typeof parsed.nonce === 'string'
      ? {
          pid: parsed.pid, nonce: parsed.nonce,
          ...(typeof parsed.startedAt === 'string' ? { startedAt: parsed.startedAt } : {}),
        }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 락을 남긴 그 프로세스가 **아직 그 자리에 있는가.**
 *
 * pid 가 살아 있다는 것만으로는 부족하다 — 재사용된 pid 일 수 있고, 컨테이너에서는
 * 그게 예외가 아니라 기본이다. 시작 시각을 양쪽 다 읽을 수 있을 때만 그걸로 가른다.
 * 한쪽이라도 모르면 **살아 있는 쪽으로** 틀린다 (안 열리는 쪽이 안전하다).
 */
function stillHolding(holder: LockRecord): boolean {
  if (!isAlive(holder.pid)) return false;
  const now = startTimeOf(holder.pid);
  if (holder.startedAt === undefined || now === undefined) return true;
  return holder.startedAt === now;
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

/**
 * 6차 검수 E 의 남은 항목 — **fsync 순서와 락 생성 원자성** (게이트 A)
 *
 * "fault injection 이 필요하다" 고 적어 두고 열 회차를 넘겼다. 여기서 닫는다.
 *
 * 커널을 끌 수는 없으므로 **커널이 보장하는 것과 우리가 보장해야 하는 것을 나눈다.**
 *
 *   커널       `rename` 은 원자적이다. `link` 는 대상이 있으면 EEXIST 다.
 *   우리       그 원자성이 **의미를 갖도록** 순서를 짠다 — 내용을 먼저 내리고 rename,
 *              락은 완성된 파일을 link 로 건다. 그리고 **그게 깨졌을 때 알아챈다.**
 *
 * 순서가 깨진 결과는 디스크에 남는 모양으로 나타난다. 그 모양을 손으로 만들어 놓고
 * "정본으로 받아들이는가" 를 본다. 받아들이면 순서가 무의미해진다 — 정합성의 마지막
 * 방어선은 체크섬이기 때문이다.
 */
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FileStore, StoreCorrupted, StoreLocked } from '../../src/dp/store-fs.js';

const dirs: string[] = [];
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'barycenter-durability-'));
  dirs.push(d);
  return d;
};

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('락 생성은 원자적이다 — 진짜로 경쟁시켜 본다', () => {
  /**
   * 한 프로세스 안에서는 `link` 가 동기라 경쟁이 안 만들어진다. **프로세스를 여럿 띄운다.**
   * 배포에서 실제로 일어나는 모양이 그것이다 — 같은 prefix 를 보는 DP 에이전트 둘.
   */
  it('여덟 프로세스가 동시에 열면 정확히 하나만 잡는다', () => {
    const dir = scratch();
    // `link` 의 성질을 진짜 프로세스 여덟 개로 경쟁시킨다.
    const linkRace = join(dir, 'linkrace.mjs');
    writeFileSync(linkRace, `
      import { linkSync, writeFileSync, unlinkSync } from 'node:fs';
      const [, , target, tag] = process.argv;
      const tmp = target + '.new-' + tag;
      writeFileSync(tmp, JSON.stringify({ pid: process.pid, nonce: tag }));
      try {
        linkSync(tmp, target);
        unlinkSync(tmp);
        process.stdout.write('won');
      } catch (e) {
        unlinkSync(tmp);
        process.stdout.write(e.code === 'EEXIST' ? 'lost' : 'error:' + e.code);
      }
    `);

    const lock = join(dir, 'state.json.lock');
    const results = Array.from({ length: 8 }, (_, i) =>
      execFileSync(process.execPath, [linkRace, lock, String(i)], { encoding: 'utf8' }));

    expect(results.filter((r) => r === 'won'), '둘 이상이 잡았거나 아무도 못 잡았다').toHaveLength(1);
    expect(results.filter((r) => r === 'lost')).toHaveLength(7);
    expect(results.filter((r) => r.startsWith('error:')), '예상 못 한 오류').toHaveLength(0);

    // 그리고 남은 락 파일은 **완성돼 있다** — 빈 파일이 걸리는 순간이 없다.
    const body = JSON.parse(readFileSync(lock, 'utf8')) as { pid: number; nonce: string };
    expect(body.nonce, '락 파일이 비어 있거나 반쯤 쓰였다').toMatch(/^[0-9]+$/);
    expect(dirname(lock)).toBe(dir);
  });

  it('실제 FileStore 도 두 번째 열기를 거부한다', () => {
    const dir = scratch();
    const path = join(dir, 'state.json');
    const first = FileStore.open(path);
    try {
      expect(() => FileStore.open(path)).toThrow(StoreLocked);
    } finally {
      first.release();
    }
  });

  it('임시 락 파일을 남기지 않는다 — 실패해도', () => {
    const dir = scratch();
    const path = join(dir, 'state.json');
    const first = FileStore.open(path);
    try {
      expect(() => FileStore.open(path)).toThrow(StoreLocked);
      const leftovers = readdirSync(dir).filter((f) => f.includes('.new-'));
      expect(leftovers, `임시 락이 남았다: ${leftovers.join(', ')}`).toHaveLength(0);
    } finally {
      first.release();
    }
  });
});

describe('fsync 순서가 깨진 모양을 정본으로 받아들이지 않는다', () => {
  /**
   * 순서가 지켜지지 않으면 어떤 모양이 남는가.
   *
   *   · rename 이 내용보다 먼저 보이면  → **빈 파일**이 정본이 된다
   *   · 내용이 반만 내려가면            → **잘린 JSON** 이 정본이 된다
   *   · 디렉토리 엔트리가 안 내려가면   → 옛 파일이 남는다 (이건 안전하다 — 옛 상태다)
   *
   * 앞의 둘을 손으로 만들어 놓고 `load()` 가 무엇을 하는지 본다. 조용히 받아들이면
   * 순서를 지키는 의미가 없어진다 — 마지막 방어선은 체크섬이다.
   */
  it('빈 파일이 정본 자리에 있으면 거부한다 — rename 이 먼저 보인 경우', async () => {
    const dir = scratch();
    const path = join(dir, 'state.json');
    const store = FileStore.open(path);
    await store.save({ version: 1, payload: { hello: 'world' } });
    store.release();

    writeFileSync(path, ''); // 내용이 안 내려간 채 rename 만 보인 모양

    const reopened = FileStore.open(path);
    try {
      expect(() => reopened.load(), '빈 파일을 정본으로 받아들였다').toThrow(StoreCorrupted);
    } finally {
      reopened.release();
    }
  });

  it('잘린 JSON 을 정본으로 받아들이지 않는다 — 내용이 반만 내려간 경우', async () => {
    const dir = scratch();
    const path = join(dir, 'state.json');
    const store = FileStore.open(path);
    await store.save({ version: 1, payload: { hello: 'world', pad: 'x'.repeat(200) } });
    store.release();

    const whole = readFileSync(path, 'utf8');
    writeFileSync(path, whole.slice(0, Math.floor(whole.length / 2)));

    const reopened = FileStore.open(path);
    try {
      expect(() => reopened.load(), '잘린 파일을 정본으로 받아들였다').toThrow(StoreCorrupted);
    } finally {
      reopened.release();
    }
  });

  it('내용이 바뀌었으면 체크섬이 잡는다 — 순서와 무관한 마지막 방어선', async () => {
    const dir = scratch();
    const path = join(dir, 'state.json');
    const store = FileStore.open(path);
    await store.save({ version: 1, payload: { count: 1 } });
    store.release();

    const raw = readFileSync(path, 'utf8');
    writeFileSync(path, raw.replace('"count":1', '"count":2'));

    const reopened = FileStore.open(path);
    try {
      expect(() => reopened.load(), '남이 고친 상태를 그대로 읽었다').toThrow(StoreCorrupted);
    } finally {
      reopened.release();
    }
  });

  it('찢어진 임시 파일은 정본이 되지 않는다 — rename 은 fsync 뒤에만 일어난다', async () => {
    const dir = scratch();
    const path = join(dir, 'state.json');
    const store = FileStore.open(path);
    await store.save({ version: 1, payload: { ok: true } });

    // 임시 파일이 남아 있어도 `load` 는 그것을 보지 않는다.
    const stray = join(dir, `.${process.pid}-999.tmp`);
    writeFileSync(stray, '{"schema":1,"checksum":"sha256:거짓","state":{"version":9}}');

    expect(store.load()?.version, '임시 파일을 정본으로 읽었다').toBe(1);
    store.release();
    expect(existsSync(stray)).toBe(true); // 우리가 만든 것이므로 남아 있다
  });

  it('save 가 끝나면 임시 파일이 남지 않는다', async () => {
    const dir = scratch();
    const path = join(dir, 'state.json');
    const store = FileStore.open(path);
    for (let v = 1; v <= 5; v += 1) await store.save({ version: v, payload: { v } });
    store.release();

    const leftovers = readdirSync(dir).filter((f) => f.endsWith('.tmp'));
    expect(leftovers, `임시 파일이 남았다: ${leftovers.join(', ')}`).toHaveLength(0);
  });
});

describe('여기서 못 재는 것', () => {
  /**
   * **커널을 끌 수 없다.** "fsync 를 호출했는가" 는 여기서 관측되지 않는다 — `strace`
   * 같은 도구 없이는 못 본다. 위 테스트가 지키는 것은 **순서가 깨졌을 때 나타나는 모양을
   * 정본으로 받아들이지 않는 것**이지, 순서 자체가 아니다.
   *
   * 아래 검사는 **소스에 적힌 순서**를 본다. 그래서 `fsyncSync` 를 지우면 빨개진다 —
   * 확인했다. 다만 그건 "코드가 그렇게 적혀 있다" 는 뜻이지 "그 syscall 이 디스크에
   * 닿았다" 는 뜻이 아니다. **텍스트 검사이고, 그 한계를 알고 쓴다.**
   *
   * 이걸 적어 두지 않으면 "fsync 를 검증했다" 고 넓게 읽게 된다.
   */
  it('이 스위트는 fsync 호출 자체를 검증하지 않는다 (문서용)', () => {
    const source = readFileSync(new URL('../../src/dp/store-fs.ts', import.meta.url), 'utf8');
    // 최소한 **있다**는 것과, 순서가 코드에 적힌 대로인지는 본다.
    const write = source.indexOf('writeSync(fd, body');
    const fsync = source.indexOf('fsyncSync(fd)', write);
    const rename = source.indexOf('renameSync(tmp, this.path)', write);
    const dirSync = source.indexOf('fsyncDir(dirname(this.path))', rename);
    expect(write, 'save 의 쓰기를 못 찾았다').toBeGreaterThan(0);
    expect(fsync, '내용 fsync 가 rename 앞에 없다').toBeGreaterThan(write);
    expect(rename, 'rename 이 fsync 뒤에 없다').toBeGreaterThan(fsync);
    expect(dirSync, '디렉토리 fsync 가 rename 뒤에 없다').toBeGreaterThan(rename);
  });
});

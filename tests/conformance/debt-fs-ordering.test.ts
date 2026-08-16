/**
 * **빚 갚기 — fsync 순서와 락 생성 원자성**
 *
 * 한계 목록에 이렇게 적혀 있었다: *"fsync 순서 · 락 생성 원자성 — 코드에는 있지만
 * 검증되지 않았다. 전원 차단 / 파일시스템 fault injection 이 필요하다."*
 *
 * **절반은 fault injection 없이 잴 수 있다.** 이 코드가 주장하는 것은 물리적 내구성이
 * 아니라 **syscall 의 순서**이기 때문이다:
 *
 *   · 내용 `fsync` → `rename` → 디렉토리 `fsync`
 *   · 락은 **완성된 파일을 `link` 로 한 번에 건다** (`wx` 로 만들고 나중에 쓰지 않는다)
 *
 * 순서는 관측 가능하고, 관측하면 뮤테이션이 지킨다. **전원 차단이 필요한 것은 그
 * 순서가 실제 디스크에서 뜻대로 되는가** 이고, 그건 여기서 못 잰다 — 그대로 남긴다.
 *
 * 프로덕션 코드는 한 줄도 안 바꾼다. `node:fs` 를 감싸 **호출 순서만 기록**한다.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 실제 fs 를 그대로 쓰되, 부른 순서를 남긴다. */
const calls: string[] = [];
vi.mock('node:fs', async () => {
  const real = await vi.importActual<typeof import('node:fs')>('node:fs');
  const spy = <K extends keyof typeof real>(name: K): typeof real[K] =>
    ((...args: unknown[]) => {
      calls.push(String(name));
      return (real[name] as (...a: unknown[]) => unknown)(...args);
    }) as typeof real[K];
  return {
    ...real,
    fsyncSync: spy('fsyncSync'),
    renameSync: spy('renameSync'),
    writeSync: spy('writeSync'),
    linkSync: spy('linkSync'),
    openSync: spy('openSync'),
  };
});

const { FileStore } = await import('../../src/dp/store-fs.js');

let dir: string | undefined;
afterEach(() => {
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  dir = undefined;
  calls.length = 0;
});

const fresh = (): string => {
  dir = mkdtempSync(join(tmpdir(), 'barycenter-fsorder-'));
  return join(dir, 'state.json');
};

describe('durable 쓰기의 순서', () => {
  it('내용을 내린 뒤에 rename 하고, 그 뒤에 디렉토리를 내린다', async () => {
    const store = FileStore.open(fresh());
    calls.length = 0;
    await store.save({ version: 1, payload: { hello: 'world' } });
    store.release();

    const write = calls.indexOf('writeSync');
    const rename = calls.indexOf('renameSync');
    const fsyncs = calls.reduce<number[]>((acc, c, i) => (c === 'fsyncSync' ? [...acc, i] : acc), []);

    expect(write, '전제가 틀렸다 — 쓰지도 않았다').toBeGreaterThanOrEqual(0);
    expect(rename, '전제가 틀렸다 — rename 이 없다').toBeGreaterThanOrEqual(0);
    // ① 내용 fsync 가 rename 보다 **먼저**. 아니면 rename 이 먼저 보여 빈 파일이 정본이 된다.
    expect(
      fsyncs.some((i) => i > write && i < rename),
      '내용을 안 내리고 rename 했다 — 전원이 끊기면 빈 파일이 정본이 된다',
    ).toBe(true);
    // ② 디렉토리 fsync 가 rename 보다 **나중**. 아니면 엔트리가 캐시에만 남는다.
    expect(
      fsyncs.some((i) => i > rename),
      'rename 뒤에 디렉토리를 안 내렸다 — 엔트리가 캐시에만 남는다',
    ).toBe(true);
  });
});

describe('락은 완성된 파일을 한 번에 건다', () => {
  it('link 로 걸고, 건 뒤에 그 파일에 쓰지 않는다', async () => {
    const store = FileStore.open(fresh());
    store.release();

    const link = calls.indexOf('linkSync');
    expect(link, '락을 link 로 걸지 않았다 — `wx` 로 만들고 나중에 쓰면 남이 빈 파일을 본다')
      .toBeGreaterThanOrEqual(0);
    // 건 **뒤에** 락 파일로 가는 쓰기가 없어야 한다. `writeSync` 가 link 보다 앞에만 있다는 것이
    // "완성된 파일을 건다" 의 관측 가능한 형태다.
    const writesAfterLink = calls.filter((c, i) => c === 'writeSync' && i > link).length;
    expect(writesAfterLink, '락을 건 뒤에 그 파일을 채웠다 — 그 사이 남이 빈 락을 본다').toBe(0);
  });
});

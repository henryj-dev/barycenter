/**
 * 실제 파일시스템에 물린 부작용 — DESIGN.md §7.2
 *
 * `FakeEffects` 는 계약을 정의했을 뿐이다. 4차 검수의 교훈이 "모의로만 검증한 것은
 * 실물에서 깨진다" 였으므로, 게시 경로는 진짜 심볼릭 링크로 확인한다.
 *
 * reload 전송과 활성 세대 관측은 **주입**한다 — 그쪽은 배포 형태(같은 호스트 / 컨테이너 /
 * 사이드카)에 따라 달라지므로 여기서 고정하면 안 된다.
 */
import { existsSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsEffects } from '../../src/dp/effects-fs.js';

let prefix: string;

/** 게시 기록. 이제 게시는 "무엇을" 이 아니라 "누가 무엇을" 이다. */
const rec = (generation: string) => ({
  generation,
  leaderToken: '10',
  operationId: 'op',
  transitionId: 't',
  generationDigest: 'sha256:g',
});

const makeGeneration = (name: string): string => {
  const dir = join(prefix, 'generations', name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'nginx.conf'), `# ${name}\n`, 'utf8');
  return dir;
};

const effects = (over: Partial<ConstructorParameters<typeof FsEffects>[0]> = {}) =>
  new FsEffects({
    prefix,
    reload: async () => undefined,
    probeAccepting: async () => undefined,
    ...over,
  });

beforeEach(() => {
  prefix = mkdtempSync(join(tmpdir(), 'bary-fx-'));
  mkdirSync(join(prefix, 'generations'), { recursive: true });
});
afterEach(() => rmSync(prefix, { recursive: true, force: true }));

describe('게시 — 심볼릭 링크 교체', () => {
  it('current 가 세대를 가리킨다', async () => {
    makeGeneration('gen-1');
    await effects().publish(rec('gen-1'));
    expect(readlinkSync(join(prefix, 'current'))).toBe('generations/gen-1');
  });

  it('이미 있는 링크 위로 교체한다 — 롤백 경로', async () => {
    makeGeneration('gen-1');
    makeGeneration('gen-2');
    const fx = effects();
    await fx.publish(rec('gen-1'));
    await fx.publish(rec('gen-2'));
    expect(await fx.observePublished()).toMatchObject({ kind: 'owned', record: { generation: 'gen-2' } });
    await fx.publish(rec('gen-1'));
    expect(await fx.observePublished()).toMatchObject({ kind: 'owned', record: { generation: 'gen-1' } });
  });

  it('교체 중에도 current 가 사라지는 순간이 없다', async () => {
    makeGeneration('gen-1');
    makeGeneration('gen-2');
    const fx = effects();
    await fx.publish(rec('gen-1'));
    // rename 은 원자적이다. 임시 링크를 만들고 덮어쓰므로 중간 상태가 관측되지 않는다.
    await fx.publish(rec('gen-2'));
    expect(existsSync(join(prefix, 'current'))).toBe(true);
    // 임시 링크가 남지 않아야 한다.
    expect(existsSync(join(prefix, 'current.tmp'))).toBe(false);
  });

  it('없는 세대는 게시하지 않는다 — 끊어진 링크를 만들지 않는다', async () => {
    await expect(effects().publish(rec('gen-없음'))).rejects.toThrow(/세대가 없다/);
    expect(existsSync(join(prefix, 'current'))).toBe(false);
  });

  it('nginx.conf 가 없는 세대도 거부한다', async () => {
    mkdirSync(join(prefix, 'generations', 'gen-빈'), { recursive: true });
    await expect(effects().publish(rec('gen-빈'))).rejects.toThrow(/nginx\.conf/);
  });
});

describe('관측', () => {
  it('아직 게시 전이면 none', async () => {
    expect(await effects().observePublished()).toEqual({ kind: 'none' });
  });

  it('**소유 기록이 없으면 정합하지 않다** — 누가 게시했는지 모르는 세대는 내 것이 아니다', async () => {
    makeGeneration('gen-1');
    const fx = effects();
    await fx.publish(rec('gen-1'));
    rmSync(join(prefix, 'current.owner'));
    expect(await fx.observePublished()).toMatchObject({ kind: 'inconsistent', generation: 'gen-1' });
  });

  it('활성 세대 관측은 주입된 프로브를 쓴다', async () => {
    const fx = effects({ probeAccepting: async () => 'gen-7' });
    expect((await fx.observeActivation())?.acceptingGeneration).toBe('gen-7');
  });

  it('config test 와 error log 증가분도 증거에 실린다 (§6.3)', async () => {
    let lines = 5;
    const fx = effects({
      probeAccepting: async () => 'gen-7',
      probeConfigTest: async () => true,
      probeErrorLogLines: async () => lines,
    });
    // 신호를 보내면 그 시점이 워터마크가 된다.
    await fx.signalReload();
    lines = 8;
    const e = await fx.observeActivation();
    expect(e?.configTestPassed).toBe(true);
    expect(e?.errorLogGrowth, '신호 이후 늘어난 줄 수').toBe(3);
  });

  it('신호 전에는 증가분을 말하지 않는다 — 기준선이 없다', async () => {
    const fx = effects({ probeAccepting: async () => 'gen-7', probeErrorLogLines: async () => 9 });
    expect((await fx.observeActivation())?.errorLogGrowth).toBeUndefined();
  });

  it('프로브가 실패하면 undefined 다 — 던지지 않는다', async () => {
    // 관측 실패는 "모른다" 지 "실패" 가 아니다. 상태기계가 재시도로 판정한다.
    const fx = effects({
      probeAccepting: async () => {
        throw new Error('연결 거부');
      },
    });
    expect(await fx.observeActivation()).toBeUndefined();
  });
});

describe('reload 전송', () => {
  it('주입된 전송을 호출한다', async () => {
    let sent = 0;
    await effects({ reload: async () => void (sent += 1) }).signalReload();
    expect(sent).toBe(1);
  });

  it('전송 실패는 그대로 올린다 — 관측과 달리 이건 진짜 실패다', async () => {
    const fx = effects({
      reload: async () => {
        throw new Error('컨테이너 없음');
      },
    });
    await expect(fx.signalReload()).rejects.toThrow(/컨테이너 없음/);
  });
});

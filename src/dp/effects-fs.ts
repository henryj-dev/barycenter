/**
 * 실제 파일시스템에 물린 부작용 — DESIGN.md §7.2 · §6.2
 *
 * 게시는 **원자적 심볼릭 링크 교체**다. 임시 링크를 만들고 `rename` 으로 덮으므로
 * `current` 가 사라지는 순간이 없다. 세대 디렉토리 자체도 `.tmp-N` 에서 통째로 rename 해
 * 게시하지만(§7.2), 그건 세대를 **만드는** 쪽 책임이고 여기서는 활성 포인터만 옮긴다.
 *
 * reload 전송과 활성 세대 관측은 **주입한다.** 배포 형태에 따라 달라지기 때문이다.
 *   · 같은 호스트   → `kill -HUP <pid>`
 *   · 컨테이너      → `docker kill --signal=HUP <name>`
 *   · 사이드카      → 유닉스 소켓 RPC
 * 여기서 고정하면 그 중 하나만 지원하는 꼴이 된다.
 */
import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  writeSync,
  readFileSync,
  readlinkSync,
  renameSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, join } from 'node:path';
import type { Effects, PreflightResult } from './apply.js';
import { verifyGeneration } from './materialize.js';
import type {
  ActivationEvidence,
  ApplyLease,
  ApplyOperation,
  PublishRecord,
  PublishedState,
  Checked,
} from './operation.js';

export type FsEffectsOptions = {
  /** `/etc/barycenter` 에 해당. `generations/` 와 `current` 가 여기 있다. */
  prefix: string;
  /** SIGHUP 전송. 실패는 진짜 실패다. */
  reload: () => Promise<void>;
  /** 지금 새 연결을 받는 세대 (§6.3 세대별 렌더 리터럴). */
  probeAccepting: () => Promise<string | undefined>;
  /**
   * `nginx -t` 결과. 없으면 관측하지 않은 것으로 둔다.
   *
   * **관측 못 한 것과 실패한 것은 다르다.** undefined 는 판정에 쓰지 않고, false 만
   * 음성 신호다 (§6.3).
   */
  probeConfigTest?: () => Promise<boolean>;
  /**
   * error log 의 현재 줄 수. 기본값은 `<prefix>/logs/error.log` 를 센다.
   *
   * S7 이 실증한 것: 세대 리터럴만 보면 포트가 점유된 실패를 4027ms 동안 못 잡았는데,
   * 이 워터마크를 음성 신호로 넣자 71ms 에 잡혔다.
   */
  probeErrorLogLines?: () => Promise<number>;
  /**
   * `nginx -t` 상당. 세대 경로를 받아 엔진이 그 설정을 받아들이는지 답한다.
   *
   * 없으면 **manifest 대조만** 하고 넘어간다. 관측하지 못한 것과 실패한 것은 다르므로
   * 없다고 해서 막지는 않는다 — 다만 그만큼 늦게 발견한다.
   */
  configTest?: (generation: string) => Promise<boolean>;
  /**
   * 멤버십 슬롯을 적재한다 (§6.5-1). 세대의 `lua/membership.json` 을 읽어 넘긴다.
   *
   * **없으면 `stageMembership` 자체가 없다.** 멤버십 평면은 엔진 capability 로 켜지므로,
   * 못 하는 배포에서 "했다" 고 답하는 것보다 메서드가 아예 없는 편이 정직하다.
   */
  pushMembership?: (plane: 'http' | 'stream', epoch: string, slots: Record<string, string[]>)
    => Promise<void>;
};

/** 내용을 fsync 하고 닫는다. rename 이 먼저 보이면 빈 파일이 정본이 된다. */
function writeFileDurable(path: string, body: string): void {
  const fd = openSync(path, 'w');
  try {
    writeSync(fd, body, 0, 'utf8');
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** 디렉토리 엔트리를 디스크에 내린다. rename 만으로는 부족하다. */
function fsyncDir(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

export class FsEffects implements Effects {
  /**
   * §6.5-1 staging. **적재하고 되읽어 대조한다.**
   *
   * 되읽는 이유: `nginx -t` 는 Lua 를 하나도 검증하지 않는다(E64). admin 조각의 Lua 에
   * 문법 오류가 있어도 게시 전 검사를 그대로 통과하고, 세대 마커는 `return 200` 이라
   * Lua 와 무관하게 답하므로 **활성화 판정도 못 잡는다.** 써 놓고 다시 읽는 것이 그
   * 경로가 실제로 살아 있다는 유일한 증거다.
   *
   * ⚠️ 그래도 **밸런서 자체가 도는지는 증명하지 못한다.** `balancer_by_lua_block` 은
   * 연결이 와야 실행되고, 그건 트래픽으로만 알 수 있다. 여기 적어 둔다.
   */
  stageMembership = async (
    generation: string, plane: 'http' | 'stream', lease: ApplyLease,
  ): Promise<Checked> => {
    // **적재할 것이 없는 것과 전송이 없는 것은 다르다.** 순서를 반대로 두면, 멤버십
    // 평면을 안 쓰는 배포(정적 `server` 줄로 렌더된 세대)에서 apply 가 통째로 죽는다 —
    // 실제로 그렇게 짰다가 게시 전 검사 conformance 둘이 빨개졌다.
    const path = join(this.opts.prefix, 'generations', generation, 'lua', 'membership.json');
    if (!existsSync(path)) {
      // 정적 `server` 줄로 렌더된 세대다. 적재할 것이 없다 — 실패가 아니다.
      return lease.assertValid();
    }
    const doc = JSON.parse(readFileSync(path, 'utf8')) as {
      epoch: string; http: Record<string, string[]>; stream: Record<string, string[]>;
    };
    const slots = doc[plane];
    if (Object.keys(slots).length === 0) return lease.assertValid();
    if (this.opts.pushMembership === undefined) {
      throw new Error('적재할 멤버십이 있는데 전송이 없다 — pushMembership 을 안 줬다');
    }
    const checked = lease.assertValid();
    await this.pushMembership(plane, doc.epoch, slots);
    return checked;
  };

  /** 활성 epoch 의 슬롯을 갈아 끼운다 — **reload 없이** (§6.5). */
  pushMembership = async (
    plane: 'http' | 'stream', epoch: string, slots: Record<string, string[]>,
  ): Promise<void> => {
    const push = this.opts.pushMembership;
    if (push === undefined) {
      throw new Error('pushMembership 이 없다 — 멤버십 평면을 쓸 수 없는 배포다');
    }
    await push(plane, epoch, slots);
  };

  /** HUP 을 보낸 시점의 error log 줄 수. 그 이후 증가분만 이 전환의 것이다. */
  private watermark: number | undefined;

  constructor(private readonly opts: FsEffectsOptions) {}

  private get link(): string {
    return join(this.opts.prefix, 'current');
  }

  /**
   * 게시 전 검사 (§6.2 #2 · §7.2).
   *
   * **디스크의 바이트를 다시 읽어 대조한다.** manifest 만 믿으면 manifest 만 맞고 내용이
   * 바뀐 세대를 활성화한다.
   */
  async preflight(op: ApplyOperation): Promise<PreflightResult> {
    const generation = op.targetGeneration;
    try {
      // **평면까지 대조한다** (10차 반례 ②). 세대가 stream 도 구성하는데 오퍼레이션이
      // http 만 말하면, stream 설정은 활성화되고 좌표만 옛 값으로 남는다.
      verifyGeneration(this.opts.prefix, generation, op.generationDigest, op.affectedPlanes);
    } catch (e) {
      return { ok: false, reason: (e as Error).message };
    }
    if (this.opts.configTest === undefined) return { ok: true };
    try {
      const passed = await this.opts.configTest(generation);
      return passed
        ? { ok: true, configTestPassed: true }
        : { ok: false, reason: '엔진이 설정을 거부했다 (nginx -t)', configTestPassed: false };
    } catch (e) {
      // 검사를 **못 한 것**은 실패가 아니다. 판정은 관측이 한다 (§6.3).
      return { ok: true, reason: `config test 를 돌리지 못했다: ${(e as Error).message}` };
    }
  }

  /** 소유 기록의 경로. `current` 옆에 둔다. */
  private get ownerPath(): string {
    return `${this.link}.owner`;
  }

  async publish(record: PublishRecord, lease: ApplyLease): Promise<Checked> {
    const generation = record.generation;
    const dir = join(this.opts.prefix, 'generations', generation);
    // 끊어진 링크를 만들지 않는다. 게시 후 reload 가 실패하는 것보다 게시를 막는 게 낫다.
    if (!existsSync(dir)) {
      throw new Error(`세대가 없다: ${dir}`);
    }
    if (!existsSync(join(dir, 'nginx.conf'))) {
      throw new Error(`세대에 nginx.conf 가 없다: ${dir}`);
    }

    // 상대 경로로 링크한다. prefix 를 통째로 옮겨도 세대 참조가 깨지지 않는다.
    const target = join('generations', generation);
    const tmp = `${this.link}.tmp`;
    if (existsSync(tmp)) unlinkSync(tmp);
    symlinkSync(target, tmp);
    // **여기가 되돌릴 수 없는 지점이다** (8차 반례 ①). 확인과 rename 사이에 `await` 가
    // 없으므로 그 구간에는 다른 코드가 끼어들지 못한다. 준비(임시 링크 생성)는 앞에서
    // 끝냈다 — 그건 되돌릴 수 있다.
    // **소유 기록을 먼저 쓴다.** 포인터가 먼저 바뀌면 "누가 게시했는지 모르는 세대" 가
    // 관측된다. 순서를 이렇게 두면 중간 상태는 `inconsistent` 로 드러나고, 그걸 본
    // 리더가 다시 게시해 수렴한다 (9차 뒤 방향 전환).
    const ownerTmp = `${this.ownerPath}.tmp`;
    if (existsSync(ownerTmp)) unlinkSync(ownerTmp);
    writeFileDurable(ownerTmp, JSON.stringify(record));
    renameSync(ownerTmp, this.ownerPath);
    fsyncDir(this.opts.prefix);

    const checked = lease.assertValid();
    // rename 은 원자적이다 — `current` 가 없는 순간이 생기지 않는다.
    renameSync(tmp, this.link);
    // **디렉토리 엔트리도 내린다** (10차 반례 ⑤). rename 만 하면 전원이 끊겼을 때
    // 포인터와 소유 기록의 순서가 뒤집힐 수 있다.
    fsyncDir(this.opts.prefix);
    return checked;
  }

  async observePublished(): Promise<PublishedState> {
    let generation: string | undefined;
    try {
      generation = basename(readlinkSync(this.link));
    } catch {
      generation = undefined;
    }

    let record: PublishRecord | undefined;
    try {
      record = JSON.parse(readFileSync(this.ownerPath, 'utf8')) as PublishRecord;
    } catch {
      record = undefined;
    }

    if (generation === undefined && record === undefined) return { kind: 'none' };
    // 포인터와 소유 기록이 **같은 세대를 말할 때만** 정합이다.
    if (generation !== undefined && record !== undefined && record.generation === generation) {
      return { kind: 'owned', record };
    }
    return record === undefined
      ? { kind: 'inconsistent', generation }
      : { kind: 'inconsistent', generation, record };
  }

  async signalReload(lease: ApplyLease): Promise<Checked> {
    // **신호 전에** 워터마크를 찍는다. 뒤에 찍으면 신호가 만든 오류를 놓친다.
    this.watermark = await this.errorLogLines();
    const checked = lease.assertValid();
    // ⚠️ 표는 "불렀는가" 를 강제할 뿐 "언제 불렀는가" 를 강제하지 못한다. 아래 `await`
    // 안에서 리더가 바뀌면 신호는 그대로 나간다 — 9차에 재현했고 아직 남아 있다.
    await this.opts.reload();
    return checked;
  }

  private async errorLogLines(): Promise<number | undefined> {
    try {
      if (this.opts.probeErrorLogLines !== undefined) return await this.opts.probeErrorLogLines();
      const path = join(this.opts.prefix, 'logs', 'error.log');
      if (!existsSync(path)) return 0;
      const text = readFileSync(path, 'utf8');
      return text.length === 0 ? 0 : text.trimEnd().split('\n').length;
    } catch {
      return undefined;
    }
  }

  /**
   * 활성화 증거 (§6.3). 관측할 수 있는 것을 전부 싣는다.
   *
   * **관측 실패는 "모른다" 지 "실패" 가 아니다.** 여기서 던지면 상태기계가 복구할 수
   * 있는 상황을 오류로 끝내 버린다. 판정은 재시도와 상한이 한다 (§6.2).
   */
  async observeActivation(): Promise<ActivationEvidence | undefined> {
    let accepting: string | undefined;
    try {
      accepting = await this.opts.probeAccepting();
    } catch {
      return undefined;
    }
    if (accepting === undefined) return undefined;

    let configTestPassed: boolean | undefined;
    if (this.opts.probeConfigTest !== undefined) {
      try {
        configTestPassed = await this.opts.probeConfigTest();
      } catch {
        configTestPassed = undefined;
      }
    }

    // 워터마크가 없으면(아직 신호를 안 보냈으면) 증가분을 말할 수 없다.
    const now = await this.errorLogLines();
    const growth =
      this.watermark === undefined || now === undefined ? undefined : Math.max(0, now - this.watermark);

    return {
      acceptingGeneration: accepting,
      ...(configTestPassed === undefined ? {} : { configTestPassed }),
      ...(growth === undefined ? {} : { errorLogGrowth: growth }),
    };
  }
}

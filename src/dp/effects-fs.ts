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
  existsSync,
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
import type { ActivationEvidence, ApplyLease, PublishRecord, PublishedState } from './operation.js';

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
};

export class FsEffects implements Effects {
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
  async preflight(generation: string, expectedDigest: string): Promise<PreflightResult> {
    try {
      verifyGeneration(this.opts.prefix, generation, expectedDigest);
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

  async publish(record: PublishRecord, lease?: ApplyLease): Promise<void> {
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
    writeFileSync(ownerTmp, JSON.stringify(record), 'utf8');
    renameSync(ownerTmp, this.ownerPath);

    lease?.assertValid();
    // rename 은 원자적이다 — `current` 가 없는 순간이 생기지 않는다.
    renameSync(tmp, this.link);
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

  async signalReload(lease?: ApplyLease): Promise<void> {
    // **신호 전에** 워터마크를 찍는다. 뒤에 찍으면 신호가 만든 오류를 놓친다.
    this.watermark = await this.errorLogLines();
    lease?.assertValid();
    await this.opts.reload();
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

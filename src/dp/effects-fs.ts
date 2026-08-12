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
import { existsSync, readFileSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Effects } from './apply.js';
import type { ActivationEvidence } from './operation.js';

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
};

export class FsEffects implements Effects {
  /** HUP 을 보낸 시점의 error log 줄 수. 그 이후 증가분만 이 전환의 것이다. */
  private watermark: number | undefined;

  constructor(private readonly opts: FsEffectsOptions) {}

  private get link(): string {
    return join(this.opts.prefix, 'current');
  }

  async publish(generation: string): Promise<void> {
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
    // rename 은 원자적이다 — `current` 가 없는 순간이 생기지 않는다.
    renameSync(tmp, this.link);
  }

  async observePublished(): Promise<string | undefined> {
    try {
      return basename(readlinkSync(this.link));
    } catch {
      return undefined;
    }
  }

  async signalReload(): Promise<void> {
    // **신호 전에** 워터마크를 찍는다. 뒤에 찍으면 신호가 만든 오류를 놓친다.
    this.watermark = await this.errorLogLines();
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

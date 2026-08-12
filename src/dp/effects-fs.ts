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
import { existsSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { Effects } from './apply.js';

export type FsEffectsOptions = {
  /** `/etc/barycenter` 에 해당. `generations/` 와 `current` 가 여기 있다. */
  prefix: string;
  /** SIGHUP 전송. 실패는 진짜 실패다. */
  reload: () => Promise<void>;
  /** 지금 새 연결을 받는 세대 (§6.3 세대별 렌더 리터럴). */
  probeAccepting: () => Promise<string | undefined>;
};

export class FsEffects implements Effects {
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
    await this.opts.reload();
  }

  async observeAccepting(): Promise<string | undefined> {
    // **관측 실패는 "모른다" 지 "실패" 가 아니다.** 여기서 던지면 상태기계가 복구할 수
    // 있는 상황을 오류로 끝내 버린다. 판정은 재시도와 상한이 한다 (§6.2).
    try {
      return await this.opts.probeAccepting();
    } catch {
      return undefined;
    }
  }
}

/**
 * 알릴 사건을 **찾는** 쪽 — 주기적으로 상태를 보고 사건을 허브에 낸다.
 *
 * 데몬에는 이 사건들의 콜백이 없다(리더 교체 · 미완 전환 · 지역 연락 끊김은 아무도 알리지 않았다). 그래서 기존 경로를
 * 고치지 않고 **읽기만** 해서 찾는다:
 *
 *   리더 교체        `isLeader()` 가 바뀌면(첫 관측은 기준으로만 삼는다 — 기동은 사건이 아니다). 모든 노드.
 *   적용 실패        head 의 마지막 적용이 실패로 끝났다(`failedHead`). 키는 plan — 같은 실패를 되풀이하지 않는다.
 *   미완 전환        끝나지 않은 전환이 `graceMs` 넘게 같은 것으로 남았다(지금 도는 적용을 사건으로 보지 않게).
 *   인증서 만료 임박  만료까지 `certDays` 안. 키에 만료 시각이 들어간다 — 갱신되면 새 사건이다.
 *   지역 연락 끊김    전역 화면이 한 지역에 `graceMs` 넘게 닿지 못한다. 다시 닿으면 그 키를 잊는다.
 *
 * 리더 교체 말고는 **리더만** 본다 — 노드마다 같은 사건을 내지 않게.
 * 출처 하나가 던져도 나머지는 본다. 출처 실패는 경고 로그만 남긴다.
 */
import { log } from '../obs/log.js';
import type { NotifyHub } from './hub.js';

export type WatchSources = {
  isLeader: () => boolean;
  failedApply?: () => Promise<{ revision: string; planId: string; failure: string } | undefined>;
  unfinished?: () => Promise<{ operationId: string; transitionId?: string; generation?: string } | undefined>;
  certificates?: () => Promise<readonly { key: string; notAfter?: string }[]>;
  regions?: () => Promise<readonly { name: string; reachable: boolean; auth?: string; error?: string; lastOkAt?: string }[]>;
};

export type WatchOptions = { certDays: number; graceMs: number; now?: () => number };

const DAY = 86_400_000;

export class NotifyWatch {
  readonly #hub: NotifyHub;
  readonly #src: WatchSources;
  readonly #o: WatchOptions;
  #leader: boolean | undefined;
  readonly #unfinishedSince = new Map<string, number>();
  readonly #regionDownSince = new Map<string, number>();
  #timer: NodeJS.Timeout | undefined;
  #running = false;

  constructor(hub: NotifyHub, src: WatchSources, o: WatchOptions) {
    this.#hub = hub;
    this.#src = src;
    this.#o = o;
  }

  #now(): number {
    return this.#o.now?.() ?? Date.now();
  }

  async tick(): Promise<void> {
    const leader = this.#src.isLeader();
    if (this.#leader !== undefined && this.#leader !== leader) {
      this.#hub.emit({
        kind: 'leader.changed', severity: leader ? 'info' : 'warning', key: `leader.changed:${String(leader)}`,
        title: leader ? '이 노드가 리더가 됐다' : '이 노드가 리더를 잃었다',
        detail: leader ? '적용 · ACME · 정리 작업을 이 노드가 맡는다.' : '다른 노드가 리더가 될 때까지 적용이 멈출 수 있다.',
      });
    }
    this.#leader = leader;
    if (!leader) return;

    await this.#guard('failedApply', async () => {
      const f = await this.#src.failedApply?.();
      if (f === undefined) return;
      this.#hub.emit({
        kind: 'apply.failed', severity: 'critical', key: `apply.failed:${f.planId}`,
        title: `리비전 ${f.revision} 적용이 실패했다`, detail: f.failure,
        facts: { revision: f.revision, plan: f.planId },
      });
    });

    await this.#guard('unfinished', async () => {
      const u = await this.#src.unfinished?.();
      const now = this.#now();
      for (const id of [...this.#unfinishedSince.keys()]) if (id !== u?.operationId) this.#unfinishedSince.delete(id);
      if (u === undefined) return;
      const since = this.#unfinishedSince.get(u.operationId) ?? now;
      this.#unfinishedSince.set(u.operationId, since);
      if (now - since < this.#o.graceMs) return;
      this.#hub.emit({
        kind: 'transition.incomplete', severity: 'critical', key: `transition.incomplete:${u.operationId}`,
        title: '끝나지 않은 전환이 남아 있다',
        detail: `오퍼레이션 ${u.operationId} 이 ${Math.round((now - since) / 60_000)}분 넘게 끝나지 않았다. 상태를 보고 이어받는다(POST /api/v1/recover).`,
        facts: { operation: u.operationId, ...(u.transitionId === undefined ? {} : { transition: u.transitionId }), ...(u.generation === undefined ? {} : { generation: u.generation }) },
      });
    });

    await this.#guard('certificates', async () => {
      const now = this.#now();
      for (const c of (await this.#src.certificates?.()) ?? []) {
        if (c.notAfter === undefined) continue;
        const left = new Date(c.notAfter).getTime() - now;
        if (Number.isNaN(left) || left > this.#o.certDays * DAY) continue;
        const days = Math.floor(left / DAY);
        this.#hub.emit({
          kind: 'cert.expiring', severity: left <= 3 * DAY ? 'critical' : 'warning', key: `cert.expiring:${c.key}:${c.notAfter}`,
          title: left <= 0 ? `인증서 ${c.key} 가 만료됐다` : `인증서 ${c.key} 만료 ${days}일 전`,
          detail: `만료 시각 ${c.notAfter}. ACME 인증서면 갱신 주문 상태를, 손으로 올린 것이면 새 자료를 올린다.`,
          facts: { certificate: c.key, notAfter: c.notAfter, daysLeft: days },
        });
      }
    });

    await this.#guard('regions', async () => {
      const list = await this.#src.regions?.();
      if (list === undefined) return;
      const now = this.#now();
      for (const r of list) {
        const key = `region.unreachable:${r.name}`;
        const down = !r.reachable || r.auth === 'rejected';
        if (!down) {
          if (this.#regionDownSince.delete(r.name)) this.#hub.forget(key);
          continue;
        }
        const since = this.#regionDownSince.get(r.name) ?? now;
        this.#regionDownSince.set(r.name, since);
        if (now - since < this.#o.graceMs) continue;
        this.#hub.emit({
          kind: 'region.unreachable', severity: 'critical', key,
          title: `지역 ${r.name} 에 닿지 못한다`,
          detail: r.auth === 'rejected' ? '지역이 전역의 인증을 거절했다(인증서 · tokens.json).' : (r.error ?? '응답 없음'),
          facts: { region: r.name, ...(r.lastOkAt === undefined ? {} : { lastOkAt: r.lastOkAt }) },
        });
      }
    });
  }

  async #guard(source: string, f: () => Promise<void>): Promise<void> {
    try {
      await f();
    } catch (e) {
      log.warn('notify.watch.source_failed', { source, error: (e as Error).message });
    }
  }

  start(intervalMs: number): void {
    this.#timer = setInterval(() => {
      if (this.#running) return;
      this.#running = true;
      void this.tick().finally(() => { this.#running = false; });
    }, intervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}

/**
 * 알림 허브 — 사건을 받아 **되풀이를 거르고, 상한이 있는 큐로, 본 동작을 막지 않고** 통로들에 보낸다.
 *
 *   emit()   동기다. 기다리지 않고 던지지 않는다. 적용 · 발급 경로 안에서 불러도 된다.
 *   중복     같은 사건 키는 `repeatMs` 안에 다시 보내지 않는다(재알림 간격). 키 표도 상한이 있다(오래된 것부터 버린다).
 *   큐       `maxQueue` 를 넘으면 가장 오래된 것을 버리고 경고한다 — 통로가 막혀도 메모리가 자라지 않는다.
 *   실패     통로마다 따로. 실패는 로그 · 계측만 남긴다(다시 보내지 않는다 — 같은 사건이 계속되면 재알림 간격 뒤에 다시 온다).
 */
import { log } from '../obs/log.js';
import { count } from '../obs/metrics.js';
import type { Notifier, NotifyEvent, NotifyResult } from './notifier.js';

export type NotifyInput = Omit<NotifyEvent, 'at' | 'node'>;

export type HubOptions = {
  node: string;
  /** 같은 키 재알림 간격. */
  repeatMs: number;
  maxQueue?: number;
  maxKeys?: number;
  now?: () => number;
};

export class NotifyHub {
  readonly #notifiers: readonly Notifier[];
  readonly #o: Required<Omit<HubOptions, 'now'>> & { now: () => number };
  readonly #last = new Map<string, number>();
  readonly #queue: NotifyEvent[] = [];
  #pumping: Promise<void> | undefined;

  constructor(notifiers: readonly Notifier[], o: HubOptions) {
    this.#notifiers = notifiers;
    this.#o = { maxQueue: 100, maxKeys: 2000, now: Date.now, ...o };
  }

  get kinds(): string[] {
    return this.#notifiers.map((n) => n.kind);
  }

  /** 보낼 것으로 받았으면 true. 되풀이로 걸렀으면 false. */
  emit(input: NotifyInput): boolean {
    try {
      const now = this.#o.now();
      const last = this.#last.get(input.key);
      if (last !== undefined && now - last < this.#o.repeatMs) {
        count(`bary_notify_total{outcome="suppressed"}`);
        return false;
      }
      this.#last.delete(input.key);
      this.#last.set(input.key, now);
      while (this.#last.size > this.#o.maxKeys) this.#last.delete(this.#last.keys().next().value!);

      this.#queue.push({ ...input, at: new Date(now).toISOString(), node: this.#o.node });
      while (this.#queue.length > this.#o.maxQueue) {
        const dropped = this.#queue.shift()!;
        count(`bary_notify_total{outcome="dropped"}`);
        log.warn('notify.queue_overflow', { dropped: dropped.key, max: this.#o.maxQueue });
      }
      this.#pump();
      return true;
    } catch (e) {
      log.warn('notify.emit_failed', { error: (e as Error).message });
      return false;
    }
  }

  /** 사건이 풀렸다 — 다음에 다시 나면 간격을 기다리지 않고 보낸다. */
  forget(key: string): void {
    this.#last.delete(key);
  }

  get queued(): number {
    return this.#queue.length;
  }

  /** 큐가 빌 때까지 기다린다(시험 · 종료용). */
  async drain(): Promise<void> {
    while (this.#pumping !== undefined) await this.#pumping;
  }

  #pump(): void {
    if (this.#pumping !== undefined) return;
    this.#pumping = (async () => {
      try {
        for (let e = this.#queue.shift(); e !== undefined; e = this.#queue.shift()) {
          const ev = e;
          await Promise.all(this.#notifiers.map((n) => this.#sendOne(n, ev)));
        }
      } finally {
        this.#pumping = undefined;
      }
    })();
  }

  async #sendOne(n: Notifier, e: NotifyEvent): Promise<void> {
    let r: NotifyResult;
    try {
      r = await n.send(e);
    } catch (err) {
      r = { ok: false, reason: 'unavailable', detail: `통로가 던졌다: ${(err as Error).message}` };
    }
    if (r.ok) {
      count(`bary_notify_total{notifier="${n.kind}",outcome="sent"}`);
      return;
    }
    count(`bary_notify_total{notifier="${n.kind}",outcome="${r.reason}"}`);
    log.warn('notify.send_failed', { notifier: n.kind, kind: e.kind, key: e.key, reason: r.reason, detail: r.detail });
  }
}

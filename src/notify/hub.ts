/**
 * 알림 허브 — 사건을 받아 **되풀이를 거르고, 상한이 있는 큐로, 본 동작을 막지 않고** 통로들에 보낸다.
 *
 *   emit()   동기다. 기다리지 않고 던지지 않는다. 적용 · 발급 경로 안에서 불러도 된다.
 *   중복     같은 사건 키는 `repeatMs` 안에 다시 보내지 않는다(재알림 간격). 키 표도 상한이 있다(오래된 것부터 버린다).
 *   큐       `maxQueue` 를 넘으면 가장 오래된 것을 버리고 경고한다 — 통로가 막혀도 메모리가 자라지 않는다.
 *   실패     통로마다 따로. 실패는 로그 · 계측만 남긴다(다시 보내지 않는다 — 같은 사건이 계속되면 재알림 간격 뒤에 다시 온다).
 *   거르기   통로마다 받을 사건 종류 · 최소 심각도가 있다(`accepts`). 안 받는 통로에는 보내지 않는다.
 *   기록     보낸 결과 · 큐에서 버린 것을 `onDelivery` 로 알린다(데몬이 `notify_deliveries` 에 적는다). 되풀이로 거른 것은
 *            계측만 남긴다 — 상태 보기가 1분마다 같은 사건을 다시 내므로, 적으면 기록이 그것으로 찬다.
 *   바꾸기   `reconfigure` 로 통로 · 간격을 바꾼다. 데몬을 다시 띄우지 않는다. 중복 억제 표는 그대로 둔다.
 */
import { log } from '../obs/log.js';
import { count } from '../obs/metrics.js';
import type { Notifier, NotifyEvent, NotifyFailure, NotifyResult } from './notifier.js';

export type NotifyInput = Omit<NotifyEvent, 'at' | 'node'>;

/** 허브가 보낸 결과 하나. `channel` 이 없으면 허브에서 걸렀다(큐 넘침). */
export type Delivery = {
  channel?: string;
  event: NotifyEvent;
  outcome: 'sent' | 'dropped' | NotifyFailure;
  detail?: string;
};

/** 이름이 있고 받을 사건을 고르는 통로(DB 의 `notify_channels` 한 행). 이름이 없으면 `kind` 를 이름으로 쓴다. */
export type ChannelNotifier = Notifier & { readonly name?: string; accepts?(e: NotifyEvent): boolean };

export type HubOptions = {
  node: string;
  /** 같은 키 재알림 간격. */
  repeatMs: number;
  maxQueue?: number;
  maxKeys?: number;
  now?: () => number;
  /** 보낸 결과마다 부른다. 던져도 허브는 계속 돈다. */
  onDelivery?: (d: Delivery) => void;
};

export class NotifyHub {
  #notifiers: readonly ChannelNotifier[];
  readonly #o: Required<Omit<HubOptions, 'now' | 'onDelivery'>> & { now: () => number; onDelivery?: (d: Delivery) => void };
  readonly #last = new Map<string, number>();
  readonly #queue: NotifyEvent[] = [];
  #pumping: Promise<void> | undefined;

  constructor(notifiers: readonly ChannelNotifier[], o: HubOptions) {
    this.#notifiers = notifiers;
    this.#o = { maxQueue: 100, maxKeys: 2000, now: Date.now, ...o };
  }

  get kinds(): string[] {
    return this.#notifiers.map((n) => n.kind);
  }

  /** 통로 이름들(설정 순서). */
  get channels(): string[] {
    return this.#notifiers.map((n) => n.name ?? n.kind);
  }

  /**
   * 통로 · 간격을 바꾼다. 큐에 있는 사건은 **새 통로로** 나간다(보내는 때의 설정을 따른다). 중복 억제 표는 그대로다 —
   * 설정을 바꿨다고 이미 보낸 사건을 다시 보내지 않는다.
   */
  reconfigure(notifiers: readonly ChannelNotifier[], o: { repeatMs: number; maxQueue: number }): void {
    this.#notifiers = notifiers;
    this.#o.repeatMs = o.repeatMs;
    this.#o.maxQueue = o.maxQueue;
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
        this.#record({ event: dropped, outcome: 'dropped', detail: `큐가 ${this.#o.maxQueue} 개를 넘었다` });
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
          const targets = this.#notifiers.filter((n) => n.accepts?.(ev) ?? true);
          await Promise.all(targets.map((n) => this.#sendOne(n, ev)));
        }
      } finally {
        this.#pumping = undefined;
      }
    })();
  }

  #record(d: Delivery): void {
    try {
      this.#o.onDelivery?.(d);
    } catch (err) {
      log.warn('notify.record_failed', { error: (err as Error).message });
    }
  }

  async #sendOne(n: ChannelNotifier, e: NotifyEvent): Promise<void> {
    let r: NotifyResult;
    try {
      r = await n.send(e);
    } catch (err) {
      r = { ok: false, reason: 'unavailable', detail: `통로가 던졌다: ${(err as Error).message}` };
    }
    const channel = n.name ?? n.kind;
    if (r.ok) {
      count(`bary_notify_total{notifier="${n.kind}",outcome="sent"}`);
      this.#record({ channel, event: e, outcome: 'sent' });
      return;
    }
    count(`bary_notify_total{notifier="${n.kind}",outcome="${r.reason}"}`);
    log.warn('notify.send_failed', { notifier: n.kind, channel, kind: e.kind, key: e.key, reason: r.reason, detail: r.detail });
    this.#record({ channel, event: e, outcome: r.reason, detail: r.detail });
  }
}

/**
 * 알림의 **돌아가는 쪽** — DB 의 설정으로 허브 · 상태 보기를 만들고, 바뀌면 다시 짠다 (2026-11-20).
 *
 *   기동      DB 가 비어 있으면 환경 변수로 씨를 뿌린다(`seed`). 이미 있으면 환경 변수를 보지 않는다 — 다르면 경고한다.
 *   바꾸기    화면이 고치면 이 노드는 곧바로(`reload`), 다른 노드는 `version` 을 주기마다 보고 다시 짠다. 다시 띄우지 않는다.
 *   보내기    누가 보내는지는 전과 같다 — 리더 교체만 모든 노드, 나머지는 리더만(`watch.ts`). ACME 실패는 리더의 러너가 낸다.
 *   기록      보낸 결과를 `notify_deliveries` 에 적는다. 적기가 실패해도 보내기는 멈추지 않는다.
 *   시험      통로 하나에 시험 사건을 곧바로 보낸다(되풀이 거르기 · 받을 사건 거르기를 지나지 않는다).
 *
 * 켜진 통로가 하나도 없으면 상태 보기를 멈춘다 — 볼 까닭이 없다.
 */
import type { SecretStore } from '../dp/secrets.js';
import { log } from '../obs/log.js';
import type { Database } from '../store/db.js';
import { NotifyHub, type Delivery, type NotifyInput } from './hub.js';
import { knobsFromEnv, readNotifyEnv, type NotifyDeps, type NotifyEnv, type NotifyKnobs } from './registry.js';
import {
  buildChannels, notifierFor, NotifySettingsError, NotifySettingsStore, scrub, testEvent,
  type NotifyConfig, type TestOutcome,
} from './settings.js';
import { NotifyWatch, type WatchSources } from './watch.js';

export type RuntimeOptions = {
  db: Database;
  secrets?: SecretStore;
  node: string;
  deps?: NotifyDeps;
  env?: NodeJS.ProcessEnv;
  sources: WatchSources;
  /** 다른 노드의 변경을 보는 주기. 기본 30초. */
  pollMs?: number;
};

export type RuntimeStatus = {
  version?: number;
  /** 지금 보내는 통로들. */
  active: string[];
  /** 켜져 있지만 만들지 못한 통로와 그 까닭. */
  problems: { channel: string; problem: string }[];
  /** 메일 전송 설정이 있나(메일 통로를 만들 수 있나). */
  mailAvailable: boolean;
};

export class NotifyRuntime {
  readonly store: NotifySettingsStore;
  readonly hub: NotifyHub;
  readonly #o: RuntimeOptions;
  readonly #watch: NotifyWatch;
  #version: number | undefined;
  #intervalMs = 0;
  #watching = false;
  #secrets: string[] = [];
  #problems: { channel: string; problem: string }[] = [];
  #poll: NodeJS.Timeout | undefined;
  #reloading: Promise<void> | undefined;

  constructor(o: RuntimeOptions) {
    this.#o = o;
    this.store = new NotifySettingsStore(o.db, o.secrets);
    const k = knobsFromEnv(o.env ?? {});
    this.hub = new NotifyHub([], {
      node: o.node, repeatMs: k.repeatS * 1000, maxQueue: k.queue,
      onDelivery: (d) => this.#record(d),
    });
    this.#watch = new NotifyWatch(this.hub, o.sources, { certDays: k.certDays, graceMs: 2 * k.intervalS * 1000 });
  }

  /**
   * 씨를 뿌리고 처음 짠다. 씨를 뿌려야 하는데 환경 변수가 반만 설정이면 **던진다**(전과 같다 — 기동을 거부한다).
   */
  async start(): Promise<void> {
    const env = this.#o.env ?? process.env;
    const already = await this.store.version();
    if (already === undefined) {
      const spec = readNotifyEnv(env, this.#o.deps);
      const seeded = await this.store.seed(spec, knobsFromEnv(env));
      if (seeded) log.info('notify.seeded', { from: spec === undefined ? 'default' : 'env', channels: spec?.channels.map((c) => c.kind) ?? [] });
    } else {
      this.#warnIgnoredEnv(env);
    }
    await this.reload();
    const every = this.#o.pollMs ?? 30_000;
    this.#poll = setInterval(() => {
      void this.store.version().then((v) => {
        if (v !== this.#version) return this.reload();
        return undefined;
      }).catch((e: unknown) => log.warn('notify.poll_failed', { error: (e as Error).message }));
    }, every);
    this.#poll.unref?.();
  }

  /** DB 를 다시 읽고 허브 · 상태 보기를 다시 짠다. 겹쳐 부르면 하나로 모은다. */
  reload(): Promise<void> {
    if (this.#reloading !== undefined) return this.#reloading.then(() => this.#reload());
    this.#reloading = this.#reload().finally(() => { this.#reloading = undefined; });
    return this.#reloading;
  }

  async #reload(): Promise<void> {
    const config = await this.store.load();
    if (config === undefined) return;
    const built = await buildChannels(config, this.store, this.#o.deps);
    this.#secrets = built.secrets;
    this.#problems = built.problems;
    for (const p of built.problems) log.warn('notify.channel_unusable', p);
    this.hub.reconfigure(built.notifiers, { repeatMs: config.knobs.repeatS * 1000, maxQueue: config.knobs.queue });
    this.#watch.configure({ certDays: config.knobs.certDays, graceMs: 2 * config.knobs.intervalS * 1000 });
    const intervalMs = config.knobs.intervalS * 1000;
    if (built.notifiers.length === 0) {
      if (this.#watching) this.#watch.stop();
      this.#watching = false;
    } else if (!this.#watching || intervalMs !== this.#intervalMs) {
      this.#watch.start(intervalMs);
      this.#watching = true;
    }
    this.#intervalMs = intervalMs;
    if (this.#version !== config.version) {
      log.info('notify.configured', { version: config.version, channels: this.hub.channels, problems: built.problems.length });
    }
    this.#version = config.version;
  }

  /** 사건 하나를 낸다(ACME 러너가 부른다). */
  emit(input: NotifyInput): boolean {
    return this.hub.emit(input);
  }

  status(): RuntimeStatus {
    return {
      ...(this.#version === undefined ? {} : { version: this.#version }),
      active: this.hub.channels,
      problems: this.#problems,
      mailAvailable: this.#o.deps?.mail?.() !== undefined,
    };
  }

  /** 통로 하나에 시험 사건을 보낸다. 꺼진 통로도 보낸다 — 켜기 전에 확인하는 자리다. */
  async test(name: string): Promise<TestOutcome> {
    const config = await this.store.load();
    const c = config?.channels.find((x) => x.name === name);
    if (c === undefined) throw new NotifySettingsError(404, 'not_found', `알림 통로 '${name}' 가 없다`);
    const secret = await this.store.secretOf(c);
    let n;
    try {
      n = notifierFor(c, secret, this.#o.deps);
    } catch (e) {
      throw new NotifySettingsError(409, 'channel_unusable', `통로 '${name}' 를 만들지 못했다: ${(e as Error).message}`);
    }
    const event = testEvent(name, this.#o.node);
    let r;
    try {
      r = await n.send(event);
    } catch (e) {
      r = { ok: false as const, reason: 'unavailable' as const, detail: `통로가 던졌다: ${(e as Error).message}` };
    }
    const secrets = secret === undefined ? [] : [secret];
    const outcome: TestOutcome = r.ok ? { outcome: 'sent' } : { outcome: r.reason, detail: scrub(r.detail, secrets) };
    await this.store.recordDelivery({
      channel: name, event, outcome: outcome.outcome, ...(r.ok ? {} : { detail: r.detail }), test: true, node: this.#o.node,
    }, secrets).catch((e: unknown) => log.warn('notify.record_failed', { error: (e as Error).message }));
    return outcome;
  }

  /** 지금 설정(화면이 읽는다). */
  async config(): Promise<NotifyConfig | undefined> {
    return this.store.load();
  }

  stop(): void {
    if (this.#poll !== undefined) clearInterval(this.#poll);
    this.#poll = undefined;
    this.#watch.stop();
    this.#watching = false;
  }

  #record(d: Delivery): void {
    void this.store.recordDelivery({ ...d, node: this.#o.node }, this.#secrets)
      .catch((e: unknown) => log.warn('notify.record_failed', { error: (e as Error).message }));
  }

  /** DB 가 이미 정본인데 환경 변수가 다른 것을 말하면 알린다(비밀은 비교하지 않는다). */
  #warnIgnoredEnv(env: NodeJS.ProcessEnv): void {
    const vars = Object.keys(env).filter((k) => k.startsWith('BARY_NOTIFY') && !k.startsWith('BARY_NOTIFY_DELIVERY_') && env[k] !== undefined && env[k] !== '');
    if (vars.length === 0) return;
    let spec: NotifyEnv | undefined;
    try {
      spec = readNotifyEnv(env, this.#o.deps);
    } catch (e) {
      log.warn('notify.env_ignored', { vars, why: `DB 에 알림 설정이 있어 환경 변수를 보지 않는다 (환경 변수도 맞지 않다: ${(e as Error).message})` });
      return;
    }
    void this.store.load().then((c) => {
      if (c === undefined) return;
      const envKinds = (spec?.channels.map((x) => x.kind) ?? []).sort().join(',');
      const dbKinds = c.channels.filter((x) => x.enabled).map((x) => x.kind).sort().join(',');
      const k: NotifyKnobs = spec?.knobs ?? knobsFromEnv(env);
      const sameKnobs = k.repeatS === c.knobs.repeatS && k.certDays === c.knobs.certDays && k.intervalS === c.knobs.intervalS && k.queue === c.knobs.queue;
      if (envKinds !== dbKinds || !sameKnobs) {
        log.warn('notify.env_ignored', { vars, why: 'DB 에 알림 설정이 있어 환경 변수를 보지 않는다 — 화면(관리 › 알림)에서 고친다' });
      }
    }).catch(() => undefined);
  }
}


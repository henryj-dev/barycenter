/** 인증 실패를 인스턴스 메모리에서 유한하게 제한한다. */
export type AuthFailureLimitOptions = {
  maxFailures?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  ttlMs?: number;
  maxEntries?: number;
};

type Entry = { failures: number; blockedUntil: number; lastSeen: number };

export class AuthFailureLimiter {
  readonly #maxFailures: number;
  readonly #baseDelayMs: number;
  readonly #maxDelayMs: number;
  readonly #ttlMs: number;
  readonly #maxEntries: number;
  readonly #entries = new Map<string, Entry>();

  constructor(opts: AuthFailureLimitOptions = {}) {
    this.#maxFailures = opts.maxFailures ?? 5;
    this.#baseDelayMs = opts.baseDelayMs ?? 1_000;
    this.#maxDelayMs = opts.maxDelayMs ?? 60_000;
    this.#ttlMs = opts.ttlMs ?? 10 * 60_000;
    this.#maxEntries = opts.maxEntries ?? 1_024;
  }

  record(key: string, now = Date.now()): number | undefined {
    this.prune(now);
    const old = this.#entries.get(key);
    const entry = old === undefined || now - old.lastSeen >= this.#ttlMs
      ? { failures: 1, blockedUntil: 0, lastSeen: now }
      : { failures: old.failures + 1, blockedUntil: old.blockedUntil, lastSeen: now };
    if (entry.failures >= this.#maxFailures) {
      const delay = Math.min(
        this.#maxDelayMs,
        this.#baseDelayMs * 2 ** (entry.failures - this.#maxFailures),
      );
      entry.blockedUntil = now + delay;
    }
    this.#entries.set(key, entry);
    this.trim();
    return entry.blockedUntil > now
      ? Math.max(1, Math.ceil((entry.blockedUntil - now) / 1_000))
      : undefined;
  }

  clear(key: string): void {
    this.#entries.delete(key);
  }

  private prune(now: number): void {
    for (const [key, entry] of this.#entries) {
      if (now - entry.lastSeen >= this.#ttlMs) this.#entries.delete(key);
    }
  }

  private trim(): void {
    while (this.#entries.size > this.#maxEntries) {
      const first = this.#entries.keys().next().value as string | undefined;
      if (first === undefined) return;
      this.#entries.delete(first);
    }
  }
}

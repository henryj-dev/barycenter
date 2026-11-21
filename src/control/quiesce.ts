/**
 * **종료 전에 하던 일을 끝낸다** (2026-11-21).
 *
 * 재시작할 때마다 옛 프로세스가 오류를 한 줄 남겼다 — `prober.failed` 나 `api.internal`
 * (`Cannot use a pool after calling end`). 종료가 타이머를 멈춘 뒤 바로 DB 를 닫았기 때문이다.
 * 타이머를 멈춰도 **이미 돌고 있는 한 바퀴와 요청은 계속 간다.** 그것이 닫힌 DB 를 썼다.
 *
 * 그래서 종료는 하던 일이 끝나기를 기다린 뒤 DB 를 닫는다. 기다림에는 끝이 있다 — 나가는 길이
 * 막히는 것보다 덜 깨끗하게 나가는 편이 낫다(`SHUTDOWN_DEADLINE_MS` 와 같은 판단).
 */

/** 진행 중인 일의 수를 센다. 0 이 되면 기다리던 쪽을 깨운다. */
export class Inflight {
  #n = 0;
  #waiters: (() => void)[] = [];

  track<T>(p: Promise<T>): Promise<T> {
    this.#n++;
    return p.finally(() => {
      this.#n--;
      if (this.#n === 0) for (const w of this.#waiters.splice(0)) w();
    });
  }

  get size(): number {
    return this.#n;
  }

  idle(): Promise<void> {
    return this.#n === 0 ? Promise.resolve() : new Promise((r) => this.#waiters.push(r));
  }
}

/**
 * 모두 끝나기를 `ms` 까지 기다린다. 끝났으면 `true`, 시간이 다 되었으면 `false`.
 * 실패한 것도 「끝난 것」이다 — 여기는 결과가 아니라 손을 뗐는지를 본다.
 */
export async function settleWithin(ms: number, work: readonly Promise<unknown>[]): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((r) => { timer = setTimeout(() => r(false), ms); timer.unref?.(); });
  try {
    return await Promise.race([Promise.allSettled(work).then(() => true as const), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

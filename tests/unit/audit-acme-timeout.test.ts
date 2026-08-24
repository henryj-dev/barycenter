/**
 * ACME 타임아웃 · 재진입 가드 · 계정 재사용 — 검수 2026-08-24 D11 · D16
 *
 * 셋이 같은 두 파일에 살고, **셋이 합쳐져야 하나의 증상을 닫는다:** 답하지 않는 CA 가
 * 러너를 영영 매단다.
 *
 * ── ㉠ `fetch` 에 마감이 없다 (D11)
 *
 * `AcmeClient` 의 `fetch` 넷 중 어느 것에도 `AbortSignal` 이 없다. Node 의 `fetch` 는
 * **기본 타임아웃이 없다** — 연결이 서 있고 바이트가 안 오면 그대로 매달린다. CA 가
 * 죽는 방식은 대개 「거절」이 아니라 「안 답함」이다(레이트리밋 뒤의 큐, LB 뒤의 좀비).
 *
 * ── ㉡ 틱이 겹친다 (D11)
 *
 * `start()` 의 `setInterval` 은 앞 틱이 끝났는지 안 본다. ㉠ 과 겹치면 30 초마다 새
 * 틱이 쌓이고, 각자 `claimDue` 로 실행권을 잡으려 든다. `HealthProber` 는 같은 자리에
 * `#running` 가드를 갖고 있다 — **한쪽만 갖고 있다는 것이 그 자체로 신호다.**
 *
 * ── ㉢ 계정이 있는데 `newAccount` 를 또 부른다 (D16)
 *
 * `#drive` 의 주석이 이렇게 적혀 있다:
 *
 * > 이미 등록된 계정이면 `kid` 를 다시 쓴다 — `newAccount` 를 또 부르면 CA 가 같은
 * > 계정을 돌려주긴 하지만 요청 하나가 낭비되고 레이트리밋에 계산된다.
 *
 * **그리고 코드는 `await client.register()` 를 부른다.** 주석이 말하는 것을 코드가 안
 * 한다 — `AcmeClient` 에 `#kid` 를 놓을 방법이 아예 없기 때문이다. 이 저장소가 여러
 * 번 잡은 *"주석이 계약을 말하고 코드가 안 지킨다"* 의 한 판이다.
 *
 * Let's Encrypt 의 `newAccount` 레이트리밋은 IP 당 시간당 10 회다. 러너는 **틱마다**
 * 이걸 부른다 — 기본 30 초 간격이면 한 시간에 120 회다.
 */
import { createPrivateKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { AcmeClient } from '../../src/acme/client.js';
import { AcmeRunner, type ChallengePlacer } from '../../src/control/acme-runner.js';

const key = (): KeyObject => {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  return createPrivateKey(privateKey.export({ type: 'pkcs8', format: 'pem' }));
};

/** 영원히 안 답하는 `fetch`. **거절이 아니라 침묵이 CA 가 죽는 방식이다.** */
const silent: typeof fetch = ((_url: string, init?: RequestInit) =>
  new Promise((_resolve, reject) => {
    const signal = init?.signal;
    if (signal == null) return;              // 마감이 없으면 이 약속은 안 끝난다
    if (signal.aborted) return reject(signal.reason as Error);
    signal.addEventListener('abort', () => reject(signal.reason as Error));
  })) as typeof fetch;

describe('안 답하는 CA', () => {
  it('안 답하는 CA 가 러너를 못 매단다 — `directory()` 가 유한 시간에 끝난다', async () => {
    const c = new AcmeClient({
      directoryUrl: 'https://ca.test/dir', accountKey: key(),
      fetchImpl: silent, timeoutMs: 200,
    });
    const started = Date.now();
    await expect(c.directory()).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  it('`post` 도 마감이 있다 — nonce 를 받으러 가서 매달리지 않는다', async () => {
    const c = new AcmeClient({
      directoryUrl: 'https://ca.test/dir', accountKey: key(),
      fetchImpl: silent, timeoutMs: 200,
    });
    const started = Date.now();
    await expect(c.post('https://ca.test/order/1')).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(5_000);
  }, 20_000);

  /** **기본값이 있어야 한다.** 안 적은 배포가 매다는 배포이면 안 고친 것과 같다. */
  it('`timeoutMs` 를 안 줘도 마감이 있다 — 무한대가 기본이면 안 된다', () => {
    const c = new AcmeClient({ directoryUrl: 'https://ca.test/dir', accountKey: key() });
    expect(c.timeoutMs).toBeGreaterThan(0);
    expect(Number.isFinite(c.timeoutMs)).toBe(true);
  });
});

describe('계정 재사용', () => {
  /**
   * `#kid` 를 놓을 방법이 없으면 러너는 **틱마다** `newAccount` 를 부를 수밖에 없다.
   * Let's Encrypt 의 그 레이트리밋은 IP 당 시간당 10 회다.
   */
  it('이미 등록된 계정은 `newAccount` 없이 이어 쓴다', () => {
    const c = new AcmeClient({ directoryUrl: 'https://ca.test/dir', accountKey: key() });
    expect(c.accountUrl).toBeUndefined();
    c.resumeAccount('https://ca.test/acct/7');
    expect(c.accountUrl).toBe('https://ca.test/acct/7');
  });

  it('러너가 그것을 쓴다 — 계정 URL 이 있으면 CA 에 안 묻는다', async () => {
    const calls: string[] = [];
    const fake = {
      register: (): Promise<string> => {
        calls.push('register');
        return Promise.resolve('https://ca.test/acct/1');
      },
      resumeAccount: (url: string): void => { calls.push(`resume:${url}`); },
      // 여기까지 오면 실행권을 잡은 주문이 없다는 뜻이라 `step()` 이 그냥 끝난다.
    };
    const runner = new AcmeRunner({
      store: stubStore('https://ca.test/acct/9') as never,
      secrets: stubSecrets() as never,
      placer: nullPlacer(),
      clientFor: () => fake as never,
    });
    await runner.step();
    expect(calls).toEqual(['resume:https://ca.test/acct/9']);
    expect(calls).not.toContain('register');
  });

  it('계정 URL 이 없으면 등록한다 — 첫 발급을 막지 않는다', async () => {
    const calls: string[] = [];
    const setAccountUrl: string[] = [];
    const fake = {
      register: (): Promise<string> => {
        calls.push('register');
        return Promise.resolve('https://ca.test/acct/1');
      },
      resumeAccount: (url: string): void => { calls.push(`resume:${url}`); },
    };
    const runner = new AcmeRunner({
      store: stubStore(undefined, setAccountUrl) as never,
      secrets: stubSecrets() as never,
      placer: nullPlacer(),
      clientFor: () => fake as never,
    });
    await runner.step();
    expect(calls).toEqual(['register']);
    // 그리고 **적어 둔다** — 다음 틱이 다시 등록하지 않게.
    expect(setAccountUrl).toEqual(['https://ca.test/acct/1']);
  });
});

describe('겹치는 틱', () => {
  /**
   * `HealthProber` 는 같은 자리에 `#running` 가드를 갖고 있다. 한쪽만 갖고 있다는
   * 것이 그 자체로 신호다 — 두 러너의 틱은 같은 성질(느릴 수 있고, durable 실행권을
   * 잡는다)을 가졌다.
   */
  it('틱이 겹쳐 돌지 않는다 — 앞 틱이 도는 동안 새 틱은 그냥 돌아간다', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release = (): void => {};
    const held = new Promise<void>((r) => { release = r; });

    const runner = new AcmeRunner({
      store: {
        claimDue: async (): Promise<undefined> => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await held;
          inFlight -= 1;
          return undefined;
        },
      } as never,
      secrets: stubSecrets() as never,
      placer: nullPlacer(),
    });

    runner.start(5, () => true, async () => []);
    await new Promise((r) => setTimeout(r, 120));   // 틱이 스무 번쯤 지나갈 시간
    release();
    await new Promise((r) => setTimeout(r, 30));
    runner.stop();

    expect(maxInFlight).toBe(1);
  }, 20_000);
});

// ── 스텁 ─────────────────────────────────────────────────────────────────
//
// **실물 PG 를 안 쓴다.** 여기서 묻는 것은 「원장이 무엇을 하는가」가 아니라
// 「러너가 CA 에 무엇을 묻는가」다 — 그건 원장을 안 지나도 보인다.
// 원장 쪽 판정은 `tests/store/acme-runner.test.ts` 가 실물로 잰다.

function stubStore(accountUrl: string | undefined, setSink: string[] = []): unknown {
  const order = {
    id: 'o1', accountId: 'a1', state: 'pending' as const,
    domains: ['a.test'], orderUrl: undefined,
  };
  let taken = false;
  return {
    claimDue: (): Promise<unknown> => {
      if (taken) return Promise.resolve(undefined);
      taken = true;
      return Promise.resolve(order);
    },
    accountById: (): Promise<unknown> => Promise.resolve({
      directoryUrl: 'https://ca.test/dir',
      accountKeyRef: 'key://acct@1',
      accountUrl,
    }),
    setAccountUrl: (_id: string, url: string): Promise<void> => {
      setSink.push(url);
      return Promise.resolve();
    },
    /**
     * 계정 단계를 지나면 `#startOrder` 가 가짜 클라이언트의 없는 메서드에 걸려 던진다.
     * 그 뒤 경로(`fail` → `cleanupOrder`)를 열어 둔다 — **이 파일이 재는 것은 계정
     * 단계이지 그 뒤가 아니므로**, 뒤에서 나는 예외가 앞의 판정을 가리면 안 된다.
     */
    fail: (): Promise<string> => Promise.resolve('failed'),
    release: (): Promise<void> => Promise.resolve(),
    orphans: (): Promise<unknown[]> => Promise.resolve([]),
    challenges: (): Promise<unknown[]> => Promise.resolve([]),
    markCleaned: (): Promise<void> => Promise.resolve(),
  };
}

function stubSecrets(): unknown {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  return { getKey: (): string => pem };
}

function nullPlacer(): ChallengePlacer {
  return {
    type: 'http-01',
    place: (): Promise<void> => Promise.resolve(),
    remove: (): Promise<void> => Promise.resolve(),
  };
}

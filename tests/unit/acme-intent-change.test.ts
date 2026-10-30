/**
 * ACME 의도가 바뀌면 만료를 기다리지 않고 다시 발급한다 (2026-10-31, web-01).
 *
 * 스테이징 계정으로 받아 확인한 뒤 같은 인증서를 운영 CA 로 받고 싶다. 전에는 러너가 「자료가 없거나 만료가
 * 30일 안」 일 때만 주문을 열어서, 계정만 바꿔도 스테이징 자료가 유효하니 아무 일도 없었다 — 인증서를
 * 새로 만들어 리스너 · SNI 를 다시 걸어야 했다.
 *
 * 재는 것:
 *   · 지금 자료를 낸 주문의 계정과 의도의 계정이 다르면 주문을 연다
 *   · 도메인이 바뀌어도 연다
 *   · 같으면(만료도 멀면) 열지 않는다
 *   · 손으로 올린 자료(발급 기록 없음)는 의도와 상관없이 만료로만 본다
 */
import { describe, expect, it } from 'vitest';

import { AcmeRunner } from '../../src/control/acme-runner.js';
import type { AcmeStore } from '../../src/control/acme-store.js';
import type { SecretStore } from '../../src/dp/secrets.js';

const FAR = new Date(Date.now() + 80 * 86_400_000).toISOString();
const placer = { type: 'http-01' as const, place: async () => undefined, remove: async () => undefined };
const secrets = { facts: () => ({ notAfter: FAR }) } as unknown as SecretStore;

const run = async (last: { accountId: string; domains: string[] } | undefined, intent: { account: string; domains: string[] }): Promise<string[]> => {
  const opened: string[] = [];
  const store = {
    accountByKey: async (key: string) => ({ id: key === 'le-prod' ? 'acct-prod' : 'acct-staging', key }),
    lastIssued: async () => last,
    openOrder: async () => { opened.push('o'); return { id: 'o', created: true }; },
  } as unknown as AcmeStore;
  const r = new AcmeRunner({ store, secrets, placer });
  await r.scan([{ key: 'web', id: 'c1', materialRef: 'cert://web', acme: intent }]);
  return opened;
};

describe('ACME 의도 변경', () => {
  it('계정을 바꾸면(스테이징 → 운영) 만료를 안 기다리고 주문을 연다', async () => {
    expect(await run({ accountId: 'acct-staging', domains: ['a.test'] }, { account: 'le-prod', domains: ['a.test'] })).toHaveLength(1);
  });

  it('도메인을 바꿔도 연다', async () => {
    expect(await run({ accountId: 'acct-staging', domains: ['a.test'] }, { account: 'le-staging', domains: ['a.test', 'b.test'] })).toHaveLength(1);
  });

  it('같고 만료도 멀면 열지 않는다', async () => {
    expect(await run({ accountId: 'acct-staging', domains: ['A.test'] }, { account: 'le-staging', domains: ['a.test'] })).toHaveLength(0);
  });

  it('손으로 올린 자료는 의도와 상관없이 만료로만 본다', async () => {
    expect(await run(undefined, { account: 'le-prod', domains: ['a.test'] })).toHaveLength(0);
  });
});

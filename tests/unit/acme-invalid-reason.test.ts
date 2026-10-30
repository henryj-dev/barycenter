/**
 * ACME 주문이 거절되면 **진짜 사유**를 남긴다 (2026-10-31, web-01 첫 발급 시도).
 *
 * web-01 의 주문이 「검증 중 → 실패」 로 가며 「CA 가 주문을 거절했다: (detail 없음)」 만 남겼다.
 * Let's Encrypt 는 http-01 실패의 사유를 주문이 아니라 **그 도메인 인가의 챌린지**(`error.detail`)에 싣는다.
 * 러너가 주문만 봐서 운영자가 무엇을 고칠지(예: :80 에 리스너가 없다) 알 수 없었다.
 *
 * 재는 것:
 *   · 주문에 사유가 없으면 인가의 챌린지에서 읽어 실패 문구에 넣는다
 *   · 인가를 못 읽어도 실패 판정은 그대로다(사유만 비운다)
 */
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import type { AcmeClient } from '../../src/acme/client.js';
import { AcmeRunner } from '../../src/control/acme-runner.js';
import type { AcmeStore } from '../../src/control/acme-store.js';
import type { SecretStore } from '../../src/dp/secrets.js';

const pem = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const store = (): { s: AcmeStore; failed: string[] } => {
  const failed: string[] = [];
  const s = {
    claimDue: async () => ({ id: 'o1', state: 'validating', accountId: 'a1', certificateId: 'c1', domains: ['x.test'], orderUrl: 'https://ca.test/order/1' }),
    accountById: async () => ({ id: 'a1', key: 'k', directoryUrl: 'https://ca.test/dir', accountKeyRef: 'key://acme-k', accountUrl: 'https://ca.test/acct/1' }),
    fail: async (_id: string, message: string) => { failed.push(message); return 'failed'; },
    challenges: async () => [],
    markCleaned: async () => undefined,
    release: async () => undefined,
  } as unknown as AcmeStore;
  return { s, failed };
};
const secrets = { getKey: async () => pem } as unknown as SecretStore;
const placer = { type: 'http-01' as const, place: async () => undefined, remove: async () => undefined };

const ca = (authz: () => Promise<unknown>): AcmeClient => ({
  resumeAccount: () => undefined,
  fetchOrder: async () => ({ status: 'invalid', identifiers: [], authorizations: ['https://ca.test/authz/1'], finalize: '' }),
  fetchAuthorization: authz,
} as unknown as AcmeClient);

describe('ACME 거절 사유', () => {
  it('주문에 사유가 없으면 챌린지의 사유를 남긴다', async () => {
    const { s, failed } = store();
    const r = new AcmeRunner({
      store: s, secrets, placer,
      clientFor: () => ca(async () => ({
        status: 'invalid', identifier: { type: 'dns', value: 'x.test' },
        challenges: [{ type: 'http-01', url: 'u', token: 't', status: 'invalid',
          error: { type: 'urn:ietf:params:acme:error:connection', detail: '1.2.3.4: Fetching http://x.test/.well-known/acme-challenge/t: Connection refused' } }],
      })),
    });
    const out = await r.step();
    expect(out?.to).toBe('failed');
    expect(failed[0]).toContain('Connection refused');
    expect(failed[0]).toContain('x.test http-01');
    expect(failed[0]).not.toContain('(detail 없음)');
  });

  it('인가를 못 읽어도 실패는 실패다', async () => {
    const { s, failed } = store();
    const r = new AcmeRunner({ store: s, secrets, placer, clientFor: () => ca(async () => { throw new Error('CA 가 안 답한다'); }) });
    expect((await r.step())?.to).toBe('failed');
    expect(failed[0]).toContain('(detail 없음)');
  });
});

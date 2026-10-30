/**
 * ACME 주문 진행이 화면에 실시간으로 온다 (2026-10-30, web-01 에서 받은 지적).
 *
 * 인증서를 만들고 적용해도 상세의 주문 상태가 「조회한 당시」 에 머물렀다. 이벤트 스트림에는
 * `revision` · `apply` · `health` 뿐이었고, 러너가 주문을 옮겨도(대기 → 검증 중 → 발급됨 · 실패)
 * 아무도 알리지 않았다. 발급된 자료를 설정에 반영하는 커밋도 API 를 거치지 않아 `revision` 을 안 냈다.
 *
 * 재는 것:
 *   · 러너가 주문 상태를 바꾸면(실패 포함) `onAdvance` 를 부른다
 *   · 알림이 던져도 러너는 멈추지 않는다
 *   · 데몬이 그것을 `acme` 이벤트로 내고, 발급 반영 커밋을 `revision` 으로 낸다
 *   · GUI 가 `acme` 이벤트에 인증서와 주문을 다시 읽는다
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { AcmeRunner, type TickResult } from '../../src/control/acme-runner.js';
import type { AcmeStore } from '../../src/control/acme-store.js';
import type { SecretStore } from '../../src/dp/secrets.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');

/** 계정이 사라진 주문 하나 — 러너가 이것을 옮기면 실패로 간다. CA 에는 안 간다. */
const storeWithOrphanOrder = (): AcmeStore => ({
  claimDue: async () => ({ id: 'o1', state: 'pending', accountId: 'gone', certificateId: 'c1', domains: ['a.test'] }),
  accountById: async () => undefined,
  fail: async () => 'failed',
  challenges: async () => [],
  markCleaned: async () => undefined,
  release: async () => undefined,
} as unknown as AcmeStore);

const placer = { type: 'http-01' as const, place: async () => undefined, remove: async () => undefined };

describe('ACME 진행 알림', () => {
  it('주문이 실패로 가면 onAdvance 를 부른다', async () => {
    const seen: TickResult[] = [];
    const r = new AcmeRunner({
      store: storeWithOrphanOrder(), secrets: {} as SecretStore, placer,
      onAdvance: (e) => { seen.push(e); },
    });
    const out = await r.step();
    expect(out?.to).toBe('failed');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ order: 'o1', from: 'pending', to: 'failed' });
    expect(seen[0]?.error).toContain('계정이 없다');
  });

  it('알림이 던져도 러너는 끝까지 간다', async () => {
    const r = new AcmeRunner({
      store: storeWithOrphanOrder(), secrets: {} as SecretStore, placer,
      onAdvance: () => { throw new Error('구독자 고장'); },
    });
    await expect(r.step()).resolves.toMatchObject({ to: 'failed' });
  });

  it('데몬이 acme · revision 이벤트로 내고, GUI 가 받는다', () => {
    const bin = readFileSync(join(root, 'src/bin/barycenterd.ts'), 'utf8');
    expect(bin).toMatch(/onAdvance: \(e\) => \{ events\.publish\('acme', e\); \}/);
    expect(bin).toMatch(/const published = await publishIssued\(/);
    expect(bin).toMatch(/events\.publish\('revision', \{ revision: p\.revision/);
    const desk = readFileSync(join(root, 'gui/src/lib/desk.svelte.ts'), 'utf8');
    expect(desk).toMatch(/frame\.event === 'acme'\) \{[\s\S]{0,200}refreshCerts\(\)/);
  });
});

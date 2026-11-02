/**
 * **두 모델이 인증서 의도만 다른가** (2026-11-02) — 트래픽에 닿지 않는 커밋을 바로 올리는 판정.
 *
 * 틀리게 「같다」 고 하면 사람이 보지 않은 변경이 적용 대기를 건너뛴다. 그래서 「아니다」 쪽으로 기운다.
 */
import { describe, expect, it } from 'vitest';

import { certificateIntentOnly } from '../../src/control/plane.js';
import type { Certificate, Model } from '../../src/model/provisional.js';

const base = (certificates: Certificate[] = []): Model => ({
  listeners: [], httpRoutes: [], passthroughRoutes: [], pools: [], backends: [],
  certificates, tlsPolicies: [], sniBindings: [],
});
const issued = (key: string, v = '1'): Certificate => ({
  key, materialRef: `store://${key}@${v}`, chainDigest: `sha256:c${v}`, keyDigest: `sha256:k${v}`,
});
const acme = { account: 'le', domains: ['a.test'] };

describe('certificateIntentOnly', () => {
  it('**자료 없는 ACME 인증서를 더하거나 빼거나 고치면 그렇다**', () => {
    expect(certificateIntentOnly(base(), base([{ key: 'site', acme }]))).toBe(true);
    expect(certificateIntentOnly(base([{ key: 'site', acme }]), base())).toBe(true);
    expect(certificateIntentOnly(base([{ key: 'site', acme }]),
      base([{ key: 'site', acme: { account: 'le-prod', domains: ['a.test', 'b.test'] } }]))).toBe(true);
  });

  it('자료 있는 인증서의 계정·도메인만 바꾸면 그렇다 — 옛 자료가 계속 쓰인다', () => {
    expect(certificateIntentOnly(base([{ ...issued('site'), acme }]),
      base([{ ...issued('site'), acme: { account: 'le-prod', domains: ['a.test'] } }]))).toBe(true);
  });

  it('**자료가 바뀌거나 생기거나 사라지면 아니다** — 세대에 들어가는 파일이 바뀐다', () => {
    expect(certificateIntentOnly(base([issued('site', '1')]), base([issued('site', '2')]))).toBe(false);
    expect(certificateIntentOnly(base([{ key: 'site', acme }]), base([{ ...issued('site'), acme }]))).toBe(false);
    expect(certificateIntentOnly(base([issued('site')]), base())).toBe(false);
    expect(certificateIntentOnly(base(), base([issued('up')]))).toBe(false);
  });

  it('**인증서 밖이 하나라도 다르면 아니다**', () => {
    const after = base([{ key: 'site', acme }]);
    after.backends = [{ key: 'w1', pool: 'web', host: '10.0.0.1', port: 80, weight: 1 } as never];
    expect(certificateIntentOnly(base(), after)).toBe(false);
  });

  it('키 순서만 다른 것은 같다', () => {
    const a = base([{ key: 'x', acme }]);
    const b = Object.fromEntries(Object.entries(a).reverse()) as Model;
    expect(certificateIntentOnly(a, b)).toBe(true);
  });
});

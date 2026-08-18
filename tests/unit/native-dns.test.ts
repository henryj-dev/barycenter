/**
 * S14 — 네이티브 DNS 실패 모드는 선택형이 아니다.
 *
 * 이 테스트가 지키는 것: capability 가 **사실의 표**이지 설정이 아니라는 것.
 * 값이 바뀌거나 키가 늘거나 객체가 녹으면, GUI 가 다시 없는 선택지를 그릴 구멍이 생긴다.
 */
import { describe, expect, expectTypeOf, it } from 'vitest';

import { parseEngineCapabilities } from '../../src/engine/capabilities.js';
import {
  NATIVE_DNS_FAILURE_MODES,
  dataplaneCapabilitiesOf,
  nativeDnsOf,
} from '../../src/engine/native-dns.js';

describe('네이티브 DNS 실패 모드', () => {
  it('실패 모드는 설정할 수 없다', () => {
    expect(Object.isFrozen(NATIVE_DNS_FAILURE_MODES)).toBe(true);
    expect(Object.keys(NATIVE_DNS_FAILURE_MODES).sort()).toEqual([
      'nxdomain',
      'servfail',
      'timeout',
    ]);
    expect(NATIVE_DNS_FAILURE_MODES).toEqual({
      nxdomain: 'drop_peer',
      servfail: 'keep_last',
      timeout: 'keep_last',
    });
    // 리터럴이어야 한다. string 으로 넓히면 선택형처럼 보인다.
    expectTypeOf(NATIVE_DNS_FAILURE_MODES.nxdomain).toEqualTypeOf<'drop_peer'>();
    expectTypeOf(NATIVE_DNS_FAILURE_MODES.servfail).toEqualTypeOf<'keep_last'>();
    expectTypeOf(NATIVE_DNS_FAILURE_MODES.timeout).toEqualTypeOf<'keep_last'>();
  });

  it('resolve 가 없으면 실패 모드 표를 내놓지 않는다', () => {
    const off = nativeDnsOf(false);
    expect(off).toEqual({ available: false });
    expect('failureModes' in off).toBe(false);
  });

  it('resolve 가 있으면 S14 표를 그대로 돌려준다', () => {
    const on = nativeDnsOf(true);
    expect(on.available).toBe(true);
    if (!on.available) throw new Error('narrow');
    expect(on.failureModes).toBe(NATIVE_DNS_FAILURE_MODES);
  });

  it('엔진 capability 에서 조립된다 — 1.27.3 미만은 경로 자체가 없다', () => {
    const old = parseEngineCapabilities(
      'nginx version: nginx/1.24.0\nconfigure arguments: --with-stream',
    );
    expect(dataplaneCapabilitiesOf(old)).toEqual({ nativeDns: { available: false } });

    const current = parseEngineCapabilities(
      'nginx version: nginx/1.27.3\nconfigure arguments: --with-stream',
    );
    expect(dataplaneCapabilitiesOf(current).nativeDns.available).toBe(true);
  });
});

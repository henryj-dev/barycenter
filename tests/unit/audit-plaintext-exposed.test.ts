import { describe, expect, it } from 'vitest';

import { plaintextExposureError } from '../../src/bin/barycenterd.js';
import { plaintextExposureMetric } from '../../src/api/server.js';
import { render } from '../../src/obs/metrics.js';

describe('외부 평문 제어 API', () => {
  it('TLS 가 없고 루프백 밖이면 플래그 없이는 안 뜬다', () => {
    expect(plaintextExposureError('0.0.0.0', false, false)).toMatch(/BARY_ALLOW_PLAINTEXT_EXPOSED/);
  });

  it('허용 플래그가 있으면 뜨되 노출 상태를 계산할 수 있다', () => {
    expect(plaintextExposureError('0.0.0.0', false, true)).toBeUndefined();
  });

  it('TLS가 있으면 플래그 없이 외부 주소를 허용한다', () => {
    expect(plaintextExposureError('0.0.0.0', true, false)).toBeUndefined();
  });

  it('루프백은 TLS 없이도 허용한다', () => {
    expect(plaintextExposureError('127.0.0.1', false, false)).toBeUndefined();
  });

  it('허용 플래그가 켜진 것이 인증된 metrics에서 보인다', () => {
    const gauges = {
      generations: 0, generationBytes: 0, agentStateBytes: 0, head: 0, leader: 0,
      activationEpochHttp: 0, activationEpochStream: 0, unfinished: 0,
      backendsHealthy: 0, backendsUnhealthy: 0, backendsUnknown: 0, pendingApply: 0,
      uptimeSeconds: 0, rssBytes: 0,
    };
    expect(render(gauges, [plaintextExposureMetric(true)])).toContain('bary_api_plaintext_exposed 1');
    expect(render(gauges, [plaintextExposureMetric(false)])).toContain('bary_api_plaintext_exposed 0');
  });
});

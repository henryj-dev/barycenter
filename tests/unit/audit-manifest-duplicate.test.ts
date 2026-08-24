import { describe, expect, it } from 'vitest';

import { parseManifest } from '../../src/store/manifest.js';

const resource = (kind: string, key: string) => ({
  kind, key, spec: { protocolClass: 'http', algorithm: 'round_robin' },
});

describe('manifest 중복 식별자', () => {
  it('같은 kind 와 key 가 두 번 나오면 거절한다', () => {
    expect(() => parseManifest({
      schemaVersion: '1', resources: [resource('pool', 'app'), resource('pool', 'app')],
    })).toThrow(/resources\[1\].*중복/);
  });

  it('같은 key 라도 kind 가 다르면 통과한다', () => {
    expect(parseManifest({
      schemaVersion: '1', resources: [resource('pool', 'app'), resource('backend', 'app')],
    }).resources).toHaveLength(2);
  });

  it('중복 메시지가 두 번째 리소스의 인덱스를 말한다', () => {
    expect(() => parseManifest({
      schemaVersion: '1', resources: [resource('pool', 'app'), resource('pool', 'app')],
    })).toThrow('resources[1]');
  });
});

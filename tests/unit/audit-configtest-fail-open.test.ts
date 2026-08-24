import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { materializeGeneration } from '../../src/dp/materialize.js';
import { FsEffects } from '../../src/dp/effects-fs.js';
import { bootEffects } from '../../src/dp/effects-boot.js';

const op = (digest: string) => ({
  operationId: 'op', transitionId: 'transition', leaderToken: '1',
  targetGeneration: 'gen-1', generationDigest: digest,
  affectedPlanes: ['http'] as const,
  targets: { http: {
    expectedCurrent: { activationEpoch: '0', payloadDigest: 'old' },
    target: { activationEpoch: '1', payloadDigest: 'new' },
  } },
});

describe('configTest 실행 실패', () => {
  let prefix: string | undefined;
  afterEach(() => {
    if (prefix !== undefined) rmSync(prefix, { recursive: true, force: true });
    prefix = undefined;
  });

  const effects = (configTest?: (generation: string) => Promise<boolean>) => {
    prefix = mkdtempSync(join(tmpdir(), 'bary-configtest-'));
    const manifest = materializeGeneration({
      prefix, generation: 'gen-1', planes: ['http'], files: { 'nginx.conf': 'events {}\n' },
    });
    return {
      fx: new FsEffects({
        prefix, reload: async () => undefined, probeAccepting: async () => undefined,
        ...(configTest === undefined ? {} : { configTest }),
      }),
      digest: manifest.digest,
    };
  };

  it('configTest 가 던지면 게시 전 검사가 실패한다', async () => {
    const { fx, digest } = effects(async () => { throw new Error('바이너리가 없다'); });
    const result = await fx.preflight(op(digest));
    expect(result.ok).toBe(false);
    expect(result.configTestErrored).toBe(true);
    expect(result.configTestPassed).toBeUndefined();
    expect(result.reason).toContain('바이너리가 없다');
  });

  it('엔진의 거부와 실행 오류를 구분한다', async () => {
    const { fx, digest } = effects(async () => false);
    const result = await fx.preflight(op(digest));
    expect(result).toMatchObject({ ok: false, configTestPassed: false });
    expect(result.configTestErrored).toBeUndefined();
  });

  it('configTest 미설정은 여전히 관측하지 않은 상태다', async () => {
    const { fx, digest } = effects();
    const result = await fx.preflight(op(digest));
    expect(result).toEqual({ ok: true });
  });

  it('빈 BARY_CONFIGTEST_CMD 는 성공한 검사로 처리하지 않는다', () => {
    expect(() => bootEffects({
      prefix: '/tmp/bary-configtest', adminSocket: '/tmp/admin.sock',
      streamAdminSocket: '/tmp/stream-admin.sock', env: { BARY_CONFIGTEST_CMD: '' },
    })).toThrow(/BARY_CONFIGTEST_CMD.*비어 있다/);
  });
});

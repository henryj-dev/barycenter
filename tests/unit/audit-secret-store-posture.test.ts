import { mkdtempSync, mkdirSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { fsSecretStorePosture } from '../../src/bin/barycenterd.js';

describe('SecretStore 기동 자세', () => {
  it('FsSecretStore 를 암호화 저장소로 가장하지 않는다', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'bary-secret-posture-')), 'secrets');
    mkdirSync(root, { mode: 0o700 });
    chmodSync(root, 0o700);

    expect(fsSecretStorePosture(root)).toEqual({
      backend: 'filesystem', encrypted: false, root, exists: true, mode: '0700',
    });
  });

  it('아직 없는 저장소도 평문·파일시스템임을 드러낸다', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'bary-secret-posture-')), 'missing');
    expect(fsSecretStorePosture(root)).toEqual({
      backend: 'filesystem', encrypted: false, root, exists: false,
    });
  });
});

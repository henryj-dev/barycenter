/**
 * 드라이버 호환성 키트.
 *
 * 로더만 있고 소비자가 없으면 §9.1 이 경고한 상태다. 이 테스트가 첫 소비자다:
 * `src/` 밖에서 온 파일을 `loadDriver` 로 집어넣고, 그 모듈의 capabilities 가
 * S14 표를 지키는지 본다. 코어를 정적으로 import 하지 않는다.
 *
 * 사내 레포는 `BARY_DRIVER_ENTRY` 로 자기 엔트리를 넘긴다
 * (`node scripts/driver-compat.mjs <entry>`).
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  DRIVER_API_VERSION,
  driverIntegrityOf,
  loadDriver,
  parseDriverPins,
} from '../../src/dp/loader.js';
import {
  DriverContractError,
  NATIVE_DNS_FAILURE_MODES,
  capabilitiesFromDriver,
} from '../../src/engine/native-dns.js';

const here = dirname(fileURLToPath(import.meta.url));
const reference = process.env['BARY_DRIVER_ENTRY']
  ?? join(here, '../../drivers/reference.mjs');

const bytesOf = (path: string): Buffer => readFileSync(path);

const pinsFor = (path: string) =>
  parseDriverPins([{
    name: 'under-test',
    version: '0.0.0',
    integrity: driverIntegrityOf(bytesOf(path)),
    apiVersion: DRIVER_API_VERSION,
    path,
  }]);

describe('참조 드라이버를 로더로 집어넣는다', () => {
  it('코어를 수정하지 않고 로드된다', async () => {
    const loaded = await loadDriver(pinsFor(reference), 'under-test');
    expect(loaded.apiVersion).toBe(DRIVER_API_VERSION);
    const caps = capabilitiesFromDriver(loaded);
    expect(caps.nativeDns.available).toBe(false);
  });

  it('allowlist 에 없는 이름은 참조 파일이어도 열지 않는다', async () => {
    await expect(loadDriver(pinsFor(reference), 'not-this')).rejects.toMatchObject({
      refusal: { kind: 'not_allowlisted' },
    });
  });
});

describe('S14 표를 어기는 드라이버는 거절한다', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'bary-compat-'));
  const sibling = (name: string, source: string): string => {
    const path = join(scratch, name);
    writeFileSync(path, source);
    return path;
  };

  it('선택형 실패 모드를 내면 거절한다', async () => {
    const path = sibling('_fake-choice.mjs', `
      export const apiVersion = ${DRIVER_API_VERSION};
      export const capabilities = {
        nativeDns: {
          available: true,
          failureModes: {
            nxdomain: 'retry',
            servfail: 'keep_last',
            timeout: 'keep_last',
          },
        },
      };
    `);
    const loaded = await loadDriver(pinsFor(path), 'under-test');
    expect(() => capabilitiesFromDriver(loaded)).toThrow(DriverContractError);
    expect(() => capabilitiesFromDriver(loaded)).toThrow(/drop_peer/);
  });

  it('S14 표와 같으면 받는다', async () => {
    const path = sibling('_fake-s14.mjs', `
      export const apiVersion = ${DRIVER_API_VERSION};
      export const capabilities = {
        nativeDns: {
          available: true,
          failureModes: {
            nxdomain: 'drop_peer',
            servfail: 'keep_last',
            timeout: 'keep_last',
          },
        },
      };
    `);
    const loaded = await loadDriver(pinsFor(path), 'under-test');
    expect(capabilitiesFromDriver(loaded)).toEqual({
      nativeDns: { available: true, failureModes: NATIVE_DNS_FAILURE_MODES },
    });
  });

  it('capabilities 가 없으면 거절한다', () => {
    expect(() => capabilitiesFromDriver({ apiVersion: DRIVER_API_VERSION })).toThrow(
      DriverContractError,
    );
  });
});

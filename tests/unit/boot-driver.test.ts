/**
 * 기동 배선 — 핀이 없으면 안 집어넣고, 있으면 기동이 로더를 지난다.
 */
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import { bootDrivers, readDriverBootSource } from '../../src/dp/boot.js';
import { DRIVER_API_VERSION, driverIntegrityOf } from '../../src/dp/loader.js';

const reference = join(dirname(fileURLToPath(import.meta.url)), '../../drivers/reference.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'bary-boot-'));

const pinOf = (over: Record<string, unknown> = {}) => {
  const bytes = readFileSync(reference);
  return {
    name: 'bary.ref',
    version: '0.0.0',
    integrity: driverIntegrityOf(bytes),
    apiVersion: DRIVER_API_VERSION,
    path: reference,
    ...over,
  };
};

describe('기동 배선', () => {
  it('핀이 없으면 드라이버를 집어넣지 않는다', async () => {
    expect(await bootDrivers({})).toEqual({ loaded: false });
    expect(await bootDrivers(readDriverBootSource({}))).toEqual({ loaded: false });
  });

  it('핀이 있으면 참조 드라이버를 기동에서 로드한다', async () => {
    const boot = await bootDrivers({ pinsText: JSON.stringify([pinOf()]) });
    expect(boot).toEqual({
      loaded: true,
      name: 'bary.ref',
      capabilities: { nativeDns: { available: false } },
    });
  });

  it('목록에 틀린 apiVersion 이 있으면 고르지 않은 핀이라도 기동을 멈춘다', async () => {
    const pins = [pinOf(), pinOf({ name: 'stale', apiVersion: DRIVER_API_VERSION + 1 })];
    await expect(bootDrivers({ pinsText: JSON.stringify(pins), name: 'bary.ref' }))
      .rejects.toMatchObject({ refusal: { kind: 'api_version_mismatch', name: 'stale' } });
  });

  it('핀이 둘인데 이름을 안 고르면 기동을 멈춘다', async () => {
    const pins = [pinOf(), pinOf({ name: 'other' })];
    await expect(bootDrivers({ pinsText: JSON.stringify(pins) }))
      .rejects.toThrow(/BARY_DRIVER/);
  });

  it('환경변수에서 핀 파일과 이름을 읽는다', async () => {
    const file = join(scratch, 'pins.json');
    writeFileSync(file, JSON.stringify([pinOf(), pinOf({ name: 'other' })]));
    const src = readDriverBootSource({
      BARY_DRIVER_PINS_FILE: file,
      BARY_DRIVER: 'bary.ref',
    });
    expect(src.name).toBe('bary.ref');
    const boot = await bootDrivers(src);
    expect(boot.loaded).toBe(true);
    if (boot.loaded) expect(boot.name).toBe('bary.ref');
  });
});

/**
 * §9.3 로더 — X5 · X6 · X7
 *
 * 이 테스트가 지키는 것: 설정의 이름을 그대로 import 하지 않는다는 것.
 * allowlist · 바이트 · apiVersion 중 하나라도 틀리면 모듈은 평가되지 않거나,
 * 평가됐더라도 호출자에게 돌아가지 않는다.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  DRIVER_API_VERSION,
  DriverLoadError,
  assertDriverPins,
  driverIntegrityOf,
  loadDriver,
  parseDriverPins,
  type DriverPin,
} from '../../src/dp/loader.js';

const dir = mkdtempSync(join(tmpdir(), 'bary-driver-'));
let seq = 0;

const write = (source: string): { path: string; integrity: string } => {
  const path = join(dir, `d${seq += 1}.mjs`);
  const bytes = Buffer.from(source, 'utf8');
  writeFileSync(path, bytes);
  return { path, integrity: driverIntegrityOf(bytes) };
};

const pin = (over: Partial<DriverPin> & Pick<DriverPin, 'name' | 'path' | 'integrity'>): DriverPin => ({
  version: '1.0.0',
  apiVersion: DRIVER_API_VERSION,
  ...over,
});

const okSource = `export const apiVersion = ${DRIVER_API_VERSION};\nexport const marker = 'ok';\n`;

describe('X5 allowlist', () => {
  it('allowlist 에 없는 이름은 로드하지 않는다', async () => {
    const bomb = write('throw new Error("imported");\n');
    await expect(loadDriver(
      [pin({ name: 'allowed', ...bomb })],
      'evil.pkg',
    )).rejects.toMatchObject({ refusal: { kind: 'not_allowlisted', name: 'evil.pkg' } });
  });

  it('목록에 있는 이름만 연다', async () => {
    const file = write(okSource);
    const loaded = await loadDriver([pin({ name: 'ok.drv', ...file })], 'ok.drv');
    expect(loaded['marker']).toBe('ok');
    expect(loaded.apiVersion).toBe(DRIVER_API_VERSION);
  });
});

describe('X6 integrity', () => {
  it('integrity 가 다르면 import 하지 않는다', async () => {
    const bomb = write('throw new Error("imported");\n');
    const wrong = pin({
      name: 'tampered',
      path: bomb.path,
      integrity: driverIntegrityOf(Buffer.from('not-the-bytes')),
    });
    await expect(loadDriver([wrong], 'tampered')).rejects.toMatchObject({
      refusal: { kind: 'integrity_mismatch', name: 'tampered' },
    });
  });

  it('파일이 없으면 바이트를 증명할 수 없다', async () => {
    const missing = pin({
      name: 'gone',
      path: join(dir, 'no-such.mjs'),
      integrity: driverIntegrityOf(Buffer.from('x')),
    });
    await expect(loadDriver([missing], 'gone')).rejects.toMatchObject({
      refusal: { kind: 'unreadable', name: 'gone' },
    });
  });
});

describe('X7 apiVersion', () => {
  it('핀의 apiVersion 이 틀리면 파일을 열지 않는다', async () => {
    const bomb = write('throw new Error("imported");\n');
    const stale = pin({ name: 'stale', apiVersion: DRIVER_API_VERSION + 1, ...bomb });
    await expect(loadDriver([stale], 'stale')).rejects.toMatchObject({
      refusal: {
        kind: 'api_version_mismatch',
        name: 'stale',
        want: DRIVER_API_VERSION,
        got: DRIVER_API_VERSION + 1,
      },
    });
  });

  it('목록에 틀린 핀이 하나라도 있으면 기동을 멈춘다', () => {
    const file = write(okSource);
    expect(() => assertDriverPins([
      pin({ name: 'ok', ...file }),
      pin({ name: 'bad', apiVersion: 99, ...file }),
    ])).toThrow(DriverLoadError);
    try {
      assertDriverPins([pin({ name: 'bad', apiVersion: 99, ...file })]);
    } catch (e) {
      expect(e).toBeInstanceOf(DriverLoadError);
      expect((e as DriverLoadError).refusal.kind).toBe('api_version_mismatch');
    }
  });

  it('모듈이 다른 apiVersion 을 내면 호출자에게 주지 않는다', async () => {
    const file = write('export const apiVersion = 99;\nexport const marker = "leaked";\n');
    await expect(loadDriver(
      [pin({ name: 'liar', ...file })],
      'liar',
    )).rejects.toMatchObject({
      refusal: { kind: 'api_version_mismatch', name: 'liar', got: 99 },
    });
  });
});

describe('핀 해독', () => {
  it('모르는 필드와 중복 이름과 깨진 해시를 거절한다', () => {
    const file = write(okSource);
    expect(() => parseDriverPins([{
      name: 'a', version: '1', integrity: file.integrity, apiVersion: 1, path: file.path, extra: true,
    }])).toThrow(/모르는 필드/);
    expect(() => parseDriverPins([
      { name: 'a', version: '1', integrity: file.integrity, apiVersion: 1, path: file.path },
      { name: 'a', version: '2', integrity: file.integrity, apiVersion: 1, path: file.path },
    ])).toThrow(/중복/);
    expect(() => parseDriverPins([{
      name: 'a', version: '1', integrity: 'sha256:dead', apiVersion: 1, path: file.path,
    }])).toThrow(/sha512/);
  });

  it('해독된 핀으로 로드된다', async () => {
    const file = write(okSource);
    const pins = parseDriverPins([{
      name: 'parsed', version: '0.1.0', integrity: file.integrity,
      apiVersion: DRIVER_API_VERSION, path: file.path,
    }]);
    const loaded = await loadDriver(pins, 'parsed');
    expect(loaded['marker']).toBe('ok');
  });
});

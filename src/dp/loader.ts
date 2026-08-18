/**
 * 드라이버 로더 — DESIGN.md §9.3 · TESTS X5–X7
 *
 * 설정의 패키지명을 그대로 `import()` 하면 공급망이 설정 파일이다. 동적 import 는
 * 코어 재컴파일을 없앨 뿐, 프로비저닝을 없애지 않는다. 이미지에 pin 된 allowlist 만
 * 통과하고, 바이트와 apiVersion 을 확인한 뒤에만 로드한다.
 *
 *   X5  이름이 목록에 없다          → 거부. 파일을 열지 않는다
 *   X6  sha512 가 핀과 다르다       → 거부. import 하지 않는다
 *   X7  apiVersion 이 코어와 다르다 → 기동 실패. 조용히 건너뛰지 않는다
 *
 * 구현하지 않은 드라이버 인터페이스를 여기서 조립하지 않는다. 이 모듈이 아는 것은
 * **이름이 허용됐는가, 바이트가 같은가, 계약 버전이 맞는가** 셋이다.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** 코어가 이해하는 드라이버 ABI. 호환이 깨지면 올린다. */
export const DRIVER_API_VERSION = 1 as const;

const INTEGRITY = /^sha512:[0-9a-f]{128}$/;

export type DriverPin = {
  name: string;
  version: string;
  /** `sha512:` + 128 hex. 엔트리 파일 바이트. */
  integrity: string;
  apiVersion: number;
  /** 이미지에 프로비저닝된 엔트리 파일. */
  path: string;
};

export type DriverModule = {
  readonly apiVersion: typeof DRIVER_API_VERSION;
  readonly [key: string]: unknown;
};

export type DriverLoadRefusal =
  | { readonly kind: 'not_allowlisted'; readonly name: string }
  | { readonly kind: 'integrity_mismatch'; readonly name: string }
  | { readonly kind: 'api_version_mismatch'; readonly name: string; readonly want: number; readonly got: number }
  | { readonly kind: 'unreadable'; readonly name: string; readonly path: string };

export class DriverLoadError extends Error {
  constructor(readonly refusal: DriverLoadRefusal) {
    super(messageOf(refusal));
    this.name = 'DriverLoadError';
  }
}

function messageOf(r: DriverLoadRefusal): string {
  switch (r.kind) {
    case 'not_allowlisted':
      return `드라이버 '${r.name}' 은 allowlist 에 없다`;
    case 'integrity_mismatch':
      return `드라이버 '${r.name}' 의 integrity 가 핀과 다르다`;
    case 'api_version_mismatch':
      return `드라이버 '${r.name}' 의 apiVersion 이 ${r.want} 이어야 하는데 ${r.got} 이다`;
    case 'unreadable':
      return `드라이버 '${r.name}' 을 읽을 수 없다 (${r.path})`;
  }
}

export function parseDriverPins(input: unknown): DriverPin[] {
  if (!Array.isArray(input)) {
    throw new Error('드라이버 핀은 배열이어야 한다');
  }
  const seen = new Set<string>();
  return input.map((raw, i) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`핀 [${i}] 는 객체여야 한다`);
    }
    const obj = raw as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (!['name', 'version', 'integrity', 'apiVersion', 'path'].includes(k)) {
        throw new Error(`핀 [${i}] 에 모르는 필드 '${k}'`);
      }
    }
    const name = str(obj['name'], i, 'name');
    const version = str(obj['version'], i, 'version');
    const integrity = str(obj['integrity'], i, 'integrity');
    const path = str(obj['path'], i, 'path');
    const apiVersion = obj['apiVersion'];
    if (typeof apiVersion !== 'number' || !Number.isInteger(apiVersion)) {
      throw new Error(`핀 [${i}].apiVersion 은 정수여야 한다`);
    }
    if (!INTEGRITY.test(integrity)) {
      throw new Error(`핀 [${i}].integrity 는 sha512:<128 hex> 여야 한다`);
    }
    if (seen.has(name)) throw new Error(`핀 이름 '${name}' 이 중복이다`);
    seen.add(name);
    return { name, version, integrity, apiVersion, path };
  });
}

function str(v: unknown, i: number, field: string): string {
  if (typeof v !== 'string' || v === '') {
    throw new Error(`핀 [${i}].${field} 는 비어 있지 않은 문자열이어야 한다`);
  }
  return v;
}

function digestOf(bytes: Uint8Array): string {
  return `sha512:${createHash('sha512').update(bytes).digest('hex')}`;
}

function sameIntegrity(want: string, got: string): boolean {
  const a = Buffer.from(want, 'utf8');
  const b = Buffer.from(got, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function pinOf(pins: readonly DriverPin[], name: string): DriverPin {
  for (const pin of pins) {
    if (pin.name === name) return pin;
  }
  throw new DriverLoadError({ kind: 'not_allowlisted', name });
}

/**
 * 핀의 apiVersion 이 코어와 맞는지 **파일을 열기 전에** 본다.
 *
 * 목록에 틀린 버전이 하나라도 있으면 기동을 멈춘다. 쓰지 않을 핀이라며 건너뛰면
 * 그게 곧 조용한 degrade 다 (X7).
 */
export function assertDriverPins(pins: readonly DriverPin[]): void {
  for (const pin of pins) {
    if (pin.apiVersion !== DRIVER_API_VERSION) {
      throw new DriverLoadError({
        kind: 'api_version_mismatch',
        name: pin.name,
        want: DRIVER_API_VERSION,
        got: pin.apiVersion,
      });
    }
  }
}

export async function loadDriver(
  pins: readonly DriverPin[],
  name: string,
): Promise<DriverModule> {
  const pin = pinOf(pins, name);
  if (pin.apiVersion !== DRIVER_API_VERSION) {
    throw new DriverLoadError({
      kind: 'api_version_mismatch',
      name: pin.name,
      want: DRIVER_API_VERSION,
      got: pin.apiVersion,
    });
  }

  let bytes: Buffer;
  try {
    bytes = readFileSync(pin.path);
  } catch {
    throw new DriverLoadError({ kind: 'unreadable', name: pin.name, path: pin.path });
  }
  if (!sameIntegrity(pin.integrity, digestOf(bytes))) {
    throw new DriverLoadError({ kind: 'integrity_mismatch', name: pin.name });
  }

  const loaded: unknown = await import(pathToFileURL(resolve(pin.path)).href);
  if (loaded === null || typeof loaded !== 'object') {
    throw new DriverLoadError({
      kind: 'api_version_mismatch',
      name: pin.name,
      want: DRIVER_API_VERSION,
      got: -1,
    });
  }
  const apiVersion = (loaded as { apiVersion?: unknown }).apiVersion;
  if (apiVersion !== DRIVER_API_VERSION) {
    throw new DriverLoadError({
      kind: 'api_version_mismatch',
      name: pin.name,
      want: DRIVER_API_VERSION,
      got: typeof apiVersion === 'number' ? apiVersion : -1,
    });
  }
  return loaded as DriverModule;
}

/** 테스트와 핀 작성기가 같은 다이제스트를 쓰게. */
export function driverIntegrityOf(bytes: Uint8Array): string {
  return digestOf(bytes);
}

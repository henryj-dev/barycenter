/**
 * 드라이버 기동 — DESIGN.md §9.3
 *
 * 핀이 없으면 아무것도 안 집어넣는다. 그게 기본이고, 설정 평면은 계속
 * `LocalDataplaneDriver` 다. 핀이 있으면 목록 전체를 검사한 뒤(X7) 고른 이름만
 * 로드한다. 로드하는 것은 capability 를 드러내는 패키지이지, apply 경로를
 * 갈아 끼우는 것이 아니다.
 *
 * 정책은 여기 있다. `barycenterd` 는 환경변수를 읽어 여기로 넘길 뿐이다.
 */
import { readFileSync } from 'node:fs';

import { capabilitiesFromDriver, type DataplaneCapabilities } from '../engine/native-dns.js';
import { assertDriverPins, loadDriver, parseDriverPins } from './loader.js';

export type DriverBoot =
  | { readonly loaded: false }
  | {
      readonly loaded: true;
      readonly name: string;
      readonly capabilities: DataplaneCapabilities;
    };

export type DriverBootSource = {
  /** 핀 JSON 본문. `BARY_DRIVER_PINS` 또는 파일 내용. */
  readonly pinsText?: string;
  /** 목록에서 고를 이름. `BARY_DRIVER`. 핀이 하나면 생략할 수 있다. */
  readonly name?: string;
};

export function readDriverBootSource(env: NodeJS.ProcessEnv): DriverBootSource {
  const file = env['BARY_DRIVER_PINS_FILE'];
  const pinsText = file !== undefined && file !== ''
    ? readFileSync(file, 'utf8')
    : env['BARY_DRIVER_PINS'];
  const name = env['BARY_DRIVER'];
  return {
    ...(pinsText === undefined || pinsText === '' ? {} : { pinsText }),
    ...(name === undefined || name === '' ? {} : { name }),
  };
}

export async function bootDrivers(source: DriverBootSource): Promise<DriverBoot> {
  if (source.pinsText === undefined) return { loaded: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(source.pinsText);
  } catch (e) {
    throw new Error(`드라이버 핀 JSON 이 깨졌다: ${e instanceof Error ? e.message : String(e)}`);
  }
  const pins = parseDriverPins(parsed);
  if (pins.length === 0) throw new Error('드라이버 핀 목록이 비어 있다');
  assertDriverPins(pins);

  const name = source.name ?? (pins.length === 1 ? pins[0]!.name : undefined);
  if (name === undefined) {
    throw new Error('핀이 둘 이상이면 BARY_DRIVER 로 이름을 고른다');
  }
  const loaded = await loadDriver(pins, name);
  return { loaded: true, name, capabilities: capabilitiesFromDriver(loaded) };
}

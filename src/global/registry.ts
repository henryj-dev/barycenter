/**
 * 전역 모드의 지역 목록 (docs/design-global-mode.md §2.1).
 *
 * **정적 파일이다.** 전역에 PG 를 두면 전역이 또 하나의 정본이 되고, 그 정본의
 * 백업·복구·리더 선출이 따라온다. 지역 목록은 자주 안 바뀌고, 바뀌면 배포 행위다.
 *
 * 해독 규칙은 모델 경계와 같다 — *모르는 키는 거부한다 · 강제 변환하지 않는다.*
 * 권한(토큰)을 가리키는 파일이라 더 엄해야 한다.
 */
import { readFileSync } from 'node:fs';

export type Region = {
  /** 키. URL·화면·로그에 그대로 쓰인다. */
  name: string;
  /** 지역 관리 API 의 기준 주소 (`https://…`, 끝 `/` 없음). */
  api: string;
  /** 쓰기를 넘길 지역 GUI 주소. */
  gui: string;
  /** 지역 API 서버 인증서를 검증할 CA (PEM). */
  ca: string;
  /** 그 지역 auditor 토큰의 평문. */
  token: string;
};

export const REGION_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

const KEYS = ['name', 'api', 'gui', 'ca', 'token'] as const;

/** 파일을 읽는 자리를 갈아 끼울 수 있게 둔다 — 테스트가 디스크 없이 해독을 잰다. */
export type ReadFile = (path: string) => string;

/**
 * 레지스트리 JSON 을 해독하고, `ca`·`token` 이 가리키는 파일을 읽는다.
 *
 * **실패는 기동 거부다.** 일부 지역만 빠진 채로 뜨면 화면이 「지역이 하나 없다」를
 * 「그 지역이 없다」로 보이게 한다 — 설정이 틀렸다는 사실이 사라진다.
 */
export function parseRegistry(input: unknown, read: ReadFile = (p) => readFileSync(p, 'utf8')): Region[] {
  if (!Array.isArray(input)) throw new Error('지역 목록은 배열이어야 한다');
  if (input.length === 0) throw new Error('지역 목록이 비어 있다 — 전역 모드가 보여 줄 것이 없다');
  const seen = new Set<string>();
  return input.map((raw, i): Region => {
    const at = `지역[${i}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`${at} 는 객체여야 한다`);
    }
    const o = raw as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (!(KEYS as readonly string[]).includes(k)) throw new Error(`${at} 에 모르는 키: ${k}`);
    }
    const str = (k: (typeof KEYS)[number]): string => {
      const v = o[k];
      if (typeof v !== 'string' || v.trim() === '') throw new Error(`${at}.${k} 는 비어 있지 않은 문자열이어야 한다`);
      return v.trim();
    };
    const name = str('name');
    if (!REGION_NAME.test(name)) {
      throw new Error(`${at}.name '${name}' 이 모양에 안 맞는다 (${REGION_NAME.source})`);
    }
    if (seen.has(name)) throw new Error(`${at}.name '${name}' 이 겹친다`);
    seen.add(name);
    const api = httpsUrl(str('api'), `${at}.api`);
    const gui = httpsUrl(str('gui'), `${at}.gui`);
    const ca = read(str('ca'));
    if (!ca.includes('-----BEGIN CERTIFICATE-----')) throw new Error(`${at}.ca 가 PEM 인증서가 아니다`);
    const token = read(str('token')).trim();
    if (token === '' || /\s/.test(token)) throw new Error(`${at}.token 파일이 비었거나 공백이 섞였다`);
    return { name, api, gui, ca, token };
  });
}

/**
 * **https 만 받는다.** 지역 API 로 토큰이 실려 가고 전체 설정이 돌아온다.
 * 평문을 허용하는 손잡이를 안 만든다 — 원격 DP 드라이버와 같은 판단이다.
 */
function httpsUrl(v: string, at: string): string {
  let u: URL;
  try {
    u = new URL(v);
  } catch {
    throw new Error(`${at} 가 URL 이 아니다: ${v}`);
  }
  if (u.protocol !== 'https:') throw new Error(`${at} 는 https 여야 한다: ${v}`);
  if (u.search !== '' || u.hash !== '') throw new Error(`${at} 에 쿼리·조각을 붙이지 않는다: ${v}`);
  return v.replace(/\/+$/, '');
}

export function loadRegistry(path: string): Region[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`지역 목록(${path})을 못 읽었다: ${e instanceof Error ? e.message : String(e)}`);
  }
  return parseRegistry(parsed);
}

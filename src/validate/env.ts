/**
 * 환경변수 해독기 — 검수 2026-08-24 G3
 *
 * ── 환경변수도 런타임 입력이다
 *
 * 이 저장소는 같은 판단을 이미 두 번 내렸다:
 *
 *   `parseTokenSpecs`  *"캐스팅하지 않는다. `role` 오타 하나가 전권 토큰이 되던
 *                      자리다"* (검수 S-03)
 *   `decodeModel`      *"타입은 런타임 입력을 막지 못한다"*
 *
 * 그런데 데몬의 숫자 설정 열다섯 자리는 전부 `Number(env(...))` 였다. `Number('abc')`
 * 는 던지지 않는다 — **`NaN` 이다.** 그리고 `NaN` 은 조용히 두 가지로 갈린다:
 *
 *   setInterval(f, NaN)          Node 가 `1` 로 읽는다 → 프로버가 **초당 천 번** 돈다
 *   left <= NaN * 86_400_000     항상 거짓 → **인증서가 영영 갱신 안 된다**
 *
 * 어느 쪽도 실패로 안 보인다. 로그에 `NaN` 이 찍히는 것 말고는 신호가 없고, 그 로그를
 * 보는 사람은 이미 뭔가 이상하다고 생각한 뒤다.
 *
 * ── 범위는 정책이 아니라 오타를 잡는다
 *
 * `min`/`max` 가 하는 일은 "이 값이 옳은가" 가 아니라 **"이 값이 이 변수의 것인가"** 다.
 * 초로 쓸 자리에 밀리초를 넣거나 그 반대인 것이 이 부류의 실수이고, 자릿수가 셋 어긋난
 * 값은 기동에서 걸리는 편이 낫다. 그래서 상한은 넉넉하게 잡는다 — 운영자가 고를 수 있는
 * 폭을 좁히는 것이 목적이 아니다.
 */

export type IntRange = { min: number; max: number };

/**
 * 정수 환경변수. 없거나 빈 문자열이면 `fallback`.
 *
 * **빈 문자열을 기본값으로 접는 것이 중요하다.** `Number('')` 은 `0` 이라, 그것을 안
 * 접으면 `FOO=` 로 지운 변수가 **0** 이 되어 `setInterval(f, 0)` 이 된다. 컨테이너
 * 오케스트레이터가 빈 값을 흔히 만든다.
 */
export function envInt(
  name: string,
  fallback: number,
  range: IntRange,
  source: NodeJS.ProcessEnv = process.env,
): number {
  const raw = source[name];
  if (raw === undefined || raw === '') return check(name, fallback, range);

  // `Number` 대신 정규식으로 먼저 거른다. `Number` 는 `'0x10'`·`'1e3'`·`' 5 '` 를
  // 전부 받는데, 그것들은 사람이 그 자리에 적으려던 것이 아니다.
  if (!/^-?[0-9]+$/.test(raw)) {
    throw new Error(
      `환경변수 ${name} 이 정수가 아니다: ${JSON.stringify(raw)} `
      + `(${range.min}~${range.max} 사이의 10진 정수를 적는다)`,
    );
  }
  return check(name, Number(raw), range);
}

/**
 * 있으면 정수, 없거나 비면 `undefined`.
 *
 * 보존 기간이 이 모양이다 — **빈 값은 「무한 보존」이라는 뜻**이라 기본값으로 접으면
 * 안 된다(`barycenterd` 의 주석: *"업그레이드가 곧 데이터 소실이다"*). 그래도 적힌
 * 값이 숫자가 아닌 것은 여전히 실수다.
 */
export function envIntOpt(
  name: string,
  range: IntRange,
  source: NodeJS.ProcessEnv = process.env,
): number | undefined {
  const raw = source[name];
  if (raw === undefined || raw === '') return undefined;
  return envInt(name, 0, range, source);
}

function check(name: string, v: number, range: IntRange): number {
  if (v < range.min || v > range.max) {
    throw new Error(
      `환경변수 ${name} 이 범위 밖이다: ${v} (${range.min}~${range.max})`,
    );
  }
  return v;
}

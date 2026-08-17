/**
 * 엔진 capability 조회 (DESIGN.md §7.6)
 *
 * `capabilities.ts` 는 `nginx -V` **출력을 해석**하는 순수 함수다. 그런데 **아무도 그걸
 * 부르지 않았다** — 컨트롤 플레인은 `streamRealip: false` 를 상수로 가정했고, 그래서
 * PROXY 신뢰 경계를 넣은 뒤로 **stream PROXY 수신이 엔진과 무관하게 항상 막혔다.**
 * capability 로 좁힌다고 해 놓고 capability 를 안 물어본 셈이다.
 *
 * **못 물어보면 보수적으로 답한다.** 모르는 것을 할 수 있다고 하지 않는다 — 다만 그
 * 사실을 조용히 넘기지 않고 이유와 함께 돌려준다.
 */
import { spawnSync } from 'node:child_process';

import { parseEngineCapabilities, type EngineCapabilities } from './capabilities.js';

export type EngineProbe =
  | { ok: true; capabilities: EngineCapabilities; via: string }
  | { ok: false; reason: string };

/**
 * `<bin> -V` 를 돌려 읽는다.
 *
 * nginx 는 `-V` 를 **stderr** 로 낸다. stdout 만 읽으면 언제나 빈 문자열을 파싱하게 되고,
 * 그러면 "모든 모듈이 없다" 는 그럴듯한 거짓말이 나온다.
 */
export function probeEngine(bin: string, timeoutMs = 5000): EngineProbe {
  // **`execFileSync` 가 아니라 `spawnSync` 다.** 앞엣것은 stdout 만 돌려주는데 nginx 는
  // `-V` 를 stderr 로 낸다. 처음에 그렇게 썼고 — 함정을 주석에 적어 놓고도 성공 경로에서
  // 그대로 빠졌다 — 종료 코드가 0 이면 언제나 빈 문자열을 파싱했다. 테스트가 잡았다.
  const r = spawnSync(bin, ['-V'], { encoding: 'utf8', timeout: timeoutMs });
  if (r.error !== undefined) {
    return { ok: false, reason: `${bin} -V 를 못 읽었다: ${r.error.message}` };
  }
  // 종료 코드는 안 본다. 구버전은 `-V` 뒤에 0 이 아닌 코드를 내기도 하고, 그때도
  // 출력은 멀쩡하다. **판정은 출력이 한다.**
  const text = `${r.stdout ?? ''}${r.stderr ?? ''}`;
  if (text === '') {
    return { ok: false, reason: `${bin} -V 가 아무것도 안 냈다` };
  }
  return finish(text, bin);
}

function finish(text: string, bin: string): EngineProbe {
  const capabilities = parseEngineCapabilities(text);
  if (capabilities.version === '') {
    return { ok: false, reason: `${bin} -V 출력에서 버전을 못 읽었다` };
  }
  return { ok: true, capabilities, via: bin };
}

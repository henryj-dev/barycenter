/**
 * 숫자 환경변수는 강제 변환하지 않는다 — 검수 2026-08-24 G3
 *
 * ── 열다섯 자리가 전부 이 모양이었다
 *
 *   intervalMs: Number(env('BARY_PROBE_INTERVAL_MS', '2000')),
 *
 * `Number('abc')` 는 던지지 않는다. **`NaN` 이다.** 그리고 `NaN` 이 `setInterval` 로 가면
 * Node 는 그것을 `1` 로 읽는다 — 프로버가 **초당 천 번** 돈다. `renewBeforeDays` 가
 * `NaN` 이면 `left <= NaN * 86_400_000` 이 항상 거짓이라 **인증서가 영영 갱신 안 된다.**
 * 둘 다 조용하다. 로그에도 `NaN` 이 찍히는 것 말고는 아무 신호가 없다.
 *
 * 이 저장소는 같은 판단을 이미 두 번 내렸다:
 *
 *   `parseTokenSpecs`  — *"캐스팅하지 않는다. `role` 오타 하나가 전권 토큰이 되던
 *                        자리다"* (검수 S-03)
 *   `decodeModel`      — *"타입은 런타임 입력을 막지 못한다"*
 *
 * 환경변수도 런타임 입력이다. 다를 이유가 없다.
 *
 * ── 그리고 사본이 갈릴 자리가 있었다
 *
 * `BARY_PROBE_INTERVAL_MS` 는 **두 번** 읽혔다 — 프로버에 넘길 때 한 번, 그 사실을
 * 로그에 찍을 때 또 한 번. `BARY_ACME_INTERVAL_MS`·`BARY_ACME_RENEW_DAYS`·
 * `BARY_ACME_ORPHAN_INTERVAL_MS` 도 같다. 지금은 기본값이 같아서 안 갈리지만,
 * 한쪽만 고치는 날 **로그가 거짓말을 하기 시작한다.**
 *
 * ── 이 파일이 재는 것은 함수가 아니라 배선이다
 *
 * `envInt` 를 직접 부르면 `envInt` 만 재게 된다. 데몬이 **그것을 지나는지**를 재려면
 * `main()` 을 불러야 하고, 그래서 순서가 중요하다: 숫자 검사가 **DB 접속보다 먼저**
 * 와야 이 테스트가 도커 없이 돈다. 그건 우연이 아니라 설계다 — 설정이 틀린 채로
 * PG 에 붙어 마이그레이션까지 돌리고 나서 죽는 것은 아무에게도 이롭지 않다.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { main } from '../../src/bin/barycenterd.js';

let prefix = '';
let saved: NodeJS.ProcessEnv;

beforeEach(() => {
  saved = { ...process.env };
  prefix = mkdtempSync(join(tmpdir(), 'bary-env-'));
  // 숫자 검사보다 앞에 있는 것만 채운다. **`BARY_DSN` 은 일부러 안 준다** —
  // 숫자를 먼저 보는지가 이 파일의 물음이라, DSN 이 없는 것이 표식이 된다.
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('BARY_')) delete process.env[k];
  }
  process.env['BARY_PREFIX'] = prefix;
});

afterEach(() => {
  process.env = saved;
  if (prefix !== '') rmSync(prefix, { recursive: true, force: true });
});

/** `main()` 이 던진 메시지. 안 던지면 실패한다. */
async function failure(): Promise<string> {
  const e = await main().then(() => undefined, (x: unknown) => x);
  if (e === undefined) throw new Error('main() 이 안 던졌다');
  return e instanceof Error ? e.message : String(e);
}

describe('숫자 환경변수', () => {
  it('숫자 환경변수는 강제 변환하지 않는다 — `NaN` 이 아니라 기동 실패다', async () => {
    process.env['BARY_PROBE_INTERVAL_MS'] = 'abc';
    const message = await failure();
    // **DSN 보다 먼저 걸린다.** 그러지 않으면 이 실패는 PG 가 있는 자리에서만 난다.
    expect(message).toContain('BARY_PROBE_INTERVAL_MS');
    expect(message).not.toContain('BARY_DSN');
  });

  it('정수가 아니면 막는다 — `setInterval` 이 소수를 반올림해 버린다', async () => {
    process.env['BARY_PROBE_INTERVAL_MS'] = '1.5';
    expect(await failure()).toContain('BARY_PROBE_INTERVAL_MS');
  });

  it('범위 밖은 막는다 — 단위를 잘못 쓴 값이 여기서 걸린다', async () => {
    // 초로 쓸 자리에 밀리초를 넣거나 그 반대인 것이 이 부류의 흔한 실수다.
    process.env['BARY_ACME_RENEW_DAYS'] = '0';
    expect(await failure()).toContain('BARY_ACME_RENEW_DAYS');
  });

  it('음수도 막는다', async () => {
    process.env['BARY_PROBE_FAIL_THRESHOLD'] = '-2';
    expect(await failure()).toContain('BARY_PROBE_FAIL_THRESHOLD');
  });

  it('빈 문자열은 기본값이다 — `Number("")` 이 `0` 이라는 함정을 안 만든다', async () => {
    process.env['BARY_PROBE_INTERVAL_MS'] = '';
    // 여기서 막히면 안 된다. 다음 관문(DSN)까지 가야 한다.
    expect(await failure()).toContain('BARY_DSN');
  });

  /** **되는 것을 못 쓰게 만들지 않는다.** */
  it('멀쩡한 값들은 그대로 지나간다 — 다음 관문은 DSN 이다', async () => {
    process.env['BARY_PROBE_INTERVAL_MS'] = '500';
    process.env['BARY_ACME_RENEW_DAYS'] = '14';
    process.env['BARY_ELECTION_INTERVAL_MS'] = '3000';
    process.env['BARY_HEALTH_EVENT_RETENTION_DAYS'] = '7';
    expect(await failure()).toContain('BARY_DSN');
  });
});

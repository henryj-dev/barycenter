/**
 * 트래픽 오류가 apply 를 안 죽인다 — 검수 2026-08-24 D5
 *
 * ── 신호는 옳고 범위가 틀렸다
 *
 * `provesActivation` 은 `errorLogGrowth > 0` 이면 활성화가 아니라고 판정한다. 워터마크는
 * HUP **직전**에 찍고, 증가분은 `error.log` 의 **줄 수 차이**다 — 어떤 줄인지는 안 본다.
 *
 * S7 이 이 신호를 넣은 이유는 옳다: *"세대 리터럴만 보면 포트가 점유된 실패를 4027ms
 * 동안 못 잡았는데, error log 워터마크를 음성 신호로 넣자 71ms 에 잡혔다."*
 *
 * **문제는 nginx 가 `[error]` 로 적는 것이 그것만이 아니라는 것이다.**
 *
 *   upstream timed out (110: Connection timed out) while reading response header
 *   no live upstreams while connecting to upstream
 *   SSL_do_handshake() failed
 *   connect() failed (111: Connection refused) while connecting to upstream
 *
 * 전부 `[error]` 다. 전부 **클라이언트와 백엔드가 만드는 것**이지 우리 설정이 만드는
 * 것이 아니다. 그중 한 줄이 HUP 창에 들어오면 멀쩡한 reload 가 「관측되지 않음」이 되고,
 * `RELOAD_ATTEMPT_LIMIT` 를 소진해 **apply 가 실패한다.**
 *
 * **바쁜 배포일수록 자주 걸린다** — 그리고 바쁜 배포일수록 apply 가 실패하면 안 된다.
 *
 * ── 겨눈 것은 「설정이 만든 실패」다
 *
 * 설정·기동 실패는 언제나 `[emerg]` · `[alert]` · `[crit]` 이다. S7 이 잡은 포트 점유도
 * `[emerg]` 다. 그 셋만 세면 **검출력은 그대로이고 오탐이 사라진다.**
 *
 * ── 왜 e2e 가 아니라 여기인가
 *
 * 투두는 `tests/e2e/` 를 적었다. 그런데 e2e 로는 **원하는 순간에 원하는 줄을 만들 수가
 * 없다** — 백엔드를 죽여서 `[error]` 를 유도해도 그것이 HUP 창 안에 들어갈지는 타이밍이
 * 정한다. 그러면 재현물이 「가끔 빨간」 것이 되고, 이 저장소가 그 부류로 이미 여러 번
 * 데였다.
 *
 * 여기서는 **실물 파일**에 실물 nginx 가 적는 것과 **같은 줄**을 적는다. 재는 것은
 * `FsEffects` 가 그 줄을 어떻게 세는가이고, 그건 파일 하나면 충분하다.
 */
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FsEffects } from '../../src/dp/effects-fs.js';
import { provesActivation } from '../../src/dp/operation.js';

let prefix = '';
let logPath = '';

/** nginx 가 실제로 적는 줄들. 앞의 넷은 **트래픽**이 만든다. */
const NOISE = [
  '2026/08/24 04:00:01 [error] 7#7: *1 upstream timed out (110: Connection timed out)'
  + ' while reading response header from upstream, client: 10.0.0.9',
  '2026/08/24 04:00:01 [error] 7#7: *2 no live upstreams while connecting to upstream',
  '2026/08/24 04:00:02 [error] 7#7: *3 SSL_do_handshake() failed (SSL: error:0A00006C)',
  '2026/08/24 04:00:02 [warn] 7#7: *4 an upstream response is buffered to a temporary file',
  '2026/08/24 04:00:03 [info] 7#7: *5 client closed connection',
];

/** 설정·기동이 만드는 줄. **이것이 겨눈 것이다.** */
const FATAL = [
  '2026/08/24 04:00:04 [emerg] 1#1: bind() to 0.0.0.0:80 failed (98: Address already in use)',
  '2026/08/24 04:00:04 [alert] 1#1: worker process 12 exited with fatal code 2',
  '2026/08/24 04:00:05 [crit] 1#1: open() "/etc/barycenter/x" failed (13: Permission denied)',
];

beforeEach(() => {
  prefix = mkdtempSync(join(tmpdir(), 'bary-elog-'));
  mkdirSync(join(prefix, 'logs'), { recursive: true });
  logPath = join(prefix, 'logs', 'error.log');
  // 이미 쌓여 있던 것 — 워터마크가 이 아래에서 시작한다.
  writeFileSync(logPath, `${NOISE.slice(0, 2).join('\n')}\n`, 'utf8');
});

afterEach(() => {
  if (prefix !== '') rmSync(prefix, { recursive: true, force: true });
});

/**
 * HUP 창을 흉내 낸다: 워터마크를 찍고 · 그 사이에 줄이 늘고 · 증거를 관측한다.
 *
 * `reload` 안에서 적는 것이 요점이다 — 그 자리가 실제로 「신호를 보낸 뒤 활성화를
 * 관측하기 전」이고, D5 가 사는 창이 그것이다.
 */
async function evidenceWith(lines: readonly string[]): Promise<{
  growth: number | undefined; proves: boolean;
}> {
  const effects = new FsEffects({
    prefix,
    reload: async () => {
      if (lines.length > 0) appendFileSync(logPath, `${lines.join('\n')}\n`, 'utf8');
    },
    probeAccepting: async () => 'g2',
  });
  await effects.signalReload({ assertValid: () => ({}) } as never);
  const evidence = await effects.observeActivation();
  return {
    growth: evidence?.errorLogGrowth,
    proves: evidence !== undefined && provesActivation(evidence, 'g2'),
  };
}

describe('HUP 창의 error log', () => {
  it('트래픽 오류가 apply 를 안 죽인다', async () => {
    const r = await evidenceWith(NOISE);
    expect(r.growth, '트래픽이 만든 줄은 음성 신호가 아니다').toBe(0);
    expect(r.proves, '활성화가 증명돼야 한다').toBe(true);
  });

  it('아무 줄도 안 늘면 당연히 초록이다 — 대조군', async () => {
    const r = await evidenceWith([]);
    expect(r.growth).toBe(0);
    expect(r.proves).toBe(true);
  });
});

describe('겨눈 것은 그대로 잡는다', () => {
  /**
   * **이것이 이 신호의 존재 이유다.** S7 이 실측한 포트 점유가 `[emerg]` 다 —
   * 좁히면서 그걸 놓치면 좁힌 것이 아니라 없앤 것이다.
   */
  it.each(FATAL)('설정·기동 실패는 여전히 잡는다: %s', async (line) => {
    const r = await evidenceWith([line]);
    expect(r.growth).toBeGreaterThan(0);
    expect(r.proves, '활성화가 증명되면 안 된다').toBe(false);
  });

  it('소음에 섞여 있어도 잡는다 — 바쁜 배포가 정확히 그 모양이다', async () => {
    const r = await evidenceWith([...NOISE, FATAL[0]!, ...NOISE]);
    expect(r.growth).toBe(1);
    expect(r.proves).toBe(false);
  });
});

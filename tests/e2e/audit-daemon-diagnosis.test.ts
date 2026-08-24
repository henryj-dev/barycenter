/**
 * 「데몬이 안 떴다」가 이유를 말한다 — 검수 2026-08-24 N4 후속
 *
 * ── 왜 이 테스트가 있나
 *
 * N4 를 진단할 때 게이트가 낸 것은 이 한 줄이었다:
 *
 *   Error: 데몬이 안 떴다:
 *
 * 콜론 뒤가 **비어 있었다.** 기동 스크립트가 `apk add` 를 `>/dev/null 2>&1` 로 지우고
 * 나머지는 성공 시 조용하므로, 첫 명령에서 죽으면 `docker logs` 가 정직하게 아무것도
 * 안 준다. 원인은 컨테이너를 손으로 다시 띄워 `set -x` 를 걸고서야 나왔다.
 *
 * **진단이 비어 있을 수 있다는 것 자체가 결함이다.** 로그가 없어도 컨테이너의 상태와
 * 종료 코드는 남아 있고, 그 둘이 서로 다른 이야기를 한다.
 *
 * ── 이 파일이 재는 것
 *
 * 일부러 못 뜨는 컨테이너를 만들고 `waitForDaemon` 이 던지는 메시지를 읽는다.
 * **재는 것은 메시지의 내용**이다 — 진단은 사람이 읽는 것이므로, 사람이 다음 발을
 * 디딜 수 있는 정보가 들어 있는지가 계약이다.
 *
 *   npm run test:e2e     (도커 필요)
 */
import { execFileSync } from 'node:child_process';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { waitForDaemon } from './daemon-up.js';

const NAME = 'bary-diag-probe';

function dockerAvailable(): boolean {
  try { execFileSync('docker', ['version'], { stdio: 'ignore' }); return true; } catch { return false; }
}

const quiet = (...args: string[]): void => {
  try { execFileSync('docker', args, { stdio: 'ignore' }); } catch { /* 없으면 그만 */ }
};

beforeAll(() => {
  if (!dockerAvailable()) throw new Error('도커가 없다 — 이 스위트는 실물로 잰다');
  execFileSync('docker', ['pull', '-q', 'docker.io/library/alpine:3.20'], { stdio: 'ignore' });
}, 180_000);

afterEach(() => {
  quiet('rm', '-f', NAME);
});

/** `sh -c <script>` 로 컨테이너를 띄운다. 뜨든 죽든 그대로 둔다. */
function start(script: string): void {
  quiet('rm', '-f', NAME);
  execFileSync('docker', [
    'run', '-d', '--name', NAME, '--entrypoint', '/bin/sh',
    'docker.io/library/alpine:3.20', '-c', script,
  ], { stdio: 'ignore' });
}

/** 절대 안 뜨는 프로브. 이 파일은 「실패했을 때 무엇을 말하는가」만 잰다. */
const never = async (): Promise<boolean> => false;

const failureOf = async (budgetMs = 1_000): Promise<string> => {
  const e = await waitForDaemon({ container: NAME, probe: never, budgetMs })
    .then(() => undefined, (x: unknown) => x as Error);
  if (e === undefined) throw new Error('waitForDaemon 이 안 던졌다');
  return e.message;
};

describe('안 뜬 데몬의 진단', () => {
  /**
   * **N4 를 진단할 때 막힌 그 자리다.** 출력을 전부 지우고 첫 명령에서 죽는다 —
   * `set -e` 가 있는 기동 스크립트가 정확히 이렇게 죽었다.
   */
  it('로그가 비어도 진단이 비지 않는다', async () => {
    start('set -e; false >/dev/null 2>&1; echo unreachable');
    // 죽을 시간을 준다 — 상태가 `exited` 여야 그 정보가 진단에 실린다.
    await new Promise((r) => setTimeout(r, 1_500));

    const msg = await failureOf();
    expect(msg, msg).toContain('컨테이너:');
    expect(msg, msg).toContain('exited');
    expect(msg, msg).toContain('exit=1');
    // **로그가 비었다는 사실 자체를 말한다.** 빈 문자열을 이어 붙이면 읽는 사람은
    // 로그를 못 받은 것인지 로그가 없는 것인지 모른다.
    expect(msg, msg).toContain('비어 있다');
    expect(msg, msg).toContain('상태와 종료 코드를 먼저 본다');
  }, 60_000);

  /** 로그가 있으면 그것도 낸다 — 있는 것을 숨기면 안 된다. */
  it('로그가 있으면 그대로 낸다', async () => {
    start('echo "설정 파일을 못 읽었다"; sleep 30');
    await new Promise((r) => setTimeout(r, 1_000));

    const msg = await failureOf();
    expect(msg, msg).toContain('설정 파일을 못 읽었다');
    expect(msg, msg).toContain('running');
    // 살아 있는데 안 답하는 것은 **다른 이야기**다 — 「비어 있다」를 안 붙인다.
    expect(msg, msg).not.toContain('비어 있다');
  }, 60_000);

  /**
   * 스크립트가 **끝나 버린** 경우. `exec` 가 빠지면 이렇게 된다 — 종료 코드가
   * `0` 이라 「성공했는데 안 뜬다」로 보이고, 그게 이 상태의 진단 가치다.
   */
  it('정상 종료도 구분된다 — `exec` 가 빠진 모양이다', async () => {
    start('echo 준비완료');
    await new Promise((r) => setTimeout(r, 1_500));

    const msg = await failureOf();
    expect(msg, msg).toContain('exited');
    expect(msg, msg).toContain('exit=0');
  }, 60_000);

  /** 컨테이너가 아예 없으면 그것도 말한다 — `docker run` 이 실패한 경우다. */
  it('컨테이너가 없으면 그 사실을 말한다 — 던지지 않는다', async () => {
    quiet('rm', '-f', NAME);
    const msg = await failureOf();
    expect(msg, msg).toContain('데몬이');
    // `docker inspect`·`logs` 가 실패해도 **진단이 예외로 바뀌지 않는다.**
    expect(msg, msg).toMatch(/컨테이너:/);
  }, 60_000);

  /** **되는 것을 안 깬다.** 프로브가 참이면 조용히 돌아온다. */
  it('뜨면 아무 말도 안 한다', async () => {
    start('sleep 30');
    await expect(waitForDaemon({
      container: NAME, probe: async () => true, budgetMs: 1_000,
    })).resolves.toBeUndefined();
  }, 60_000);
});

/**
 * 「데몬이 안 떴다」가 **이유를 말한다** — 검수 2026-08-24 N4 후속
 *
 * ── 무엇이 진단을 막았나
 *
 * 다섯 스위트가 전부 이렇게 적혀 있었다:
 *
 *   if (!up) throw new Error(`데몬이 안 떴다:\n${docker('logs', '--tail', '40', DP)}`);
 *
 * N4 를 진단할 때 그 메시지에 붙은 로그가 **빈 문자열**이었다. 기동 스크립트가
 * `apk add` 를 `>/dev/null 2>&1` 로 지우고 나머지는 성공 시 조용하기 때문이다 —
 * 실패 경로에 아무 출력이 없으면 `docker logs` 는 정직하게 아무것도 안 준다.
 *
 * 그래서 원인은 컨테이너를 **손으로 다시 띄워 `set -x` 를 걸고서야** 나왔다.
 * 게이트가 낸 것만으로는 한 발도 못 나갔다.
 *
 * ── 로그가 비었을 때 무엇이 남아 있나
 *
 * 컨테이너의 **상태와 종료 코드**다. 그리고 그 둘이 서로 다른 이야기를 한다:
 *
 *   `running`  + 로그 없음  → 아직 `apk add` 중이거나 **어딘가 매달렸다**
 *   `exited 1` + 로그 없음  → `set -e` 가 조용히 죽은 명령에서 끊었다 (N4 가 그랬다)
 *   `exited 0`             → 스크립트가 끝나 버렸다. `exec` 가 빠졌다는 뜻이다
 *   컨테이너 없음           → `docker run` 자체가 실패했다
 *
 * 「로그가 없다」와 「컨테이너가 죽었다」를 갈라 주는 것만으로도 다음 사람은 어디를
 * 파야 하는지 안다.
 *
 * ── 왜 파일 하나에 함수 하나인가
 *
 * `pg-ready.ts` 가 같은 이유로 존재하고 그 머리말이 이렇게 적어 뒀다:
 * *"넷에 복사하지 않고 여기 둔다. 같은 판정이 다섯 자리에 흩어지면 언젠가 하나가
 * 뒤처지고, 그때 그 스위트만 조용히 다시 경합한다."*
 */
import { execFileSync } from 'node:child_process';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** `docker` 한 번. 실패하면 이유를 문자열로 돌려준다 — 여기서 던지면 진단이 사라진다. */
function docker(...args: string[]): string {
  try {
    return execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch (e) {
    return `(docker ${args[0]} 실패: ${(e as Error).message})`;
  }
}

/**
 * 컨테이너가 지금 어떤 상태인지. **로그가 비었을 때 유일하게 남는 신호다.**
 *
 * `docker inspect` 가 실패하면 컨테이너가 없다는 뜻이고, 그것도 진단이다 —
 * `docker run` 이 통째로 실패한 경우다.
 */
function stateOf(container: string): string {
  const raw = docker('inspect', '-f', '{{.State.Status}} exit={{.State.ExitCode}}'
    + ' oom={{.State.OOMKilled}} err={{.State.Error}}', container);
  return raw === '' ? '(inspect 가 빈 답을 줬다)' : raw;
}

/**
 * 데몬이 답할 때까지 기다린다. 안 뜨면 **이유와 함께** 던진다.
 *
 * `probe` 는 「떴는가」를 답한다 — 스위트마다 포트가 다르므로 부르는 쪽이 준다.
 */
export async function waitForDaemon(opts: {
  container: string;
  probe: () => Promise<boolean>;
  budgetMs?: number;
  /** 로그 꼬리 줄 수. 기본 40. */
  tail?: number;
}): Promise<void> {
  const budget = opts.budgetMs ?? 120_000;
  const deadline = Date.now() + budget;
  for (;;) {
    if (await opts.probe()) return;
    if (Date.now() >= deadline) break;
    await sleep(250);
  }

  const logs = docker('logs', '--tail', String(opts.tail ?? 40), opts.container);
  const state = stateOf(opts.container);
  throw new Error(
    `데몬이 ${budget}ms 안에 안 떴다.\n`
    + `  컨테이너: ${state}\n`
    // **로그가 비었다는 것도 사실이다.** 빈 문자열을 그대로 이어 붙이면 메시지가
    // 「데몬이 안 떴다:」 로 끝나고, 그러면 읽는 사람은 로그를 못 받은 것인지
    // 로그가 없는 것인지 모른다 — N4 를 진단할 때 정확히 그 자리에서 막혔다.
    + `  로그(${opts.tail ?? 40}줄): ${logs === '' ? '**비어 있다**' : `\n${logs}`}\n`
    + (logs === ''
      ? '  ↳ 로그가 비면 기동 스크립트가 출력을 지웠거나 첫 명령에서 죽은 것이다.'
        + ' 위 상태와 종료 코드를 먼저 본다.\n'
      : ''),
  );
}

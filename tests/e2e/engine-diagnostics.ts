/**
 * 실패한 e2e 케이스가 **엔진의 상태를 들고 죽게 한다.**
 *
 * ── 왜 필요한가
 *
 * 활성화 흔들림을 두 번 봤다 (2026-08-31, PR #33 · #35). 둘 다 같은 모양이다:
 *
 *     reload 를 2 번 보냈는데 활성화가 관측되지 않았다
 *     (기대 세대 r3-e2, 관측 {"acceptingGeneration":"r2-e1","errorLogGrowth":0})
 *
 * `errorLogGrowth: 0` 이라 **설정이 만든 실패는 아니다.** 세대만 안 넘어갔다.
 * 그런데 그 다음을 볼 수가 없었다 — `afterEach` 가 컨테이너를 지우면서 nginx 의
 * error log 도, `current` 링크가 어디를 가리켰는지도 같이 사라진다. 실패 메세지는
 * *"엔진의 error log 를 본다"* 라고 말하는데 **CI 에는 그 로그가 남지 않는다.**
 *
 * 그래서 두 번을 보고도 아는 것이 늘지 않았다. 이 파일은 그걸 고친다 — 원인을 아직
 * 모르는 채로 **다음 발생이 증거를 들고 오게** 만드는 것이 지금 할 수 있는 일이다.
 *
 * ⚠️ **원인을 고치는 것이 아니다.** 폴링 예산은 재서 배제했다: 컨테이너를 `--cpus 0.05`
 * 로 조여도 활성화는 25 회 중 0~1 회에 증명된다(2.1~9.7초). 예산이 얇아서가 아니다.
 * 무엇 때문인지는 다음 발생의 로그가 답할 것이다.
 */
import { execFileSync } from 'node:child_process';

/** 한 줄도 못 읽어도 죽지 않는다 — 진단이 진단을 막으면 안 된다. */
function quiet(args: string[]): string {
  try {
    return execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trimEnd();
  } catch (e) {
    return `(못 읽었다: ${(e as Error).message.split('\n')[0]})`;
  }
}

/**
 * 컨테이너 안 엔진의 상태를 한 덩어리로 모은다.
 *
 * 모으는 것은 **활성화 판정이 보는 것들**이다: 무엇을 가리키고 있나(`current`), 무엇이
 * 있나(`generations`), 엔진이 무엇을 말했나(error log), 그리고 컨테이너 자신의 출력.
 */
export function engineDiagnostics(container: string, prefix = '/prefix'): string {
  const sh = (cmd: string): string => quiet(['exec', container, 'sh', '-c', cmd]);
  return [
    `── 엔진 진단 (${container}) ─────────────────────────────`,
    `current      → ${sh(`readlink ${prefix}/current 2>/dev/null || echo '(링크 없음)'`)}`,
    `generations  : ${sh(`ls ${prefix}/generations 2>/dev/null | tr '\\n' ' '`)}`,
    `nginx 프로세스:`,
    sh("ps -eo pid,ppid,args 2>/dev/null | grep '[n]ginx' || echo '(없다)'"),
    `error.log (마지막 40 줄):`,
    sh(`tail -n 40 ${prefix}/logs/error.log 2>/dev/null || echo '(없다)'`),
    `docker logs (마지막 20 줄):`,
    quiet(['logs', '--tail', '20', container]),
    '─────────────────────────────────────────────────────────',
  ].join('\n');
}

/**
 * 실패했을 때만 낸다.
 *
 * **컨테이너를 지우기 전에** 불러야 한다 — 지운 뒤에는 아무것도 안 남는다.
 * `state` 는 `afterEach` 컨텍스트의 `task.result?.state` 다.
 */
export function dumpEngineIfFailed(
  state: string | undefined, container: string, prefix = '/prefix',
): void {
  if (state !== 'fail') return;
  // stderr 로 낸다 — CI 로그에 그대로 실린다.
  console.error(engineDiagnostics(container, prefix));
}

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
import { execFileSync, spawnSync } from 'node:child_process';
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 기동 스크립트의 `apk add` 한 토막. **성공하면 조용하고, 실패하면 이유를 stderr 에 남긴다.**
 *
 * ── 무엇이 깨졌나 (CI 41393428259, 2026-11-02)
 *
 * `cluster.test.ts` 가 이렇게 죽었다:
 *
 *   컨테이너: exited exit=11 oom=false err=
 *   로그(40줄): **비어 있다**
 *
 * `11` 은 시그널이 아니다(시그널이면 128+n). **`apk add` 의 종료 코드는 apk 가 센 오류
 * 수다** — 패키지 하나를 못 받을 때마다 하나다. `nodejs` 는 의존성까지 10 개를 받는다.
 * 즉 그 순간 CDN 이 답하지 않았다.
 * 그런데 기동 스크립트가 `apk add ... >/dev/null 2>&1` 로 **오류까지 지워서** 로그가
 * 비었다. N4 때 `waitForDaemon` 이 「비어 있다」를 말하게 고쳤지만, 지우는 자리는 그대로였다.
 * 그리고 지우지 않았어도 안 보였다 — `logsOf` 의 머리말을 본다.
 *
 * 그래서 출력은 파일에 받고, 실패했을 때만 그 꼬리를 stderr 로 낸다. 종료 코드는 apk 의
 * 것을 그대로 돌려준다 — 바꾸면 「몇 개가 실패했나」가 사라진다. **다시 시도하지 않는다** —
 * 망이 안 되면 그 사실을 보이는 것이 이 함수의 일이다.
 *
 * 기동 스크립트는 `' && '` 로 잇는다. 그 사이에 끼어도 `||` 가 앞 명령까지 묶지 않도록
 * 통째로 `{ ...; }` 로 감싼다.
 */
export function apkAdd(...packages: string[]): string {
  const pkgs = packages.join(' ');
  return `{ apk add --no-cache ${pkgs} >/tmp/apk.log 2>&1 || { rc=$?;`
    + ` echo "apk add ${pkgs} 실패: exit=$rc (apk 가 센 오류 수 — 대개 망이다)" >&2;`
    + ' tail -n 20 /tmp/apk.log >&2; exit $rc; }; }';
}

/** `docker` 한 번. 실패하면 이유를 문자열로 돌려준다 — 여기서 던지면 진단이 사라진다. */
function docker(...args: string[]): string {
  try {
    return execFileSync('docker', args, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch (e) {
    return `(docker ${args[0]} 실패: ${(e as Error).message})`;
  }
}

/**
 * 컨테이너 로그 꼬리. **stdout 과 stderr 를 둘 다** 돌려준다.
 *
 * `docker logs` 는 컨테이너의 stderr 를 **자기 stderr** 로 낸다. 위 `docker()` 는 stdout 만
 * 돌려주므로, 이 자리를 `docker('logs', ...)` 로 두면 node 의 스택 추적도, apk 의 오류도,
 * 기동 스크립트의 `>&2` 도 **전부 버려진다** — 컨테이너에 로그가 있어도 「비어 있다」가 된다.
 * 두 흐름을 한 파일에 받아 순서를 지킨다.
 */
function logsOf(container: string, tail: number): string {
  const dir = mkdtempSync(join(tmpdir(), 'bary-logs-'));
  const file = join(dir, 'logs');
  const fd = openSync(file, 'w');
  try {
    const r = spawnSync('docker', ['logs', '--tail', String(tail), container], { stdio: ['ignore', fd, fd] });
    if (r.error) return `(docker logs 실패: ${r.error.message})`;
    return readFileSync(file, 'utf8').trim();
  } finally {
    closeSync(fd);
    rmSync(dir, { recursive: true, force: true });
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

  const logs = logsOf(opts.container, opts.tail ?? 40);
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

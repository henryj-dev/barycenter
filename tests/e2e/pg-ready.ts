/**
 * **PG 가 실제로 답할 때까지 기다린다** (2026-08-23).
 *
 * 다섯 e2e 스위트가 전부 같은 모양이었다: `docker run -d …postgres` 로 띄우자마자
 * 데몬 컨테이너를 붙인다. 데몬은 붙기 전에 `apk add nodejs` 를 하므로 보통 그 사이에
 * PG 가 준비됐고, **그래서 오래 통과했다.**
 *
 * 부하가 걸린 기계에서 그 순서가 뒤집히면 데몬이 `connect ECONNREFUSED …:5432` 로
 * **죽고 다시 시도하지 않는다.** 러너가 보는 것은 `데몬이 안 떴다` 한 줄이라 원인이
 * 경합이라는 것이 어디에도 안 드러난다 — 죽은 컨테이너 로그를 따로 파야 나온다.
 * 2026-08-23 에 `v02-capability` 가 그렇게 한 번 빨갰고 재실행은 통과했다.
 *
 * **넷에 복사하지 않고 여기 둔다.** 같은 판정이 다섯 자리에 흩어지면 언젠가 하나가
 * 뒤처지고, 그때 그 스위트만 조용히 다시 경합한다.
 *
 * 판정은 `deploy/docker-compose.yml` 의 healthcheck 와 **같은 것**이다. 거기 주석이
 * 이유를 적어 뒀다: *"`pg_isready` 만으로는 부족하다 — 초기화 중의 임시 서버도 참을
 * 답한다."* 실제 접속으로 확인한다.
 */
import { execFileSync } from 'node:child_process';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 이 컨테이너의 PG 가 질의에 답하는가. */
function answers(container: string): boolean {
  try {
    execFileSync('docker', ['exec', container, 'psql', '-U', 'postgres', '-d', 'bary', '-c', 'SELECT 1'],
      { stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch {
    return false;
  }
}

/**
 * 답할 때까지 기다린다. 예산을 넘기면 **컨테이너 로그와 함께** 던진다 —
 * "안 떴다" 만으로는 다음 사람이 또 엉뚱한 곳을 판다.
 */
export async function waitForPg(container: string, budgetMs = 60_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!answers(container)) {
    if (Date.now() >= deadline) {
      let logs = '(로그를 못 읽었다)';
      try {
        logs = execFileSync('docker', ['logs', '--tail', '20', container]).toString();
      } catch { /* 컨테이너가 이미 없을 수 있다 */ }
      throw new Error(`PG(${container})가 ${budgetMs}ms 안에 안 떴다:\n${logs}`);
    }
    await sleep(500);
  }
}

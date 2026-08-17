/**
 * 메트릭 — Prometheus 텍스트 노출
 *
 * **왜 이걸 먼저 짓는가.** §6.4 가 *"리소스 알람: `serving_generations` 수, FD, 메모리,
 * UDP 세션, conntrack"* 을 요구하는데 하나도 없었다. 그리고 이 저장소가 오래 달고 있는
 * 부채가 전부 **"오래 돌면 자란다"** 부류다 — `terminal` 원장, 세대 디렉토리, durable
 * 상태 파일. **자라는지 보려면 재는 자리가 있어야 한다.**
 *
 * 오래 돌려 보는 것(soak)이 다음 순서인데, 관측 없이 돌리면 "안 죽었다" 까지만 알 수
 * 있고 그건 측정이 아니다.
 *
 * ── 무엇을 재는가 ────────────────────────────────────────────────────────
 *
 * **자라는 것**(gauge)과 **일어난 것**(counter)을 나눈다. 전자는 부채를 겨누고 후자는
 * 흐름을 겨눈다.
 *
 * ⚠️ **FD·메모리·UDP 세션·conntrack 은 아직 없다.** 앞의 둘은 프로세스 것만 알 수 있고
 * (엔진 것이 필요하다), 뒤의 둘은 커널을 읽어야 한다. §6.4 가 요구한 목록의 절반이라는
 * 사실을 적어 둔다 — 있는 척하지 않는다.
 */
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** 이름 → 값. 라벨은 이름에 접어 넣는다 — 라벨 조합이 몇 개 안 된다. */
const counters = new Map<string, number>();

export function count(name: string, by = 1): void {
  counters.set(name, (counters.get(name) ?? 0) + by);
}

export function counterSnapshot(): Map<string, number> {
  return new Map(counters);
}

/** 테스트가 되돌린다. */
export function resetCounters(): void {
  counters.clear();
}

export type Gauges = {
  /** 세대 디렉토리 수와 바이트. **상한이 도는지 보는 자리다.** */
  generations: number;
  generationBytes: number;
  /**
   * durable 상태 파일의 바이트.
   *
   * `terminal`·`completed` 원장이 자라는지를 **직접** 재는 값이다. 원장 내부를 들여다보지
   * 않는 이유: 저장소는 payload 를 불투명하게 다루기로 한 계약이고(9차 검수), 파일 크기는
   * 그 계약을 안 깨면서 "자라는가" 에 답한다.
   */
  agentStateBytes: number;
  head: number;
  leader: number;
  activationEpochHttp: number;
  activationEpochStream: number;
  unfinished: number;
  backendsHealthy: number;
  backendsUnhealthy: number;
  backendsUnknown: number;
  pendingApply: number;
  uptimeSeconds: number;
  rssBytes: number;
};

const HELP: Record<keyof Gauges, [string, string]> = {
  generations: ['bary_generations', '디스크에 남아 있는 세대 디렉토리 수'],
  generationBytes: ['bary_generation_bytes', '세대 디렉토리가 차지하는 바이트'],
  agentStateBytes: ['bary_agent_state_bytes', 'DP Agent durable 상태 파일 바이트 (원장 성장)'],
  head: ['bary_config_head_revision', '전역 설정 리비전'],
  leader: ['bary_leader', '이 인스턴스가 리더인가 (1/0)'],
  activationEpochHttp: ['bary_activation_epoch_http', 'http 평면의 활성 epoch'],
  activationEpochStream: ['bary_activation_epoch_stream', 'stream 평면의 활성 epoch'],
  unfinished: ['bary_unfinished_transitions', '끝나지 않은 전환 수 (0 또는 1)'],
  backendsHealthy: ['bary_backends_healthy', 'healthy 로 판정된 백엔드 수'],
  backendsUnhealthy: ['bary_backends_unhealthy', 'unhealthy 로 판정된 백엔드 수'],
  backendsUnknown: ['bary_backends_unknown', '아직 판정 못 한 백엔드 수'],
  pendingApply: ['bary_pending_apply', '커밋됐지만 적용 안 된 plan 수'],
  uptimeSeconds: ['bary_uptime_seconds', '프로세스 가동 시간'],
  rssBytes: ['bary_process_rss_bytes', '컨트롤 플레인 프로세스 RSS (엔진은 안 포함)'],
};

/** 세대 디렉토리를 센다. 못 읽으면 0 — 실패가 아니라 "아직 없다" 다. */
export function measureGenerations(prefix: string): { count: number; bytes: number } {
  const root = join(prefix, 'generations');
  let count = 0;
  let bytes = 0;
  try {
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      count += 1;
      bytes += dirBytes(join(root, entry.name));
    }
  } catch {
    return { count: 0, bytes: 0 };
  }
  return { count, bytes };
}

function dirBytes(dir: string): number {
  let total = 0;
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      total += entry.isDirectory() ? dirBytes(p) : statSync(p).size;
    }
  } catch {
    /* 그 사이 지워졌으면 0 */
  }
  return total;
}

export function fileBytes(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

/**
 * Prometheus 텍스트 형식.
 *
 * 라이브러리를 안 쓴다 — 형식이 몇 줄이고, 여기서 의존성을 늘리면 그게 곧 공급망이다.
 */
export function render(gauges: Gauges): string {
  const lines: string[] = [];
  for (const [key, [name, help]] of Object.entries(HELP) as [keyof Gauges, [string, string]][]) {
    lines.push(`# HELP ${name} ${help}`);
    lines.push(`# TYPE ${name} gauge`);
    lines.push(`${name} ${gauges[key]}`);
  }
  for (const [name, value] of [...counters].sort(([a], [b]) => (a < b ? -1 : 1))) {
    lines.push(`# TYPE ${name} counter`);
    lines.push(`${name} ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

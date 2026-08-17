/**
 * 구조화 로그
 *
 * `console.log` 로 사람이 읽는 문장을 찍고 있었다. 사람이 터미널을 보고 있을 때는
 * 괜찮지만, **오래 돌리는 순간 그건 관측이 아니다** — 무엇이 몇 번 일어났는지 세려면
 * 문장을 다시 파싱해야 하고, 문장은 내가 고칠 때마다 바뀐다.
 *
 * 한 줄에 한 사건, JSON 하나. 필드 이름은 계약이고 메시지는 사람용 곁다리다.
 *
 * **의존성을 안 늘린다.** 로깅 라이브러리는 여기서 필요 없는 것을 많이 가져온다 —
 * `JSON.stringify` 한 줄이면 되는 일이다 (§11.2 가 PG 하나만 쓰기로 한 것과 같은 이유).
 */

export type Level = 'info' | 'warn' | 'error';

/** 사건 이름은 **점으로 구분한 명사**다. `apply.activated` 처럼. */
export type Fields = Record<string, unknown>;

let sink: (line: string) => void = (line) => process.stdout.write(`${line}\n`);

/** 테스트가 갈아 끼운다. */
export function setSink(fn: (line: string) => void): void {
  sink = fn;
}

function emit(level: Level, event: string, fields: Fields): void {
  // **시각을 먼저 쓴다.** 로그를 `sort` 로 정렬할 수 있어야 한다.
  const record: Fields = { ts: new Date().toISOString(), level, event, ...fields };
  let line: string;
  try {
    line = JSON.stringify(record);
  } catch {
    // 순환 참조 같은 것이 섞여도 **로그가 프로세스를 죽이면 안 된다.**
    line = JSON.stringify({ ts: record['ts'], level, event, error: '직렬화 실패' });
  }
  sink(line);
}

export const log = {
  info: (event: string, fields: Fields = {}): void => emit('info', event, fields),
  warn: (event: string, fields: Fields = {}): void => emit('warn', event, fields),
  error: (event: string, fields: Fields = {}): void => emit('error', event, fields),
};

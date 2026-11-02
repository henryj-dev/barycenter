/**
 * **풀 헬스체크 폼** (2026-11-02). 전에는 GUI 에 헬스체크를 고칠 곳이 없었다 — 목록에 「있음 · 없음」 만 보였고, 넣으려면
 * JSON 을 손으로 고쳐야 했다. web-01 의 counter 백엔드가 그래서 비정상으로 빠졌다: 프로버가 Host 없이 `GET /` 를 보내 400 을
 * 받았는데, 경로 · Host 헤더를 고칠 칸이 없었다.
 *
 * 폼 값 ↔ 풀 `healthCheck` 를 오간다. 판정 규칙(범위 · 타임아웃 ≤ 주기)은 해독기가 진다 — 여기서는 숫자 모양과 「저장 못 하는
 * patch 를 만들지 않는다」 만 본다. 풀의 다른 칸은 그대로 둔다(업스트림 TLS 폼과 같은 방식).
 */

/** `default` 는 「안 적음」 — 풀의 protocolClass 가 정한다(http → http GET /, 그 외 → tcp_connect). */
export type HealthMode = 'default' | 'none' | 'tcp' | 'http';

export type HealthForm = {
  mode: HealthMode;
  path: string;
  hostHeader: string;
  /** 쉼표 · 공백으로 나눈 상태 코드. 비면 2xx. */
  expectStatus: string;
  expectBody: string;
  port: string;
  hostOverride: string;
  intervalS: string;
  timeoutS: string;
  rise: string;
  fall: string;
};

export const HEALTH_DEFAULT: HealthForm = {
  mode: 'default', path: '', hostHeader: '', expectStatus: '', expectBody: '',
  port: '', hostOverride: '', intervalS: '', timeoutS: '', rise: '', fall: '',
};

const text = (v: unknown): string => (v === undefined || v === null ? '' : String(v));

/** 풀 → 폼. 모르는 모양이면 빈 칸이다(저장하면 그 모양은 폼의 것으로 바뀐다 — JSON 수정이 그대로 남는다). */
export function healthFormOf(pool: Readonly<Record<string, unknown>>): HealthForm {
  const h = pool['healthCheck'];
  if (h === null || typeof h !== 'object') return { ...HEALTH_DEFAULT };
  const r = h as Record<string, unknown>;
  const mode: HealthMode = r['mode'] === 'none' ? 'none' : r['protocol'] === 'http' ? 'http' : r['protocol'] === 'tcp_connect' ? 'tcp' : 'default';
  return {
    mode,
    path: text(r['path']), hostHeader: text(r['hostHeader']),
    expectStatus: Array.isArray(r['expectStatus']) ? (r['expectStatus'] as unknown[]).join(', ') : '',
    expectBody: text(r['expectBody']), port: text(r['port']), hostOverride: text(r['hostOverride']),
    intervalS: text(r['intervalS']), timeoutS: text(r['timeoutS']), rise: text(r['rise']), fall: text(r['fall']),
  };
}

const intOf = (label: string, s: string): number | undefined => {
  const t = s.trim();
  if (t === '') return undefined;
  if (!/^[0-9]+$/.test(t)) throw new Error(`${label} 는 정수다 (받은 것: ${JSON.stringify(s)})`);
  return Number(t);
};

/** 폼 → `healthCheck` 값. `undefined` 면 필드를 뺀다(`default`). 숫자 모양이 틀리면 던진다. */
export function healthCheckOf(f: HealthForm): Record<string, unknown> | undefined {
  if (f.mode === 'default') return undefined;
  if (f.mode === 'none') return { mode: 'none' };
  const common = {
    ...(intOf('포트', f.port) === undefined ? {} : { port: intOf('포트', f.port) }),
    ...(f.hostOverride.trim() === '' ? {} : { hostOverride: f.hostOverride.trim() }),
    ...(intOf('주기', f.intervalS) === undefined ? {} : { intervalS: intOf('주기', f.intervalS) }),
    ...(intOf('타임아웃', f.timeoutS) === undefined ? {} : { timeoutS: intOf('타임아웃', f.timeoutS) }),
    ...(intOf('rise', f.rise) === undefined ? {} : { rise: intOf('rise', f.rise) }),
    ...(intOf('fall', f.fall) === undefined ? {} : { fall: intOf('fall', f.fall) }),
  };
  if (f.mode === 'tcp') return { protocol: 'tcp_connect', ...common };
  const codes = f.expectStatus.split(/[\s,]+/).filter((x) => x !== '').map((x) => intOf('기대 상태 코드', x)!);
  return {
    protocol: 'http',
    ...(f.path.trim() === '' ? {} : { path: f.path.trim() }),
    ...(f.hostHeader.trim() === '' ? {} : { hostHeader: f.hostHeader.trim() }),
    ...(codes.length === 0 ? {} : { expectStatus: codes }),
    ...(f.expectBody === '' ? {} : { expectBody: f.expectBody }),
    ...common,
  };
}

/** 저장 전에 알릴 것 — 숫자 모양 · 타임아웃이 주기보다 김. 해독기와 같은 말을 미리 한다. */
export function healthIssue(f: HealthForm): string | undefined {
  try {
    const h = healthCheckOf(f);
    const i = h?.['intervalS'];
    const t = h?.['timeoutS'];
    if (typeof i === 'number' && typeof t === 'number' && t > i) return `타임아웃(${t}초)이 주기(${i}초)보다 길어요 — 프로브가 쌓여요`;
    if (f.mode === 'http' && f.path.trim() !== '' && !f.path.trim().startsWith('/')) return '경로는 / 로 시작해요';
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

/** 풀 본문에 헬스체크를 바꿔 끼운다. key 는 뺀다(PUT 본문에 안 들어간다). */
export function poolBodyWithHealth(pool: Readonly<Record<string, unknown>>, f: HealthForm): Record<string, unknown> {
  const issue = healthIssue(f);
  if (issue !== undefined) throw new Error(issue);
  const { key: _key, healthCheck: _old, ...rest } = pool;
  const h = healthCheckOf(f);
  return h === undefined ? rest : { ...rest, healthCheck: h };
}
